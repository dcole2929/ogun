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
  /**
   * The worker ran, the gate passed, and its answer was **no** — so the work it was asked
   * about must not go ahead (§4.13, ADR-0013).
   *
   * The scope evaluator is what forced this value, and none of the four above would do.
   * `approved` is the closest and the most dangerous: it means the node succeeded, which
   * releases its dependents, so a ticket Ogun had just judged unfit would be planned and
   * implemented anyway — the outcome that the evaluator exists to prevent, produced by the
   * evaluator producing it. `skipped` means admission refused the job before an agent ran;
   * here an agent ran, read the repository and spent the money, and there is a judgement to
   * record. `changes-requested` is the gate's word, not the worker's. And `error` is the
   * conflation principle 6 is named for: "Ogun looked at this and said no" and "the
   * evaluator crashed" would be the same row, and the second is the one somebody has to go
   * and fix.
   *
   * Declining is a **result**. It does not feed the failure breaker, because a run of
   * badly-written tickets is not a malfunctioning worker — see `finalizeRun`.
   */
  'declined',
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

/**
 * A cycle is complete when every node is terminal — not when all succeeded (§5.1).
 *
 * `declined` is the grade for a cycle that ended because a node judged the work and
 * refused it — a scope evaluator turning down a ticket, with everything behind it blocked
 * (§4.13). Nothing succeeded and nothing broke, and the other three words each claim one
 * of those. It is only reached when nothing failed: a decline must never be able to hide a
 * failure somebody has to act on. See `finalizeCycleIfDone`.
 */
export const CYCLE_STATES = ['running', 'complete', 'degraded', 'declined', 'failed'] as const
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
  /**
   * Ran, judged the work it was handed, and refused it — a scope evaluator declining a
   * ticket (§4.13).
   *
   * Not `clean`, which is the seductive mapping and the wrong one. `clean` means "looked
   * and there was nothing to report", and it is the value that says a surface is *covered*
   * — so filing a decline under it makes the night read as though the ticket were fine and
   * makes "what did Ogun decline last night, and why" unanswerable from the one table
   * whose entire job is to answer that. An *admit* is the clean one: the evaluator looked
   * and found no reason to stop.
   *
   * The reason travels in `coverage.reason`, which is what puts the sentence next to the
   * row on the coverage page rather than in a run detail somebody has to go and open.
   */
  'declined',
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
