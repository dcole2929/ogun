import { and, eq, isNull } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'

const { runners } = schema

/**
 * Whether anything can ever claim a queued job, and — when nothing can right now — which
 * of the two reasons it is.
 *
 * A job whose `requires` no runner satisfies is not refused, retried or timed out. The
 * claim query's `requires <@ labels` simply does not match, so the row stays `queued`,
 * indefinitely, looking exactly like a row that is about to be picked up. Nothing errors
 * and nothing is recorded. That is the failure principle 6 exists to forbid, and honouring
 * `workers.*.requires` at all is what makes it reachable — so the diagnostic ships with
 * the feature rather than after it.
 *
 * ### Why three states and not a boolean
 *
 * The queue view answered this with `claimable: boolean` computed against *online*
 * runners, which folded two situations with nothing in common into one word. A job whose
 * only GPU machine is rebooting was reported as "nothing can run this" — false, and
 * identical to the sentence shown when it is true. Somebody who reads that once about a
 * machine that returns ninety seconds later has learned to disbelieve the message, and the
 * case it exists for is the one they will disbelieve.
 *
 *  - `claimable` — a runner that satisfies it is up now. Waiting its turn.
 *  - `offline` — one is registered and not up. It resolves itself when that machine
 *    returns, so this is a fact about the fleet's uptime, not about the job.
 *  - `unmatched` — no live runner has ever advertised one of these labels. This is the
 *    one that never resolves on its own, and `missing` names the labels so the reader is
 *    sent to the line they wrote rather than to a Runners page where everything is green.
 *
 * ### Why this is not an admission refusal
 *
 * Because `unmatched` is a fact about this minute and admission's refusals are permanent —
 * a `skipped` job and a `refused` coverage row. The GPU box being provisioned this
 * afternoon, the laptop that has not re-run `ogun runner init` since the label was added,
 * a runner rebuilt after a disk failure: in each of those the job is waiting for a machine
 * that is coming, and discarding it because the machine has not arrived is worse than the
 * wait. The wait was never the bug. Nobody being told was.
 */
export type Reach = 'claimable' | 'offline' | 'unmatched'

export type ReachVerdict = {
  reach: Reach
  /** Non-empty exactly when `reach` is `unmatched`. */
  missing: string[]
}

/**
 * A machine counts as up if it has been seen inside this window. It is the runner's poll
 * interval with room for one missed beat — a runner polls every few seconds, so a minute
 * of silence is a machine that is genuinely gone rather than one mid-request.
 */
const STALE_MS = 60_000

export type Fleet = {
  /** Registered, not revoked, and past enrollment — whether or not it is up. */
  live: number
  online: number
  verdict: (requires: string[]) => ReachVerdict
}

/**
 * The fleet as it is right now, read once and asked many times.
 *
 * A function over a snapshot rather than a query per job: the queue view asks this of
 * fifty rows, and fifty round trips to answer one question about one set of machines is
 * both slower and *wrong* — a fleet that changed halfway down the list would produce a
 * page whose rows disagree about which runners exist.
 *
 * `pending` and revoked runners are excluded. A revoked runner is a machine somebody took
 * away; a pending one is an invite that has never been run, still carrying the empty
 * default set of labels. Neither is evidence that a capability exists here, and counting
 * either would suppress the one message that fits.
 */
export async function fleet(db: Db): Promise<Fleet> {
  const rows = await db
    .select({ labels: runners.labels, lastSeenAt: runners.lastSeenAt })
    .from(runners)
    .where(and(isNull(runners.revokedAt), eq(runners.pending, false)))

  const now = Date.now()
  const up = rows.filter((r) => now - r.lastSeenAt.getTime() < STALE_MS)
  const advertised = new Set(rows.flatMap((r) => r.labels))

  return {
    live: rows.length,
    online: up.length,
    verdict: (requires) => {
      const missing = requires.filter((label) => !advertised.has(label))
      if (missing.length > 0) return { reach: 'unmatched', missing }
      const claimable = up.some((r) => requires.every((label) => r.labels.includes(label)))
      return { reach: claimable ? 'claimable' : 'offline', missing: [] }
    },
  }
}
