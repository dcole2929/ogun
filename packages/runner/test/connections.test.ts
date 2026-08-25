import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sealSecret, type OAuthGrant, type ProjectSecret } from '@ogun/core'
import { connectionReader, linearConnection } from '../src/sandbox/connections.ts'

/**
 * Turning what the host stores into what the gateway may put on a wire.
 *
 * The naive implementation is `if (secret.state === 'present') return secret.secret.expose()`
 * — one line, and it works. What it gets wrong is the whole of this file:
 *
 *  - it hands a sandbox a **personal API key**, which is everything its owner can do in
 *    that workspace forever, and which Linear attributes every write to by name;
 *  - it collapses six distinct reasons for "no credential" into one, so an operator whose
 *    control plane runs on another machine is told to reconnect an application;
 *  - it captures the token once, so a renewal never reaches a job that is already running.
 */

const grant = (over: Partial<OAuthGrant> = {}): OAuthGrant => ({
  clientId: 'client-abc',
  access: sealSecret('lin_oauth_real_token'),
  refresh: sealSecret('lin_refresh_real'),
  expiresAt: Date.UTC(2030, 0, 1),
  obtainedAt: Date.UTC(2029, 11, 31),
  scopes: ['read'],
  actor: 'app',
  ...over,
})

const NOW = Date.UTC(2029, 11, 31, 12)

// ── the personal key is refused, and that is a decision ────────────────────

/**
 * A personal API key is a perfectly good credential *for the host* — it is what §4.13's
 * poll authenticates with when a project has not connected an application — and it is not
 * one for a sandbox. The asymmetry is the point, so it is asserted rather than left to the
 * comment: a `present` secret must never produce an injectable credential.
 */
test('a personal api key is never injectable into a sandbox', () => {
  const lookup = linearConnection({ state: 'present', secret: sealSecret('lin_api_personal') }, NOW)
  assert.equal(lookup.ok, false)
  assert.equal(lookup.ok === false && lookup.reason.includes('lin_api_personal'), false)
  // The refusal names the fix, because "not supported" sends nobody anywhere.
  assert.match(lookup.ok === false ? lookup.reason : '', /connect an application/i)
})

test('an oauth grant is injectable, and carries the Bearer-shaped token', () => {
  const lookup = linearConnection({ state: 'granted', grant: grant(), apiKeyIgnored: false }, NOW)
  assert.equal(lookup.ok, true)
  assert.deepEqual(lookup.ok && lookup.credential, {
    app: 'linear',
    accessToken: 'lin_oauth_real_token',
    scopes: ['read'],
  })
})

/**
 * An expired token is refused rather than injected.
 *
 * Injecting one produces a `401 AUTHENTICATION_ERROR` from Linear, which reads as "this
 * connection was revoked" — so an operator reconnects an application that is fine while the
 * actual cause is that nothing has polled since the token lapsed.
 */
test('an expired access token is refused, and says what renews it', () => {
  const lookup = linearConnection(
    { state: 'granted', grant: grant({ expiresAt: NOW - 1 }), apiKeyIgnored: false },
    NOW,
  )
  assert.equal(lookup.ok, false)
  assert.match(lookup.ok === false ? lookup.reason : '', /expired/)
})

/**
 * `expiring` is *not* refused. The token is valid right now, the control plane renews on
 * demand before its next poll, and the reader re-reads often enough to pick the new one up
 * mid-job. Refusing on a horizon here would refuse work for a credential about to be fine.
 */
test('a token with minutes left is still used', () => {
  const lookup = linearConnection(
    { state: 'granted', grant: grant({ expiresAt: NOW + 60_000 }), apiKeyIgnored: false },
    NOW,
  )
  assert.equal(lookup.ok, true)
})

/**
 * Six reasons, six sentences.
 *
 * `readProjectSecret` grew seven states precisely so these would not collapse into "no
 * linear key" (principle 6), and a lookup that flattened them would throw that away at the
 * last step. Each of these sends an operator somewhere different.
 */
test('every refusal reason is distinct, because every remedy is', () => {
  const states: ProjectSecret[] = [
    { state: 'present', secret: sealSecret('k') },
    { state: 'unconnected', clientId: 'client-abc' },
    { state: 'absent' },
    { state: 'empty' },
    { state: 'malformed', reason: 'grant is not an object' },
    { state: 'unreadable', reason: 'unexpected token }' },
  ]
  const reasons = states.map((s) => {
    const lookup = linearConnection(s, NOW)
    assert.equal(lookup.ok, false)
    return lookup.ok === false ? lookup.reason : ''
  })
  assert.equal(new Set(reasons).size, reasons.length)
  // `absent` names the thing that surprises people: the store is on the control plane's
  // machine, and a runner on a different box has nothing to read.
  assert.match(reasons[2] ?? '', /machine/)
})

// ── the reader ─────────────────────────────────────────────────────────────

const granted: ProjectSecret = { state: 'granted', grant: grant(), apiKeyIgnored: false }

/**
 * The first read is awaited in `provision()`.
 *
 * Without it, the agent's first Linear call — which a skill makes immediately — races a
 * cold cache and collects a 502 for a credential that was on disk all along. That is a
 * flake that hides on a laptop and appears under load, which is the worst shape of bug this
 * repository keeps finding.
 */
test('the first credential is there before the reader is handed over', async () => {
  const reader = await connectionReader('ogun', ['linear'], { read: async () => granted })
  assert.equal(reader.read().linear?.accessToken, 'lin_oauth_real_token')
})

test('a session granted nothing reads nothing, and never opens the store', async () => {
  let reads = 0
  const reader = await connectionReader('ogun', [], {
    read: async () => {
      reads++
      return granted
    },
  })
  assert.deepEqual(reader.read(), {})
  assert.equal(reads, 0)
})

/**
 * Inside the TTL the store is not re-read, and past it the value refreshes.
 *
 * The memo exists because `read()` is on a per-request path and `readProjectSecret` parses
 * a whole config file with zod; five seconds exists because a window longer than a retry
 * backoff defeats the point of re-reading at all.
 */
test('the store is re-read past the ttl, so a renewal reaches a running job', async () => {
  let now = 1_000_000
  let token = 'first'
  const reader = await connectionReader('ogun', ['linear'], {
    ttlMs: 5_000,
    now: () => now,
    read: async () => ({
      state: 'granted',
      grant: grant({ access: sealSecret(token) }),
      apiKeyIgnored: false,
    }),
  })

  assert.equal(reader.read().linear?.accessToken, 'first')
  token = 'renewed'

  // Inside the window: the old value, and no read.
  now += 1_000
  assert.equal(reader.read().linear?.accessToken, 'first')

  // Past it: the read is started, and the *next* caller sees the new value. The refresh is
  // deliberately not awaited — `read()` is called from a request handler on the gateway's
  // event loop, and blocking it on a file read is a cost with no matching benefit.
  now += 5_000
  reader.read()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reader.read().linear?.accessToken, 'renewed')
})

/**
 * A control plane rewriting `config.json` writes into a fresh file and renames it, so a
 * read that lands mid-rename sees nothing at all. Dropping the credential on that would
 * turn an ordinary renewal into a job that lost its connection, reported as "linear is
 * unreachable" — which is exactly the misnaming this whole path is careful about.
 */
test('a transient absent read keeps the last good credential rather than dropping it', async () => {
  let now = 1_000_000
  let answer: ProjectSecret = granted
  const reasons: string[] = []
  const reader = await connectionReader('ogun', ['linear'], {
    ttlMs: 5_000,
    now: () => now,
    read: async () => answer,
    onUnavailable: (_app, reason) => reasons.push(reason),
  })

  answer = { state: 'absent' }
  now += 6_000
  reader.read()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reader.read().linear?.accessToken, 'lin_oauth_real_token')
  assert.equal(reasons.length, 1)
})

/**
 * ...but an *expired* grant is not transient, and holding the last good token would mean
 * the gateway spends the rest of the job collecting 401s from Linear for a credential it
 * already knows is dead.
 */
test('an expired grant drops the credential it replaced', async () => {
  let now = 1_000_000
  let answer: ProjectSecret = granted
  const reader = await connectionReader('ogun', ['linear'], {
    ttlMs: 5_000,
    now: () => now,
    read: async () => answer,
    onUnavailable: () => undefined,
  })

  answer = { state: 'granted', grant: grant({ expiresAt: now }), apiKeyIgnored: false }
  now += 6_000
  reader.read()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reader.read().linear, undefined)
})

/**
 * A five-second TTL over a thirty-minute job is 360 reads. An unconnected project would
 * print 360 identical lines into the runner's log, and a log nobody reads reports nothing.
 */
test('a repeated failure is reported once, not once per read', async () => {
  let now = 1_000_000
  const reasons: string[] = []
  const reader = await connectionReader('ogun', ['linear'], {
    ttlMs: 5_000,
    now: () => now,
    read: async () => ({ state: 'absent' }),
    onUnavailable: (_app, reason) => reasons.push(reason),
  })

  for (let i = 0; i < 5; i++) {
    now += 6_000
    reader.read()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(reasons.length, 1)
})

/**
 * A rejected refresh must not become an unhandled rejection: this runs on the runner's
 * event loop, and an unhandled rejection out of the credential path takes the process down
 * — and every other job on the machine with it.
 */
test('a store that throws does not take the runner down', async () => {
  let now = 1_000_000
  let fail = false
  const reader = await connectionReader('ogun', ['linear'], {
    ttlMs: 5_000,
    now: () => now,
    read: async () => {
      if (fail) throw new Error('EACCES')
      return granted
    },
    onUnavailable: () => undefined,
  })

  fail = true
  now += 6_000
  reader.read()
  await new Promise((resolve) => setImmediate(resolve))
  // The last good value survives, and nothing threw.
  assert.equal(reader.read().linear?.accessToken, 'lin_oauth_real_token')
})
