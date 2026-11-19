import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { finalizeRun } from './finalize.ts'
import { finalizeCycleIfDone, releaseDependents } from './cycles.ts'

const { coverage, cycleRuns, jobs, runs } = schema

/**
 * On a runner crash everything already flushed is durable, but the job stays `running`
 * forever unless something sweeps it (§5.1). Anything claimed longer than the timeout
 * is failed with an explicit reason — never left ambiguous, and never silently retried,
 * since v1 has no retry loop.
 */
export async function sweepStaleClaims(db: Db, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const stale = await db
    .select({ jobId: jobs.id, runId: runs.id })
    .from(jobs)
    .leftJoin(runs, eq(runs.jobId, jobs.id))
    .where(
      and(
        inArray(jobs.state, ['claimed', 'running']),
        lt(jobs.claimedAt, cutoff),
        sql`${runs.endedAt} is null`,
      ),
    )

  for (const row of stale) {
    if (!row.runId) {
      await db.update(jobs).set({ state: 'failed' }).where(eq(jobs.id, row.jobId))
      continue
    }
    /**
     * Racing the runner, in both directions: this row was selected as un-ended, and the
     * runner it gave up on may report between that select and this write — or minutes
     * after it. `finalizeRun` claims the run's terminal state rather than assigning it,
     * so whichever of the two gets there first is the one that stands and the other
     * applies nothing. Nothing here needs to check; the loser is told what was recorded.
     */
    await finalizeRun(db, {
      runId: row.runId,
      outcome: 'error',
      detail: `stale claim: no report within ${Math.round(maxAgeMs / 60_000)}m`,
      gates: [],
      coverage: { outcome: 'errored', reason: 'runner went away' },
      artifacts: [],
    })
  }
  return stale.length
}


/**
 * `pending` means "selected and queued, waiting for a runner". A job that has already
 * reached a terminal state and still carries it is stating something false — and the
 * coverage ledger is the one table whose entire purpose is to be true about what ran
 * (principle 6). An empty findings list is only trustworthy if this is.
 *
 * Reachable through more than one path: a cancelled job (fixed at the source), a job
 * skipped by admission after the row was written, or anything that moved a job by hand.
 * Rather than chase each, the sweep reconciles from job state, which is the fact.
 */
export async function reconcileCoverage(db: Db): Promise<number> {
  const stale = await db
    .select({ id: coverage.id, jobState: jobs.state })
    .from(coverage)
    .innerJoin(
      jobs,
      and(eq(jobs.cycleRunId, coverage.cycleRunId), eq(jobs.workerId, coverage.workerId)),
    )
    .where(
      and(
        eq(coverage.outcome, 'pending'),
        inArray(jobs.state, ['succeeded', 'failed', 'skipped']),
      ),
    )

  for (const row of stale) {
    await db
      .update(coverage)
      .set({
        // `abandoned`, not `blocked`: nothing blocked it. The job simply ended without
        // the ledger being told, and this row is the sweep's inference from job state
        // rather than something anyone observed.
        outcome: 'abandoned',
        ran: false,
        reason: `job ended as ${row.jobState} without reporting a run`,
      })
      .where(eq(coverage.id, row.id))
  }
  return stale.length
}

/**
 * Cycle runs that can no longer move on their own.
 *
 * `releaseDependents` is called when a job finishes, which is the right moment for every
 * cycle that has a job still to finish. A cycle where nothing is queued, claimed or
 * running and something is still `blocked` has no such moment left: whatever was going to
 * end has ended, and the blocked node is waiting on a signal that will never be sent. It
 * sits there, and the Runs page says "waiting on a dependency" in the same words it uses
 * for a job that is about to start.
 *
 * Two bugs put cycles in that state and both are fixed at the source — a release pass
 * that resolved only one layer of the graph, and admission refusing an entry node without
 * anything sweeping the nodes behind it. This is not those fixes. It is the reconciliation
 * that repairs what they already left behind, and the one that catches a control plane
 * killed between a job going terminal and the sweep that follows it. On the machine this
 * was written against there were twenty-seven, the oldest two months old.
 *
 * The predicate is **nothing in flight**, and nothing more. A cycle with a job queued,
 * claimed or running still has a moment coming, so it is never touched; a cycle without
 * one cannot move again whatever its jobs say, and there are two ways to be in that
 * state. Something is still `blocked` and needs releasing, or everything is already
 * terminal and the run was simply never closed.
 *
 * The first draft required a blocked job and missed the second case entirely — sixteen
 * `nightly` runs whose three reviewers were all refused at admission, every job terminal,
 * every run reporting `running` since September. They are the same defect wearing a
 * different shape: nothing called the finalizer because nothing finished. Asking only
 * whether the cycle can still move catches both, and both are repaired by the same two
 * idempotent calls — so the cost of being wrong about a candidate is two reads.
 *
 * Returns the number of cycle runs it moved, for the same reason the sweeps above do:
 * silence and "there was nothing to do" must not be the same log line.
 */
export async function reconcileStalledCycles(db: Db): Promise<number> {
  const stalled = await db
    .select({ id: jobs.cycleRunId })
    .from(jobs)
    .innerJoin(cycleRuns, eq(cycleRuns.id, jobs.cycleRunId))
    .where(and(eq(cycleRuns.state, 'running'), isNull(cycleRuns.endedAt)))
    .groupBy(jobs.cycleRunId)
    .having(sql`count(*) filter (where ${jobs.state} in ('queued', 'claimed', 'running')) = 0`)

  let moved = 0
  for (const { id } of stalled) {
    /**
     * Serial, and one failure does not stop the rest. These are independent cycles that
     * have already been stuck for however long they have been stuck; a transient error on
     * one is not a reason to leave the other twenty-six where they are.
     */
    try {
      await releaseDependents(db, id)
      await finalizeCycleIfDone(db, id)
      moved++
    } catch (err) {
      console.error(`[foreman] could not reconcile cycle run ${id}`, err)
    }
  }
  return moved
}
