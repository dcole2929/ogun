import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import {
  credentialHealth,
  DEFAULT_WORKER_TIMEOUT_MS,
  humanDuration,
  readTestCommand,
  wouldFailAuth,
  type ControlPlanePolicies,
  type CredentialHealth,
  type CredentialOutlook,
} from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { readProjectMap } from '../config-store.ts'

const { breakers, jobs, runners, workers } = schema

export type AdmissionVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * What the *machine* can bear. Nothing here is a property of a project.
 *
 * `failureBreakerThreshold` used to live in this type and in `DEFAULT_LIMITS` beside it,
 * which is how `policies.failureBreakerThreshold` came to mean nothing: the config
 * declared it, sync posted it, and the two readers — `finalizeRun` and the Workers page —
 * each took the constant instead. Setting 5 got you 3.
 *
 * It is gone from here rather than merely defaulted from here, because a project policy
 * with a machine-scoped fallback is the same bug wearing a coat: the fallback is what
 * gets used the moment somebody forgets to thread the real value through, and nothing
 * says so. The breaker threshold now has exactly one home, `projects.policies`, reached
 * through `projectPolicies`, whose defaults come from `policiesSchema` itself.
 */
export type AdmissionLimits = {
  /** Global, machine-scoped. WSL2 caps at ~50% of Windows RAM and will OOM otherwise. */
  maxConcurrentJobs: number
}

export const DEFAULT_LIMITS: AdmissionLimits = {
  maxConcurrentJobs: 2,
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
  // Carries `runtime` and `timeoutMs` because the credential gate needs to know which
  // provider this job will authenticate against and for how long it must stay valid.
  worker: { id: string; permissions?: string; runtime?: string; timeoutMs?: number },
  /**
   * The project's control-plane policies. Required rather than defaulted: every caller
   * already holds a project, and a default here would be the same silent fallback that
   * made `failureBreakerThreshold` mean nothing for as long as it did.
   */
  policies: ControlPlanePolicies,
  /**
   * What the project can offer a modifier, established once per cycle run by the caller.
   * Only consulted for a modifier; absent for every other profile, and absent for a
   * modifier is itself a refusal (see below).
   */
  modifier?: ModifierReadiness,
  /**
   * What the fleet's runners last said about their own credentials, established once per
   * cycle run by the caller for the same reason `modifier` is: it is a query, and the
   * answer cannot differ between the nodes of one graph.
   */
  credentials?: FleetCredentials,
): Promise<AdmissionVerdict> {
  /**
   * Before the breaker, because these are different kinds of "no". An open breaker is a
   * worker that has been failing and will be admitted again once it stops; a project with
   * no image and no test command is a fact about the repository that no retry changes,
   * and it is the sentence the person reading the coverage row has to act on.
   */
  if (worker.permissions === 'modifier') {
    /**
     * `maxConcurrentModifiers: 0` first, ahead of readiness, on the same grounds the
     * sandbox-downgrade gate goes ahead of the tests gate: several refusals can be true
     * at once and the order decides which sentence a person is left holding. A project
     * that has switched modifiers off has said the operative thing; told instead that it
     * has no `.ogun/Dockerfile`, somebody writes one and the worker still does not run.
     *
     * Only zero is answered here. A cap of one that is *currently* full is not a fact
     * about the config — it is a fact about this minute, it stops being true when the
     * running job finishes, and admission's refusals are permanent: they write a
     * `skipped` job and a `refused` coverage row for the night. Turning "wait your turn"
     * into "your work was dropped" would be a worse bug than the unenforced limit. That
     * half is enforced at claim time by `modifiersOverCap`, where a job simply is not
     * handed out yet and is picked up on the next poll.
     */
    if (policies.maxConcurrentModifiers === 0) {
      return {
        allowed: false,
        reason:
          'this project sets policies.maxConcurrentModifiers: 0, so no modifier runs at ' +
          'all. Nothing about this worker failed — raise the cap in .ogun/config.yaml and ' +
          'sync if you meant it to run.',
      }
    }
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
   * it at a prompt that is fine, while the one true sentence ("desktop's Anthropic token
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
//
// **Where the fact comes from.** From the runner, on its claim, and never from this
// process's own `~/`. The control plane used to read its own disk and call the answer the
// runner's, which is correct only while they are the same host — and was already wrong on
// one host, in the direction that refuses: an `ANTHROPIC_API_KEY` exported into the
// runner's systemd unit and not the server's had the runner authenticating perfectly while
// every job was refused with a sentence that sounded certain. A machine is the only thing
// that can answer for its own disk, so the machine answers, over the same claim that
// already carries its labels and its capacity — credential health being a capability fact
// about a host in exactly the way a label is.

/** Which credential each runtime actually authenticates with, through the gateway. */
const PROVIDER_FOR_RUNTIME: Record<string, keyof CredentialOutlook> = {
  claude: 'anthropic',
  codex: 'openai',
}

/**
 * The fix, and it now names *the runner's* environment rather than "somewhere both halves
 * can see".
 *
 * That phrasing was in these strings because the check ran on the wrong machine, and it
 * was advice for working around the bug rather than a description of the system. A key
 * exported into the runner's unit is simply correct now: that is the process which
 * authenticates, and it is the process which reports. docs/setup.md's warning about
 * exporting into both units goes with it.
 */
const FIX: Record<keyof CredentialOutlook, string> = {
  anthropic:
    "run `claude` on that machine, or set ANTHROPIC_API_KEY in the runner's own " +
    'environment — an API key does not expire (docs/setup.md)',
  openai:
    "run `codex login` on that machine, or set OPENAI_API_KEY in the runner's own " +
    'environment (docs/setup.md)',
}

/** One machine's own account of what it can authenticate. */
export type RunnerCredentials = { name: string; outlook: CredentialOutlook }

/**
 * What the fleet says about itself, as of a moment.
 *
 * Two lists rather than one, and the second is the whole backwards-compatibility story.
 *
 *   `reporting`  Live runners whose report is recent enough to act on.
 *   `silent`     Live runners that have reported *nothing* recent — an older build, or a
 *                machine whose last report has aged out of the window.
 *
 * One list would collapse "this machine cannot authenticate" into "this machine has not
 * said", which is the absence-of-evidence trap pointing in the direction that refuses
 * work. With one dead reporter and one silent machine beside it, the true answer is that
 * nobody knows whether the job can run — and the true answer has to admit, because
 * admitting wrongly costs one job and refusing wrongly costs every job on the fleet, every
 * night, with a reason that reads as certain.
 */
export type FleetCredentials = {
  reporting: RunnerCredentials[]
  silent: string[]
}

/**
 * How long a runner's word is good for, and how long since a claim it still counts as
 * live.
 *
 * A runner claims every `pollIntervalMs` — three seconds by default — and the claim is the
 * heartbeat, so this is twenty missed beats. Deliberately one constant for both questions
 * and shared with the Runners page's `online` pill, because they *are* one question: a
 * machine we have not heard from is not going to run this job either, so it should stop
 * being quoted rather than be believed forever.
 *
 * Note what the window is *not* protecting against. `{ kind: 'at', expiresAt }` is an
 * absolute instant, so an old report is still exactly true about when that token dies —
 * staleness never makes an expiry wrong. What goes stale is the assumption that the
 * machine still holds that credential, and every way that assumption breaks breaks toward
 * a false refusal: somebody runs `claude`, somebody exports an API key, somebody restarts
 * the unit. A minute is short enough that the fix a refusal asks for takes effect within a
 * poll or two — the property `probeCredentials` had by reading on demand, which had to
 * survive the move to a report.
 */
export const RUNNER_STALE_MS = 60_000

/**
 * Whether this worker's runtime could authenticate for the whole of this job, on any
 * machine that could take it.
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
 * **Why one bad machine is not a refusal.** Admission runs when a cycle run is created,
 * which is before any runner has claimed anything — so "the credential state" is not one
 * state, it is one per machine. A job only one machine can authenticate is not
 * unadmittable; it is admittable *there*. This therefore refuses only what no live machine
 * can do, which is the half of the question that cannot change while the queue drains, and
 * the per-machine half is answered at claim time by `jobsThisRunnerCannotAuthenticate` —
 * where a job is held back rather than skipped, stays `queued`, and is picked up by a
 * machine that can run it. The same split `maxConcurrentModifiers` gets, for the same
 * reason: admission's refusals are permanent, and a permanent refusal is the wrong answer
 * to a condition that clears on its own.
 *
 * It deliberately does not consult `requires`/`labels`. A fleet whose only `docker`
 * machine has a dead token, with a label-less machine beside it holding a good one, is
 * admitted here and held at the claim — under-refusing, which is the safe direction, and
 * the direction the label system already behaves in for every other capability.
 *
 * **Why an unrecorded expiry is admitted.** An API key does not expire and a `~/.codex/
 * auth.json` token records no expiry anywhere a runner can read. Refusing on either would
 * refuse a machine that is working perfectly, which is the failure this function is
 * supposed to prevent, inverted.
 *
 * **Why silence is admitted.** The opposite of `modifierReadiness`, on purpose. Modifier
 * readiness is a fact about a repository, and a control plane that cannot establish it has
 * to fail closed because the consequence is an unverifiable patch. This is a fact about a
 * *machine*, and there are three ways not to have it: no fleet outlook was established at
 * all, no runner is live, or a live runner has never reported. Every one means "we have
 * not been told", and a control plane that failed closed on what it has not been told
 * would refuse every job forever the day a runner is one release behind it — a preflight
 * that becomes an outage. So silence admits, and the gateway's own `502 no_credential` and
 * the job's 401 remain the backstop they always were.
 */
export function credentialVerdict(
  worker: { runtime?: string; timeoutMs?: number },
  fleet: FleetCredentials | undefined,
  now = Date.now(),
): AdmissionVerdict {
  // Not established by the caller at all — every test that drives `startCycleRun`
  // directly, and any future path with no fleet to ask.
  if (!fleet) return { allowed: true }
  // Some live machine has told us nothing. It may be the one that takes this job, and
  // "has not said" must never be answered "so, no".
  if (fleet.silent.length > 0) return { allowed: true }
  // Nobody live at all. Queued jobs wait for a machine to wake up — that is the designed
  // behaviour of the whole claim model, and refusing them here would file a night as
  // refused because a laptop was closed at 3am.
  if (fleet.reporting.length === 0) return { allowed: true }

  const provider = worker.runtime ? PROVIDER_FOR_RUNTIME[worker.runtime] : undefined
  // A runtime nobody has taught this function about authenticates with something unknown,
  // and "I do not know which credential this needs" must not be answered "the Anthropic
  // one is dead, so no".
  if (!provider) return { allowed: true }

  const horizonMs = worker.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
  const judged = fleet.reporting.map((runner) => ({
    name: runner.name,
    health: credentialHealth(runner.outlook[provider], { now, horizonMs }),
  }))
  // One machine that can do it is enough. The job goes there, or waits for it.
  if (judged.some((r) => !wouldFailAuth(r.health))) return { allowed: true }

  /**
   * Every machine named, with what is wrong with each. On a one-runner control plane this
   * reads almost exactly as it did before this became a fleet question; on a bigger one it
   * is the difference between knowing which box to go and fix and being told only that
   * "no runner can authenticate anthropic", which sends a person round all of them.
   */
  const detail = judged.map((r) => `${r.name}: ${describeFailure(provider, r.health)}`).join('; ')
  return {
    allowed: false,
    reason:
      `no runner can authenticate ${provider} for the ${humanDuration(horizonMs)} this ` +
      `worker may run — ${detail}. ${FIX[provider]}`,
  }
}

/** The half-sentence naming what is wrong with one machine's credential. */
function describeFailure(provider: keyof CredentialOutlook, health: CredentialHealth): string {
  switch (health.state) {
    case 'absent':
      // Named as the mechanism it would actually hit, rather than implying a stale token.
      return `no ${provider} credential, so the gateway would answer 502 no_credential`
    case 'expired':
      return `OAuth token expired ${humanDuration(health.msElapsed)} ago`
    case 'expiring':
      return `OAuth token has only ${humanDuration(health.msRemaining)} left`
    default:
      /**
       * Unreachable — `wouldFailAuth` selected these and it selects exactly the three
       * above. A sentence rather than a `throw` because this runs on the path that writes
       * a refusal reason, and an exception here would replace an actionable coverage row
       * with a 500, which is the one outcome worse than an odd string.
       */
      return `${provider} credential unusable (${health.state})`
  }
}

/**
 * What every live runner last said about itself.
 *
 * Queried on demand rather than cached, exactly as `probeProject` is read on demand: the
 * fix a refusal asks for is running `claude` on some *other* machine, and that machine's
 * next claim — three seconds later — is what carries the news. A cache here would mean the
 * fix took a server restart, which is the property the old `probeCredentials` was careful
 * to avoid and this had to inherit.
 *
 * `pending` runners are excluded along with revoked ones. A pending row is a machine that
 * was invited and has never connected: it has no credential state and no ability to take
 * work, and counting it as `silent` would make it a permanent excuse to admit everything —
 * a preflight switched off by an invite nobody redeemed.
 */
export async function fleetCredentials(db: Db, now = Date.now()): Promise<FleetCredentials> {
  const rows = await db
    .select({
      name: runners.name,
      credentials: runners.credentials,
      credentialsAt: runners.credentialsAt,
      lastSeenAt: runners.lastSeenAt,
      pending: runners.pending,
      revokedAt: runners.revokedAt,
    })
    .from(runners)

  const fleet: FleetCredentials = { reporting: [], silent: [] }
  for (const row of rows) {
    const live = !row.revokedAt && !row.pending && now - row.lastSeenAt.getTime() < RUNNER_STALE_MS
    if (!live) continue
    const fresh =
      row.credentials !== null &&
      row.credentialsAt !== null &&
      now - row.credentialsAt.getTime() < RUNNER_STALE_MS
    /**
     * Not re-validated against `credentialOutlookSchema` on the way out. It was validated
     * by `claimRequestSchema` at the boundary that faces the network; re-parsing here
     * would be guarding against this control plane's own database, and the cost of getting
     * that wrong — a parse error thrown inside `startCycleRun`'s transaction — is worse
     * than the shape it would be catching.
     */
    if (fresh) {
      fleet.reporting.push({ name: row.name, outlook: row.credentials as CredentialOutlook })
    } else fleet.silent.push(row.name)
  }
  return fleet
}

/**
 * Which queued jobs this particular runner must not be handed, because *its* credential
 * for their runtime is dead or will die before they finish.
 *
 * ### Why a hold-back rather than a refusal
 *
 * The same shape as `modifiersOverCap`, for the same reason. Admission answers the
 * question that cannot change while the queue drains — no machine on the fleet can
 * authenticate this at all — and its answer is permanent: a `skipped` job and a `refused`
 * coverage row, for the night. "*This* machine cannot, right now" is not that question. It
 * stops being true the moment somebody runs `claude` over there, and it may never have
 * been true of the machine next to it. A job held back here stays `queued`, is recorded as
 * nothing, and is claimed by whichever runner can actually run it — or by this one on a
 * later poll, after the token is refreshed.
 *
 * ### Why the runner's own report and not the stored one
 *
 * The outlook arrives in the claim body, read seconds earlier by the very
 * `credentialReader` the gateway will inject from. There is no freshness window to argue
 * about and no way for the control plane's belief to diverge from what the machine will
 * actually put on the wire — which is this whole feature's failure appearing in its
 * smallest and most avoidable form.
 *
 * ### The gap it leaves, stated rather than hidden
 *
 * A fleet that degrades *after* admission — the one healthy machine's token lapsing while
 * the job sits queued — leaves that job queued indefinitely rather than refused. That is
 * exactly what `requires <@ labels` already does to a container job on a fleet with no
 * docker; it is visible on the Runs page as a pending job nothing claims; and it recovers
 * by itself the moment the credential is fixed, which a permanent refusal would not.
 *
 * Pure and separately testable: the interesting cases are a mixed queue, a runner with one
 * dead provider and one good one, and a runtime nobody has heard of, none of which need a
 * database to state.
 */
export function jobsThisRunnerCannotAuthenticate(
  candidates: Array<{ id: string; runtime?: string; timeoutMs?: number }>,
  outlook: CredentialOutlook | undefined,
  now = Date.now(),
): string[] {
  // An older runner sends nothing and gets exactly the behaviour it had before this
  // existed. Reading its silence as "no credentials" would strand every job on the fleet.
  if (!outlook) return []
  const fleet: FleetCredentials = { reporting: [{ name: 'this runner', outlook }], silent: [] }
  return candidates
    .filter((job) => !credentialVerdict(job, fleet, now).allowed)
    .map((job) => job.id)
}

/**
 * The queued jobs `jobsThisRunnerCannotAuthenticate` has to judge, with the two facts it
 * needs about each: which provider it will authenticate against, and for how long.
 *
 * `timeoutMs` comes out of `workers.config` rather than a column, the same way the claim
 * route reads it a few lines later — a worker indexed before `timeoutMs` existed has none
 * and gets the default it will actually run under, rather than zero, which would hand out
 * a doomed job.
 */
export async function queuedJobRuntimes(
  db: Db,
): Promise<Array<{ id: string; runtime: string; timeoutMs: number }>> {
  const rows = await db
    .select({ id: jobs.id, runtime: workers.runtime, config: workers.config })
    .from(jobs)
    .innerJoin(workers, eq(workers.id, jobs.workerId))
    .where(eq(jobs.state, 'queued'))
  return rows.map((r) => ({
    id: r.id,
    runtime: r.runtime,
    timeoutMs: Number((r.config as { timeoutMs?: unknown }).timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS),
  }))
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

/** One queued or in-flight modifier job, as much of it as the cap needs to know. */
export type ModifierJob = {
  id: string
  projectId: string
  /** Already claimed or running — it is spending the project's allowance right now. */
  inFlight: boolean
  priority: number
  createdAt: Date
}

/**
 * Which queued modifier jobs must not be handed out yet, because their project already
 * has `policies.maxConcurrentModifiers` of them going.
 *
 * ### Why this is a hold-back rather than a refusal
 *
 * `maxConcurrentModifiers` had no consumer at all. The only cap in force was
 * `maxConcurrentJobs`, which is the machine's — so two projects nightly-modifying
 * themselves were bounded only by how much RAM this box has, and a project that wrote
 * `maxConcurrentModifiers: 1` got whatever number the machine allowed.
 *
 * The obvious place to enforce it was admission, and it is the wrong one for the *dynamic*
 * half. Admission runs when a cycle run is created, which is before any of that run's own
 * jobs are in flight — so at the moment it would count, there is nothing to count. And its
 * refusals are permanent: a `skipped` job and a `refused` coverage row, for the night. A
 * concurrency limit that dropped tonight's second modifier because tonight's first was
 * still going would be a worse failure than not having the limit. So admission answers
 * only the question that cannot change while the queue drains — a cap of zero — and this
 * answers the one that can. A job held back here stays `queued`, is not skipped, is not
 * recorded as anything, and is claimed on a later poll.
 *
 * ### Per project, and that is the whole point
 *
 * The counter is per `projectId`, never global. `maxConcurrentJobs` is the machine's
 * scarce resource; this is a statement one repository makes about how much unattended
 * change it wants at once, and two of them sharing a counter would mean a busy project
 * throttling a quiet one for a reason neither `config.yaml` mentions.
 *
 * ### The race it does not close
 *
 * Two runners polling in the same instant can both read the same headroom and both claim,
 * overshooting by one. That is the shape `remainingCapacity` already has and the reason it
 * calls itself defence in depth: closing it needs the count inside the `FOR UPDATE SKIP
 * LOCKED` statement, which cannot hold a window function. The machine cap is the one that
 * has to be hard, because exceeding it is an OOM; exceeding this one briefly costs an
 * extra agent round. Worth knowing, not worth a lock table.
 *
 * Pure and separately testable, because the interesting cases — a full project beside an
 * empty one, a cap of zero, ordering — are arithmetic, and a test that has to stand up two
 * projects and a runner to assert arithmetic is a test about fixtures.
 */
export function modifiersOverCap(
  candidates: ModifierJob[],
  capOf: (projectId: string) => number,
): string[] {
  const byProject = new Map<string, ModifierJob[]>()
  for (const job of candidates) {
    const list = byProject.get(job.projectId)
    if (list) list.push(job)
    else byProject.set(job.projectId, [job])
  }

  const held: string[] = []
  for (const [projectId, group] of byProject) {
    const running = group.filter((j) => j.inFlight).length
    let room = Math.max(0, capOf(projectId) - running)
    /**
     * Ordered the way the claim orders, so the jobs kept back are the ones the claim
     * would have reached last. Sorting differently here would hold back a high-priority
     * job to make room for one the claim then does not take, and the slot goes unused.
     */
    const queued = group
      .filter((j) => !j.inFlight)
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
    for (const job of queued) {
      if (room > 0) room -= 1
      else held.push(job.id)
    }
  }
  return held
}

/**
 * The rows `modifiersOverCap` needs, in one statement.
 *
 * `innerJoin` on workers rather than a column on `jobs`: the permission profile is the
 * worker's, and a job whose worker has since been deleted (`worker_id` goes null, §4.4)
 * cannot be claimed anyway — the claim's own join drops it — so it is not a modifier this
 * cap has to reserve room for.
 */
export async function modifierJobs(db: Db): Promise<ModifierJob[]> {
  const rows = await db
    .select({
      id: jobs.id,
      projectId: jobs.projectId,
      state: jobs.state,
      priority: jobs.priority,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(workers, eq(workers.id, jobs.workerId))
    .where(
      and(
        eq(workers.permissions, 'modifier'),
        inArray(jobs.state, ['queued', 'claimed', 'running']),
      ),
    )
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    inFlight: r.state !== 'queued',
    priority: r.priority,
    createdAt: r.createdAt,
  }))
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
