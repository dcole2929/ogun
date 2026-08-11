import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { cycleDefinitionSchema, isTerminal, type CycleDefinition, type JobState } from '@ogun/core'
import { admit, DEFAULT_LIMITS, type AdmissionLimits } from './admission.ts'

const { coverage, cycleRuns, cycles, jobs, workers } = schema

export type StartCycleRunInput = {
  cycleId: string
  trigger: string
  limits?: AdmissionLimits
  /** Per-node prompt override, keyed by node key. Used by a manual trigger. */
  promptOverrides?: Record<string, string>
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
  const limits = input.limits ?? DEFAULT_LIMITS
  const cycle = await db.query.cycles.findFirst({ where: eq(cycles.id, input.cycleId) })
  if (!cycle) throw new Error(`no such cycle: ${input.cycleId}`)

  const definition = cycleDefinitionSchema.parse(cycle.definition)
  const byName = await resolveWorkers(db, cycle.projectId, definition)

  return db.transaction(async (tx) => {
    const [cycleRun] = await tx
      .insert(cycleRuns)
      .values({ cycleId: cycle.id, trigger: input.trigger, state: 'running' })
      .returning()
    if (!cycleRun) throw new Error('failed to create cycle run')

    const jobIds: string[] = []
    for (const node of definition.nodes) {
      const worker = byName.get(node.worker)
      if (!worker) throw new Error(`cycle references unknown worker: ${node.worker}`)

      const dependsOn = definition.edges.filter((e) => e.to === node.key).map((e) => e.from)
      const verdict = worker.enabled
        ? await admit(tx, worker.id, limits)
        : ({ allowed: false, reason: 'worker disabled' } as const)

      const state: JobState = !verdict.allowed ? 'skipped' : dependsOn.length ? 'blocked' : 'queued'
      const prompt =
        input.promptOverrides?.[node.key] ??
        node.prompt ??
        (worker.config as { prompt?: string }).prompt ??
        `Use the ${worker.skillRef} skill.`

      const [job] = await tx
        .insert(jobs)
        .values({
          cycleRunId: cycleRun.id,
          workerId: worker.id,
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
        selected: true,
        ran: false,
        outcome: verdict.allowed ? 'not-selected' : 'blocked',
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
  const cycle = await db.query.cycles.findFirst({ where: eq(cycles.id, cycleRun.cycleId) })
  const definition = cycleDefinitionSchema.parse(cycle?.definition ?? { nodes: [] })

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
      await markCoverage(db, cycleRunId, job.workerId, {
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

export async function markCoverage(
  db: Db,
  cycleRunId: string,
  workerId: string,
  fields: { outcome: string; reason?: string; ran?: boolean; runId?: string; findingCount?: number },
): Promise<void> {
  await db
    .insert(coverage)
    .values({
      cycleRunId,
      workerId,
      selected: true,
      ran: fields.ran ?? false,
      outcome: fields.outcome,
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
      findingCount: fields.findingCount ?? 0,
    })
    .onConflictDoUpdate({
      target: [coverage.cycleRunId, coverage.workerId],
      set: {
        ran: fields.ran ?? false,
        outcome: fields.outcome,
        ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
        ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
        findingCount: fields.findingCount ?? 0,
      },
    })
}

async function resolveWorkers(db: Db, projectId: string, definition: CycleDefinition) {
  const names = [...new Set(definition.nodes.map((n) => n.worker))]
  const rows = await db
    .select()
    .from(workers)
    .where(and(eq(workers.projectId, projectId), inArray(workers.name, names)))
  return new Map(rows.map((w) => [w.name, w]))
}

/** A job's requirements are derived from its worker, not hand-maintained. */
function workerRequirements(worker: { runtime: string; sandbox: string }): string[] {
  const req = [worker.runtime]
  if (worker.sandbox === 'container') req.push('docker')
  return req
}
