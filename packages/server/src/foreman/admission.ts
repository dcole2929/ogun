import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { readTestCommand } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { readProjectMap } from '../config-store.ts'

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
  worker: { id: string; permissions?: string },
  limits: AdmissionLimits = DEFAULT_LIMITS,
  /**
   * What the project can offer a modifier, established once per cycle run by the caller.
   * Only consulted for a modifier; absent for every other profile, and absent for a
   * modifier is itself a refusal (see below).
   */
  modifier?: ModifierReadiness,
): Promise<AdmissionVerdict> {
  /**
   * Before the breaker, because these are different kinds of "no". An open breaker is a
   * worker that has been failing and will be admitted again once it stops; a project with
   * no image and no test command is a fact about the repository that no retry changes,
   * and it is the sentence the person reading the coverage row has to act on.
   */
  if (worker.permissions === 'modifier') {
    /**
     * Fail closed. A caller that did not establish readiness has not proved the project
     * can build an image or run a suite, and the whole rule is that a modifier which
     * cannot be verified does not run unattended — so an omission here refuses rather
     * than waves through.
     */
    if (!modifier) {
      return {
        allowed: false,
        reason:
          'modifier readiness was never established for this project, so nothing has ' +
          'confirmed its patches could be verified',
      }
    }
    if (!modifier.ready) return { allowed: false, reason: modifier.reason }
  }

  const breaker = await db.query.breakers.findFirst({ where: eq(breakers.workerId, worker.id) })
  if (breaker && breaker.openedAt !== null) {
    return {
      allowed: false,
      reason: `breaker open: ${breaker.consecutiveFailures} consecutive failures since ${breaker.openedAt.toISOString()}`,
    }
  }
  return { allowed: true }
}

/**
 * Whether a project is in a state where a modifier's work could be checked at all.
 *
 * Two requirements, and both are about verification rather than about the agent:
 *
 *   `.ogun/Dockerfile`   Without one the run gets `ogun/base`, which carries the two
 *                        agent CLIs, git and node and nothing of the project's toolchain
 *                        (§4.6). A suite cannot run in it, so a modifier in it cannot be
 *                        verified. The image is per project and built at
 *                        `ogun project add`, never at 2am, so its absence is knowable
 *                        long before a run.
 *   `tests.command`      Without one there is no suite to run. A gate that passed because
 *                        a project never said how to test itself would be worse than no
 *                        gate, because the run would report `dispatched` and the pull
 *                        request would look checked.
 *
 * Refused rather than downgraded, and refused before dispatch rather than failed after.
 * A modifier that runs and cannot be proved has already spent an agent round and left a
 * patch nobody may publish; a refusal costs nothing and names the file to edit. It is
 * also not the same fact as a failed test gate, and must never wear that name: nothing
 * about the agent's work failed here, because there was never anything to judge
 * (principle 6).
 */
export type ModifierReadiness = { ready: true } | { ready: false; reason: string }

/** What a probe found in a project's `.ogun/` directory. */
export type ModifierRequirements = {
  /** Absent when this control plane has no local copy of the project at all. */
  root?: string
  hasImage: boolean
  testCommand?: string
}

export function modifierReadiness(slug: string, found: ModifierRequirements): ModifierReadiness {
  /**
   * No path is its own refusal, and deliberately not silence. A control plane that cannot
   * see the repository cannot confirm either requirement, and "I could not check" must not
   * arrive wearing the same value as "I checked and it was fine" — that is the mistake
   * `destinationOf` made in finalize.ts, in the direction that publishes.
   */
  if (!found.root) {
    return {
      ready: false,
      reason:
        `this control plane has no local path for "${slug}", so it cannot confirm the ` +
        'project image and test command a modifier has to be verified against. Run ' +
        '`ogun project sync` on the machine holding the repo.',
    }
  }
  const missing = [
    ...(found.hasImage
      ? []
      : [
          `${slug} has no .ogun/Dockerfile, so a modifier would run in ogun/base — which ` +
            "has none of this project's toolchain and cannot run its suite",
        ]),
    ...(found.testCommand
      ? []
      : [
          `${slug} declares no tests.command in .ogun/config.yaml, so nothing could show ` +
            "a modifier's patch works",
        ]),
  ]

  return missing.length === 0 ? { ready: true } : { ready: false, reason: missing.join('; ') }
}

/**
 * The disk, read through the same machine-local path map the config store uses — never
 * from the database, because a path is a fact about a machine and §4.5 keeps it out of
 * postgres.
 *
 * Read on demand rather than cached: `ogun project sync` rewrites that map, and adding a
 * Dockerfile is exactly the thing a person does in response to being refused. Caching it
 * would mean the fix took a server restart.
 */
export async function probeProject(slug: string): Promise<ModifierRequirements> {
  const root = (await readProjectMap())[slug]
  if (!root) return { hasImage: false }
  const config = await readFile(join(root, '.ogun', 'config.yaml'), 'utf8').catch(() => null)
  return {
    root,
    hasImage: existsSync(join(root, '.ogun', 'Dockerfile')),
    ...(config === null ? {} : { testCommand: readTestCommand(config) }),
  }
}

/**
 * How many jobs may start right now, machine-wide. Re-checked at claim time because
 * conditions change while a job sits in the queue — defence in depth, not the primary
 * gate.
 *
 * A count rather than a boolean. "Is a slot free?" is the wrong question to ask on
 * behalf of a caller that then takes as many jobs as *it* wants: with one job running
 * and a cap of two, a runner reporting capacity 2 was handed two more. The cap exists
 * because WSL2 will OOM (§8), so overshooting it is the failure it was written to
 * prevent.
 */
export async function remainingCapacity(
  db: Db,
  limits: AdmissionLimits = DEFAULT_LIMITS,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(inArray(jobs.state, ['claimed', 'running']))
  return Math.max(0, limits.maxConcurrentJobs - (row?.n ?? 0))
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
