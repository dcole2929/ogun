import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import {
  connectionForHost,
  connectionInjections,
  connectionRequestRefusal,
  NO_CONNECTIONS,
  type ConnectionCredentials,
  type SessionConnections,
} from '../src/connections.ts'
import { DEFAULT_ALLOWED_HOSTS } from '../src/hosts.ts'
import { connectionStub, sandboxConnectionEnv, PLACEHOLDER } from '../src/stubs.ts'
import {
  openRawTunnel,
  proxySocket,
  requestThroughProxy,
  speakUpgrade,
  startHarness,
  type Harness,
} from './harness.ts'

/**
 * A connected application reached from inside a sandbox (§4.13).
 *
 * The property under test is not "Linear works". It is the narrower and much more
 * dangerous one: **a job that was not granted a connection cannot reach one**, on any
 * door, and a job that was granted one never holds the credential it spends.
 *
 * The naive implementation of this feature is one line — `api.linear.app` appended to
 * `DEFAULT_ALLOWED_HOSTS` — and every "does Linear work" test passes against it. What it
 * gets wrong is invisible from those tests and is the whole point: it hands the project's
 * issue tracker to `adversarial-review`, a worker pointed at untrusted repository content
 * on purpose, whose threat model is that the content is trying to make it do something.
 * So most of what follows asserts refusals.
 */

const LINEAR = 'api.linear.app'
const REAL_TOKEN = 'lin_oauth_11111111-2222-3333-4444-555555555555'

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await harness.cleanup()
})

/**
 * A gateway whose *standing* allowlist is empty.
 *
 * Deliberately empty rather than `[LINEAR]`: a test that put the host on the gateway's own
 * list would pass against exactly the implementation this feature exists to avoid, and
 * would keep passing after somebody deleted the per-session grant.
 */
async function linearHarness(): Promise<Harness> {
  const harness = await startHarness({ hostname: LINEAR, credentials: {}, allowedHosts: [] })
  harnesses.push(harness)
  return harness
}

const grant = (credentials: ConnectionCredentials): SessionConnections => ({
  granted: ['linear'],
  read: () => credentials,
})

const live = (accessToken = REAL_TOKEN): SessionConnections =>
  grant({ linear: { app: 'linear', accessToken, scopes: ['read'] } })

// ── the default, which is the feature ──────────────────────────────────────

/**
 * The one-line implementation, refused.
 *
 * If this ever fails, every worker on the machine — reviewers included — has a
 * credentialed path to whatever workspace the runner's config.json holds a grant for.
 */
test('no connected application is on the standing allowlist', () => {
  assert.equal(DEFAULT_ALLOWED_HOSTS.includes(LINEAR), false)
  for (const host of DEFAULT_ALLOWED_HOSTS) {
    assert.equal(connectionForHost(host), undefined, `${host} must not be a connection host`)
  }
})

test('a session that was granted nothing cannot open a tunnel to a connection host', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open()
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  // Refused at the CONNECT, before TLS: the host is not on this session's allowlist at all.
  assert.equal(response.connect, 403)
  assert.equal(harness.upstream.received.length, 0)
})

/**
 * The same refusal on the door that has no tunnel in front of it.
 *
 * This gateway has twice shipped a second entrance that skipped the first one's checks, so
 * every rule gets asserted per door rather than once against whichever door is convenient.
 */
test('the absolute-form door refuses a connection host to an ungranted session', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open()
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, `https://${LINEAR}/graphql`, {
    host: LINEAR,
    proxyToken: session.token,
  })
  assert.equal(result.status, 403)
  assert.match(result.body, /not on the sandbox egress allowlist/)
  socket.destroy()
})

// ── the grant ──────────────────────────────────────────────────────────────

/**
 * The whole path, end to end: the container sends a placeholder and the upstream receives
 * the real token, having never been in the same process as it.
 */
test('a granted session reaches linear, and the container never held the token', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
    headers: { authorization: PLACEHOLDER, 'content-type': 'application/json' },
    body: '{"query":"{ viewer { id } }"}',
  })

  assert.equal(response.connect, 200)
  assert.equal(response.status, 200)
  const received = harness.upstream.received.at(-1)
  assert.equal(received?.headers.authorization, `Bearer ${REAL_TOKEN}`)
  assert.equal(received?.body, '{"query":"{ viewer { id } }"}')
})

/**
 * `Bearer`, and this is the assertion that cannot be checked without a live workspace.
 *
 * Linear takes a personal API key **raw** in `Authorization` and an OAuth token **with**
 * `Bearer`. Both spellings produce a well-formed request, and getting it backwards comes
 * back as the same `AUTHENTICATION_ERROR` a revoked credential does — so it is pinned as a
 * literal here, beside the same claim in `authorizationHeader` on the host side.
 */
test('an oauth access token is sent with the Bearer prefix, raw is not', () => {
  const injections = connectionInjections('linear', {
    linear: { app: 'linear', accessToken: REAL_TOKEN, scopes: ['read'] },
  })
  assert.deepEqual(injections, [
    { kind: 'set', name: 'authorization', value: `Bearer ${REAL_TOKEN}` },
    { kind: 'remove', name: 'x-api-key' },
  ])
})

/**
 * A container that copied its own model-API call as a template sends `x-api-key` too.
 * Two authorization-ish headers are resolved by *Linear's* precedence rule rather than
 * ours, and whichever way that falls the reason for the failure is invisible from both
 * ends — the same argument `planInjections` makes for the model providers.
 */
test('a competing x-api-key is removed rather than left beside the real token', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
    headers: { authorization: PLACEHOLDER, 'x-api-key': PLACEHOLDER },
  })
  assert.equal(harness.upstream.received.at(-1)?.headers['x-api-key'], undefined)
})

/**
 * A grant is per session, and two sessions on one gateway do not share it.
 *
 * The regression this catches never fails a test that looks at one job: a connection held
 * anywhere but the session widens every worker on the machine to the union of all of them,
 * and the symptom is that nothing is refused.
 */
test('a second session on the same gateway inherits no part of the first grant', async () => {
  const harness = await linearHarness()
  const granted = harness.gateway.open(undefined, undefined, live())
  const ungranted = harness.gateway.open()

  const allowed = await requestThroughProxy(harness, {
    token: granted.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  const refused = await requestThroughProxy(harness, {
    token: ungranted.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(allowed.connect, 200)
  assert.equal(refused.connect, 403)
})

// ── the grant is checked again inside the tunnel ───────────────────────────

/**
 * The belt-and-braces check, and it is not decoration.
 *
 * `open()` composes the allowlist from the grant, so in the ordinary case a request that
 * reaches a connection host has a grant behind it. This asserts what happens when it does
 * not — a caller that hand-composed an allowlist, a fourth door, a future `egress:` entry
 * that slipped past config validation. The answer must be a refusal naming the missing
 * grant, not a credentialed request.
 */
test('an allowlist entry with no grant behind it is still refused, inside the tunnel', async () => {
  const harness = await linearHarness()
  // The host, by hand, with `connections` left at its default of nothing.
  const session = harness.gateway.open(undefined, [LINEAR])
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(response.connect, 200)
  assert.equal(response.status, 403)
  assert.match(response.body ?? '', /connection_not_granted/)
  assert.equal(harness.upstream.received.length, 0)
})

// ── the request shape ──────────────────────────────────────────────────────

/**
 * `/oauth/revoke` is the reason this check exists, and it is a *destructive* capability
 * rather than a disclosure one: the gateway would have attached a working credential to
 * it, and reconnecting afterwards needs a workspace admin.
 */
test('a granted session cannot reach the oauth endpoints on the same host', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())

  for (const path of ['/oauth/revoke', '/oauth/token', '/oauth/authorize']) {
    const response = await requestThroughProxy(harness, {
      token: session.token,
      hostname: LINEAR,
      method: 'POST',
      path,
    })
    assert.equal(response.status, 403, `${path} must be refused`)
    assert.match(response.body ?? '', /connection_path_refused/)
  }
  assert.equal(harness.upstream.received.length, 0)
})

test('only POST reaches /graphql', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'GET',
    path: '/graphql',
  })
  assert.equal(response.status, 403)
  assert.equal(harness.upstream.received.length, 0)
})

/**
 * The percent-encoding trick, in the direction it bites here.
 *
 * `isGitPushRequest` decodes so a disguised path still matches a *refusal*; this decodes so
 * a disguised path still matches the one *permitted* path. A matcher that compared raw
 * bytes would answer 403 for a request the origin server would have routed to `/graphql` —
 * a refusal with no explanation an agent could act on.
 */
test('a percent-encoded /graphql is the same path, and a disguised /oauth is not', () => {
  assert.equal(connectionRequestRefusal('linear', 'POST', '/graph%71l'), undefined)
  assert.equal(connectionRequestRefusal('linear', 'POST', '/graphql?trace=1'), undefined)
  assert.notEqual(connectionRequestRefusal('linear', 'POST', '/oauth%2Frevoke'), undefined)
  assert.notEqual(connectionRequestRefusal('linear', 'POST', '/graphql/../oauth/revoke'), undefined)
})

/** The upgrade door runs `prepare()` too, so it refuses on the same rule. */
test('an upgrade inside a tunnel to a connection host is refused', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  const tunnel = await openRawTunnel(harness, { token: session.token, hostname: LINEAR })
  const result = await speakUpgrade(tunnel, '/graphql', { host: LINEAR })
  // A websocket handshake is a GET, so the request-shape rule catches it — which is the
  // right answer: Linear's API is a POST endpoint and a socket to it is not a connection.
  assert.equal(result.status, 403)
  assert.equal(harness.upstream.upgraded.length, 0)
  tunnel.destroy()
})

// ── the port ───────────────────────────────────────────────────────────────

/**
 * The allowlist matches on hostname alone, so a granted connection host on port 22 is an
 * allowlisted name pointing at somebody else's SSH server — which the gateway would
 * otherwise intercept and credential.
 */
test('a granted connection host is still only reachable on 443', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    port: 22,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(response.connect, 403)
})

// ── revocation ─────────────────────────────────────────────────────────────

/**
 * `revoke()` has to reach a connection exactly as it reaches a model provider. The failure
 * it guards against is a container that outlived its `docker run` — an injected agent can
 * hold a socket open on purpose — going on reading a workspace after the job that was
 * allowed to ended.
 */
test('a revoked session stops reaching a connection it held a tunnel to', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  const first = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(first.status, 200)

  session.revoke()

  const after = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(after.connect, 407)
})

// ── the credential is read per request ─────────────────────────────────────

/**
 * A renewal performed by the control plane has to reach a job that is already running.
 *
 * An access token lasts 24 hours and is renewed on demand before a poll (ADR-0014); a
 * session that captured one at `provision()` would present a dead token at minute twenty
 * of a thirty-minute job and 401 for a credential that was renewed at minute three.
 */
test('the credential is read per request, so a renewal reaches a job in flight', async () => {
  const harness = await linearHarness()
  let token = 'lin_oauth_first'
  const session = harness.gateway.open(undefined, undefined, {
    granted: ['linear'],
    read: () => ({ linear: { app: 'linear', accessToken: token, scopes: ['read'] } }),
  })

  await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(harness.upstream.received.at(-1)?.headers.authorization, 'Bearer lin_oauth_first')

  token = 'lin_oauth_renewed'
  await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(harness.upstream.received.at(-1)?.headers.authorization, 'Bearer lin_oauth_renewed')
})

/**
 * Granted, and the host holds nothing.
 *
 * Answered by the gateway rather than forwarded, for the reason `no_credential` is: a
 * placeholder sent to Linear comes back as `AUTHENTICATION_ERROR`, which reads as "your
 * connection is revoked" and sends an operator to reconnect an application that may never
 * have been the problem — the runner may simply not be the machine holding the store.
 */
test('a grant with no credential behind it is answered here, not by linear', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, grant({}))
  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: LINEAR,
    method: 'POST',
    path: '/graphql',
  })
  assert.equal(response.status, 502)
  assert.match(response.body ?? '', /no_connection_credential/)
  assert.equal(harness.upstream.received.length, 0)
})

// ── nothing leaks in a refusal ─────────────────────────────────────────────

/**
 * This repository has had five credentials in error messages. Every refusal on this path
 * is checked against the real token, not against a regex for what a token looks like.
 */
test('no refusal on the connection path contains any part of the credential', async () => {
  const harness = await linearHarness()
  const session = harness.gateway.open(undefined, undefined, live())
  const bodies: string[] = []

  for (const [method, path] of [
    ['POST', '/oauth/revoke'],
    ['GET', '/graphql'],
  ] as const) {
    const response = await requestThroughProxy(harness, {
      token: session.token,
      hostname: LINEAR,
      method,
      path,
    })
    bodies.push(response.body ?? '')
  }
  const ungranted = harness.gateway.open(undefined, [LINEAR])
  bodies.push(
    (
      await requestThroughProxy(harness, {
        token: ungranted.token,
        hostname: LINEAR,
        method: 'POST',
        path: '/graphql',
      })
    ).body ?? '',
  )

  for (const body of bodies) {
    assert.equal(body.includes(REAL_TOKEN), false)
    // Not just the whole token: a prefix long enough to identify it is a leak too.
    assert.equal(body.includes(REAL_TOKEN.slice(0, 16)), false)
  }
})

// ── what the container is told ─────────────────────────────────────────────

/**
 * Whatever a sandbox is handed has to be worthless if it is exfiltrated, which is the one
 * property that makes it safe to write into a container at all.
 */
test('the connection stub carries no credential, only a placeholder', () => {
  const stub = JSON.parse(connectionStub('linear')) as Record<string, unknown>
  assert.equal(stub.authorization, PLACEHOLDER)
  assert.equal(stub.endpoint, 'https://api.linear.app/graphql')
  assert.equal(stub.method, 'POST')
  // The sentence an agent reads. Without it, a CLI or an agent that inspects its own
  // credential concludes it is unauthenticated and spends a turn looking for the real one.
  assert.match(String(stub.note), /placeholder/i)
})

/**
 * `OGUN_CONNECTIONS=` and no `OGUN_CONNECTIONS` are the same to a shell test and different
 * to anything that splits on commas. "Granted nothing" must never read as "granted
 * something I could not name".
 */
test('a sandbox granted nothing gets no connection environment at all', () => {
  assert.deepEqual(sandboxConnectionEnv([]), {})
  const env = sandboxConnectionEnv(['linear'])
  assert.equal(env.OGUN_CONNECTIONS, 'linear')
  assert.equal(env.LINEAR_API_KEY, PLACEHOLDER)
})

// ── the vocabulary ─────────────────────────────────────────────────────────

test('a default session is granted nothing and reads nothing', () => {
  assert.deepEqual(NO_CONNECTIONS.granted, [])
  assert.deepEqual(NO_CONNECTIONS.read(), {})
})

/**
 * Exact names, never a wildcard. The table decides where a real workspace credential is
 * allowed to go, and `*.linear.app` would hand it to every subdomain Linear ever adds.
 */
test('a connection host is matched exactly, and a lookalike is not a connection', () => {
  assert.equal(connectionForHost('api.linear.app'), 'linear')
  assert.equal(connectionForHost('API.Linear.app'), 'linear')
  assert.equal(connectionForHost('api.linear.app.'), 'linear')
  assert.equal(connectionForHost('linear.app'), undefined)
  assert.equal(connectionForHost('evil-api.linear.app'), undefined)
  assert.equal(connectionForHost('api.linear.app.evil.com'), undefined)
})
