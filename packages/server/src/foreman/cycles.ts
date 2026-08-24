import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { cycleDefinitionSchema, isTerminal, type CycleDefinition, type JobState } from '@ogun/core'
import type { CredentialOutlook } from '@ogun/gateway'
import { admit, modifierReadiness, probeProject, type ModifierReadiness } from './admission.ts'
import { projectPolicies } from './policies.ts'

const { coverage, cycleRuns, cycles, jobs, projects, skills, workers } = schema

export type StartCycleRunInput = {
  cycleId: string
  trigger: string
  /** Per-node prompt override, keyed by node key. Used by a manual trigger. */
  promptOverrides?: Record<string, string>
  /**
   * What the project can offer a modifier (§4.3). Established by this function from the
   * disk when omitted; a seam, because a test that has to lay out a real repository to
   * assert an admission rule is a test about filesystems.
   */
  modifierReadiness?: ModifierReadiness
  /**
   * What the host's credential files say (§4.3), for the preflight that refuses a job no
   * credential on this machine could authenticate.
   *
   * Established by the caller and — unlike `modifierReadiness` — deliberately *not*
   * probed here when it is missing. Every trigger passes through this function, including
   * the twenty-odd tests that call it directly, and a `probeCredentials()` default would
   * make each of their outcomes depend on whatever `~/.claude/.credentials.json` happened
   * to hold: green on a laptop somebody used this morning, red on CI, red on the very
   * machine whose lapsed token this feature exists to catch. A suite that fails when the
   * host is misconfigured is a suite that gets ignored.
   *
   * The two production callers — `scheduler.ts` for cron and `routes/trigger.ts` for a
   * manual run — pass it. Omitting it means the credential guard does not run, which is
   * the documented open case: the gateway's `502 no_credential` and the provider's 401
   * are still there behind it.
   */
  credentials?: CredentialOutlook
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
      const prompt =
        input.promptOverrides?.[node.key] ??
        node.prompt ??
        (worker.config as { prompt?: string }).prompt ??
        skillPrompts.get(worker.skillRef) ??
        `Use the ${worker.skillRef} skill.`

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
          requires: workerRequirements(worker),
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
 * Release is per-node, not per-stage: a node unlocks as soon as *its* dependencies are
 * terminal, not when the whole preceding stage finishes. Otherwise a slow reviewer
 * stalls everything behind it (§5.1).
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

  const released: string[] = []
  for (const job of all) {
    if (job.state !== 'blocked') continue
    const incoming = definition.edges.filter((e) => e.to === job.nodeKey)
    const deps = incoming.map((e) => ({ edge: e, dep: byNode.get(e.from) }))
    if (!deps.every(({ dep }) => dep && isTerminal(dep.state as JobState))) continue

    const blockedBy = deps.filter(
      ({ edge, dep }) => edge.onDepFailure === 'block' && dep?.state !== 'succeeded',
    )
    if (blockedBy.length > 0) {
      await db
        .update(jobs)
        .set({ state: 'skipped' })
        .where(eq(jobs.id, job.id))
      await markCoverage(db, cycleRunId, job, {
        // `blocked` in its narrow sense: a dependency in this cycle did not succeed.
        outcome: 'blocked',
        reason: `dependency ${blockedBy.map((b) => b.edge.from).join(', ')} did not succeed`,
      })
      continue
    }
    await db.update(jobs).set({ state: 'queued' }).where(eq(jobs.id, job.id))
    released.push(job.id)
  }
  return released
}

/** A cycle is complete when every node is terminal — not when all succeeded (§5.1). */
export async function finalizeCycleIfDone(db: Db, cycleRunId: string): Promise<void> {
  const all = await db.select().from(jobs).where(eq(jobs.cycleRunId, cycleRunId))
  if (all.length === 0) return
  if (!all.every((j) => isTerminal(j.state as JobState))) return

  const succeeded = all.filter((j) => j.state === 'succeeded').length
  const state = succeeded === all.length ? 'complete' : succeeded > 0 ? 'degraded' : 'failed'
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

/** A job's requirements are derived from its worker, not hand-maintained. */
function workerRequirements(worker: { runtime: string; sandbox: string }): string[] {
  const req = [worker.runtime]
  if (worker.sandbox === 'container') req.push('docker')
  return req
}
