import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { credentialHealth, humanDuration, wouldFailAuth } from '../src/credentials.ts'
import { claimRequestSchema, credentialOutlookSchema } from '../src/api.ts'

/**
 * The credential vocabulary, now that three processes share it.
 *
 * The runner classifies what is on its own disk and reports it, the control plane judges
 * that report before dispatching a job, and the CLI prints it in `doctor`. While all of
 * that lived in `@ogun/gateway` it could only be read by processes that start a gateway,
 * so the control plane read the *host's* files instead and called the answer the runner's
 * — right on one box, and already wrong there for an `ANTHROPIC_API_KEY` exported into the
 * runner's unit and not the server's.
 *
 * The behaviour of `credentialHealth` itself is exercised in `packages/gateway/test/
 * expiry.test.ts` against real credential shapes. What is asserted here is what the move
 * added: the classification of a health into "this would fail" or not, and the wire schema
 * that carries the fact between the machines.
 */

const now = Date.UTC(2026, 7, 20, 3, 0, 0)

test('only a checked failure counts as a failure — "could not tell" never does', () => {
  /**
   * The property: `wouldFailAuth` is true for exactly the three states that mean somebody
   * looked and found a problem, and false for the three that include not knowing.
   *
   * The naive implementation is `health.state !== 'valid'`, written inline at whichever
   * call site needs it first. That turns every codex job into a refusal — `~/.codex/
   * auth.json` records no expiry in the fields the gateway reads, so its health is
   * permanently `unknown-expiry` — and it turns the API key that the docs recommend for an
   * unattended runner into a refusal too, since `no-expiry` is not `valid` either. Both
   * are working machines. The whole point of a six-state health rather than a boolean is
   * that "I checked and it is dead" and "I could not check" are different facts
   * (principle 6), and a caller writing its own condition loses that on the first line.
   */
  assert.equal(wouldFailAuth({ state: 'absent' }), true)
  assert.equal(wouldFailAuth({ state: 'expired', expiresAt: now, msElapsed: 1 }), true)
  assert.equal(wouldFailAuth({ state: 'expiring', expiresAt: now, msRemaining: 1 }), true)

  assert.equal(wouldFailAuth({ state: 'no-expiry' }), false, 'an API key does not expire')
  assert.equal(wouldFailAuth({ state: 'unknown-expiry' }), false, 'unknown is not dead')
  assert.equal(wouldFailAuth({ state: 'valid', expiresAt: now, msRemaining: 1 }), false)
})

test('the horizon, not the clock, decides whether a live token is a problem', () => {
  // Kept here as well as in the gateway's suite because `wouldFailAuth` is only correct in
  // company with it: the same token is a failure for a long job and not for a short one.
  const expiry = { kind: 'at', expiresAt: now + 5 * 60_000 } as const
  assert.equal(wouldFailAuth(credentialHealth(expiry, { now, horizonMs: 30 * 60_000 })), true)
  assert.equal(wouldFailAuth(credentialHealth(expiry, { now, horizonMs: 60_000 })), false)
})

test('a report crosses the wire as expiries and nothing else', () => {
  /**
   * The one thing this schema must never grow is a token. A runner reports *when* its
   * credential dies so the control plane can refuse a doomed job before it costs a night;
   * ADR-0010 is that the credential itself never leaves the process that injects it, and a
   * "while we are here, send the account id too" would undo that through the one channel
   * nobody thinks of as a credential path.
   *
   * Zod strips unknown keys rather than rejecting them, which is what makes this an
   * assertion about the shape that arrives rather than about the shape that was sent.
   */
  const parsed = credentialOutlookSchema.parse({
    anthropic: { kind: 'at', expiresAt: now, accessToken: 'sk-ant-oat01-secret' },
    openai: { kind: 'unrecorded' },
  })
  assert.deepEqual(parsed, {
    anthropic: { kind: 'at', expiresAt: now },
    openai: { kind: 'unrecorded' },
  })
})

test('a claim without a credential report is still a valid claim', () => {
  /**
   * The compatibility contract, asserted at the boundary that enforces it. A runner built
   * before this field existed sends `{ runnerName, labels, capacity }`; if the schema
   * required `credentials`, every one of those claims would become a 400 the moment the
   * control plane was deployed ahead of its runners — a fleet that stops working during a
   * rolling upgrade, with the error visible only in the runner's own log.
   */
  const legacy = claimRequestSchema.parse({ runnerName: 'desktop', labels: ['claude'], capacity: 2 })
  assert.equal(legacy.credentials, undefined)

  const reporting = claimRequestSchema.parse({
    runnerName: 'desktop',
    labels: ['claude'],
    capacity: 2,
    credentials: { anthropic: { kind: 'never' }, openai: { kind: 'absent' } },
  })
  assert.deepEqual(reporting.credentials, {
    anthropic: { kind: 'never' },
    openai: { kind: 'absent' },
  })
})

test('a duration reads in minutes where the warning window actually lives', () => {
  // Rounding to whole hours renders "42 minutes left" as "1h" and "expired 11 minutes ago"
  // as "0h ago" — so the one window a preflight exists to warn about is the one the string
  // could not express.
  assert.equal(humanDuration(42 * 60_000), '42m')
  assert.equal(humanDuration(6 * 36e5), '6h')
  assert.equal(humanDuration(3 * 864e5), '3d')
})
