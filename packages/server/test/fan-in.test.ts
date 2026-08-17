import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { cycleConfigSchema, expandCycle } from '@ogun/core'
import { startHarness } from './harness.ts'
import { startCycleRun, releaseDependents } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * Fan-in (§4.12): N reviewers stage, one triage node publishes.
 *
 * The property under test is not "the DAG executes" — it is that a reviewer feeding
 * triage writes *nothing* to the inbox. Get that wrong and the inbox shows the raw
 * findings alongside the consolidated ones, which is worse than not running triage.
 */
describe('triage fan-in', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `fanin-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  const workerIds = new Map<string, string>()

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id

    for (const name of ['reviewer-a', 'reviewer-b', 'triage']) {
      const [w] = await db
        .insert(schema.workers)
        .values({
          projectId,
          name,
          skillRef: name === 'triage' ? 'triage' : 'adversarial-review',
          runtime: 'claude',
          versionHash: 'v1',
          config: {},
        })
        .returning()
      workerIds.set(name, w!.id)
    }

    const definition = expandCycle(
      cycleConfigSchema.parse({ workers: ['reviewer-a', 'reviewer-b'], then: 'triage' }),
    )
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'nightly', definition })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const finish = async (cycleRunId: string, nodeKey: string, findings: unknown[]) => {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, nodeKey)))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: { findings: findings as never },
      coverage: { outcome: findings.length > 0 ? 'found' : 'clean' },
      artifacts: [],
    })
    await releaseDependents(db, cycleRunId)
    return { job: job!, run: run!, result }
  }

  const finding = (fingerprint: string, path: string) => ({
    fingerprint,
    title: `problem at ${path}`,
    body: 'detail',
    severity: 'high' as const,
    citations: [{ path, line: 1 }],
  })

  test('reviewers stage but do not publish; triage publishes', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })

    // Triage must not be runnable before its dependencies are done — otherwise it would
    // triage an empty input and report a clean night.
    const [triageJob] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))
    assert.equal(triageJob?.state, 'blocked')

    const a = await finish(cycleRunId, 'reviewer-a', [finding('api/auth/isolation/swap', 'src/a.ts')])
    const b = await finish(cycleRunId, 'reviewer-b', [finding('api/auth/isolation/swap', 'src/a.ts')])

    assert.equal(a.result.findingsWritten, 0, 'a reviewer feeding triage must not reach the inbox')
    assert.equal(a.result.staged, 1)
    assert.equal(b.result.staged, 1)

    const inbox = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(inbox.length, 0, 'nothing is visible until triage has run')

    // Coverage still reflects what each reviewer found, not what was promoted.
    const cov = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    const reviewerCoverage = cov.filter((r) => r.workerId !== workerIds.get('triage'))
    assert.equal(reviewerCoverage.length, 2)
    for (const row of reviewerCoverage) {
      assert.equal(row.outcome, 'found')
      assert.equal(row.findingCount, 1, 'the reviewer found something; the ledger should say so')
    }

    const [released] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))
    assert.equal(released?.state, 'queued', 'triage runs once every dependency is done')

    const t = await finish(cycleRunId, 'triage', [finding('api/auth/isolation/swap', 'src/a.ts')])
    assert.equal(t.result.findingsWritten, 1)

    const after = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(after.length, 1, 'two reviewers, one invariant, one inbox item')
  })

  test('triage reads what upstream staged, including the reviewer that found nothing', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await finish(cycleRunId, 'reviewer-a', [finding('db/tx/atomicity/partial', 'src/db.ts')])
    await finish(cycleRunId, 'reviewer-b', [])

    const [triageJob] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))

    const res = await h.fetch(`/api/jobs/${triageJob!.id}/inputs`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      degraded: boolean
      sources: { worker: string; ran: boolean; findings: unknown[] }[]
    }

    assert.equal(body.sources.length, 2)
    assert.equal(body.degraded, false)
    const empty = body.sources.find((s) => s.worker === 'reviewer-b')
    assert.equal(empty?.ran, true, '"ran and found nothing" is a result triage needs')
    assert.equal(empty?.findings.length, 0)
    const found = body.sources.find((s) => s.worker === 'reviewer-a')
    assert.equal(found?.findings.length, 1)
  })

  test('a standalone reviewer still publishes directly', async () => {
    const [solo] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'just-a',
        definition: { nodes: [{ key: 'reviewer-a', worker: 'reviewer-a' }], edges: [] },
      })
      .returning()

    const { cycleRunId } = await startCycleRun(db, { cycleId: solo!.id, trigger: 'test' })
    const r = await finish(cycleRunId, 'reviewer-a', [finding('cli/args/parsing/quote', 'src/cli.ts')])
    assert.equal(
      r.result.findingsWritten,
      1,
      'membership in a fan-in cycle is what stages a run, not a property of the worker',
    )
  })
})
/**
 * History outlives the definitions that produced it (§4.4).
 *
 * `jobs`, `coverage`, `staged_findings` and `cycle_runs` used to cascade off `workers`
 * and `cycles`, and `reindexProject` deletes anything absent from config.yaml — so a
 * *rename*, which reaches it as a delete plus an insert, destroyed every run the old name
 * had ever produced. One worker toggle from the UI took a whole night's cycle run, its
 * three runs and its coverage rows with it, and nothing failed or said so.
 */
describe('editing config.yaml does not delete run history', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `hist-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  let workerId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'doomed',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'doomed',
        definition: { nodes: [{ key: 'doomed', worker: 'doomed' }], edges: [] },
      })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  test('a run survives its worker and its cycle being deleted', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
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
            fingerprint: 'a/b/c/d',
            title: 'problem',
            body: 'detail',
            severity: 'high',
            citations: [{ path: 'src/x.ts', line: 1 }],
          },
        ] as never,
      },
      coverage: { outcome: 'found' },
      artifacts: [],
    })

    // Exactly what `ogun project sync` does when a worker and cycle leave config.yaml.
    await db.delete(schema.workers).where(eq(schema.workers.id, workerId))
    await db.delete(schema.cycles).where(eq(schema.cycles.id, cycleId))

    const runsLeft = await db.select().from(schema.runs).where(eq(schema.runs.id, run!.id))
    assert.equal(runsLeft.length, 1, 'the run was deleted with its worker')

    const [survivingJob] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job!.id))
    assert.ok(survivingJob, 'the job was deleted with its worker')
    assert.equal(survivingJob!.workerId, null, 'the pointer goes, not the row')
    assert.equal(survivingJob!.workerName, 'doomed', 'the name is what makes it readable')

    const [cycleRun] = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.id, cycleRunId))
    assert.ok(cycleRun, 'the cycle run was deleted with its cycle')
    assert.equal(cycleRun!.cycleId, null)
    assert.equal(cycleRun!.cycleName, 'doomed')

    const cov = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    assert.equal(cov.length, 1, 'the coverage ledger is the trust anchor — it must not vanish')
    assert.equal(cov[0]!.workerName, 'doomed')

    const staged = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, run!.id))
    assert.equal(staged.length, 1, 'raw reviewer output is a run artifact and outlives the worker')
    assert.equal(staged[0]!.workerName, 'doomed')
  })
})

