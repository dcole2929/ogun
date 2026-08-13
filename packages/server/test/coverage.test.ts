import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { singleWorkerCycle } from '@ogun/core'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { reconcileCoverage } from '../src/foreman/sweep.ts'



/**
 * The coverage ledger is the one table whose entire purpose is to be true about what ran
 * (principle 6): an empty findings list is only trustworthy if this is. `pending` means
 * "selected and queued, waiting for a runner", so a job that has already ended and still
 * carries it is stating something false.
 */
describe('coverage reconciliation', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `cov-${Date.now()}`
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
      config: {},
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

  const coverageFor = async (cycleRunId: string) => {
    const [row] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    return row!
  }

  test('a queued job is pending — it genuinely is waiting', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    assert.equal((await coverageFor(cycleRunId)).outcome, 'pending')
  })

  test('a job that ended without running is reconciled to abandoned', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await db
      .update(schema.jobs)
      .set({ state: 'skipped' })
      .where(eq(schema.jobs.cycleRunId, cycleRunId))

    assert.equal((await coverageFor(cycleRunId)).outcome, 'pending', 'stale before the sweep')
    await reconcileCoverage(db)

    const row = await coverageFor(cycleRunId)
    assert.equal(row.outcome, 'abandoned')
    assert.equal(row.ran, false)
    // The reason has to say it was inferred, so a reconciled row is not mistaken for a
    // decision something actually made.
    assert.match(row.reason ?? '', /without reporting a run/)
  })

  test('a still-queued job is left alone', async () => {
    // Reconciling on job state must not sweep away rows that are correctly pending, or
    // the ledger would claim a waiting job had been blocked.
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await reconcileCoverage(db)
    assert.equal((await coverageFor(cycleRunId)).outcome, 'pending')
  })

  test('an outcome that was actually reported is not overwritten', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await db
      .update(schema.coverage)
      .set({ outcome: 'clean', ran: true })
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    await db
      .update(schema.jobs)
      .set({ state: 'succeeded' })
      .where(eq(schema.jobs.cycleRunId, cycleRunId))

    await reconcileCoverage(db)
    const row = await coverageFor(cycleRunId)
    assert.equal(row.outcome, 'clean', 'a real result must survive the sweep')
    assert.equal(row.ran, true)
  })

  test('cancelling a job records why it never ran', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))

    const res = await h.fetch(`/api/jobs/${job!.id}/cancel`, { method: 'POST' })
    assert.equal(res.status, 200)

    const row = await coverageFor(cycleRunId)
    assert.equal(row.outcome, 'cancelled', 'nothing blocked it — you stopped it')
    assert.match(row.reason ?? '', /cancelled/)
    void and
  })
})
