import type { RunEvent } from '@ogun/core'

export type JobCtx = {
  prompt: string
  model?: string
  /** Absolute path inside the sandbox, not on the host. */
  workspace: string
  /** Where the runtime must write its final answer, if it supports doing so. */
  outputFile: string
  permissions: 'observer' | 'reviewer' | 'modifier'
}

/**
 * `claude` and `codex` are presets over one generic cli spec (§4.7) — two hand-written
 * adapters means writing the same subprocess and stream-normalizing code twice, and it
 * drifts.
 */
export type RuntimeSpec = {
  provider: 'claude' | 'codex'
  /** argv builders, not a flag list — resume is structurally different per runtime. */
  start: (ctx: JobCtx) => string[]
  resume: (ctx: JobCtx, sessionId: string) => string[]
  /** JSONL line -> normalized events. One line can yield several (a message with two
   *  content blocks) or none (a keepalive). */
  parseLine: (line: string, state: ParserState) => RunEvent[]
  /**
   * Codex constrains *every* assistant message when given an output schema, so the
   * first schema-valid message is not the answer. The file is authoritative (§4.7).
   */
  resultFile: boolean
  /** Codex hangs forever if stdin is left open, reporting "Reading additional input
   *  from stdin…". Every invocation closes it. */
  stdin: 'close'
}

/** Carried across lines so a parser can correlate and assign sequence numbers. */
export type ParserState = {
  seq: number
  sessionId?: string
  /** callId -> tool name, so a completion can name the tool that produced it. */
  toolNames: Map<string, string>
}

export const newParserState = (): ParserState => ({ seq: 0, toolNames: new Map() })

export const nextSeq = (state: ParserState): number => state.seq++
