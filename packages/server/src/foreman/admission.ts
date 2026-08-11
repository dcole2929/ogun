import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'

const { breakers, jobs } = schema

export type AdmissionVerdict = { allowed: true } | { allowed: false; reason: string }

export type AdmissionLimits = {
  /** Global, machine-scoped. WSL2 caps at ~50% of Windows RAM and will OOM otherwise. */
  maxConcurrentJobs: number
  /** Consecutive failures for one worker before it stops being dispatched. */
  failureBreakerThreshold: number
}

export const DEFAULT_LIMITS: AdmissionLimits = {
  maxConcurrentJobs: 2,
  failureBreakerThreshold: 3,
}

/**
 * The gate that stops a 2am failure loop from eating the whole rate limit by morning
 * (§4.3). Each guard sits at the scope where its scarce resource actually lives:
 * concurrency is a property of the machine, the breaker is a property of a worker.
 *
 * Budgets are deliberately absent — on a subscription there is no dollar cost, and you
 * cannot pick a sensible token ceiling before knowing what one review run costs.
 */
export async function admit(
  db: Db,
  workerId: string,
  limits: AdmissionLimits = DEFAULT_LIMITS,
): Promise<AdmissionVerdict> {
  const breaker = await db.query.breakers.findFirst({ where: eq(breakers.workerId, workerId) })
  if (breaker && breaker.openedAt !== null) {
    return {
      allowed: false,
      reason: `breaker open: ${breaker.consecutiveFailures} consecutive failures since ${breaker.openedAt.toISOString()}`,
    }
  }
  return { allowed: true }
}

/** Re-checked at claim time because conditions change while a job sits in the queue —
 *  defence in depth, not the primary gate. */
export async function hasCapacity(
  db: Db,
  limits: AdmissionLimits = DEFAULT_LIMITS,
): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(inArray(jobs.state, ['claimed', 'running']))
  return (row?.n ?? 0) < limits.maxConcurrentJobs
}

export async function recordWorkerFailure(
  db: Db,
  workerId: string,
  threshold: number,
): Promise<void> {
  await db
    .insert(breakers)
    .values({ workerId, consecutiveFailures: 1 })
    .onConflictDoUpdate({
      target: breakers.workerId,
      set: {
        consecutiveFailures: sql`${breakers.consecutiveFailures} + 1`,
        updatedAt: new Date(),
        openedAt: sql`case when ${breakers.consecutiveFailures} + 1 >= ${threshold}
                           then coalesce(${breakers.openedAt}, now())
                           else ${breakers.openedAt} end`,
      },
    })
}

export async function recordWorkerSuccess(db: Db, workerId: string): Promise<void> {
  await db
    .insert(breakers)
    .values({ workerId, consecutiveFailures: 0 })
    .onConflictDoUpdate({
      target: breakers.workerId,
      set: { consecutiveFailures: 0, openedAt: null, updatedAt: new Date() },
    })
}

export async function resetBreaker(db: Db, workerId: string): Promise<void> {
  await db.update(breakers).set({ consecutiveFailures: 0, openedAt: null }).where(
    and(eq(breakers.workerId, workerId)),
  )
}
