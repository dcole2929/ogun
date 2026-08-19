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
  /** Waiting on a dependency inside its cycle. Phase 1 never produces one. */
  'blocked',
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

/**
 * Why a selected worker did or did not produce a result.
 *
 * The three "never ran" cases are deliberately separate. `blocked` previously meant all
 * of them at once — admission refusing a job, a dependency failing, and a job being
 * cancelled — which left the ledger saying "blocked" and nothing about by what. That is
 * the conflation principle 6 exists to prevent, applied to the table written to enforce
 * it.
 */
export const COVERAGE_OUTCOMES = [
  /** Selected and admitted, waiting for a runner. Not the same as clean. */
  'pending',

  // Ran.
  /** Reported findings. */
  'found',
  /**
   * Looked and produced nothing — a result, not an absence. A reviewer that reported no
   * findings, or a modifier that read the code and concluded nothing needed changing.
   */
  'clean',
  /**
   * A modifier ran and left a patch. Distinct from `found` because nothing was reported
   * and the finding count is zero, and distinct from `clean` because there is work
   * waiting to be published — collapsing either way makes "the night produced a change"
   * unreadable from the ledger.
   */
  'changed',
  /** Produced output the verify gate rejected, so nothing was persisted. */
  'gate-failed',
  /** Started and failed. */
  'errored',

  // Never ran, and which of these it was matters.
  /** Admission refused it: the breaker is open, or the worker is disabled. */
  'refused',
  /** A dependency in its cycle did not succeed. */
  'blocked',
  /** Stopped deliberately before it started. */
  'cancelled',
  /** Ended without reporting, and the ledger had to infer that from job state. */
  'abandoned',

  /** Not part of this batch. */
  'not-selected',
] as const
export type CoverageOutcome = (typeof COVERAGE_OUTCOMES)[number]
