import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { singleWorkerCycle, type RunReport } from '@ogun/core'
import { startHarness } from './harness.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * What the control plane records when a modifier run ends (§4.4).
 *
 * The `changes` row is an artifact record, not a work queue — which is the distinction
 * every test here is about. A row exists for a run that changed nothing and for a run
 * whose gate rejected the work, and a publisher that read "there is a row" as "open a
 * pull request" would publish both.
 */
describe('a modifier run is recorded', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `changes-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'fixer',
      skillRef: 'fix-the-thing',
      runtime: 'claude',
      versionHash: 'v1',
      config: { permissions: 'modifier' },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'fixer', definition: singleWorkerCycle('fixer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const runOnce = async (report: Omit<RunReport, 'runId'>) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, { ...report, runId: run!.id })
    const rows = await db.select().from(schema.changes).where(eq(schema.changes.runId, run!.id))
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    return { runId: run!.id, result, rows, cov, report: { ...report, runId: run!.id } }
  }

  const withPatch = {
    outcome: 'dispatched',
    gates: [],
    change: { baseSha: 'a'.repeat(40), filesChanged: 3, patchRef: '/scratch/patches/r/changes.patch' },
    coverage: { outcome: 'changed' },
    artifacts: [{ kind: 'patch', ref: '/scratch/patches/r/changes.patch', bytes: 4096 }],
  } satisfies Omit<RunReport, 'runId'>

  test('a patch becomes a change row, an artifact, and a dispatched run', async () => {
    const r = await runOnce(withPatch)

    assert.equal(r.result.outcome, 'dispatched')
    assert.equal(r.result.jobState, 'succeeded')
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0]?.filesChanged, 3)
    assert.equal(r.rows[0]?.baseSha, 'a'.repeat(40))
    // The pointer, never the patch itself — blobs live on disk (§4.4).
    assert.equal(r.rows[0]?.patchRef, '/scratch/patches/r/changes.patch')
    // Host-side columns, and they stay empty until something host-side fills them: the
    // runner cannot know either, because neither exists until after the container exits.
    assert.equal(r.rows[0]?.branch, null)
    assert.equal(r.rows[0]?.prUrl, null)
    // `clean` would say the night produced nothing, and a modifier reports no findings at
    // all — so without its own value the ledger cannot tell the two nights apart.
    assert.equal(r.cov?.outcome, 'changed')
  })

  test('a modifier that changed nothing says so, rather than leaving no record', async () => {
    const r = await runOnce({
      outcome: 'approved',
      gates: [],
      change: { baseSha: 'b'.repeat(40), filesChanged: 0 },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })

    assert.equal(r.result.outcome, 'approved')
    assert.equal(r.rows.length, 1, 'a run that read the code and left it alone still ran')
    assert.equal(r.rows[0]?.filesChanged, 0)
    assert.equal(r.rows[0]?.patchRef, null)
    assert.equal(r.cov?.outcome, 'clean')
  })

  /**
   * The gate decides, and for a modifier that is the sharper end of the same rule the
   * findings path already follows. `dispatched` means "there is a patch ready to
   * publish"; a modifier gate that will eventually run the project's test suite (§9) has
   * just said it is not. Leaving the run `dispatched` would hand the publisher work the
   * gate rejected — with tests red.
   */
  test('a failed gate withdraws the claim that a patch is ready', async () => {
    const r = await runOnce({
      ...withPatch,
      gates: [{ name: 'tests', method: 'tool', passed: false, detail: '2 failing' }],
    })

    assert.equal(r.result.outcome, 'changes-requested')
    assert.equal(r.result.jobState, 'failed')
    assert.equal(r.cov?.outcome, 'gate-failed')
    // Recorded anyway: the patch exists on disk and a person debugging the failure needs
    // to be able to read it. What the gate withdraws is readiness, not the artefact.
    assert.equal(r.rows.length, 1)
  })

  /**
   * Two callers race for every run — the runner reporting and the stale-claim sweep — and
   * the loser applies nothing. `changes` has no unique key on `run_id`, so an insert
   * outside the claim would double-count a modifier's night in every query that goes near
   * this table, with nothing to tell the copies apart.
   */
  test('a report that lost the race adds no second change row', async () => {
    const r = await runOnce(withPatch)
    const second = await finalizeRun(db, r.report)

    assert.equal(second.alreadyFinalized, true)
    const rows = await db.select().from(schema.changes).where(eq(schema.changes.runId, r.runId))
    assert.equal(rows.length, 1)
  })
})
