import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import { PLACEHOLDER } from '../src/stubs.ts'
import { requestThroughProxy, startHarness } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The end-to-end property, and the only test that can prove it: a client that speaks real
 * TLS through a real CONNECT tunnel, sending the placeholder credential the container was
 * given, arrives upstream carrying the *real* one.
 *
 * Everything else in this package is a pure function that can be asserted directly. This
 * file exists because the interesting failures are not in those functions — they are in
 * the seams. A leaf certificate the client refuses, an ALPN offer that negotiates h2 and
 * hangs, a body that never gets piped, `proxy-authorization` forwarded upstream. Each of
 * those passes every unit test in the package and fails here.
 */

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await harness.cleanup()
})

const anthropic = async (): Promise<Harness> => {
  const harness = await startHarness({
    hostname: 'api.anthropic.com',
    credentials: {
      anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'sk-ant-oat01-REAL' },
    },
  })
  harnesses.push(harness)
  return harness
}

test('the real credential reaches the upstream and the placeholder does not', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    method: 'POST',
    path: '/v1/messages',
    // Exactly what a container's CLI sends: the stub's placeholder, believed to be real.
    headers: { authorization: `Bearer ${PLACEHOLDER}`, 'content-type': 'application/json' },
    body: '{"model":"claude-x"}',
  })

  assert.equal(response.connect, 200)
  assert.equal(response.status, 200)

  const upstream = harness.upstream.received.at(-1)
  assert.equal(upstream?.headers.authorization, 'Bearer sk-ant-oat01-REAL')
  assert.equal(upstream?.body, '{"model":"claude-x"}', 'the request body must survive the splice')
  assert.ok(
    !JSON.stringify(upstream?.headers).includes(PLACEHOLDER),
    'no trace of the placeholder may reach the provider',
  )
})

/**
 * The header that carries the gateway's own secret.
 *
 * `proxy-authorization` holds the per-job token, and an implementation that forwards the
 * client's headers wholesale publishes it to Anthropic — a third party — on every request.
 * It is hop-by-hop by RFC and by consequence, and this is the assertion that says so.
 */
test('the proxy token is never forwarded upstream', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    headers: {
      // Sent *inside* the tunnel this time, which is where a careless client puts it and
      // where a careless proxy passes it straight through.
      'proxy-authorization': `Basic ${Buffer.from(`x:${session.token}`).toString('base64')}`,
    },
  })

  const upstream = harness.upstream.received.at(-1)
  assert.equal(upstream?.headers['proxy-authorization'], undefined)
  assert.ok(!JSON.stringify(upstream?.headers).includes(session.token))
})

/**
 * Claude Code's OAuth requests carry `anthropic-beta: oauth-2025-04-20`, and an OAuth
 * token is rejected by `/v1/messages` without it. The gateway rewrites `authorization`
 * and must leave everything else exactly as the client wrote it — a strip list that
 * reached for "anything auth-adjacent" would break every OAuth request while looking
 * more careful.
 */
test('provider headers the client set are passed through untouched', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
  })

  const upstream = harness.upstream.received.at(-1)
  assert.equal(upstream?.headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(upstream?.headers['anthropic-version'], '2023-06-01')
})

/**
 * A response that arrives in pieces over time must leave in pieces over time.
 *
 * Every agent run is a streaming completion. A gateway that collected the response before
 * answering would still pass a naive "did the body arrive" assertion — the bytes are all
 * there at the end — while turning an interactive run into a minutes-long silence and
 * holding the whole completion in memory. The assertion is therefore about *arrival
 * order*, not content.
 */
test('a streamed response is relayed as it arrives, not collected first', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: start\n\n')
    // Held open past the point a buffering proxy would have had to answer.
    setTimeout(() => {
      res.write('event: done\n\n')
      res.end()
    }, 150)
  })

  const started = Date.now()
  let firstByteAt = 0
  await new Promise<void>((resolve, reject) => {
    void requestThroughProxy(harness, {
      token: session.token,
      hostname: 'api.anthropic.com',
      path: '/v1/messages?stream=true',
    }).then(() => resolve(), reject)
    // The harness resolves on `end`, so first-byte timing is observed on the upstream
    // side: the request must have reached it well before the response completed.
    const poll = setInterval(() => {
      if (harness.upstream.received.length > 0 && firstByteAt === 0) {
        firstByteAt = Date.now()
        clearInterval(poll)
      }
    }, 5)
    poll.unref()
  })

  assert.ok(
    firstByteAt > 0 && firstByteAt - started < 140,
    'the upstream saw the request before the response finished',
  )
})

test('a host that is not on the allowlist never gets a tunnel', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'evil.example.com',
  })

  assert.equal(response.connect, 403, 'refused at CONNECT, before any TLS is spoken')
  assert.equal(response.status, undefined)
})

/**
 * The listener sits on an address every container on the host's bridge network can reach,
 * so "can you connect to it" and "may you use it" are different questions. Without the
 * token check the gateway is an open credential oracle for anything else on the box.
 */
test('a CONNECT with no valid token is refused, not tunnelled', async () => {
  const harness = await anthropic()

  const response = await requestThroughProxy(harness, {
    token: 'not-a-real-token',
    hostname: 'api.anthropic.com',
  })

  assert.equal(response.connect, 407)
})

/**
 * A job's token dies with the job. A container that outlives its run — a `--rm` that did
 * not fire, a leaked `docker run` — would otherwise keep spending the host's credentials
 * indefinitely, and nothing in the system would ever notice.
 */
test('a revoked session token stops working immediately', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  assert.equal(
    (await requestThroughProxy(harness, { token: session.token, hostname: 'api.anthropic.com' }))
      .connect,
    200,
  )
  session.revoke()
  assert.equal(
    (await requestThroughProxy(harness, { token: session.token, hostname: 'api.anthropic.com' }))
      .connect,
    407,
  )
})

/**
 * ADR-0005, at the second boundary.
 *
 * The refusal is inside the tunnel rather than at CONNECT, because `github.com` is an
 * allowlisted host — a sandbox is allowed to *read* a repository. What it may never do is
 * write one, and a proxy cannot tell a push to a topic branch from a force-push to `main`:
 * the refs live in a pkt-line body nothing here parses. So the whole shape is refused.
 */
test('a git push is refused even to an allowlisted host with a credential', async () => {
  const harness = await startHarness({
    hostname: 'github.com',
    credentials: { github: { provider: 'github', token: 'ghp_REAL' } },
  })
  harnesses.push(harness)
  const session = harness.gateway.open()

  const push = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'github.com',
    method: 'POST',
    path: '/owner/repo.git/git-receive-pack',
  })
  assert.equal(push.status, 403)
  assert.match(push.body ?? '', /push_refused/)

  // …and the discovery half. Refusing only the POST lets git prepare and upload a packfile
  // before failing, which reports as a transfer error rather than as a refusal.
  const discovery = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'github.com',
    path: '/owner/repo.git/info/refs?service=git-receive-pack',
  })
  assert.equal(discovery.status, 403)

  // A fetch through the same door still works, and still gets the credential.
  const fetch = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'github.com',
    path: '/owner/repo.git/info/refs?service=git-upload-pack',
  })
  assert.equal(fetch.status, 200)
  assert.equal(
    harness.upstream.received.at(-1)?.headers.authorization,
    `Basic ${Buffer.from('x-access-token:ghp_REAL').toString('base64')}`,
  )
  assert.ok(harness.upstream.received.every((r) => !r.url.includes('git-receive-pack')))
})

/**
 * The gateway knows why the request cannot work, so it says so.
 *
 * Forwarding a placeholder to Anthropic gets a 401, and the CLI reports that as "your
 * credentials are invalid" — sending whoever reads the 3am transcript to re-authenticate
 * a host credential that was never the problem. `x-should-retry: false` matters as much:
 * without it both provider SDKs retry a permanent refusal until the job's budget is gone
 * and the run is filed as a timeout.
 */
test('a missing host credential is reported by the gateway, not by the provider', async () => {
  const harness = await startHarness({ hostname: 'api.anthropic.com', credentials: {} })
  harnesses.push(harness)
  const session = harness.gateway.open()

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
  })

  assert.equal(response.status, 502)
  assert.match(response.body ?? '', /no_credential/)
  assert.equal(response.headers?.['x-should-retry'], 'false')
  assert.equal(harness.upstream.received.length, 0, 'nothing was forwarded')
})
