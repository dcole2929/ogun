import type { GateResult } from '@ogun/core'
import { TESTS_LENS, type VerifyOutcome } from './verify.ts'

/**
 * Whether a modifier whose patch the gate rejected gets another go, and what it is told
 * (§5.2, §9's phase 3).
 *
 * Until now a rejected patch was simply `changes-requested` and the work was discarded —
 * which is the right answer to "may this be published" and the wrong answer to "is this
 * the best this run can do". The agent is still in a container it has spent twenty
 * minutes reading itself into, its workspace still holds its own commits, and the gate
 * has just produced the one thing it was missing: the suite's own output, naming the test
 * that broke. Throwing all three away and reporting a failure is the expensive mistake.
 *
 * Two questions decide it, and the second is the one that had to be got right. (A round
 * cap and a workspace sweep bound it too; the cap is below and the sweep is the
 * pipeline's, because it touches the workspace and this file is pure.)
 *
 *  - **Not every rejection is a question.** A red suite is evidence a second attempt can
 *    act on. A commit message that closes somebody's issue is not — the only repair is
 *    rewriting history, which is exactly what `extractPatch` refuses, so a retry would
 *    spend a round producing the same refusal or an unpublishable one. Those are facts
 *    about the run, in the sense `admission.ts` uses when it puts "this project has no
 *    test command" ahead of the failure breaker: no retry changes them.
 *  - **A retry that leaves no budget for the gate is worse than no retry.** The gate's
 *    clock is what remains of `job.timeoutMs`, not a fresh one, so a round that runs to
 *    the deadline produces "the suite never ran" — and the publisher refuses that with a
 *    sentence about an absence of evidence, which reads like a broken harness rather than
 *    a bad patch. `fix-a-finding` already sets 45 minutes for exactly that reason; a
 *    retry loop that spends the margin defeats the setting.
 */

/**
 * How many rounds a modifier gets, at most.
 *
 * The *budget* is the operative bound — `retryDecision` refuses long before this on any
 * project whose suite takes minutes — and this is the backstop for the case the budget
 * does not cover: a project whose suite runs in four seconds would otherwise permit
 * dozens of rounds inside one timeout, each spending a full model round to re-read the
 * same failure. Two rather than three because of what a round is worth rather than what
 * it costs: the first retry is handed the suite's output, which is genuinely new
 * information; the second is handed the same complaint about the same code by an agent
 * that has already tried once, and the honest prior is that it thrashes.
 *
 * Not a worker knob. `verify:` could carry one and it would be a knob set from nothing —
 * there is no corpus of retried modifier runs to pick a number from, and a setting that
 * exists before its evidence does is how `failureBreakerThreshold` came to mean nothing
 * for as long as it did. When there are retried runs to read, this constant is where the
 * number is, and moving it out of here is one line.
 */
export const MAX_MODIFIER_ROUNDS = 2

/**
 * Lenses whose failure another round could plausibly repair.
 *
 * An allowlist, not a denylist, and it fails closed: a lens added later — a worker's own
 * `expectations` entry, an agent lens when those are wired — gets no retry until somebody
 * decides it deserves one. The alternative is that a new check quietly starts costing a
 * second model round for a verdict it will reach again.
 */
const RETRYABLE_LENSES = new Set<string>([TESTS_LENS])

export type RetryDecision =
  | { retry: false; reason: string }
  | {
      retry: true
      reason: string
      /**
       * What the retry round is given as its own timeout, so it cannot eat the gate's
       * share. Passed to `sandbox.exec`, which otherwise applies the sandbox's timeout —
       * the *whole* job budget — to every round it is asked to run.
       */
      agentBudgetMs: number
      /** What is being held back for the gate, and why the round got what it got. */
      reserveMs: number
    }

export function retryDecision(input: {
  /** 1-based, and the round that was just graded. */
  round: number
  maxRounds: number
  permissions: 'observer' | 'reviewer' | 'modifier'
  gates: GateResult[]
  tests: VerifyOutcome['tests']
  /** `deadline - Date.now()`, taken by the caller so this function is pure. */
  remainingMs: number
}): RetryDecision {
  /**
   * Retry is a modifier concept (§5.2, settled). A reviewer's gate decides whether
   * findings persist; re-delivering a rejected findings document to the same agent is a
   * different feature with a different failure mode, and it is not this one.
   */
  if (input.permissions !== 'modifier') {
    return { retry: false, reason: 'retry is a modifier concept; this run is not one' }
  }

  const failed = input.gates.filter((g) => !g.passed)
  if (failed.length === 0) return { retry: false, reason: 'the gate passed; nothing to retry' }

  /**
   * Ahead of the round cap, because when both are true this is the more useful sentence.
   * "You are out of rounds" invites somebody to raise the cap; "no round can change this"
   * tells them the cap was never the problem.
   */
  const permanent = failed
    .map((g) => permanence(g, input.tests))
    .filter((r): r is string => r !== undefined)
  if (permanent.length > 0) {
    return {
      retry: false,
      reason:
        `no second attempt: ${permanent.join('; ')}. That is a fact about this run rather ` +
        'than a question another round could answer',
    }
  }

  if (input.round >= input.maxRounds) {
    return {
      retry: false,
      reason:
        `no second attempt: this run has used all ${input.maxRounds} of its rounds and the ` +
        `gate still refuses it (${failed.map((g) => g.name).join(', ')})`,
    }
  }

  /**
   * The reserve, and the reason it is a measurement rather than a constant.
   *
   * The gate has to run the suite again after the retry exits, and the only honest
   * estimate of what that costs is what it just cost. A fixed reserve would be a second
   * number able to disagree with `timeoutMs` — the same objection `testsCheck` makes to
   * giving the gate a timeout of its own — and it would be wrong in both directions: too
   * small on a repository whose suite takes ten minutes, absurdly large on one whose
   * suite takes four seconds.
   *
   * `permanence` has already refused every case where no measurement exists, so this is a
   * backstop for a future retryable lens that fails without the suite having run at all.
   */
  const suiteMs = input.tests?.durationMs
  if (suiteMs === undefined) {
    return {
      retry: false,
      reason:
        'no second attempt: nothing measured how long this project\'s suite takes, so the ' +
        'gate\'s share of what remains could not be worked out',
    }
  }

  /**
   * Twice the suite, and both halves are the same measurement.
   *
   * One for the gate to run it after the agent exits. One for the *agent* to run it
   * itself — `references/making-a-change.md` §5 tells a modifier to prove its change
   * before it finishes, and a round that cannot afford a single suite run is a round
   * that must guess. A retry that guesses is a retry that produces a second red patch
   * and spends the rest of the budget doing it.
   */
  const reserveMs = suiteMs
  if (input.remainingMs < 2 * suiteMs) {
    return {
      retry: false,
      reason:
        `no second attempt: ${Math.round(input.remainingMs / 1000)}s of the job's timeout ` +
        `remain and the suite alone takes ${Math.round(suiteMs / 1000)}s. A round that ` +
        'cannot run the suite once and still leave the gate time to run it again produces ' +
        '"the suite never ran", which refuses to publish for a reason that looks like a ' +
        'broken harness',
    }
  }

  return {
    retry: true,
    agentBudgetMs: input.remainingMs - reserveMs,
    reserveMs,
    reason:
      `retrying: ${failed.map((g) => g.name).join(', ')} failed, ` +
      `${Math.round((input.remainingMs - reserveMs) / 1000)}s for the agent with ` +
      `${Math.round(reserveMs / 1000)}s held back for the gate`,
  }
}

/**
 * Why this failed gate is permanent, or `undefined` if it is not.
 *
 * A reason rather than a boolean, because the reasons are not interchangeable and the
 * caller has no way to reconstruct them. "The suite never ran" and "a commit message
 * closes an issue" are both unretryable and one of them is fixed by giving the job more
 * time while the other is fixed by a person reading the patch — telling them apart is the
 * ledger's whole job (principle 6), and a decision that said only "not retryable" would
 * be the collapse this codebase keeps refusing to make.
 *
 * A `tests` failure is retryable only when the suite actually *ran*: `ran: false` covers
 * a project with no test command and a gate that started with the budget already spent,
 * and neither is repaired by writing more code. That is the distinction
 * `VerifyOutcome.tests` was split in two to keep, used here for the first time.
 */
const permanence = (gate: GateResult, tests: VerifyOutcome['tests']): string | undefined => {
  if (!RETRYABLE_LENSES.has(gate.name)) {
    return `${gate.name} failed, and it is not a lens another round can repair`
  }
  if (gate.name === TESTS_LENS) {
    if (tests?.ran !== true) {
      return "the project's suite never ran, so no round produced anything to act on"
    }
    if (tests.durationMs === undefined) {
      return "the project's suite never finished, so nothing measured what the gate would need again"
    }
  }
  return undefined
}

/**
 * What the agent is handed on its second round.
 *
 * A rejection is evidence, and a vague "try again" wastes the round this whole mechanism
 * exists to buy. So the gate's own detail goes back verbatim — for the test lens that is
 * the last forty lines the suite printed, which is the thing a person would look at
 * first, and it is safe to return because every byte of it came out of this sandbox in
 * the first place. Nothing here reveals anything the agent could not already read: the
 * test command is in the workspace, the lens names are its own gate, and the budget
 * numbers are its own clock.
 *
 * The three instructions after it are each a failure mode that has cost a whole round
 * somewhere:
 *
 *  - **Your work is still here.** §5.2 settled that the workspace is provisioned once and
 *    every retry reuses it, which means an agent that starts over is re-doing work it
 *    already has and paying twice for it.
 *  - **Commit forward.** The obvious repair for "my patch was rejected" is `--amend` or
 *    `reset`, and an agent that resets past the pinned base makes the run unextractable —
 *    at which point everything, including the first round's work, is deleted with the
 *    workspace. This is the one instruction whose absence loses more than the round.
 *  - **Reverting is a result.** A modifier that cannot get the suite green should undo
 *    its change and say so, which is an `approved` run with a note rather than a second
 *    red patch. Said out loud because the pressure at this point in a round is entirely
 *    the other way.
 */
export function retryPrompt(input: {
  round: number
  maxRounds: number
  gates: GateResult[]
  agentBudgetMs: number
  reserveMs: number
  /** Workspace root as the *agent* sees it, which is not the host path (§5.1). */
  guestRoot: string
  outputPath: string
}): string {
  const failed = input.gates.filter((g) => !g.passed)
  const minutes = Math.max(1, Math.round(input.agentBudgetMs / 60_000))

  return [
    'Your work was extracted and graded, and the verify gate refused to publish it. This',
    `is round ${input.round} of ${input.maxRounds}; there is no round after the last one,`,
    'and a run that ends refused produces no pull request at all.',
    '',
    'What the gate said, verbatim:',
    '',
    ...failed.map((g) => `[${g.name}] ${g.detail ?? 'failed, with no detail recorded'}`),
    '',
    'Your previous round\'s changes are still present in this workspace — it was never',
    'reset. Run `git status` and `git log` and `git diff` before you do anything else, and',
    'build on what is there. Starting over re-does work you already have.',
    '',
    'Commit forward. Do not `--amend`, `reset`, `rebase`, or check out another ref: the',
    'host is holding the commit this workspace was pinned to, and a HEAD that stops being',
    'a descendant of it cannot be turned into a patch at all. That would throw away this',
    'round *and* the last one.',
    '',
    `You have about ${minutes} minute(s). That is what remains of the job's timeout minus`,
    `the ${Math.round(input.reserveMs / 1000)}s the gate needs to run the suite again after`,
    'you exit — it is not a fresh budget, and the gate does not get one either. Run the',
    'suite yourself while you still have time to act on what it says.',
    '',
    'If you cannot get it green, `git revert` your own commits so the tree matches the',
    'base again and write your account of it to',
    `${input.guestRoot}/${input.outputPath} with \`ogun findings write\`. A run that`,
    'changed nothing and explained why is recorded as approved and is a better result than',
    'a red patch nobody can publish.',
  ].join('\n')
}
