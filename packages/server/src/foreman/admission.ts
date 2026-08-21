import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { DEFAULT_WORKER_TIMEOUT_MS, readTestCommand } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { credentialHealth, credentialOutlook, humanDuration, readCredentials } from '@ogun/gateway'
import type { CredentialOutlook } from '@ogun/gateway'
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
  worker: { id: string; permissions?: string; runtime?: string; timeoutMs?: number },
  limits: AdmissionLimits = DEFAULT_LIMITS,
  /**
   * What the project can offer a modifier, established once per cycle run by the caller.
   * Only consulted for a modifier; absent for every other profile, and absent for a
   * modifier is itself a refusal (see below).
   */
  modifier?: ModifierReadiness,
  /**
   * What the runner host's credential files say, established once per cycle run by the
   * caller for the same reason `modifier` is: it reads the disk, and the answer cannot
   * differ between the nodes of one graph.
   */
  credentials?: CredentialOutlook,
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

  /**
   * Before the breaker, and that ordering is the point rather than an accident.
   *
   * A lapsed credential fails every job on the machine. Three nights of that and every
   * worker has an open breaker, so the reason attached to each refusal becomes "breaker
   * open: 3 consecutive failures" — a sentence about the worker, pointing whoever reads
   * it at a prompt that is fine, while the one true sentence ("the host's Anthropic token
   * expired on Tuesday") is nowhere in the record. Saying the credential first turns a
   * fleet of misleading refusals into one actionable one.
   */
  const credential = credentialVerdict(worker, credentials)
  if (!credential.allowed) return credential

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

// ── The credential preflight ───────────────────────────────────────────────
//
// Both agent CLIs authenticate with OAuth access tokens that expire, and the gateway does
// not refresh them — it re-reads the file the host's own `claude` rewrites whenever a
// human runs it. Nothing runs it on an unattended runner. So the token lapses, the
// gateway keeps splicing a dead one onto every request, and the whole 3am cycle fails on
// auth with nothing in the record naming the cause: the container's placeholder is fine,
// the gateway is up, and what the transcript shows is a provider 401 that reads as "go
// re-authenticate", pointing at the credential that is already there.
//
// This is the half of the answer that runs before dispatch. `ogun runner doctor` is the
// other half and is the one a person reads; this one is what stops the night being spent.

/** Which credential each runtime actually authenticates with, through the gateway. */
const PROVIDER_FOR_RUNTIME: Record<string, keyof CredentialOutlook> = {
  claude: 'anthropic',
  codex: 'openai',
}

const FIX: Record<keyof CredentialOutlook, string> = {
  anthropic:
    'run `claude` on the runner host, or set ANTHROPIC_API_KEY where both the control ' +
    'plane and the runner can see it — an API key does not expire (docs/setup.md)',
  openai:
    'run `codex login` on the runner host, or set OPENAI_API_KEY where both the control ' +
    'plane and the runner can see it (docs/setup.md)',
}

/**
 * Whether this worker's runtime could authenticate for the whole of this job.
 *
 * **Why refuse rather than dispatch and let it fail.** A dispatched job that cannot
 * authenticate spends a runner slot, an agent round and a workspace clone to arrive at a
 * 401, and then lands in the ledger as a *failure* — which is the wrong name for it
 * twice over. Nothing about the worker failed; the machine could not log in. And a run
 * filed as a failure latches the consecutive-failure breaker, so a credential that lapsed
 * on Tuesday has, by Friday, disabled every worker on the project for reasons that will
 * still be there after the token is fixed. A refusal costs nothing, writes one coverage
 * row per node saying exactly which credential and exactly what to type, and touches no
 * breaker (principle 6: "didn't run" is not "ran and failed").
 *
 * **Why the horizon is the job's own timeout, not "right now".** A token with five
 * minutes left passes any is-it-valid test and dies in the middle of a thirty-minute run
 * — same 401, same night, later. `timeoutMs` is how long this worker is permitted to run,
 * so it is exactly the window the credential has to cover. Note what this deliberately
 * does *not* do: it does not refuse a codex job because the Anthropic token is dead, and
 * it does not refuse anything over the GitHub token, whose absence is the intended
 * default (ADR-0005).
 *
 * **Why an unrecorded expiry is admitted.** An API key does not expire and a `~/.codex/
 * auth.json` token records no expiry anywhere this can read. Refusing on either would
 * refuse a machine that is working perfectly, which is the failure this function is
 * supposed to prevent, inverted.
 *
 * **Why no outlook at all is admitted.** The opposite of `modifierReadiness`, on purpose.
 * Modifier readiness is a fact about a repository, and a control plane that cannot
 * establish it has to fail closed because the consequence is an unverifiable patch. This
 * is a fact about the *runner host*, which the control plane can only see while they are
 * the same machine (§3, ADR-0001). When they separate, a control plane that failed closed
 * on what it could not see would refuse every job forever — a preflight that becomes an
 * outage. So absence means "not checked", the gateway's own `502 no_credential` and the
 * job's 401 remain the backstop, and the seam is here for a runner that reports its own
 * credential state later.
 */
export function credentialVerdict(
  worker: { runtime?: string; timeoutMs?: number },
  outlook: CredentialOutlook | undefined,
  now = Date.now(),
): AdmissionVerdict {
  if (!outlook) return { allowed: true }
  const provider = worker.runtime ? PROVIDER_FOR_RUNTIME[worker.runtime] : undefined
  // A runtime nobody has taught this function about authenticates with something unknown,
  // and "I do not know which credential this needs" must not be answered "the Anthropic
  // one is dead, so no".
  if (!provider) return { allowed: true }

  const horizonMs = worker.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
  const health = credentialHealth(outlook[provider], { now, horizonMs })
  const fix = FIX[provider]
  switch (health.state) {
    case 'absent':
      return {
        allowed: false,
        reason:
          `there is no ${provider} credential on this host, so the gateway would answer ` +
          `502 no_credential for every request this job made — ${fix}`,
      }
    case 'expired':
      return {
        allowed: false,
        reason:
          `the host's ${provider} OAuth token expired ${humanDuration(health.msElapsed)} ` +
          `ago, so this job would 401 on its first request — ${fix}`,
      }
    case 'expiring':
      return {
        allowed: false,
        reason:
          `the host's ${provider} OAuth token has ${humanDuration(health.msRemaining)} ` +
          `left and this worker may run for ${humanDuration(horizonMs)}, so it would 401 ` +
          `partway through — ${fix}`,
      }
    default:
      return { allowed: true }
  }
}

/**
 * The credential files on the machine this control plane is running on.
 *
 * Correct only while the control plane and the runner are the same host, which §3 says
 * they are and ADR-0001 says they will not always be. Two things follow, and both are
 * deliberate: `credentialVerdict` takes the outlook as an argument and never reads a file
 * itself, so the day a runner reports its own state this function is the only thing that
 * has to go; and the refusal text says "where both the control plane and the runner can
 * see it", because the one way this is wrong *today* is an `ANTHROPIC_API_KEY` exported
 * into the runner's unit and not the server's — the runner would authenticate fine and
 * the control plane would refuse every job with a reason that looks certain.
 *
 * Read on demand rather than cached, exactly as `probeProject` is: running `claude` on
 * the host is the fix this refusal asks for, and a cached answer would mean it took a
 * server restart to take effect.
 */
export function probeCredentials(): CredentialOutlook {
  return credentialOutlook(readCredentials())
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
