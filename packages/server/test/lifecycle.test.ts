import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { defaultControlPlanePolicies, singleWorkerCycle } from '@ogun/core'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'
import { admit } from '../src/foreman/admission.ts'




describe('run lifecycle', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `test-${Date.now()}`
  let projectId = ''
  let workerId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'reviewer',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'reviewer', definition: singleWorkerCycle('reviewer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const runOnce = async (report: Parameters<typeof finalizeRun>[1] extends infer R ? Omit<R & object, 'runId'> : never) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    if (job?.state === 'skipped') return { skipped: true as const, cycleRunId }
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, { ...report, runId: run!.id })
    return { skipped: false as const, cycleRunId, result }
  }

  test('a clean run records coverage as clean, not as absence', async () => {
    const r = await runOnce({
      outcome: 'approved',
      gates: [{ name: 'schema', method: 'tool', passed: true }],
      findings: { findings: [] },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })
    assert.equal(r.skipped, false)
    assert.equal(r.result?.coverage, 'clean')
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, r.cycleRunId))
    assert.equal(cov?.ran, true, '"ran and found nothing" must be distinguishable from "never ran"')
    assert.equal(cov?.findingCount, 0)
  })

  test('the same fingerprint twice is one finding with a bumped count', async () => {
    const finding = {
      fingerprint: 'security/orders/isolation/id-swap',
      title: 'Order lookup trusts a client id',
      body: 'detail',
      severity: 'high' as const,
      citations: [{ path: 'src/orders.ts', line: 12 }],
    }
    const report = {
      outcome: 'approved' as const,
      gates: [],
      findings: { findings: [finding] },
      coverage: { outcome: 'found' as const },
      artifacts: [],
    }
    await runOnce(report)
    await runOnce(report)
    const rows = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId))
    assert.equal(rows.length, 1, 'night two must not regenerate night one')
    assert.equal(rows[0]?.seenCount, 2)
  })

  test('a failed gate blocks persistence and is not reported as success', async () => {
    const before = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    const r = await runOnce({
      outcome: 'approved',
      gates: [{ name: 'grounded', method: 'tool', passed: false, detail: 'src/ghost.ts:1 not in diff' }],
      findings: {
        findings: [
          {
            fingerprint: 'security/ghost/isolation/hallucinated',
            title: 'x',
            body: 'y',
            severity: 'critical',
            citations: [{ path: 'src/ghost.ts', line: 1 }],
          },
        ],
      },
      coverage: { outcome: 'found' },
      artifacts: [],
    })
    assert.equal(r.result?.outcome, 'changes-requested', 'the gate decides, not the runner')
    assert.equal(r.result?.findingsWritten, 0)
    assert.equal(r.result?.coverage, 'gate-failed')
    const after = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(after.length, before.length)
  })

  test('consecutive failures open the breaker and refuse the next job before it queues', async () => {
    const fail = {
      outcome: 'error' as const,
      detail: 'agent exited 1',
      gates: [],
      coverage: { outcome: 'errored' as const },
      artifacts: [],
    }
    // Two more on top of the gate failure above reaches the default threshold of three.
    await runOnce(fail)
    await runOnce(fail)

    // The project's own policies — `admit` takes no default, so a test cannot silently
    // assert against a machine constant the way the production path used to.
    const verdict = await admit(db, { id: workerId }, defaultControlPlanePolicies())
    assert.equal(verdict.allowed, false)

    const r = await runOnce(fail)
    assert.equal(r.skipped, true, 'a refused job is never dispatched')
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, r.cycleRunId))
    // `refused`, not `blocked`: admission said no. Nothing was blocking it.
    assert.equal(cov?.outcome, 'refused')
    assert.match(cov?.reason ?? '', /breaker open/)
  })
})

/**
 * Regression test for the first finding ogun's own adversarial reviewer produced
 * against ogun: the upsert bumped seenCount but never touched status, so a `fixed`
 * finding that came back stayed invisible to `--status open,triaged` forever.
 */
describe('re-sighting a finding', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `resight-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'reviewer',
      skillRef: 'adversarial-review',
      runtime: 'claude',
      versionHash: 'v1',
      config: {},
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'reviewer', definition: singleWorkerCycle('reviewer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const report = async (extra: Partial<{ revisitOf: string; revisitReason: string }> = {}) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: {
        findings: [
          {
            fingerprint: 'security/orders/isolation/id-swap',
            title: 'Order lookup trusts a client id',
            body: 'detail',
            severity: 'high',
            citations: [{ path: 'src/orders.ts', line: 12 }],
            ...extra,
          },
        ],
      },
      coverage: { outcome: 'found' },
      artifacts: [],
    })
  }

  const current = async () => {
    const [row] = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId))
    return row!
  }

  const setStatus = async (status: string) =>
    db
      .update(schema.findings)
      .set({ status })
      .where(eq(schema.findings.projectId, projectId))

  test('a fixed finding that comes back reopens', async () => {
    await report()
    await setStatus('fixed')
    await report({ revisitOf: 'prior run', revisitReason: 'verifying the merged fix' })

    const row = await current()
    assert.equal(row.status, 'open', 'a regression must not stay invisible to the inbox')
    assert.match(row.statusReason ?? '', /reported again after being marked fixed/)
    assert.equal(row.seenCount, 2)
    assert.equal(row.revisitReason, 'verifying the merged fix', 'revisit metadata must survive')
  })

  test('a wontfix finding stays dismissed but still counts', async () => {
    await setStatus('wontfix')
    await report()
    const row = await current()
    assert.equal(row.status, 'wontfix', 'a reviewer does not get to overrule a human decision')
    assert.equal(row.seenCount, 3, 'the pressure is still visible in the count')
  })

  test('a gated finding reopens — triage setting it aside is not a decision', async () => {
    await setStatus('gated')
    await report()
    assert.equal((await current()).status, 'open')
  })
})

/**
 * The prompt layers, most specific first (§5.1): a trigger override, then a cycle node,
 * then the worker, then the skill's own `default_prompt`, then a synthesised fallback.
 *
 * The skill layer was missing — sync stored `default_prompt` and nothing ever read it.
 * It went unnoticed because the fallback produced the same string for a skill whose
 * declared prompt was the obvious one-liner.
 */
describe('prompt resolution', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `prompt-${Date.now()}`
  let projectId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.skills).values({
      projectId,
      name: 'review',
      sourcePath: '.agents/skills/review',
      versionHash: 'sv1',
      // Deliberately not "Use the review skill." — the fallback would mask the bug.
      defaultPrompt: 'Use the review skill and start from the last deploy.',
    })
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const promptFor = async (
    name: string,
    config: Record<string, unknown>,
    overrides?: Record<string, string>,
  ) => {
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name,
        skillRef: 'review',
        runtime: 'claude',
        versionHash: `v-${name}`,
        config,
      })
      .returning()
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name, definition: singleWorkerCycle(name) })
      .returning()
    const { cycleRunId } = await startCycleRun(db, {
      cycleId: c!.id,
      trigger: 'test',
      ...(overrides ? { promptOverrides: overrides } : {}),
    })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    void w
    return job!.prompt
  }

  test("a worker with no prompt inherits the skill's default_prompt", async () => {
    assert.equal(
      await promptFor('inherits', {}),
      'Use the review skill and start from the last deploy.',
    )
  })

  test('a worker prompt overrides the skill default', async () => {
    assert.equal(await promptFor('overrides', { prompt: 'Only look at auth.' }), 'Only look at auth.')
  })

  test('a trigger override beats both', async () => {
    assert.equal(
      await promptFor('triggered', { prompt: 'Only look at auth.' }, { triggered: 'Just this once.' }),
      'Just this once.',
    )
  })

  test('a skill with no declared prompt falls back to a synthesised one', async () => {
    await db.insert(schema.skills).values({
      projectId,
      name: 'bare',
      sourcePath: '.agents/skills/bare',
      versionHash: 'sv2',
    })
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'bare-worker',
        skillRef: 'bare',
        runtime: 'claude',
        versionHash: 'v-bare',
        config: {},
      })
      .returning()
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'bare-worker', definition: singleWorkerCycle('bare-worker') })
      .returning()
    const { cycleRunId } = await startCycleRun(db, { cycleId: c!.id, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    void w
    assert.equal(job!.prompt, 'Use the bare skill.')
  })
})

/**
 * A run reaches a terminal state once (§5.1).
 *
 * Two callers finalize the same run: the runner reporting, and `sweepStaleClaims`
 * writing off a claim that went quiet. A runner that was slow rather than dead reports
 * afterwards, and whatever it says then arrives against a run that is already finished.
 */
describe('finalizing a run that is already finished', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `once-${Date.now()}`
  let projectId = ''
  let workerId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'reviewer',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'reviewer', definition: singleWorkerCycle('reviewer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const startRun = async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    return { cycleRunId, jobId: job!.id, runId: run!.id }
  }

  /** What the runner sends when the agent finished and the gate passed. */
  const approved = (runId: string) =>
    ({
      runId,
      outcome: 'approved',
      detail: 'the agent finished',
      gates: [{ name: 'schema', method: 'tool', passed: true }],
      findings: {
        findings: [
          {
            fingerprint: 'security/orders/isolation/late-report',
            title: 'Order lookup trusts a client id',
            body: 'detail',
            severity: 'high',
            citations: [{ path: 'src/orders.ts', line: 12 }],
          },
        ],
      },
      coverage: { outcome: 'found' },
      artifacts: [{ kind: 'transcript', ref: '/tmp/transcript.jsonl' }],
    }) satisfies Parameters<typeof finalizeRun>[1]

  const breaker = async () => {
    const [row] = await db
      .select()
      .from(schema.breakers)
      .where(eq(schema.breakers.workerId, workerId))
    return row
  }

  test('a report arriving after the stale sweep changes nothing', async () => {
    const { cycleRunId, jobId, runId } = await startRun()
    // Exactly what sweepStaleClaims writes for a claim that stopped reporting.
    await finalizeRun(db, {
      runId,
      outcome: 'error',
      detail: 'stale claim: no report within 30m',
      gates: [],
      coverage: { outcome: 'errored', reason: 'runner went away' },
      artifacts: [],
    })

    const late = await finalizeRun(db, approved(runId))
    assert.equal(late.outcome, 'error', 'the first writer wins, and the late one is told so')

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    assert.equal(run?.outcome, 'error', 'a run written off as failed must not flip to succeeded')
    assert.match(run?.detail ?? '', /stale claim/)

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId))
    assert.equal(job?.state, 'failed')

    const published = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId))
    assert.equal(published.length, 0, 'a run the ledger calls errored must not fill the inbox')
    const staged = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, runId))
    assert.equal(staged.length, 0)
    const files = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId))
    assert.equal(files.length, 0)

    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    // The upsert here is what masked the rest of it: coverage was the one table that
    // looked the same either way.
    assert.equal(cov?.outcome, 'errored')
    assert.equal(cov?.findingCount, 0)

    assert.equal(
      (await breaker())?.consecutiveFailures,
      1,
      'a late success must not clear a failure the sweep just latched',
    )

    assert.equal(late.alreadyFinalized, true)
    assert.equal(late.findingsWritten, 0)
    assert.equal(late.coverage, 'errored')
  })

  test('a retried report after a successful one does not count twice', async () => {
    const { runId } = await startRun()
    const first = await finalizeRun(db, approved(runId))
    assert.equal(first.alreadyFinalized, undefined, 'the first report is not a repeat')
    assert.equal(first.findingsWritten, 1)

    // The runner never saw the response — a dropped connection, a restart — and sends
    // the identical report again.
    const retry = await finalizeRun(db, approved(runId))
    assert.equal(retry.findingsWritten, 0, 'this call published nothing; the first one did')

    const [finding] = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId))
    assert.equal(finding?.seenCount, 1, 'one run cannot be two sightings of the same finding')

    const staged = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, runId))
    assert.equal(staged.length, 1, 'staging is what triage reads; a duplicate there is a lie')
    const files = await db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runId, runId))
    assert.equal(files.length, 1)

    assert.equal(retry.alreadyFinalized, true)
    assert.equal(retry.outcome, 'approved', 'what stands, not what this call proposed')
  })
})
