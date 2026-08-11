import { z } from 'zod'

/**
 * One normalized event type for every runtime. Claude Code is API-message shaped and
 * codex is item-lifecycle shaped (§4.7); both collapse onto this without loss, which
 * is what lets the timeline, the CLI, and anything later render an identical session.
 *
 * Granularity is per-message, not per-token — neither runtime emits deltas headless.
 */
export const RUN_EVENT_TYPES = [
  'run.started',
  'agent.message',
  'agent.reasoning',
  'tool.started',
  'tool.completed',
  'run.completed',
  'run.failed',
  'usage',
  'rate_limit',
  'runner.note',
] as const

export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** Claude reports a list-price estimate; codex reports nothing. Never a bill. */
  costUsdEstimate: z.number().nonnegative().optional(),
})
export type Usage = z.infer<typeof usageSchema>

export const runEventSchema = z.object({
  type: z.enum(RUN_EVENT_TYPES),
  /** Runtime-supplied timestamp when there is one, else the moment we parsed the line. */
  ts: z.string(),
  /**
   * Per-run monotonic sequence. Assigned by the runner, not the server, so ordering
   * survives out-of-order batch delivery and the UI can detect gaps.
   */
  seq: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
})
export type RunEvent = z.infer<typeof runEventSchema>

/** Payload shapes, by convention rather than a discriminated union — the DB column is jsonb. */
export type ToolStartedPayload = {
  /** Stable per-runtime correlation key: claude uses tool_use.id, codex uses item.id. */
  callId: string
  name: string
  input?: unknown
}
export type ToolCompletedPayload = {
  callId: string
  name?: string
  exitCode?: number
  isError?: boolean
  output?: string
}
export type AgentMessagePayload = { text: string }
export type RunStartedPayload = { sessionId?: string; model?: string; runtime: string }
export type RunCompletedPayload = { usage?: Usage; result?: string }
