import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import {
  cycleDefinitionSchema,
  isTerminal,
  workerRequirements,
  type CycleDefinition,
  type JobState,
  type WorkerConfig,
} from '@ogun/core'
import {
  admit,
  modifierReadiness,
  probeProject,
  type FleetCredentials,
  type ModifierReadiness,
} from './admission.ts'
import { projectPolicies } from './policies.ts'

const { coverage, cycleRuns, cycles, jobs, projects, runs, skills, workers } = schema

export type StartCycleRunInput = {
  cycleId: string
  trigger: string
  /** Per-node prompt override, keyed by node key. Used by a manual trigger. */
  promptOverrides?: Record<string, string>
  /**
   * Per-node text *appended* to whatever the prompt layers resolved to, keyed by node key.
   * What a source hands the entry node: the ticket (§4.13, ADR-0013).
   *
   * §5.1 says a source "may override" the prompt, and this is the one place the
   * implementation deliberately does not do what that sentence says. The resolved prompt
   * is the sentence naming the skill — *"Use the scope-evaluation skill."* — and replacing
   * it with ticket text leaves the agent holding a feature request and no idea what it has
   * been asked to do about it. Rebuilding that sentence inside the source would put a
   * second copy of the layering rule somewhere it can drift from this one.
   *
   * So the layers decide *what to do* and this decides *what to do it to*, and the job's
   * prompt is the two concatenated. A manual trigger still overrides outright, which is
   * what a person typing a prompt means.
   */
  promptContext?: Record<string, string>
  /**
   * What the project can offer a modifier (§4.3). Established by this function from the
   * disk when omitted; a seam, because a test that has to lay out a real repository to
   * assert an admission rule is a test about filesystems.
   */
  modifierReadiness?: ModifierReadiness
  /**
   * What the fleet's runners last reported about their own credentials (§4.3), for the
   * preflight that refuses a job no live machine could authenticate.
   *
   * Established by the caller and — unlike `modifierReadiness` — deliberately *not*
   * established here when it is missing. Every trigger passes through this function,
   * including the twenty-odd tests that call it directly; those tests are about graph
   * shape and admission arithmetic, and a default would make each of their outcomes
   * depend on which rows happen to be in `runners`. That was a sharper edge when this read
   * a file — green on a laptop somebody used this morning, red on CI — and it is a milder
   * one now, but the reason holds: a test that has to stand up a live runner with a fresh
   * credential report to assert something about edges is a test about fixtures.
   *
   * The two production callers — `scheduler.ts` for cron and `routes/trigger.ts` for a
   * manual run — pass it. Omitting it means the credential guard does not run, which is
   * the documented open case: the gateway's `502 no_credential` and the provider's 401
   * are still there behind it.
   */
  credentials?: FleetCredentials
}

/**
 * Create a CycleRun and its jobs. Entry nodes (no incoming edges) go straight to
 * `queued`; everything else starts `blocked` and is released as its dependencies go
 * terminal.
 *
 * Admission runs here, before a job is ever queued. A refused node still gets a job row
 * in `skipped` and a coverage row saying why — principle 6: "didn't run" must be a
 * recorded fact, not an absence.
 */
export async function startCycleRun(
  db: Db,
  input: StartCycleRunInput,
): Promise<{ cycleRunId: string; jobIds: string[] }> {
  const cycle = await db.query.cycles.findFirst({ where: eq(cycles.id, input.cycleId) })
  if (!cycle) throw new Error(`no such cycle: ${input.cycleId}`)

  const definition = cycleDefinitionSchema.parse(cycle.definition)
  const byName = await resolveWorkers(db, cycle.projectId, definition)
  const skillPrompts = await resolveSkillPrompts(db, cycle.projectId)

  /**
   * Established once, here, and only when the graph actually contains a modifier.
   *
   * Once because it is a property of the project rather than of a node, and here because
   * it reads the disk — a probe inside the transaction below would hold a write
   * transaction open across filesystem I/O, and would repeat it per node for an answer
   * that cannot differ between them.
   */
  const readiness = [...byName.values()].some((w) => w.permissions === 'modifier')
    ? (input.modifierReadiness ?? (await probeReadiness(db, cycle.projectId)))
    : undefined

  /**
   * The project's own policies, read once for the same reason readiness is: they are a
   * property of the project, not of a node, and every node in this graph belongs to one
   * project. Read outside the transaction so a write transaction is not held open across
   * a lookup none of the writes depend on.
   *
   * Control-plane half only — `ControlPlanePolicies`, not `Policies`. The publisher's
   * `maxOpenPullRequests` and the sandbox's `allowSandboxDowngrade` are read by the runner
   * from the git blob at the pinned base, because a modifier can write to its checkout
   * (§4.6, ADR-0009); admission has no business holding a second copy of either, and the
   * type is what stops one appearing here later.
   */
  const { policies } = await projectPolicies(db, cycle.projectId)

  return db.transaction(async (tx) => {
    const [cycleRun] = await tx
      .insert(cycleRuns)
      .values({
        cycleId: cycle.id,
        // Frozen here, so everything downstream reads the graph this run began with
        // rather than a `cycles` row that `ogun project sync` can rewrite mid-flight.
        cycleName: cycle.name,
        definition,
        trigger: input.trigger,
        state: 'running',
      })
      .returning()
    if (!cycleRun) throw new Error('failed to create cycle run')

    const jobIds: string[] = []
    for (const node of definition.nodes) {
      const worker = byName.get(node.worker)
      /**
       * `reindexProject` refuses a definition naming a worker the file does not define,
       * so by the time a cycle is stored this cannot be a typo anyone can go and fix.
       * Reaching it means a graph written before that check existed, or a worker row that
       * went missing some other way — a fault of ours, and it stays a 500. Kept because
       * the alternative is a run whose jobs reference nothing.
       */
      if (!worker) throw new Error(`cycle references unknown worker: ${node.worker}`)

      const dependsOn = definition.edges.filter((e) => e.to === node.key).map((e) => e.from)
      const verdict = worker.enabled
        ? await admit(
            tx,
            {
              id: worker.id,
              permissions: worker.permissions,
              // The runtime decides *which* credential has to be alive, and the timeout
              // decides for how long — a worker permitted to run for two hours needs more
              // of a token left than one capped at ten minutes.
              runtime: worker.runtime,
              ...timeoutOf(worker.config),
              // The exemption from `modifierReadiness`, out of the stored config for the
              // same reason `timeoutMs` is: `workers.config` is the whole parsed worker,
              // so a worker indexed before this field existed simply has none — which is
              // also what every ordinary worker has, and is the direction that refuses.
              ...bootstrapOf(worker.config),
            },
            policies,
            readiness,
            input.credentials,
          )
        : ({ allowed: false, reason: 'worker disabled' } as const)

      const state: JobState = !verdict.allowed ? 'skipped' : dependsOn.length ? 'blocked' : 'queued'
      /**
       * The prompt layers, most specific first (§5.1). The skill's own `default_prompt`
       * from its agents/*.yaml is the base — it was being stored by sync and then never
       * read, so a skill that declared anything other than the obvious one-liner had it
       * silently ignored.
       */
      const resolved =
        input.promptOverrides?.[node.key] ??
        node.prompt ??
        (worker.config as { prompt?: string }).prompt ??
        skillPrompts.get(worker.skillRef) ??
        `Use the ${worker.skillRef} skill.`
      // Appended, never substituted — see `promptContext`. Blank line between, because the
      // two halves are written by different authors and run together they read as one
      // sentence that trails off.
      const context = input.promptContext?.[node.key]
      const prompt = context ? `${resolved}\n\n${context}` : resolved

      const [job] = await tx
        .insert(jobs)
        .values({
          cycleRunId: cycleRun.id,
          workerId: worker.id,
          workerName: worker.name,
          projectId: cycle.projectId,
          nodeKey: node.key,
          prompt,
          dependsOn,
          /**
           * The columns *and* the stored config. `workerRequirements` used to live in
           * this file and take only `{runtime, sandbox}`, so a worker's `requires:` — a
           * field the schema documents, sync stores, the API returns and the UI is
           * careful to preserve through a PATCH — reached the queue as nothing at all.
           *
           * Snapshotted onto the job rather than looked up at claim time for the same
           * reason `prompt` and `workerName` are: the claim query is a single statement
           * against `jobs`, and a run's requirements must be the ones it was created
           * with rather than whatever `ogun project sync` wrote since.
           */
          requires: workerRequirements({
            runtime: worker.runtime as WorkerConfig['runtime'],
            sandbox: worker.sandbox as WorkerConfig['sandbox'],
            ...requiresOf(worker.config),
          }),
          state,
        })
        .returning()
      if (!job) throw new Error('failed to create job')
      jobIds.push(job.id)

      await tx.insert(coverage).values({
        cycleRunId: cycleRun.id,
        workerId: worker.id,
        workerName: worker.name,
        selected: true,
        ran: false,
        // `pending`, not `not-selected`: this worker *was* selected. The row exists
        // from the moment the batch does so a crashed run leaves evidence it was
        // supposed to happen, but calling it not-selected would be a false entry in
        // the one table whose entire job is to be true (principle 6).
        outcome: verdict.allowed ? 'pending' : 'refused',
        ...(verdict.allowed ? {} : { reason: verdict.reason }),
      })
    }

    return { cycleRunId: cycleRun.id, jobIds }
  })
}

/**
 * The nodes of this cycle run whose worker judged the work and refused it (§4.13).
 *
 * Read from `runs` rather than inferred from `jobs`, because `jobs.state` deliberately does
 * not carry it: a declined job is `skipped`, the same value an admission refusal gets, and
 * which of the two it was lives on the run (see `finalizeRun`). One join is the price of
 * not putting a scheduling state machine in charge of explaining why a worker said no.
 */
async function declinedNodes(db: Db, cycleRunId: string): Promise<Set<string>> {
  const rows = await db
    .select({ nodeKey: jobs.nodeKey })
    .from(runs)
    .innerJoin(jobs, eq(runs.jobId, jobs.id))
    .where(and(eq(jobs.cycleRunId, cycleRunId), eq(runs.outcome, 'declined')))
  return new Set(rows.map((r) => r.nodeKey))
}

/**
 * Release is per-node, not per-stage: a node unlocks as soon as *its* dependencies are
 * terminal, not when the whole preceding stage finishes. Otherwise a slow reviewer
 * stalls everything behind it (§5.1).
 *
 * **A decline blocks its dependents whatever the edge says, and `degrade` does not
 * override it.** `degrade` answers one question — *what if this node broke?* — and triage
 * running over three of four reviewers is the answer it was written for. A scope evaluator
 * refusing a ticket did not break; it produced the result it exists to produce, and that
 * result is an instruction about the rest of the graph. "Carry on without them" and "carry
 * on against them" are not the same permission.
 *
 * Left to the edge, this would be silent and unrecoverable in the one direction that
 * matters. `cycleSugarSchema` defaults `onDepFailure` to `degrade` — right for the fan-in
 * it was written for — so the obvious ticket pipeline, `workers: [scope-a-ticket], then:
 * plan`, would plan and implement a ticket its own evaluator had just refused, and open a
 * draft pull request with the decline sitting in the ledger saying it should not exist.
 * Nobody writing that config would see the bug in it.
 */
export async function releaseDependents(db: Db, cycleRunId: string): Promise<string[]> {
  const all = await db.select().from(jobs).where(eq(jobs.cycleRunId, cycleRunId))
  const byNode = new Map(all.map((j) => [j.nodeKey, j]))
  const cycleRun = await db.query.cycleRuns.findFirst({ where: eq(cycleRuns.id, cycleRunId) })
  if (!cycleRun) return []
  /**
   * The run's own frozen graph, not the `cycles` row.
   *
   * Re-reading the live row meant `ogun project sync` — an edit the docs actively
   * encourage — could change a running cycle's shape underneath it: an edge dropped
   * mid-flight leaves a dependent blocked on something that no longer points at it, and
   * `jobs.dependsOn` (snapshotted at creation) and this graph would disagree about the
   * same run.
   */
  const definition = cycleDefinitionSchema.parse(cycleRun.definition)
  const declined = await declinedNodes(db, cycleRunId)

  const released: string[] = []
  for (const job of all) {
    if (job.state !== 'blocked') continue
    const incoming = definition.edges.filter((e) => e.to === job.nodeKey)
    const deps = incoming.map((e) => ({ edge: e, dep: byNode.get(e.from) }))
    if (!deps.every(({ dep }) => dep && isTerminal(dep.state as JobState))) continue

    const blockedBy = deps.filter(
      ({ edge, dep }) =>
        dep?.state !== 'succeeded' && (edge.onDepFailure === 'block' || declined.has(edge.from)),
    )
    if (blockedBy.length > 0) {
      await db
        .update(jobs)
        .set({ state: 'skipped' })
        .where(eq(jobs.id, job.id))
      await markCoverage(db, cycleRunId, job, {
        // `blocked` in its narrow sense: a dependency in this cycle did not succeed.
        outcome: 'blocked',
        // Which of the two it was, because they send a reader to different places. A
        // dependency that failed is somebody's bug to go and find; one that declined is a
        // decision, already explained on its own row, and this node not running is the
        // decision working rather than a second thing that went wrong.
        reason: blockedBy
          .map((b) =>
            declined.has(b.edge.from)
              ? `dependency ${b.edge.from} declined the work`
              : `dependency ${b.edge.from} did not succeed`,
          )
          .join('; '),
      })
      continue
    }
    await db.update(jobs).set({ state: 'queued' }).where(eq(jobs.id, job.id))
    released.push(job.id)
  }
  return released
}

/**
 * A cycle is complete when every node is terminal — not when all succeeded (§5.1).
 *
 * **`declined` is a fourth grade, and it exists because the other three would each have
 * lied about a ticket pipeline.** A scope evaluator that refuses a ticket is the first
 * node that ends deliberately without succeeding (§4.13): its job lands on `skipped`, the
 * plan and implement nodes behind it are blocked, and nothing in the run succeeded. Under
 * `succeeded > 0 ? degraded : failed` that reads `failed` — so "the pipeline broke" and
 * "Ogun looked at this ticket and said no" would be the same row, and only one of them is
 * something for a person to go and fix. `complete` would be the opposite lie: it is what a
 * night reads when the work got done.
 *
 * Only when nothing actually failed. A cycle that both declined something and had a node
 * fall over keeps the failure in its grade, because the failure is the part somebody has
 * to act on and a decline must never be able to hide one.
 */
export async function finalizeCycleIfDone(db: Db, cycleRunId: string): Promise<void> {
  const all = await db.select().from(jobs).where(eq(jobs.cycleRunId, cycleRunId))
  if (all.length === 0) return
  if (!all.every((j) => isTerminal(j.state as JobState))) return

  const succeeded = all.filter((j) => j.state === 'succeeded').length
  const failed = all.filter((j) => j.state === 'failed').length
  const declined = await declinedNodes(db, cycleRunId)
  const state =
    succeeded === all.length
      ? 'complete'
      : failed === 0 && declined.size > 0
        ? 'declined'
        : succeeded > 0
          ? 'degraded'
          : 'failed'
  await db
    .update(cycleRuns)
    .set({ state, endedAt: new Date() })
    .where(and(eq(cycleRuns.id, cycleRunId), eq(cycleRuns.state, 'running')))
}

/**
 * `worker` is the job's own snapshot rather than a bare id, because the id is nullable
 * once that worker leaves config.yaml and the name is what identifies the row either way.
 */
export async function markCoverage(
  db: Db,
  cycleRunId: string,
  worker: { workerId: string | null; workerName: string },
  fields: { outcome: string; reason?: string; ran?: boolean; runId?: string; findingCount?: number },
): Promise<void> {
  await db
    .insert(coverage)
    .values({
      cycleRunId,
      workerId: worker.workerId,
      workerName: worker.workerName,
      selected: true,
      ran: fields.ran ?? false,
      outcome: fields.outcome,
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
      findingCount: fields.findingCount ?? 0,
    })
    .onConflictDoUpdate({
      target: [coverage.cycleRunId, coverage.workerName],
      set: {
        ran: fields.ran ?? false,
        outcome: fields.outcome,
        ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
        ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
        findingCount: fields.findingCount ?? 0,
      },
    })
}

/**
 * The slug is what a person types and what the path map is keyed by, so the refusal can
 * name the project rather than a uuid nobody can look up.
 */
async function probeReadiness(db: Db, projectId: string): Promise<ModifierReadiness> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return { ready: false, reason: 'this cycle has no project' }
  return modifierReadiness(project.slug, await probeProject(project.slug))
}

/** A skill with no agents/*.yaml has no declared prompt; the caller falls back. */
async function resolveSkillPrompts(db: Db, projectId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ name: skills.name, defaultPrompt: skills.defaultPrompt })
    .from(skills)
    .where(eq(skills.projectId, projectId))
  return new Map(
    rows.flatMap((r) => (r.defaultPrompt ? [[r.name, r.defaultPrompt] as const] : [])),
  )
}

async function resolveWorkers(db: Db, projectId: string, definition: CycleDefinition) {
  const names = [...new Set(definition.nodes.map((n) => n.worker))]
  const rows = await db
    .select()
    .from(workers)
    .where(and(eq(workers.projectId, projectId), inArray(workers.name, names)))
  return new Map(rows.map((w) => [w.name, w]))
}

/**
 * The worker's declared `requires:`, if its stored config carries a usable one.
 *
 * Guarded rather than cast, for the same reason `timeoutOf` below is. `workers.config` is
 * a jsonb column typed `Record<string, unknown>`; everything that writes it goes through
 * `workerSchema.parse`, but a column is not a type and this is the one place its contents
 * reach a queue that decides which machine may run the job. A `requires: gpu` written by
 * hand into the database — no list — would otherwise be a `.map` on a string, thrown
 * inside the transaction that creates the whole cycle run, taking every other node with
 * it.
 *
 * Spread, so "this worker did not say" arrives at `workerRequirements` as an absence and
 * the derivation stays the single place that decides what an absence means.
 */
function requiresOf(config: Record<string, unknown>): { requires?: string[] } {
  const requires = config.requires
  return Array.isArray(requires) && requires.every((r) => typeof r === 'string')
    ? { requires }
    : {}
}

/**
 * The worker's own timeout, if its stored config carries one.
 *
 * Spread rather than defaulted here so that "this worker did not say" reaches admission
 * as an absence, and the fallback is applied in the one place that knows what a missing
 * timeout means. A default written twice is a default that drifts.
 */
function timeoutOf(config: Record<string, unknown>): { timeoutMs?: number } {
  const timeoutMs = config.timeoutMs
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? { timeoutMs } : {}
}


/**
 * The worker's `bootstrap:` declaration, if its stored config carries a usable one.
 *
 * Guarded and spread on the same terms as `timeoutOf` above, and the guard matters more
 * here than it does there: this is the field that exempts a modifier from the image and
 * test-command requirements, and `workers.config` is a jsonb column that `workerSchema`
 * writes but does not own. A non-string value written into the database by hand must
 * arrive at admission as *nothing said* — which is the direction that refuses — rather
 * than as a truthy object nobody compared against a name.
 *
 * The value is passed through as a string rather than narrowed to `BootstrapKind` here.
 * `admit` compares it against the one name it honours, so an unrecognised one is refused
 * by not matching; narrowing here would move that decision into a parser and leave the
 * comparison looking like it could be skipped.
 */
function bootstrapOf(config: Record<string, unknown>): { bootstrap?: string } {
  const bootstrap = config.bootstrap
  return typeof bootstrap === 'string' && bootstrap.length > 0 ? { bootstrap } : {}
}
