/**
 * Outcome taxonomy (§5.2). These are never conflated — "didn't run", "ran and found
 * nothing", and "found something that got filtered" are three different facts
 * (principle 6) and collapsing them is how coverage silently rots.
 */
export const RUN_OUTCOMES = [
  /** Reviewer ran, verify gate passed, findings (possibly zero) persisted. */
  'approved',
  /** Reviewer ran and the verify gate rejected the output — nothing persisted. */
  'changes-requested',
  /** Admission refused the job before any agent ran. */
  'skipped',
  /** Modifier produced a patch (phase 3). */
  'dispatched',
  /** The harness or the agent failed. */
  'error',
] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

export const JOB_STATES = [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const
export type JobState = (typeof JOB_STATES)[number]

export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'skipped']
export const isTerminal = (s: JobState): boolean => TERMINAL_JOB_STATES.includes(s)

/** A cycle is complete when every node is terminal — not when all succeeded (§5.1). */
export const CYCLE_STATES = ['running', 'complete', 'degraded', 'failed'] as const
export type CycleState = (typeof CYCLE_STATES)[number]

export const COVERAGE_OUTCOMES = [
  'found',
  'clean',
  'gate-failed',
  'blocked',
  'errored',
  'not-selected',
] as const
export type CoverageOutcome = (typeof COVERAGE_OUTCOMES)[number]
