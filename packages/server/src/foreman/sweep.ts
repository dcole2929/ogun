import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { finalizeRun } from './finalize.ts'

const { coverage, jobs, runs } = schema

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
        // Never ran, whatever the reason. `blocked` is the honest outcome; the reason
        // says it was reconciled rather than observed, so a stale row is not mistaken
        // for a decision something actually made.
        outcome: 'blocked',
        ran: false,
        reason: `job ended as ${row.jobState} without reporting a run`,
      })
      .where(eq(coverage.id, row.id))
  }
  return stale.length
}