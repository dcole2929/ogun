import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { singleWorkerCycle } from '@ogun/core'
import { remainingCapacity } from '../src/foreman/admission.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'



/**
 * The global concurrency cap is a hard limit, not a hint: it exists because a container
 * running an agent plus a test suite is not small and WSL2 caps at ~50% of Windows RAM
 * (§8). Exceeding it is the OOM it was written to prevent.
 *
 * It was exceedable. The claim gated on a boolean — "is at least one slot free?" — and
 * then handed out as many jobs as the *runner* asked for, so one job running plus a
 * runner reporting capacity 2 produced three concurrent jobs against a cap of two.
 */
describe('global concurrency cap', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `cap-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  const created: string[] = []

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

  /** Queue a job and force it into a given state, standing in for a real runner. */
  const queueJob = async (state: 'queued' | 'running') => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    created.push(job!.id)
    if (state === 'running') {
      await db.update(schema.jobs).set({ state: 'running' }).where(eq(schema.jobs.id, job!.id))
    }
    return job!.id
  }

  const inFlight = async () => {
    const rows = await db
      .select()
      .from(schema.jobs)
      .where(inArray(schema.jobs.state, ['claimed', 'running']))
    return rows.length
  }

  test('capacity is a count of free slots, not a yes/no', async () => {
    const limits = { maxConcurrentJobs: 2, failureBreakerThreshold: 3 }
    const before = await inFlight()

    await queueJob('running')
    const remaining = await remainingCapacity(db, limits)

    // The old boolean said "yes, room exists" here, and told the caller nothing about
    // how much room — which is the whole bug.
    assert.equal(
      remaining,
      Math.max(0, 2 - (before + 1)),
      'must report the number of slots, so the claim can be bounded by it',
    )
  })

  test('it never reports more slots than the cap', async () => {
    const limits = { maxConcurrentJobs: 2, failureBreakerThreshold: 3 }
    assert.ok((await remainingCapacity(db, limits)) <= 2)
  })

  test('a machine already at the cap reports nothing free', async () => {
    const limits = { maxConcurrentJobs: 1, failureBreakerThreshold: 3 }
    await queueJob('running')
    assert.equal(await remainingCapacity(db, limits), 0)
  })

  test('it floors at zero rather than going negative', async () => {
    // Over the cap already — a runner asking for work must be told none, not offered a
    // negative number that a `limit` would reject or, worse, treat as unbounded.
    const limits = { maxConcurrentJobs: 0, failureBreakerThreshold: 3 }
    assert.equal(await remainingCapacity(db, limits), 0)
  })
})
