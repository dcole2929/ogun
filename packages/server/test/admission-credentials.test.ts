import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { singleWorkerCycle } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { CredentialOutlook } from '@ogun/gateway'
import { credentialVerdict } from '../src/foreman/admission.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { startHarness } from './harness.ts'

/**
 * Whether a job that cannot possibly authenticate is refused before it burns a slot.
 *
 * The failure this guards: both agent CLIs authenticate with OAuth access tokens that
 * expire, the gateway does not refresh them — it re-reads the file the host's own
 * `claude` rewrites when a human runs it — and on an unattended runner nobody does. The
 * token lapses, the gateway keeps splicing a dead one onto every request, and the 3am
 * cycle fails on auth with nothing in the record naming the cause.
 *
 * These are all pure: `credentialVerdict` is deliberately given the outlook rather than
 * reading `~/.claude/.credentials.json` itself, so nothing here depends on when whoever
 * runs the suite last logged in.
 */

const now = Date.UTC(2026, 7, 20, 3, 0, 0)
const HOUR = 36e5

const outlook = (anthropic: CredentialOutlook['anthropic']): CredentialOutlook => ({
  anthropic,
  openai: { kind: 'unrecorded' },
})

const claude = { runtime: 'claude', timeoutMs: 30 * 60_000 }

// ── the states that refuse ─────────────────────────────────────────────────

test('an expired token refuses the job instead of dispatching it to fail', () => {
  /**
   * Refused, not dispatched, and the distinction is not cosmetic. A dispatched job spends
   * a runner slot, a workspace clone and an agent round to arrive at a 401, and then
   * lands in the ledger as a *failure* — which is the wrong name twice: nothing about the
   * worker failed, and a run filed as a failure latches the consecutive-failure breaker.
   * A token that lapsed on Tuesday would, by Friday, have disabled every worker on the
   * project for a reason that outlives the fix.
   */
  const verdict = credentialVerdict(claude, outlook({ kind: 'at', expiresAt: now - 6 * HOUR }), now)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && /expired 6h ago/.test(verdict.reason), true)
})

test('the refusal names the fix, including the one for a machine nobody logs into', () => {
  // A refusal that only states the problem leaves the reader where the 401 did.
  const verdict = credentialVerdict(claude, outlook({ kind: 'at', expiresAt: now - HOUR }), now)
  assert.equal(verdict.allowed, false)
  if (verdict.allowed) return
  assert.match(verdict.reason, /run `claude` on the runner host/)
  assert.match(verdict.reason, /ANTHROPIC_API_KEY/)
})

test('a token that expires during the run is refused, because "valid now" is the wrong question', () => {
  /**
   * The naive implementation asks whether the credential works right now. A token with
   * five minutes left passes that and dies in the middle of a thirty-minute job — the
   * same wasted night, arriving late enough that the transcript shows a successful start
   * and looks even less like a credential problem. The horizon is the worker's own
   * `timeoutMs`, because that is exactly how long the credential has to keep working.
   */
  const expiring = outlook({ kind: 'at', expiresAt: now + 5 * 60_000 })
  const verdict = credentialVerdict(claude, expiring, now)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && /5m left/.test(verdict.reason), true)

  // Same token, same instant, a worker capped at one minute: it will finish in time.
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 60_000 }, expiring, now).allowed, true)
})

test('a worker with a long timeout needs more of a token left than a short one', () => {
  const outlook40 = outlook({ kind: 'at', expiresAt: now + 40 * 60_000 })
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 30 * 60_000 }, outlook40, now).allowed, true)
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 2 * HOUR }, outlook40, now).allowed, false)
})

test('a worker that declares no timeout is judged against the default it will actually get', () => {
  // `workerSchema` defaults `timeoutMs` to thirty minutes, so a worker that says nothing
  // still runs for thirty minutes; judging it against zero would admit a doomed job.
  const twenty = outlook({ kind: 'at', expiresAt: now + 20 * 60_000 })
  assert.equal(credentialVerdict({ runtime: 'claude' }, twenty, now).allowed, false)
})

test('no credential at all is refused, and does not wear the same reason as an expired one', () => {
  const verdict = credentialVerdict(claude, outlook({ kind: 'absent' }), now)
  assert.equal(verdict.allowed, false)
  if (verdict.allowed) return
  assert.match(verdict.reason, /no anthropic credential/)
  // The gateway would answer 502 no_credential; saying so points at the actual mechanism
  // rather than implying the token went stale.
  assert.match(verdict.reason, /502 no_credential/)
  assert.equal(/expired/.test(verdict.reason), false)
})

// ── the states that must not refuse ────────────────────────────────────────

test('an API key is never refused, because it does not expire', () => {
  /**
   * This is the escape hatch the docs now recommend for an unattended runner
   * (`credentials.ts` prefers `ANTHROPIC_API_KEY` over the subscription token). A
   * preflight that refused it, or nagged about it, would be arguing against the only
   * configuration that actually survives a machine nobody logs into.
   */
  assert.equal(credentialVerdict(claude, outlook({ kind: 'never' }), now).allowed, true)
})

test('an unrecorded expiry is admitted — "I could not check" is not "it is dead"', () => {
  /**
   * A `~/.codex/auth.json` token records no expiry anywhere the gateway reads, and a
   * `claudeAiOauth` block in an unfamiliar shape records none either. Refusing on that
   * would refuse a machine that works perfectly — this function's own failure mode,
   * inverted — so the unknown is admitted and the provider's 401 stays the backstop.
   */
  assert.equal(credentialVerdict(claude, outlook({ kind: 'unrecorded' }), now).allowed, true)
})

test('a codex job is not refused because the Anthropic token is dead', () => {
  /**
   * Each runtime authenticates with one provider's credential. Collapsing them would
   * take a machine that can still run half its workers and stop all of them.
   */
  const dead = outlook({ kind: 'at', expiresAt: now - 6 * HOUR })
  assert.equal(credentialVerdict({ runtime: 'codex', timeoutMs: 30 * 60_000 }, dead, now).allowed, true)
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 30 * 60_000 }, dead, now).allowed, false)
})

test('a runtime this guard has never heard of is admitted, not refused by default', () => {
  // "I do not know which credential this needs" must not be answered "the Anthropic one
  // is dead, so no". A new runtime would otherwise be unable to run at all.
  const dead = outlook({ kind: 'at', expiresAt: now - HOUR })
  assert.equal(credentialVerdict({ runtime: 'gemini' }, dead, now).allowed, true)
  assert.equal(credentialVerdict({}, dead, now).allowed, true)
})

test('no outlook at all admits, which is the opposite of modifier readiness on purpose', () => {
  /**
   * Modifier readiness fails closed: a control plane that cannot establish it must not
   * let an unverifiable patch through. This one fails open, because it is a fact about
   * the *runner host*, which the control plane can only see while they are the same
   * machine (ADR-0001). A control plane on a VPS that refused everything it could not see
   * would turn a preflight into an outage.
   */
  assert.equal(credentialVerdict(claude, undefined, now).allowed, true)
})

// ── the refusal has to reach the ledger ────────────────────────────────────

/**
 * A refusal nobody can read is no better than a 401 nobody can read.
 *
 * §5.1 files a refused node as a `skipped` job plus a coverage row carrying the reason,
 * because principle 6 says "didn't run" is a recorded fact rather than an absence. If the
 * credential guard refused and the ledger recorded nothing — or recorded `errored` —
 * whoever opens the run in the morning would be back to guessing, which is the state this
 * whole feature exists to leave.
 */
describe('a credential refusal in a real cycle run', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `cred-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'w',
      skillRef: 'review',
      runtime: 'claude',
      versionHash: 'v1',
      config: { timeoutMs: 30 * 60_000 },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'w', definition: singleWorkerCycle('w') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  test('the node is skipped and the ledger says which credential and what to type', async () => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId,
      trigger: 'test',
      credentials: outlook({ kind: 'at', expiresAt: Date.now() - 6 * HOUR }),
    })

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    assert.equal(job!.state, 'skipped', 'a job that cannot authenticate must never be queued')

    const [row] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    // `refused`, not `errored`: nothing failed, there was never anything to judge.
    assert.equal(row!.outcome, 'refused')
    assert.equal(row!.ran, false)
    assert.match(row!.reason ?? '', /expired/)
    assert.match(row!.reason ?? '', /ANTHROPIC_API_KEY/)
  })

  test('a healthy credential leaves the run exactly as it was before this guard existed', async () => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId,
      trigger: 'test',
      credentials: outlook({ kind: 'at', expiresAt: Date.now() + 8 * HOUR }),
    })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    assert.equal(job!.state, 'queued')
  })
})
