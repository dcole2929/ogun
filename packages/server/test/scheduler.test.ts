import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { singleWorkerCycle } from '@ogun/core'
import { findDue, InvalidSchedule, parseSchedule, tick, upcoming } from '../src/foreman/scheduler.ts'
import { startHarness } from './harness.ts'

/**
 * The scheduler's hard part is not cron, it is that the machine is not always on. WSL2
 * stops when Windows sleeps or reboots for an update, so missed occurrences are ordinary
 * rather than exceptional, and what to do about one differs per worker.
 */
describe('scheduler', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  let projectId = ''

  const at = (iso: string) => () => new Date(iso)

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug: 'sched' }).returning()
    projectId = p!.id
  })

  after(async () => {
    await h.stop()
  })

  /** A worker on a nightly 3am schedule, with its last run at a chosen moment. */
  const nightly = async (name: string, onMissed: 'skip' | 'runOnce', lastRunAt: Date | null) => {
    await db.insert(schema.workers).values({
      projectId,
      name,
      skillRef: 's',
      runtime: 'claude',
      versionHash: 'v',
      config: {},
    })
    const [cycle] = await db
      .insert(schema.cycles)
      .values({ projectId, name, definition: singleWorkerCycle(name) })
      .returning()
    await db.insert(schema.schedules).values({
      cycleId: cycle!.id,
      cron: '0 3 * * *',
      tz: 'UTC',
      onMissed,
      lastRunAt,
      enabled: true,
    })
    return cycle!.id
  }

  const runsFor = async (cycleId: string) =>
    (await db.select().from(schema.cycleRuns).where(eq(schema.cycleRuns.cycleId, cycleId))).length

  test('an invalid expression is rejected where it is written, not at 3am', () => {
    assert.throws(() => parseSchedule('not a cron', 'UTC'), InvalidSchedule)
    assert.doesNotThrow(() => parseSchedule('0 3 * * *', 'UTC'))
  })

  test('a schedule seen for the first time does not fire for a past occurrence', async () => {
    // Adding a nightly worker at noon must not immediately run last night's 3am. There
    // is no history to catch up on — the schedule did not exist then.
    const cycleId = await nightly('fresh', 'skip', null)
    const result = await tick(db, { now: at('2026-08-13T12:00:00Z') })

    assert.equal(result.started.length, 0)
    assert.equal(await runsFor(cycleId), 0)

    // ...and it is now anchored, so the next occurrence fires normally.
    const [row] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.cycleId, cycleId))
    assert.ok(row?.lastRunAt, 'the first sighting anchors it rather than firing')
  })

  test('an occurrence that just passed fires, whatever the policy', async () => {
    const cycleId = await nightly('ontime', 'skip', new Date('2026-08-13T02:00:00Z'))
    // 3:01am: one minute late is a normal firing, not a catch-up.
    const result = await tick(db, { now: at('2026-08-13T03:01:00Z') })

    assert.deepEqual(result.started, ['ontime'])
    assert.equal(await runsFor(cycleId), 1)
  })

  test('skip does not run a missed occurrence, and does not accumulate it', async () => {
    // Asleep through 3am, noticed at 11am. A nightly review should wait for tonight
    // rather than start against a tree that has moved on.
    const cycleId = await nightly('sleepy', 'skip', new Date('2026-08-13T02:00:00Z'))
    const result = await tick(db, { now: at('2026-08-13T11:00:00Z') })

    assert.deepEqual(result.skipped, ['sleepy'])
    assert.equal(await runsFor(cycleId), 0)

    // The next tick must not re-decide the same occurrence.
    const again = await tick(db, { now: at('2026-08-13T11:00:30Z') })
    assert.equal(again.skipped.length, 0)
    assert.equal(again.started.length, 0)
  })

  test('runOnce catches up exactly once, not once per missed day', async () => {
    // Three nights down. "Catch up, but only once" has to mean one run, or a machine
    // back from a week off starts seven.
    const cycleId = await nightly('weekly', 'runOnce', new Date('2026-08-10T03:00:00Z'))
    const result = await tick(db, { now: at('2026-08-13T11:00:00Z') })

    assert.deepEqual(result.started, ['weekly'])
    assert.equal(await runsFor(cycleId), 1, 'one run, not one per missed occurrence')

    const again = await tick(db, { now: at('2026-08-13T11:00:30Z') })
    assert.equal(again.started.length, 0, 'and it does not keep catching up')
    assert.equal(await runsFor(cycleId), 1)
  })

  test('lastRunAt advances to the occurrence, never to now', async () => {
    // Advancing to `now` would drift the schedule a little later every day.
    const cycleId = await nightly('nodrift', 'runOnce', new Date('2026-08-12T03:00:00Z'))
    await tick(db, { now: at('2026-08-13T03:00:20Z') })

    const [row] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.cycleId, cycleId))
    assert.equal(row?.lastRunAt?.toISOString(), '2026-08-13T03:00:00.000Z')
  })

  test('a disabled schedule is not evaluated', async () => {
    const cycleId = await nightly('off', 'runOnce', new Date('2026-08-12T03:00:00Z'))
    await db
      .update(schema.schedules)
      .set({ enabled: false })
      .where(eq(schema.schedules.cycleId, cycleId))

    await tick(db, { now: at('2026-08-13T11:00:00Z') })
    assert.equal(await runsFor(cycleId), 0)
  })

  test('one unparseable schedule does not stop the others', async () => {
    const good = await nightly('healthy', 'runOnce', new Date('2026-08-13T02:00:00Z'))
    const bad = await nightly('broken', 'runOnce', new Date('2026-08-13T02:00:00Z'))
    await db
      .update(schema.schedules)
      .set({ cron: 'every other tuesday' })
      .where(eq(schema.schedules.cycleId, bad))

    const result = await tick(db, { now: at('2026-08-13T03:01:00Z') })
    assert.ok(result.started.includes('healthy'))
    assert.equal(await runsFor(bad), 0)
  })

  test('the timezone is honoured, so 3am means local 3am', async () => {
    const due = await findDue(db, { now: at('2026-08-13T03:01:00Z') })
    void due
    const cycleId = await nightly('tz', 'runOnce', new Date('2026-08-13T02:00:00Z'))
    await db
      .update(schema.schedules)
      .set({ tz: 'America/New_York' })
      .where(eq(schema.schedules.cycleId, cycleId))

    // 03:01 UTC is 23:01 the previous evening in New York — not yet 3am there.
    await tick(db, { now: at('2026-08-13T03:01:00Z') })
    assert.equal(await runsFor(cycleId), 0, 'must not fire on UTC 3am')

    // 07:01 UTC is 03:01 in New York.
    await tick(db, { now: at('2026-08-13T07:01:00Z') })
    assert.equal(await runsFor(cycleId), 1)
  })

  test('upcoming reports the next firing for the UI', async () => {
    const rows = await upcoming(db)
    assert.ok(rows.length > 0)
    assert.ok(rows.every((r) => r.nextRun === null || r.nextRun > new Date()))
  })
})
