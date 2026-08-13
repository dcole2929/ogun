import { z } from 'zod'

/**
 * A cycle is a DAG of jobs. A single worker is a one-node cycle — that costs one table
 * and an FK, and it means "run this worker now" and "run the nightly cycle" are the
 * same code path from the start (§5.1).
 */
export const cycleNodeSchema = z.object({
  key: z.string().min(1),
  worker: z.string().min(1),
  /** Overrides the worker's prompt for this node only. */
  prompt: z.string().optional(),
})
export type CycleNode = z.infer<typeof cycleNodeSchema>

export const cycleEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * `degrade` lets triage run with three of four reviewers and mark the batch
   * incomplete in the coverage ledger. Silent coverage loss is worse than a partial
   * result, so a failed dependency does not have to block a dependent (§5.1).
   */
  onDepFailure: z.enum(['block', 'degrade']).default('block'),
})
export type CycleEdge = z.infer<typeof cycleEdgeSchema>

/**
 * When a cycle runs. Identical in meaning to the same fields on a worker — a worker's
 * schedule is really its one-node cycle's schedule (§5.1), so a multi-node cycle needs
 * the same three fields rather than a second scheduling concept.
 */
export const cycleScheduleSchema = {
  schedule: z.string().min(1).optional(),
  timezone: z.string().optional(),
  onMissed: z.enum(['skip', 'runOnce']).default('skip'),
  enabled: z.boolean().default(true),
}

export const cycleDefinitionSchema = z.object({
  nodes: z.array(cycleNodeSchema).min(1),
  edges: z.array(cycleEdgeSchema).default([]),
  ...cycleScheduleSchema,
})
export type CycleDefinition = z.infer<typeof cycleDefinitionSchema>

export const singleWorkerCycle = (worker: string, prompt?: string): CycleDefinition => ({
  nodes: [{ key: worker, worker, ...(prompt ? { prompt } : {}) }],
  edges: [],
  onMissed: 'skip',
  enabled: true,
})

/**
 * Workers that a named cycle drives.
 *
 * Every worker also gets a one-node cycle so it can be triggered on its own, and that
 * cycle carries the worker's `schedule:`. Once the worker is a member of a named cycle,
 * those two schedules mean two different things at the same hour: the standalone one
 * would run the reviewer again and publish its findings raw, which is exactly what
 * triage exists to prevent. Membership therefore suppresses the standalone schedule —
 * the manual trigger stays.
 */
export function cycleMembers(definition: CycleDefinition): Set<string> {
  return new Set(definition.nodes.map((n) => n.worker))
}


/**
 * How a cycle is written in `.ogun/config.yaml`.
 *
 * Fan-in is the only real justification for cycles (§4.12) — fan-out alone is just N
 * independent jobs — so the common shape gets sugar and the general form stays available
 * underneath:
 *
 * ```yaml
 * cycles:
 *   nightly:
 *     workers: [adversarial-review, security-review, dependency-health]
 *     then: triage
 * ```
 *
 * Writing that as nodes and edges by hand means naming three edges that all say the same
 * thing, and getting one wrong is silent — the missed reviewer's findings simply never
 * reach triage.
 */
export const cycleSugarSchema = z.object({
  /** Run these together. They have no dependencies, so they all start at once. */
  workers: z.array(z.string().min(1)).min(1),
  /** One worker that runs after all of them, consuming what they produced. */
  then: z.string().min(1).optional(),
  /**
   * What happens to `then` when one of the workers fails. `degrade` is the default and
   * usually right: triage running over three of four reviewers, with the batch marked
   * incomplete, beats a night that produces nothing because one reviewer crashed.
   */
  onDepFailure: z.enum(['block', 'degrade']).default('degrade'),
  ...cycleScheduleSchema,
})

/** Either form. The sugar is expanded to the general one before anything else sees it. */
export const cycleConfigSchema = z.union([cycleSugarSchema, cycleDefinitionSchema])
export type CycleConfig = z.infer<typeof cycleConfigSchema>

export function expandCycle(config: CycleConfig): CycleDefinition {
  if ('nodes' in config) return cycleDefinitionSchema.parse(config)

  const nodes: CycleNode[] = config.workers.map((worker) => ({ key: worker, worker }))
  const edges: CycleEdge[] = []

  if (config.then) {
    nodes.push({ key: config.then, worker: config.then })
    for (const worker of config.workers) {
      edges.push({ from: worker, to: config.then, onDepFailure: config.onDepFailure })
    }
  }
  return {
    nodes,
    edges,
    ...(config.schedule ? { schedule: config.schedule } : {}),
    ...(config.timezone ? { timezone: config.timezone } : {}),
    onMissed: config.onMissed,
    enabled: config.enabled,
  }
}

/**
 * Nodes whose output something downstream consumes.
 *
 * A reviewer feeding triage must not write to the findings table itself — triage is the
 * only thing that does (§4.12), or the inbox gets both the raw findings and the
 * consolidated ones. This is how a run decides whether to publish or only stage.
 */
export function nodesWithDependents(definition: CycleDefinition): Set<string> {
  return new Set(definition.edges.map((e) => e.from))
}
