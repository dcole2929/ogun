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

/**
 * Everything about a graph that would stop it ever finishing, in the words of whoever
 * has to fix it.
 *
 * Nothing checked this. A hand-written `nodes`/`edges` block saying A depends on B and B
 * depends on A parsed, stored, and fired at 3am: both jobs start `blocked`, a node is
 * released only once every dependency is terminal, and neither ever is. No error, no
 * timeout — the run simply never reaches a terminal state. An edge naming a node key
 * that does not exist is the same hang with a quieter cause: the dependent waits on a
 * key nothing will ever report against.
 *
 * A graph where *every* node has an incoming edge gets no message of its own. Once the
 * edges all name real nodes, walking backwards from any node through a finite graph has
 * to revisit one — so "nothing can start here" is always some loop, and naming the loop
 * is the half that tells you which line to edit.
 *
 * Messages, not exceptions: the caller knows which cycle this is and this does not.
 */
export function cycleGraphProblems(definition: CycleDefinition): string[] {
  const problems: string[] = []
  const keys = definition.nodes.map((n) => n.key)

  const known = new Set<string>()
  for (const key of keys) {
    if (known.has(key)) {
      problems.push(
        `two nodes share the key "${key}" — a key names one node, so every edge touching it would mean both`,
      )
    }
    known.add(key)
  }

  for (const edge of definition.edges) {
    for (const end of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
      if (!known.has(end)) {
        problems.push(
          `edge "${edge.from}" → "${edge.to}": no node has the key "${end}" ` +
            `(this cycle's nodes: ${keys.join(', ')})`,
        )
      }
    }
  }

  // Edges to nowhere are left out rather than followed: they are reported already, and a
  // loop drawn through a node that does not exist is not the loop anyone would go fix.
  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }

  const finished = new Set<string>()
  const path: string[] = []
  const walk = (key: string): void => {
    // Only from the repeated key onwards. The nodes that led into a loop are themselves
    // fine, and naming them sends someone to edit an edge that is not the problem.
    const at = path.indexOf(key)
    if (at !== -1) {
      problems.push(
        `a loop, so nothing in it can ever start: ${[...path.slice(at), key].join(' → ')}`,
      )
      return
    }
    if (finished.has(key)) return
    path.push(key)
    for (const next of outgoing.get(key) ?? []) walk(next)
    path.pop()
    finished.add(key)
  }
  for (const key of known) walk(key)

  return problems
}

/**
 * A definition that can actually finish. What every write path parses with.
 *
 * Deliberately not folded into `cycleDefinitionSchema` itself, tempting as that is: that
 * schema is also how the jsonb already in `cycles` and `cycle_runs` is read back, and a
 * graph written before this check existed can still be sitting there. `ogun cycles` has
 * to print such a row and a finishing run has to be able to read its own frozen copy —
 * refusing to parse would turn a bad graph into a blind spot, and in `hasDependents` a
 * definition that will not parse silently means "nothing downstream", which publishes
 * findings that should have been staged. So: the shape is what you read with, this is
 * what you write with.
 */
export const runnableCycleSchema = cycleDefinitionSchema.superRefine((definition, ctx) => {
  for (const message of cycleGraphProblems(definition)) {
    ctx.addIssue({ code: 'custom', message })
  }
})

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
 *
 * The two ways this can still expand into a graph that never finishes are refused here
 * rather than after expansion, in the words the file was written in: someone who wrote
 * `then:` did not write an edge, and a complaint about node keys sends them looking for
 * something their file does not contain.
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
}).superRefine((sugar, ctx) => {
  const seen = new Set<string>()
  for (const [i, worker] of sugar.workers.entries()) {
    if (seen.has(worker)) {
      ctx.addIssue({ code: 'custom', path: ['workers', i], message: `"${worker}" is listed twice` })
    }
    seen.add(worker)
  }
  if (sugar.then && seen.has(sugar.then)) {
    ctx.addIssue({
      code: 'custom',
      path: ['then'],
      message:
        `"${sugar.then}" is also in workers: — it would have to run after itself, ` +
        'so it would sit blocked forever',
    })
  }
})

/** Either form. The sugar is expanded to the general one before anything else sees it. */
export const cycleConfigSchema = z.union([cycleSugarSchema, runnableCycleSchema])
export type CycleConfig = z.infer<typeof cycleConfigSchema>

/**
 * Whatever comes out of here is a graph that can finish — including from the sugar, which
 * is re-checked on the way out rather than trusted because it was built rather than
 * written. A caller handed an unparsed object is the case that matters.
 */
export function expandCycle(config: CycleConfig): CycleDefinition {
  if ('nodes' in config) return runnableCycleSchema.parse(config)

  const nodes: CycleNode[] = config.workers.map((worker) => ({ key: worker, worker }))
  const edges: CycleEdge[] = []

  if (config.then) {
    nodes.push({ key: config.then, worker: config.then })
    for (const worker of config.workers) {
      edges.push({ from: worker, to: config.then, onDepFailure: config.onDepFailure })
    }
  }
  return runnableCycleSchema.parse({
    nodes,
    edges,
    ...(config.schedule ? { schedule: config.schedule } : {}),
    ...(config.timezone ? { timezone: config.timezone } : {}),
    onMissed: config.onMissed,
    enabled: config.enabled,
  })
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
