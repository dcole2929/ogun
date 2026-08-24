import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { singleWorkerCycle, type CredentialExpiry, type CredentialOutlook } from '@ogun/core'
import { schema } from '@ogun/core/db'
import {
  credentialVerdict,
  fleetCredentials,
  jobsThisRunnerCannotAuthenticate,
  type FleetCredentials,
} from '../src/foreman/admission.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { startHarness } from './harness.ts'

/**
 * Whether a job that cannot possibly authenticate is refused before it burns a slot —
 * and, since a runner started reporting its own credentials, whether the control plane
 * refuses on what it was *told* rather than on what it can see of its own disk.
 *
 * The failure this guards: both agent CLIs authenticate with OAuth access tokens that
 * expire, the gateway does not refresh them — it re-reads the file the host's own
 * `claude` rewrites when a human runs it — and on an unattended runner nobody does. The
 * token lapses, the gateway keeps splicing a dead one onto every request, and the 3am
 * cycle fails on auth with nothing in the record naming the cause.
 *
 * The second failure, which is what the fleet shape is for: the control plane used to
 * read `~/.claude/.credentials.json` on its *own* host. On one box that is nearly right
 * and was already wrong for an `ANTHROPIC_API_KEY` exported into the runner's systemd
 * unit and not the server's — the runner authenticated perfectly and every job was
 * refused with a reason that read as certain. On two boxes it is simply an answer about
 * the wrong machine.
 *
 * Most of these are pure: `credentialVerdict` is deliberately given the fleet's reports
 * rather than reading anything itself, so nothing here depends on when whoever runs the
 * suite last logged in.
 */

const now = Date.UTC(2026, 7, 20, 3, 0, 0)
const HOUR = 36e5

const outlook = (anthropic: CredentialExpiry, openai: CredentialExpiry = { kind: 'unrecorded' }): CredentialOutlook => ({
  anthropic,
  openai,
})

/** One machine, reporting. The single-runner control plane §3 describes. */
const alone = (anthropic: CredentialExpiry): FleetCredentials => ({
  reporting: [{ name: 'desktop', outlook: outlook(anthropic) }],
  silent: [],
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
  const verdict = credentialVerdict(claude, alone({ kind: 'at', expiresAt: now - 6 * HOUR }), now)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && /expired 6h ago/.test(verdict.reason), true)
})

test('the refusal names the machine, so a person knows which box to go and fix', () => {
  /**
   * The naive version of a fleet-wide refusal says "no runner can authenticate anthropic"
   * and stops. On one machine that is fine; on four it sends whoever reads it round all of
   * them, which is the same "go and check everything" the raw 401 gave.
   */
  const verdict = credentialVerdict(
    claude,
    {
      reporting: [
        { name: 'desktop', outlook: outlook({ kind: 'at', expiresAt: now - 6 * HOUR }) },
        { name: 'nas', outlook: outlook({ kind: 'absent' }) },
      ],
      silent: [],
    },
    now,
  )
  assert.equal(verdict.allowed, false)
  if (verdict.allowed) return
  assert.match(verdict.reason, /desktop: OAuth token expired 6h ago/)
  assert.match(verdict.reason, /nas: no anthropic credential/)
})

test('the refusal names the fix, and points at the runner rather than at both halves', () => {
  /**
   * A refusal that only states the problem leaves the reader where the 401 did. The fix
   * text also changed with the design: it used to say to export `ANTHROPIC_API_KEY` "where
   * both the control plane and the runner can see it", which was advice for working around
   * the fact that the check ran on the wrong machine. It now names the runner's own
   * environment, because that is the process which authenticates and the process which
   * reports.
   */
  const verdict = credentialVerdict(claude, alone({ kind: 'at', expiresAt: now - HOUR }), now)
  assert.equal(verdict.allowed, false)
  if (verdict.allowed) return
  assert.match(verdict.reason, /run `claude` on that machine/)
  assert.match(verdict.reason, /ANTHROPIC_API_KEY/)
  assert.equal(/both the control plane and the runner/.test(verdict.reason), false)
})

test('a token that expires during the run is refused, because "valid now" is the wrong question', () => {
  /**
   * The naive implementation asks whether the credential works right now. A token with
   * five minutes left passes that and dies in the middle of a thirty-minute job — the
   * same wasted night, arriving late enough that the transcript shows a successful start
   * and looks even less like a credential problem. The horizon is the worker's own
   * `timeoutMs`, because that is exactly how long the credential has to keep working.
   */
  const expiring = alone({ kind: 'at', expiresAt: now + 5 * 60_000 })
  const verdict = credentialVerdict(claude, expiring, now)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.allowed === false && /only 5m left/.test(verdict.reason), true)

  // Same token, same instant, a worker capped at one minute: it will finish in time.
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 60_000 }, expiring, now).allowed, true)
})

test('a worker with a long timeout needs more of a token left than a short one', () => {
  const fleet = alone({ kind: 'at', expiresAt: now + 40 * 60_000 })
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 30 * 60_000 }, fleet, now).allowed, true)
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 2 * HOUR }, fleet, now).allowed, false)
})

test('a worker that declares no timeout is judged against the default it will actually get', () => {
  // `workerSchema` defaults `timeoutMs` to thirty minutes, so a worker that says nothing
  // still runs for thirty minutes; judging it against zero would admit a doomed job.
  const twenty = alone({ kind: 'at', expiresAt: now + 20 * 60_000 })
  assert.equal(credentialVerdict({ runtime: 'claude' }, twenty, now).allowed, false)
})

test('no credential at all is refused, and does not wear the same reason as an expired one', () => {
  const verdict = credentialVerdict(claude, alone({ kind: 'absent' }), now)
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
   * This is the escape hatch the docs recommend for an unattended runner
   * (`credentials.ts` prefers `ANTHROPIC_API_KEY` over the subscription token). A
   * preflight that refused it, or nagged about it, would be arguing against the only
   * configuration that actually survives a machine nobody logs into.
   */
  assert.equal(credentialVerdict(claude, alone({ kind: 'never' }), now).allowed, true)
})

test('an unrecorded expiry is admitted — "I could not check" is not "it is dead"', () => {
  /**
   * A `~/.codex/auth.json` token records no expiry anywhere the gateway reads, and a
   * `claudeAiOauth` block in an unfamiliar shape records none either. Refusing on that
   * would refuse a machine that works perfectly — this function's own failure mode,
   * inverted — so the unknown is admitted and the provider's 401 stays the backstop.
   */
  assert.equal(credentialVerdict(claude, alone({ kind: 'unrecorded' }), now).allowed, true)
})

test('a codex job is not refused because the Anthropic token is dead', () => {
  /**
   * Each runtime authenticates with one provider's credential. Collapsing them would
   * take a machine that can still run half its workers and stop all of them.
   */
  const dead = alone({ kind: 'at', expiresAt: now - 6 * HOUR })
  assert.equal(credentialVerdict({ runtime: 'codex', timeoutMs: 30 * 60_000 }, dead, now).allowed, true)
  assert.equal(credentialVerdict({ runtime: 'claude', timeoutMs: 30 * 60_000 }, dead, now).allowed, false)
})

test('a runtime this guard has never heard of is admitted, not refused by default', () => {
  // "I do not know which credential this needs" must not be answered "the Anthropic one
  // is dead, so no". A new runtime would otherwise be unable to run at all.
  const dead = alone({ kind: 'at', expiresAt: now - HOUR })
  assert.equal(credentialVerdict({ runtime: 'gemini' }, dead, now).allowed, true)
  assert.equal(credentialVerdict({}, dead, now).allowed, true)
})

test('no fleet outlook at all admits, which is the opposite of modifier readiness on purpose', () => {
  /**
   * Modifier readiness fails closed: a control plane that cannot establish it must not
   * let an unverifiable patch through. This one fails open, because it is a fact about a
   * *machine*, which the control plane only ever learns by being told. A control plane
   * that refused everything it had not been told would turn a preflight into an outage.
   */
  assert.equal(credentialVerdict(claude, undefined, now).allowed, true)
})

// ── which machine, which is the whole reason this is a fleet ───────────────

test('one healthy machine is enough — a job only it can authenticate is admittable there', () => {
  /**
   * The naive fleet implementation asks about "the" credential and takes the first runner,
   * or intersects them. Both turn a mixed fleet into its worst member: a laptop whose
   * token lapsed over the weekend would stop the always-on box from running anything,
   * which is the opposite of what having two machines is for.
   *
   * Admission's job is only to establish that *somebody* can. Which machine actually gets
   * it is settled at claim time, where a job the claimer cannot authenticate is held back
   * rather than refused.
   */
  const mixed: FleetCredentials = {
    reporting: [
      { name: 'laptop', outlook: outlook({ kind: 'at', expiresAt: now - 2 * HOUR }) },
      { name: 'nas', outlook: outlook({ kind: 'never' }) },
    ],
    silent: [],
  }
  assert.equal(credentialVerdict(claude, mixed, now).allowed, true)
})

test('a live runner that has reported nothing is not evidence that nothing can run', () => {
  /**
   * The absence-of-evidence trap, and the one a naive implementation walks straight into:
   * having built a list of reports, it is natural to refuse when every report in the list
   * is dead. But a machine running yesterday's build sends no report at all, so it is not
   * in the list — and refusing on the strength of the machines that *did* answer would
   * strand every job on a fleet mid-upgrade, permanently, with a `refused` coverage row
   * per node claiming the credential was checked.
   *
   * So `silent` is carried separately and any entry in it admits.
   */
  const upgrading: FleetCredentials = {
    reporting: [{ name: 'desktop', outlook: outlook({ kind: 'at', expiresAt: now - 6 * HOUR }) }],
    silent: ['old-build'],
  }
  assert.equal(credentialVerdict(claude, upgrading, now).allowed, true)
})

test('an empty fleet admits, because a closed laptop is not a refusal', () => {
  /**
   * No runner is online at 3am — the machine is asleep, or being rebooted. Queued jobs
   * waiting for a machine to wake up is the designed behaviour of the entire claim model;
   * a preflight that turned it into a night filed as `refused` would be destroying work
   * that was never in trouble.
   */
  assert.equal(credentialVerdict(claude, { reporting: [], silent: [] }, now).allowed, true)
})

// ── what a runner is handed, decided by that runner's own report ───────────

describe('holding back a job the claiming runner cannot authenticate', () => {
  const jobs = [
    { id: 'claude-30m', runtime: 'claude', timeoutMs: 30 * 60_000 },
    { id: 'claude-1m', runtime: 'claude', timeoutMs: 60_000 },
    { id: 'codex-30m', runtime: 'codex', timeoutMs: 30 * 60_000 },
    { id: 'gemini-30m', runtime: 'gemini', timeoutMs: 30 * 60_000 },
  ]

  test('only the jobs this machine could not finish are held', () => {
    /**
     * A token with ten minutes left. The naive implementation holds back every `claude`
     * job, or none; the right answer is per job, because the horizon is the job's own
     * timeout — the one-minute worker will be finished long before the token dies.
     *
     * `codex` and the unknown runtime are untouched: one authenticates with a different
     * provider, and the other with something this guard has never been taught about.
     */
    const held = jobsThisRunnerCannotAuthenticate(
      jobs,
      outlook({ kind: 'at', expiresAt: now + 10 * 60_000 }),
      now,
    )
    assert.deepEqual(held, ['claude-30m'])
  })

  test('a runner that reports nothing has nothing held back', () => {
    /**
     * The compatibility half, at claim time. A runner built before this field existed
     * sends no credentials, and reading that silence as "no credentials" would hold back
     * every job it asked for — a fleet that quietly stops working the day the control
     * plane is deployed ahead of the runners, with nothing anywhere saying why, because a
     * held-back job is recorded as nothing at all.
     */
    assert.deepEqual(jobsThisRunnerCannotAuthenticate(jobs, undefined, now), [])
  })

  test('a machine with an API key holds nothing back', () => {
    assert.deepEqual(jobsThisRunnerCannotAuthenticate(jobs, outlook({ kind: 'never' }), now), [])
  })

  test('a dead provider holds back only that provider’s jobs', () => {
    const held = jobsThisRunnerCannotAuthenticate(
      jobs,
      outlook({ kind: 'never' }, { kind: 'absent' }),
      now,
    )
    assert.deepEqual(held, ['codex-30m'])
  })
})

// ── reading the fleet out of the database ──────────────────────────────────

describe('what the control plane believes about its machines', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']

  before(async () => {
    h = await startHarness()
    db = h.db
  })
  after(async () => {
    await db.delete(schema.runners)
    await h.stop()
  })

  const insert = (
    name: string,
    fields: Partial<typeof schema.runners.$inferInsert>,
  ): Promise<unknown> => db.insert(schema.runners).values({ name, ...fields })

  test('a stale report is silence, not a verdict', async () => {
    /**
     * The property: a report has its own clock, and one that has stopped advancing must
     * stop being quoted.
     *
     * What a naive implementation gets wrong is storing the report against `last_seen_at`
     * and treating a live heartbeat as proof the report is current. A runner downgraded to
     * a build that does not report — or a field dropped in transit — would then keep a
     * months-old expiry looking eternally fresh, and admission would go on refusing every
     * job over a token that was replaced with an API key hours ago. That is this feature's
     * own failure mode, restored by the fix for it.
     *
     * The runner below is unambiguously alive: seen a second ago. Only its *report* is
     * old, and that is enough to move it to `silent`, which admits.
     */
    const t = Date.now()
    await insert('stale-reporter', {
      lastSeenAt: new Date(t - 1_000),
      credentials: outlook({ kind: 'at', expiresAt: t - 6 * HOUR }),
      credentialsAt: new Date(t - 10 * 60_000),
    })

    const fleet = await fleetCredentials(db, t)
    assert.deepEqual(fleet.reporting, [])
    assert.deepEqual(fleet.silent, ['stale-reporter'])
    assert.equal(credentialVerdict(claude, fleet, t).allowed, true)

    await db.delete(schema.runners)
  })

  test('an offline machine is not quoted at all — neither reporting nor silent', async () => {
    /**
     * A machine that has not claimed for an hour cannot take this job, so its opinion is
     * worthless in both directions: quoting its healthy token would admit a job nothing
     * can run, and counting it as `silent` would make every offline machine a standing
     * excuse to admit. It is simply not part of the fleet right now.
     */
    const t = Date.now()
    await insert('asleep', {
      lastSeenAt: new Date(t - HOUR),
      credentials: outlook({ kind: 'never' }),
      credentialsAt: new Date(t - HOUR),
    })
    const fleet = await fleetCredentials(db, t)
    assert.deepEqual(fleet, { reporting: [], silent: [] })
    await db.delete(schema.runners)
  })

  test('an invited machine that has never connected is not a silent runner', async () => {
    /**
     * `pending` means an enrollment command was issued and nobody ran it. Counting that
     * row as `silent` would switch the preflight off for the whole control plane on the
     * strength of an invite nobody redeemed — and it would look like nothing, because the
     * only symptom is jobs no longer being refused.
     */
    const t = Date.now()
    await insert('never-showed-up', { pending: true, lastSeenAt: new Date(t) })
    await insert('revoked-box', { revokedAt: new Date(t), lastSeenAt: new Date(t) })
    assert.deepEqual(await fleetCredentials(db, t), { reporting: [], silent: [] })
    await db.delete(schema.runners)
  })

  test('a fresh report from a live machine is what admission judges', async () => {
    const t = Date.now()
    await insert('desktop', {
      lastSeenAt: new Date(t - 2_000),
      credentials: outlook({ kind: 'at', expiresAt: t - 6 * HOUR }),
      credentialsAt: new Date(t - 2_000),
    })
    const fleet = await fleetCredentials(db, t)
    assert.deepEqual(fleet.silent, [])
    assert.equal(fleet.reporting.length, 1)
    assert.equal(fleet.reporting[0]?.name, 'desktop')

    const verdict = credentialVerdict(claude, fleet, t)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.allowed === false && /desktop: OAuth token expired/.test(verdict.reason), true)
    await db.delete(schema.runners)
  })
})

// ── the claim, where the reporting and the holding back actually happen ────

/**
 * The wiring, through the endpoint that does it.
 *
 * Asserted at `/api/jobs/claim` rather than at admission because that is the difference
 * the design turns on: a job this machine cannot authenticate stays `queued` and is picked
 * up by a machine that can, where an admission refusal would have written it off as
 * `skipped` for the night. Same split as `maxConcurrentModifiers`, same reason.
 */
describe('a runner reports its credentials on the claim, and is handed work accordingly', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const stamp = Date.now()
  const name = `cred-runner-${stamp}`
  const slug = `cred-claim-${stamp}`
  let cycleId = ''

  const claim = async (credentials?: CredentialOutlook) => {
    const res = await h.fetch('/api/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runnerName: name,
        labels: ['claude'],
        capacity: 5,
        ...(credentials ? { credentials } : {}),
      }),
    })
    assert.equal(res.status, 200)
    return ((await res.json()) as { jobs: Array<{ jobId: string }> }).jobs
  }

  /** A fresh queued job, admitted without any fleet opinion so the claim is what decides. */
  const queue = async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    assert.equal(job?.state, 'queued', 'the fixture job must be claimable')
    return job!.id
  }

  const runnerRow = async () =>
    db.query.runners.findFirst({ where: eq(schema.runners.name, name) })

  before(async () => {
    h = await startHarness()
    db = h.db
    await db.insert(schema.runners).values({
      name,
      labels: ['claude'],
      maxConcurrency: 5,
      enrolledAt: new Date(),
    })
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    await db.insert(schema.workers).values({
      projectId: p!.id,
      name: 'w',
      skillRef: 'review',
      runtime: 'claude',
      versionHash: 'v1',
      // `worktree`, so the job's `requires` is just `claude` and this runner's labels
      // cover it. A container worker would also require `docker`, and the job would sit
      // unclaimed for a reason that has nothing to do with credentials.
      sandbox: 'worktree',
      config: { timeoutMs: 30 * 60_000 },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId: p!.id, name: 'w', definition: singleWorkerCycle('w') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.slug, slug))
    await db.delete(schema.runners).where(eq(schema.runners.name, name))
    await h.stop()
  })

  test('a dead token holds the job back rather than being handed it to fail', async () => {
    const jobId = await queue()
    const handed = await claim(outlook({ kind: 'at', expiresAt: Date.now() - 6 * HOUR }))
    assert.deepEqual(handed, [], 'a job this machine would 401 on must not be handed out')

    // Held back, not skipped and not cancelled. The distinction is the whole design: this
    // machine cannot run it *now*, which stops being true the moment somebody logs in, and
    // may never have been true of the machine next to it.
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId))
    assert.equal(job!.state, 'queued')

    // And the report reached the row, which is what admission will read next time.
    const row = await runnerRow()
    assert.notEqual(row!.credentials, null)
    assert.notEqual(row!.credentialsAt, null)
  })

  test('the same job goes out once the machine can authenticate again', async () => {
    /**
     * Recovery without anybody re-triggering anything: the job was never destroyed, so
     * running `claude` on the box — or setting an API key and restarting it — is enough.
     * An admission refusal would have left a `skipped` job and a `refused` coverage row
     * that no credential fix brings back.
     */
    const handed = await claim(outlook({ kind: 'never' }))
    assert.equal(handed.length, 1)
  })

  test('a runner that reports nothing is handed work, and its last report is not erased', async () => {
    /**
     * Both halves of backwards compatibility in one claim.
     *
     * A runner built before this field existed sends no `credentials`. Reading that as "no
     * credentials" would hold back every job it asked for and leave the fleet silently
     * idle — held-back jobs are recorded as nothing, so there would be no row anywhere
     * saying why. And writing `null` over the stored report would be inventing the same
     * claim in the database.
     *
     * The stored report is left alone precisely because `credentials_at` does not move
     * with it: it ages out of the freshness window within the minute and the machine
     * becomes `silent`, which admits. Kept-but-aging is honest; erased is a lie, and
     * kept-and-refreshed would be worse still.
     */
    const before = await runnerRow()
    const jobId = await queue()
    const handed = await claim()
    assert.deepEqual(
      handed.map((j) => j.jobId),
      [jobId],
    )
    const after = await runnerRow()
    assert.deepEqual(after!.credentials, before!.credentials)
    assert.deepEqual(after!.credentialsAt, before!.credentialsAt)
  })
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

  test('the node is skipped and the ledger says which machine, which credential and what to type', async () => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId,
      trigger: 'test',
      credentials: {
        reporting: [
          { name: 'desktop', outlook: outlook({ kind: 'at', expiresAt: Date.now() - 6 * HOUR }) },
        ],
        silent: [],
      },
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
    assert.match(row!.reason ?? '', /desktop/)
    assert.match(row!.reason ?? '', /expired/)
    assert.match(row!.reason ?? '', /ANTHROPIC_API_KEY/)
  })

  test('a healthy credential leaves the run exactly as it was before this guard existed', async () => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId,
      trigger: 'test',
      credentials: {
        reporting: [
          { name: 'desktop', outlook: outlook({ kind: 'at', expiresAt: Date.now() + 8 * HOUR }) },
        ],
        silent: [],
      },
    })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    assert.equal(job!.state, 'queued')
  })
})
