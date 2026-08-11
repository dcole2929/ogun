import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { finalizeRun } from './finalize.ts'

const { jobs, runs } = schema

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
