import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  credentialExpiry,
  credentialHealth,
  credentialOutlook,
  credentialStatuses,
  humanDuration,
} from '../src/credentials.ts'
import type { CredentialSet } from '../src/credentials.ts'

/**
 * What "this credential is fine" is allowed to mean.
 *
 * The gateway never refreshes; it re-reads the files the host's own CLIs rewrite when a
 * human uses them, and on an unattended runner nobody does. So the whole failure mode is
 * a token that is *present* and dead, being spliced onto every request, producing a
 * provider 401 inside a 3am transcript that names the wrong cause. Everything below
 * exists to keep the five distinguishable answers distinguishable (principle 6): absent,
 * an API key that cannot expire, an expiry nobody recorded, alive, and dead.
 */

const now = Date.UTC(2026, 7, 20, 3, 0, 0)
const oauth = (expiresAt?: number): CredentialSet => ({
  anthropic: {
    provider: 'anthropic',
    mode: 'oauth',
    accessToken: 'sk-ant-oat01-x',
    ...(expiresAt === undefined ? {} : { expiresAt }),
  },
})

// ── the five answers ───────────────────────────────────────────────────────

test('an API key is not "has not expired yet" — it is "does not expire"', () => {
  /**
   * The naive version stores a boolean, or an `expiresAt` of `Infinity`. Both make an API
   * key indistinguishable from a subscription token that happens to be healthy right now,
   * and the difference is the entire recommendation for an unattended runner: one of them
   * needs a human to run `claude` before tomorrow night and the other never does.
   */
  const expiry = credentialExpiry({ provider: 'anthropic', mode: 'api-key', apiKey: 'sk-ant-api03-x' })
  assert.deepEqual(expiry, { kind: 'never' })
  assert.deepEqual(credentialHealth(expiry, { now, horizonMs: 864e5 }), { state: 'no-expiry' })
})

test('a missing credential is its own answer, not an expired one', () => {
  assert.deepEqual(credentialExpiry(undefined), { kind: 'absent' })
  assert.deepEqual(credentialHealth({ kind: 'absent' }, { now }), { state: 'absent' })
})

test('an oauth token whose file records no expiry is unknown, never expired', () => {
  /**
   * `claudeAiOauth` carries `expiresAt` today. If it stops, the honest answer is "this
   * was not recorded" — and it must not be spelled `expired`, because downstream that is
   * an admission refusal and every job on the machine would be refused indefinitely with
   * a reason that reads as certain.
   */
  assert.deepEqual(credentialExpiry(oauth().anthropic), { kind: 'unrecorded' })
  assert.deepEqual(credentialHealth({ kind: 'unrecorded' }, { now }), { state: 'unknown-expiry' })
})

test('a healthy token is valid, and carries how long it has', () => {
  const health = credentialHealth(credentialExpiry(oauth(now + 6 * 36e5).anthropic), {
    now,
    horizonMs: 30 * 60_000,
  })
  assert.equal(health.state, 'valid')
  assert.equal(health.state === 'valid' && health.msRemaining, 6 * 36e5)
})

test('a lapsed token is expired, and carries how long ago', () => {
  const health = credentialHealth(credentialExpiry(oauth(now - 6 * 36e5).anthropic), { now })
  assert.equal(health.state, 'expired')
  assert.equal(health.state === 'expired' && health.msElapsed, 6 * 36e5)
})

// ── the boundaries ─────────────────────────────────────────────────────────

test('a token inside the horizon is expiring, which is not the same as valid', () => {
  /**
   * The property this protects: "is it valid right now" is the wrong question when the
   * caller is about to start a job that runs for half an hour. A token with five minutes
   * left passes that test and then dies mid-stream — the same 401, the same wasted night,
   * arriving slightly later and looking even less like a credential problem.
   */
  const expiry = credentialExpiry(oauth(now + 5 * 60_000).anthropic)
  assert.equal(credentialHealth(expiry, { now, horizonMs: 30 * 60_000 }).state, 'expiring')
  // Same token, same clock, a caller with nothing to protect: alive is alive.
  assert.equal(credentialHealth(expiry, { now, horizonMs: 0 }).state, 'valid')
})

test('a token expiring exactly now is expired, not expiring', () => {
  // The next request it is spliced into fails, so there is no window left to warn about.
  assert.equal(credentialHealth({ kind: 'at', expiresAt: now }, { now, horizonMs: 60_000 }).state, 'expired')
  // And one millisecond of life is still life — but only inside the horizon.
  const alive = credentialHealth({ kind: 'at', expiresAt: now + 1 }, { now, horizonMs: 60_000 })
  assert.equal(alive.state, 'expiring')
})

test('a token expiring exactly at the horizon is expiring, not valid', () => {
  const at = credentialHealth({ kind: 'at', expiresAt: now + 60_000 }, { now, horizonMs: 60_000 })
  assert.equal(at.state, 'expiring')
  const past = credentialHealth({ kind: 'at', expiresAt: now + 60_001 }, { now, horizonMs: 60_000 })
  assert.equal(past.state, 'valid')
})

test('an expiresAt that is not epoch-milliseconds is unreadable, not ancient', () => {
  /**
   * The trap: `expiresAt` is milliseconds today, seconds is the more common convention,
   * and third-party credential formats change without announcing it. A seconds value
   * subtracted from `Date.now()` says the token expired fifty-four years ago — which as a
   * doctor line is merely wrong, and as an admission refusal stops the entire factory
   * with a reason nobody would think to doubt. "I cannot read this" is a third answer.
   */
  assert.deepEqual(credentialExpiry(oauth(Math.floor(now / 1000)).anthropic), { kind: 'unrecorded' })
})

// ── what codex can and cannot be asked ─────────────────────────────────────

test('a chatgpt oauth token reports an unknown expiry rather than a guessed one', () => {
  /**
   * `~/.codex/auth.json` records no expiry in the fields the gateway reads, and the
   * access token's JWT payload is deliberately not parsed. What matters here is that the
   * absence is *said*: a codex line that looked like every healthy line would be a
   * silent claim that something checked.
   */
  const set: CredentialSet = {
    openai: { provider: 'openai', mode: 'oauth', accessToken: 'oa-x', accountId: 'acct-1' },
  }
  assert.deepEqual(credentialOutlook(set).openai, { kind: 'unrecorded' })
  const status = credentialStatuses(set, now)[1]!
  assert.equal(status.health.state, 'unknown-expiry')
  assert.match(status.detail, /no expiry/)
})

// ── what doctor prints ─────────────────────────────────────────────────────

test('doctor says minutes when minutes are what is left', () => {
  /**
   * The original rounded to whole hours, so the one window this preflight exists for was
   * the one window the string could not express: "42 minutes left" printed as "1h left"
   * and "expired eleven minutes ago" printed as "EXPIRED 0h ago" — a line that reads as
   * healthy for a token that is not.
   */
  assert.equal(humanDuration(42 * 60_000), '42m')
  assert.equal(humanDuration(11 * 60_000), '11m')
  assert.equal(humanDuration(6 * 36e5), '6h')
  assert.equal(humanDuration(3 * 864e5), '3d')

  const soon = credentialStatuses(oauth(now + 42 * 60_000), now)[0]!
  assert.equal(soon.health.state, 'expiring')
  assert.match(soon.detail, /42m left/)
})

test('every unhealthy line names a fix, including the one for a machine nobody logs into', () => {
  /**
   * A check that only names the problem gets ignored, and there are two fixes here for
   * two different machines: `claude` on a workstation, and an API key on a runner where
   * an OAuth token will simply lapse again tomorrow night.
   */
  for (const set of [oauth(now - 6 * 36e5), oauth(now + 10 * 60_000), {} as CredentialSet]) {
    const detail = credentialStatuses(set, now)[0]!.detail
    assert.match(detail, /run `claude` on this host/)
    assert.match(detail, /ANTHROPIC_API_KEY/)
  }
})

test('an API key line promises nothing about a clock', () => {
  const status = credentialStatuses(
    { anthropic: { provider: 'anthropic', mode: 'api-key', apiKey: 'sk-ant-api03-x' } },
    now,
  )[0]!
  assert.equal(status.health.state, 'no-expiry')
  assert.match(status.detail, /does not expire/)
})
