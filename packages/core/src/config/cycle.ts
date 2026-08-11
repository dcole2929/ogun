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

export const cycleDefinitionSchema = z.object({
  nodes: z.array(cycleNodeSchema).min(1),
  edges: z.array(cycleEdgeSchema).default([]),
})
export type CycleDefinition = z.infer<typeof cycleDefinitionSchema>

export const singleWorkerCycle = (worker: string, prompt?: string): CycleDefinition => ({
  nodes: [{ key: worker, worker, ...(prompt ? { prompt } : {}) }],
  edges: [],
})
