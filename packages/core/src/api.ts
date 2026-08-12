import { z } from 'zod'
import { runEventSchema } from './events.ts'
import { findingsDocumentSchema } from './findings.ts'
import { RUN_OUTCOMES } from './outcomes.ts'
import { COVERAGE_OUTCOMES } from './outcomes.ts'

/**
 * The runner/server wire contract (§3). The runner never opens a database connection —
 * everything crosses this boundary, so moving the control plane to a VPS is a URL
 * change rather than a rewrite. Validated on both ends.
 */

export const runnerHeartbeatSchema = z.object({
  runnerName: z.string().min(1),
  labels: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
})

export const claimRequestSchema = z.object({
  /** The name this machine registered under. Its real id lives on the control plane. */
  runnerName: z.string().min(1),
  /** Capability labels this runner advertises; a job's `requires` must be a subset. */
  labels: z.array(z.string()),
  /** How many slots the runner has free right now. */
  capacity: z.number().int().positive().default(1),
})

/** Everything the runner needs to execute without a second round trip. */
export const claimedJobSchema = z.object({
  jobId: z.string(),
  runId: z.string(),
  cycleRunId: z.string(),
  projectSlug: z.string(),
  projectDefaultBranch: z.string(),
  /** Where to clone from when this runner has no local checkout. */
  remoteUrl: z.string().optional(),
  workerId: z.string(),
  workerName: z.string(),
  workerVersion: z.string(),
  nodeKey: z.string(),
  prompt: z.string(),
  runtime: z.string(),
  model: z.string(),
  permissions: z.string(),
  sandbox: z.string(),
  timeoutMs: z.number().int().positive(),
  skillRef: z.string(),
  verify: z.unknown().optional(),
  attempt: z.number().int().nonnegative(),
})
export type ClaimedJob = z.infer<typeof claimedJobSchema>

export const claimResponseSchema = z.object({
  jobs: z.array(claimedJobSchema),
})

export const eventBatchSchema = z.object({
  runId: z.string(),
  events: z.array(runEventSchema).min(1),
})

/** Sent once the runner knows what it actually resolved — sha, session, model. */
export const runStartedSchema = z.object({
  runId: z.string(),
  repoSha: z.string().optional(),
  sessionId: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  skillVersion: z.string().optional(),
})

export const gateResultSchema = z.object({
  name: z.string(),
  method: z.enum(['tool', 'agent']),
  passed: z.boolean(),
  detail: z.string().optional(),
})
export type GateResult = z.infer<typeof gateResultSchema>

/**
 * The single write that ends a run. Outcome, findings, and coverage land in one
 * transaction — partial findings from a crashed run are worse than none (§5.1).
 */
export const runReportSchema = z.object({
  runId: z.string(),
  outcome: z.enum(RUN_OUTCOMES),
  detail: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      costCents: z.number().int().nonnegative().optional(),
    })
    .optional(),
  gates: z.array(gateResultSchema).default([]),
  /** Absent when the gate failed or the run errored before producing output. */
  findings: findingsDocumentSchema.optional(),
  coverage: z.object({
    outcome: z.enum(COVERAGE_OUTCOMES),
    reason: z.string().optional(),
  }),
  artifacts: z
    .array(z.object({ kind: z.string(), ref: z.string(), bytes: z.number().optional() }))
    .default([]),
})
export type RunReport = z.infer<typeof runReportSchema>

export const triggerRunSchema = z.object({
  projectSlug: z.string().min(1),
  worker: z.string().min(1),
  prompt: z.string().optional(),
})
