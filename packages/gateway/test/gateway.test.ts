import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { connect as tlsConnect } from 'node:tls'
import { loadOrCreateCa } from '../src/ca.ts'
import { startGateway } from '../src/server.ts'
import { PLACEHOLDER } from '../src/stubs.ts'
import {
  openTunnel,
  pipelinedTunnel,
  requestThroughProxy,
  startHarness,
  startUpstream,
} from './harness.ts'
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

/** A raw CONNECT, for the tests that need the socket rather than a finished response. */
const rawTunnel = (
  harness: Harness,
  token: string,
  onError: (err: Error) => void,
  authority = 'api.anthropic.com:443',
) => {
  const socket = netConnect(harness.address.port, harness.address.host, () => {
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}\r\n\r\n`,
    )
  })
  socket.on('error', onError)
  return socket
}

const secureTunnel = (harness: Harness, socket: Socket, hostname = 'api.anthropic.com') => {
  const tls = tlsConnect({
    socket,
    ca: harness.sandboxCa,
    servername: hostname,
    ALPNProtocols: ['http/1.1'],
  })
  tls.on('error', () => undefined)
  return tls
}

/**
 * Poll for a condition rather than sleeping a guessed interval.
 *
 * A fixed sleep is either flaky on a loaded machine or slow on an idle one, and the
 * conditions here — a socket closing, a handle being released — settle in milliseconds
 * when they settle at all.
 */
const waitFor = async (condition: () => boolean, message: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The proxy's other door: an absolute-form request URI sent straight at the proxy port,
 * with no CONNECT and no tunnel.
 *
 * Written on the raw socket because that is the only way to send a request line the HTTP
 * client libraries will not produce — `http.request` always writes origin form unless it
 * is going through its own proxy support, and the point here is to send exactly what a
 * misbehaving client would.
 */
const absoluteForm = (
  harness: Harness,
  token: string,
  url: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = netConnect(harness.address.port, harness.address.host, () => {
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n` +
          `Proxy-Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}\r\n` +
          'Connection: close\r\n\r\n',
      )
    })
    socket.on('error', reject)
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const status = Number(raw.split(' ')[1])
      resolve({ status, body: raw.slice(raw.indexOf('\r\n\r\n') + 4) })
    })
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
 * Every agent run is a streaming completion. A gateway that collected the whole response
 * before answering still delivers every byte, so "did the body arrive" proves nothing —
 * the assertion has to be about *when the client saw each chunk*.
 *
 * This test was written the wrong way first, and it is worth saying how: it timed when the
 * *upstream* received the request, which a buffering proxy does exactly as fast. It passed
 * against an implementation it could not have distinguished from a broken one.
 */
test('a streamed response reaches the client in pieces, not in one block at the end', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const HOLD_MS = 200
  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: start\n\n')
    // Held open well past the point a buffering proxy would have had to answer.
    setTimeout(() => {
      res.write('event: done\n\n')
      res.end()
    }, HOLD_MS)
  })

  const started = Date.now()
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    path: '/v1/messages?stream=true',
  })

  assert.equal(response.status, 200)
  assert.match(response.body ?? '', /event: start/)
  assert.match(response.body ?? '', /event: done/)

  const times = response.chunkTimes ?? []
  assert.ok(times.length >= 2, `expected the body in pieces, got ${times.length} chunk(s)`)
  // The first chunk lands roughly immediately; the last only after the upstream releases
  // it. A buffering proxy delivers both at the same moment, at the end.
  assert.ok(
    times[0]! - started < HOLD_MS / 2,
    `first chunk reached the client after ${times[0]! - started}ms`,
  )
  assert.ok(times.at(-1)! - times[0]! > HOLD_MS / 2, 'the chunks arrived at the same moment')
})

/**
 * A client that cancels a turn takes the upstream with it.
 *
 * `req.on('aborted')` covers only a client that vanishes while its *request body* is still
 * arriving, which is never the case once a response is streaming — and streaming is what
 * an agent does. Without a teardown on the response side, every cancelled turn leaks a
 * socket on a long-lived runner and leaves the provider generating, and billing for, a
 * completion nobody will read.
 */
test('a client that hangs up mid-stream tears the upstream down with it', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  let upstreamClosed = false
  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: start\n\n')
    // Never ends on its own: the only thing that can close it is the client going away.
    const keepalive = setInterval(() => res.write(': ping\n\n'), 20)
    res.on('close', () => {
      upstreamClosed = true
      clearInterval(keepalive)
    })
  })

  await new Promise<void>((resolve, reject) => {
    const socket = rawTunnel(harness, session.token, reject)
    socket.once('data', () => {
      const tls = secureTunnel(harness, socket)
      const req = request({
        createConnection: () => tls,
        host: 'api.anthropic.com',
        path: '/v1/messages?stream=true',
        headers: { host: 'api.anthropic.com' },
      })
      req.on('error', () => undefined)
      req.on('response', (res) => {
        res.once('data', () => {
          // The agent pressing stop.
          tls.destroy()
          socket.destroy()
          resolve()
        })
      })
      req.end()
    })
  })

  await waitFor(() => upstreamClosed, 'the upstream connection was still open')
})

/**
 * The client has to be told when an upstream dies with a promise outstanding.
 *
 * The response headers are already gone, and with them a `content-length` announcing bytes
 * that will never arrive. Ending the response cleanly leaves the message unterminated *and*
 * the connection advertised as reusable, so the client waits for the rest of a body that
 * does not exist until its own timeout fires — and the run is filed as a timeout rather
 * than as the upstream failure it was. Only destroying the socket says "truncated".
 */
test('an upstream that dies mid-body closes the client connection instead of hanging it', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
    res.write('abc')
    setTimeout(() => res.socket?.destroy(), 30)
  })

  const closed = await new Promise<boolean>((resolve, reject) => {
    const socket = rawTunnel(harness, session.token, reject)
    const timer = setTimeout(() => resolve(false), 5_000)
    timer.unref()
    socket.once('data', () => {
      const tls = secureTunnel(harness, socket)
      // The client's own connection ending is the signal. Without the fix this never fires
      // and the test times out — which is exactly what the agent would do.
      tls.on('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
      const req = request({
        createConnection: () => tls,
        host: 'api.anthropic.com',
        path: '/v1/messages',
        headers: { host: 'api.anthropic.com' },
      })
      req.on('error', () => undefined)
      req.on('response', (res) => res.on('error', () => undefined))
      req.end()
    })
  })

  assert.equal(closed, true, 'the client was left waiting for a body that will never come')
})

/**
 * A client that starts its TLS handshake without waiting for `200 Connection Established`.
 *
 * Node's `'connect'` event hands the proxy a `head` buffer holding whatever arrived after
 * the CONNECT request line — for such a client, the first bytes of the ClientHello, still
 * encrypted. They have to be replayed onto the *raw socket*, before TLS wraps it. Putting
 * them back with `tlsSocket.unshift()` instead injects ciphertext into the decrypted side,
 * where it reads as a mangled HTTP request or as nothing at all.
 *
 * This was written the wrong way here first, and every other test in this file passed:
 * a client that waits for the 200 leaves `head` empty, so the whole class of mistake is
 * invisible unless a test deliberately pipelines.
 */
test('a client that pipelines its ClientHello behind the CONNECT still connects', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const tls = await pipelinedTunnel(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
  })

  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      createConnection: () => tls,
      host: 'api.anthropic.com',
      path: '/v1/messages',
      headers: { host: 'api.anthropic.com' },
    })
    req.on('error', reject)
    req.on('response', (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.end()
  })
  tls.destroy()

  assert.equal(status, 200)
  assert.equal(harness.upstream.received.at(-1)?.headers.authorization, 'Bearer sk-ant-oat01-REAL')
})

/**
 * The transport that makes the proxy unavoidable instead of advisory.
 *
 * On any network, `HTTPS_PROXY` is a suggestion — `curl --noproxy '*'` declines it and the
 * agent reaches the internet directly, taking every guarantee above it with it. A container
 * run `--network none` has no interface to decline with, and a bind-mounted unix socket is
 * its only route out. So the gateway has to be able to listen on one.
 *
 * `open()` refuses to invent a proxy URL in that mode rather than composing a plausible
 * one: a socket has no authority, `HTTPS_PROXY` has no syntax for a path, and a container
 * handed a silently wrong proxy address talks to nothing at all.
 */
test('the gateway serves over a unix socket, and will not guess the URL for one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ogun-sock-'))
  const socketPath = join(directory, 'proxy.sock')
  const upstream = await startUpstream('api.anthropic.com')
  const ca = loadOrCreateCa(mkdtempSync(join(tmpdir(), 'ogun-sock-ca-')))

  const gateway = await startGateway({
    ca,
    socketPath,
    credentials: () => ({
      anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'sk-ant-oat01-REAL' },
    }),
    allowedHosts: ['api.anthropic.com'],
    dial: { rewrite: () => upstream.origin, ca: upstream.ca },
    onWarning: () => undefined,
  })

  assert.deepEqual(gateway.listening, { kind: 'socket', path: socketPath })
  // Anything else on the box that can open this file can spend the host's credentials.
  assert.equal(statSync(socketPath).mode & 0o777, 0o600)
  assert.throws(() => gateway.open(), /needs the authority/)

  const session = gateway.open('127.0.0.1:8118')
  assert.equal(session.proxyUrl, `http://x:${session.token}@127.0.0.1:8118`)

  // And it really serves: CONNECT over the socket, then TLS, then the splice.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const wire = netConnect(socketPath, () => {
      wire.write(
        'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n' +
          `Proxy-Authorization: Basic ${Buffer.from(`x:${session.token}`).toString('base64')}\r\n\r\n`,
      )
    })
    wire.on('error', reject)
    wire.once('data', (chunk: Buffer) => {
      assert.match(chunk.toString('utf8'), /^HTTP\/1\.1 200/)
      const tls = tlsConnect({ socket: wire, ca: ca.certificatePem, servername: 'api.anthropic.com' })
      tls.on('error', reject)
      const req = request({
        createConnection: () => tls,
        host: 'api.anthropic.com',
        path: '/v1/messages',
        headers: { host: 'api.anthropic.com', authorization: `Bearer ${PLACEHOLDER}` },
      })
      req.on('error', reject)
      req.on('response', (res) => {
        res.resume()
        res.on('end', () => {
          tls.destroy()
          resolve(res.statusCode)
        })
      })
      req.end()
    })
  })

  assert.equal(status, 200)
  assert.equal(upstream.received.at(-1)?.headers.authorization, 'Bearer sk-ant-oat01-REAL')

  await gateway.close()
  await upstream.close()
  rmSync(directory, { recursive: true, force: true })
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
 * One gateway serves every job on the machine, so the allowlist has to belong to the
 * session and not to the gateway. It did not: `allowedHosts` was a single list closed over
 * at startup, and every token was checked against it.
 *
 * The failure mode is the quiet kind. Nothing errors — a reviewer that declared a narrow
 * `egress:` simply inherits the reach of whatever else the runner is running, and the
 * union only widens as more workers are added. A test that opens one session cannot see
 * it; it takes two, with the second asserting a refusal for a host the first is allowed.
 */
test('one session does not inherit another session\'s reach', async () => {
  const harness = await anthropic()
  const permitted = harness.gateway.open(undefined, ['api.anthropic.com'])
  const restricted = harness.gateway.open(undefined, ['docs.example.com'])

  const allowed = await requestThroughProxy(harness, {
    token: permitted.token,
    hostname: 'api.anthropic.com',
  })
  assert.equal(allowed.connect, 200, 'the session that declared the host reaches it')

  const refused = await requestThroughProxy(harness, {
    token: restricted.token,
    hostname: 'api.anthropic.com',
  })
  assert.equal(
    refused.connect,
    403,
    'a second session with a narrower list must not reach what the first may',
  )
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

// ── The other door ─────────────────────────────────────────────────────────
//
// A proxy is reachable two ways. Everything above goes through CONNECT; these go through
// absolute-form (`GET https://host/path` sent straight at the proxy port), which some
// clients use and which had no test at all. Two live security bugs were found here.

/**
 * Absolute-form `http://` used to inject a real credential onto plaintext TCP/80.
 *
 * The scheme test was `protocol.startsWith('http')`, so `http:` passed it. A sandbox
 * sending `GET http://api.anthropic.com/v1/messages` at the proxy port cleared the
 * allowlist — the hostname is allowlisted — had the host's live OAuth token spliced in,
 * and had it put on the wire unencrypted. The container still never held the token; the
 * token was simply readable by anyone on the path, one `curl` from a prompt-injected
 * agent.
 *
 * Every host on the allowlist is an HTTPS API, so cleartext is refused rather than
 * upgraded: an upgrade would work silently and leave the rule undiscoverable.
 */
test('an absolute-form cleartext request is refused, credential and all', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await absoluteForm(harness, session.token, 'http://api.anthropic.com/v1/messages')

  assert.equal(response.status, 403)
  assert.match(response.body, /cleartext_refused/)
  assert.equal(harness.upstream.received.length, 0, 'nothing was forwarded, encrypted or not')
})

/**
 * …and the same check accepted any scheme *beginning* "http".
 *
 * `httpz://api.anthropic.com/x` parsed, matched `startsWith('http')`, and was forwarded
 * with a real credential over a plaintext socket. An exact comparison is the fix, and the
 * reason a prefix test is never the right shape for a scheme.
 */
test('a scheme that merely starts with "http" is not https', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await absoluteForm(harness, session.token, 'httpz://api.anthropic.com/x')

  assert.equal(response.status, 403)
  assert.equal(harness.upstream.received.length, 0)
})

/**
 * The second door runs the same checks as the first, or it is a governed proxy sitting
 * next to an ungoverned one.
 */
test('absolute-form enforces the token and the allowlist exactly as CONNECT does', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const noToken = await absoluteForm(harness, 'not-a-token', 'https://api.anthropic.com/v1/messages')
  assert.equal(noToken.status, 407)

  const offList = await absoluteForm(harness, session.token, 'https://evil.example.com/x')
  assert.equal(offList.status, 403)
  assert.match(offList.body, /host_not_allowed/)

  assert.equal(harness.upstream.received.length, 0)
})

test('an absolute-form https request is forwarded, with the credential spliced in', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await absoluteForm(
    harness,
    session.token,
    'https://api.anthropic.com/v1/models?limit=1',
  )

  assert.equal(response.status, 200)
  const upstream = harness.upstream.received.at(-1)
  assert.equal(upstream?.headers.authorization, 'Bearer sk-ant-oat01-REAL')
  // The query string survives, and the proxy token does not.
  assert.equal(upstream?.url, '/v1/models?limit=1')
  assert.equal(upstream?.headers['proxy-authorization'], undefined)
})

// ── Ports ──────────────────────────────────────────────────────────────────

/**
 * The allowlist matches on hostname alone, so without a separate port check
 * `api.anthropic.com:22` is an allowlisted name pointing at somebody else's SSH port —
 * intercepted, credentialed, and tunnelled. `parseAuthority` had always returned the port
 * with a comment saying exactly this; nothing acted on it.
 */
test('an allowlisted host on an unexpected port is still refused', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    port: 8443,
  })

  assert.equal(response.connect, 403, 'refused at CONNECT, before any TLS')
  assert.equal(harness.upstream.received.length, 0)
})

// ── Framing ────────────────────────────────────────────────────────────────

/**
 * The second request on a connection is where framing bugs surface.
 *
 * A proxy that mishandles `content-length` or chunking still answers the first request
 * perfectly and then desynchronises — the next response is read as a continuation of the
 * last body, or the parser never finds a status line. Every other test in this file opens
 * a fresh tunnel per request and would never see it.
 */
test('a tunnel carries more than one request without desynchronising', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()
  const tunnel = await openTunnel(harness, { token: session.token, hostname: 'api.anthropic.com' })

  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ n: harness.upstream.received.length }))
  })

  const first = await tunnel.send({ path: '/v1/models' })
  const second = await tunnel.send({ path: '/v1/messages' })
  tunnel.close()

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.notEqual(first.body, second.body, 'the second response is its own, not an echo')
  assert.deepEqual(
    harness.upstream.received.map((r) => r.url),
    ['/v1/models', '/v1/messages'],
  )
  // Both carried the real credential: injection is per-request, not per-connection.
  assert.ok(
    harness.upstream.received.every((r) => r.headers.authorization === 'Bearer sk-ant-oat01-REAL'),
  )
})

/**
 * A HEAD response announces a `content-length` and carries no body, and a 304 carries
 * neither. A proxy that strips the length, or that waits for a body that is not coming,
 * turns both into a hang or an apparent truncation.
 */
test('a bodyless response keeps its framing and does not stall the connection', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()
  const tunnel = await openTunnel(harness, { token: session.token, hostname: 'api.anthropic.com' })

  harness.upstream.respond((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1234' })
      res.end()
      return
    }
    res.writeHead(304, { etag: 'W/"abc"' })
    res.end()
  })

  const head = await tunnel.send({ method: 'HEAD', path: '/v1/models' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], '1234', 'the announced length survives')
  assert.equal(head.body, '', 'and no body is invented')

  // The connection is still usable, which is the half a stalled HEAD would break.
  const notModified = await tunnel.send({ path: '/v1/models' })
  tunnel.close()
  assert.equal(notModified.status, 304)
  assert.equal(notModified.body, '')
})

// ── ADR-0005, the awkward cases ────────────────────────────────────────────

/**
 * A push refused while the packfile is still uploading.
 *
 * The existing push test posts an empty body, so it never exercises the case that actually
 * happens: git has megabytes in flight when the refusal is written. A proxy that answers
 * without draining, or that waits for the whole body before deciding, either resets the
 * connection before the client can read the status or holds the upload to completion first.
 */
test('a push is refused while its packfile is still being uploaded', async () => {
  const harness = await startHarness({
    hostname: 'github.com',
    credentials: { github: { provider: 'github', token: 'ghp_REAL' } },
  })
  harnesses.push(harness)
  const session = harness.gateway.open()

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'github.com',
    method: 'POST',
    path: '/owner/repo.git/git-receive-pack',
    // Not megabytes — enough that the body is still arriving when the refusal is written.
    body: 'x'.repeat(512 * 1024),
  })

  assert.equal(response.status, 403)
  assert.match(response.body ?? '', /push_refused/)
  assert.equal(harness.upstream.received.length, 0)
})

/**
 * GitHub percent-decodes a path before routing, so `/git-receive-pac%6b` is a push. A
 * matcher that compares the raw bytes says it is not — a one-`curl` walk around ADR-0005,
 * live in exactly the configuration the rule exists for.
 */
test('a percent-encoded push is still a push', async () => {
  const harness = await startHarness({
    hostname: 'github.com',
    credentials: { github: { provider: 'github', token: 'ghp_REAL' } },
  })
  harnesses.push(harness)
  const session = harness.gateway.open()

  // Each in the method git actually uses for it: the pack goes by POST, the discovery
  // that precedes it by GET.
  for (const [method, path] of [
    ['POST', '/owner/repo.git/git-receive-pac%6b'],
    ['POST', '/owner/repo.git/GIT-RECEIVE-PACK'],
    ['POST', '/owner/repo.git/git-receive-pac%256b'],
    ['GET', '/owner/repo.git/info/refs?service=git-receive-pac%6b'],
  ] as const) {
    const response = await requestThroughProxy(harness, {
      token: session.token,
      hostname: 'github.com',
      method,
      path,
    })
    assert.equal(response.status, 403, `${method} ${path}`)
  }
  assert.equal(harness.upstream.received.length, 0)

  // And a fetch is still a fetch, encoded or not — the decoding must not turn the rule
  // into "refuse anything that mentions git".
  const fetch = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'github.com',
    path: '/owner/repo.git/info/refs?service=git-upload-pac%6b',
  })
  assert.equal(fetch.status, 200)
})

/**
 * A container that dies mid-request must not take the runner with it.
 *
 * `pipeline()` does not report a destroyed destination through its callback — it *throws*
 * `ERR_STREAM_UNABLE_TO_PIPE` synchronously. Thrown from inside a `'response'` handler
 * that is an uncaught exception, and the runner process ends: not this job, every job on
 * the machine. The window is small and entirely ordinary — a job budget expiring, a
 * `docker kill`, an agent that exits while a turn is in flight — and it is reached by the
 * upstream answering *after* the client has gone.
 *
 * Found by killing a container mid-run rather than by reading the code, which is why the
 * test drives the same order: hang up first, answer second. A gateway without the guard
 * does not fail this test with an assertion — it dies with the test runner still holding
 * the results.
 */
test('an upstream answering after the client hung up does not crash the gateway', async () => {
  const harness = await anthropic()
  const session = harness.gateway.open()

  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  harness.upstream.respond((_req, res) => {
    void held.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"late":true}')
    })
  })

  const socket = rawTunnel(harness, session.token, () => undefined)
  await new Promise<void>((resolve) => {
    socket.once('data', () => {
      const tls = secureTunnel(harness, socket)
      const req = request({
        createConnection: () => tls,
        host: 'api.anthropic.com',
        path: '/v1/messages',
        headers: { host: 'api.anthropic.com' },
      })
      req.on('error', () => undefined)
      // The request is on the wire and the upstream is holding it; now the container dies.
      req.end(() => {
        tls.destroy()
        socket.destroy()
        resolve()
      })
    })
  })

  await waitFor(() => harness.upstream.received.length > 0, 'the upstream never saw the request')
  // Only now does the upstream answer, into a response object that is already gone.
  release()

  // The proof is that the gateway is still here to serve the next job. A process that
  // threw in the handler above never reaches this line.
  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const after = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
  })
  assert.equal(after.status, 200)
})
