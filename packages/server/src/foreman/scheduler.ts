import { Cron } from 'croner'
import { and, eq, isNull } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { fleetCredentials } from './admission.ts'
import { startCycleRun } from './cycles.ts'

const { cycles, schedules } = schema

/**
 * Time-based triggers (§4.2).
 *
 * Croner evaluates the expression; everything else here is about the two things a cron
 * library does not answer on a laptop.
 *
 * **Schedules are re-read every tick, not registered once.** The obvious implementation
 * registers callbacks at boot from whatever config existed then, so editing a worker
 * hot-reloads but *adding* one needs a restart — and adding workers is what you do
 * constantly in the first weeks.
 *
 * **The machine is not always on.** WSL2 stops when Windows sleeps, hibernates, or
 * reboots for an update, so occurrences are missed as a matter of course rather than as
 * an exception. Firing is therefore derived from `nextRun(lastRunAt)` rather than from a
 * timer: a schedule is due when its next occurrence after the last one has passed, which
 * is true whether the machine was awake for it or not.
 *
 * **An occurrence is claimed, not assumed.** `lastRunAt` is both the cursor the decision
 * is read from and the record that the decision was acted on, so evaluating and acting
 * are a compare-and-set on one row rather than a read, a slow start, and a later write
 * (see `tick`).
 */
export type SchedulerOptions = {
  /**
   * How late an occurrence can be and still count as "now" rather than "missed". Wider
   * than the tick interval, or a tick that lands a second late would treat an ordinary
   * firing as a catch-up and apply the missed-run policy to it.
   */
  graceMs?: number
  now?: () => Date
}

export type Due = {
  scheduleId: string
  cycleId: string
  /** The occurrence this run is *for*, not the moment we noticed. */
  occurrence: Date
  /**
   * The cursor this decision was derived from. `tick` advances `lastRunAt` only while it
   * is still this value, which is what makes the decision a claim rather than an opinion
   * another tick can hold at the same time.
   */
  readFrom: Date
  missed: boolean
  policy: 'skip' | 'runOnce'
}

export class InvalidSchedule extends Error {}

/** Parse once, so an unusable expression is a startup error rather than a silent no-op. */
export function parseSchedule(expression: string, tz: string): Cron {
  try {
    return new Cron(expression, { timezone: tz })
  } catch (err) {
    throw new InvalidSchedule(`"${expression}" is not a valid cron expression: ${(err as Error).message}`)
  }
}

/** The last occurrence at or before `now`, found by stepping forward from `after`. */
function latestOccurrence(cron: Cron, after: Date, now: Date): Date | null {
  let last: Date | null = null
  let cursor = after
  // Bounded: a per-minute schedule unattended for a month is ~43k steps, and stopping
  // early simply means the remaining catch-up happens on the next tick.
  for (let i = 0; i < 10_000; i++) {
    const next = cron.nextRun(cursor)
    if (!next || next.getTime() > now.getTime()) break
    last = next
    cursor = next
  }
  return last
}

/**
 * What is due right now. Pure: it reads schedules and returns decisions, so the policy
 * can be tested without a database full of side effects.
 */
export async function findDue(db: Db, opts: SchedulerOptions = {}): Promise<Due[]> {
  const now = opts.now?.() ?? new Date()
  const graceMs = opts.graceMs ?? 5 * 60_000

  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true))
  const due: Due[] = []

  for (const row of rows) {
    let cron: Cron
    try {
      cron = parseSchedule(row.cron, row.tz)
    } catch {
      // A bad expression must not stop every other schedule from being evaluated.
      continue
    }

    /**
     * A schedule seen for the first time starts from now, so adding a nightly worker at
     * noon does not immediately fire last night's 3am occurrence. There is no history to
     * catch up on — the schedule did not exist then.
     */
    if (!row.lastRunAt) {
      // Conditional for the same reason the claim below is: a tick that read the row
      // while it was still unanchored could otherwise land its `now` on top of a cursor
      // a later tick had already advanced past an occurrence, rewinding the schedule and
      // re-firing that occurrence.
      await db
        .update(schedules)
        .set({ lastRunAt: now })
        .where(and(eq(schedules.id, row.id), isNull(schedules.lastRunAt)))
      continue
    }

    const occurrence = latestOccurrence(cron, row.lastRunAt, now)
    if (!occurrence) continue

    due.push({
      scheduleId: row.id,
      cycleId: row.cycleId,
      occurrence,
      readFrom: row.lastRunAt,
      missed: now.getTime() - occurrence.getTime() > graceMs,
      policy: row.onMissed === 'runOnce' ? 'runOnce' : 'skip',
    })
  }
  return due
}

export type TickResult = { started: string[]; skipped: string[] }

/**
 * Evaluate and act. Returns what it did rather than logging, so a caller can report it
 * and a test can assert it.
 *
 * Concurrent ticks are ordinary, not exceptional: the driver is a `setInterval` that does
 * not wait for the previous callback (§4.2, and see `main.ts`), and `startCycleRun`
 * creates a CycleRun plus a job per node, which is not fast. Two ticks that overlapped
 * therefore both read the same `lastRunAt`, both found the same occurrence due, and both
 * fired it — two nightly runs, twice the containers, and two sets of findings racing into
 * one inbox. Nothing downstream could tell them apart, because both were legitimately
 * "the 3am run".
 */
export async function tick(db: Db, opts: SchedulerOptions = {}): Promise<TickResult> {
  const now = opts.now?.() ?? new Date()
  const result: TickResult = { started: [], skipped: [] }

  for (const item of await findDue(db, opts)) {
    const cycle = await db.query.cycles.findFirst({ where: eq(cycles.id, item.cycleId) })
    if (!cycle) continue

    /**
     * The claim, and it comes *before* the run rather than after it.
     *
     * `lastRunAt` is the only thing that says an occurrence has been dealt with, so
     * advancing it conditionally on it still being what `findDue` read makes the check
     * and the claim one statement: exactly one racer gets a row back, the loser sees the
     * predicate no longer holds and does nothing at all. Same shape as consuming an
     * invite (`routes/runners.ts`) and claiming a run's terminal state (`finalize.ts`).
     *
     * Advanced to the *latest* occurrence, never to `now`, and whether or not the run is
     * skipped. Using now would drift the schedule; leaving it behind would re-fire every
     * tick, and `runOnce` would become "run once per tick until you catch up", which is
     * the opposite of what it says.
     *
     * Claiming first means a `startCycleRun` that throws burns the occurrence instead of
     * leaving it to be retried, and that is the direction to fail in: the alternative
     * retries on every tick, so a cycle that cannot start — an unknown worker, an
     * unparseable definition — would spend the night creating a half-built CycleRun every
     * 30 seconds. At most once is what a nightly review means.
     */
    const [claimed] = await db
      .update(schedules)
      .set({ lastRunAt: item.occurrence })
      .where(and(eq(schedules.id, item.scheduleId), eq(schedules.lastRunAt, item.readFrom)))
      .returning()
    if (!claimed) continue

    /**
     * A missed occurrence under `skip` is deliberately not run. A nightly review that
     * slept through 3am should wait for tonight rather than start at 11am against a tree
     * that has moved on — and either way `lastRunAt` advanced above, so the catch-up does
     * not accumulate.
     */
    const shouldRun = !item.missed || item.policy === 'runOnce'

    if (shouldRun) {
      /**
       * Read here rather than once outside the loop: the fix for a refusal is running
       * `claude` on a runner, whose next claim lands three seconds later, and a tick that
       * started before that happened should not go on refusing cycles it evaluates
       * afterwards. One small query against work measured in minutes.
       *
       * This is the path the whole preflight is for — 3am, nobody watching, and the token
       * that was refreshed by hand a week ago.
       */
      await startCycleRun(db, {
        cycleId: item.cycleId,
        trigger: item.missed ? 'cron:missed' : 'cron',
        credentials: await fleetCredentials(db),
      })
      result.started.push(cycle.name)
    } else {
      result.skipped.push(cycle.name)
    }
  }

  void now
  return result
}

/** When each enabled schedule fires next, for the UI. */
export async function upcoming(
  db: Db,
): Promise<Array<{ cycleId: string; cron: string; tz: string; nextRun: Date | null; onMissed: string }>> {
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true))
  return rows.map((row) => {
    let nextRun: Date | null = null
    try {
      nextRun = parseSchedule(row.cron, row.tz).nextRun() ?? null
    } catch {
      nextRun = null
    }
    return { cycleId: row.cycleId, cron: row.cron, tz: row.tz, nextRun, onMissed: row.onMissed }
  })
}
