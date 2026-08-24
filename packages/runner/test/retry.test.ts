import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { GateResult } from '@ogun/core'
import { MAX_MODIFIER_ROUNDS, retryDecision, retryPrompt } from '../src/retry.ts'

/**
 * The retry loop's bounds (§5.2, §9 phase 3).
 *
 * Everything here is about what stops a second round, because a retry that happens is
 * cheap to be wrong about and a retry that should not have happened is not: it spends the
 * rest of a shared budget, and the gate that runs afterwards then reports "the suite never
 * ran" — which the publisher refuses with a sentence about an absence of evidence, and
 * which reads like a broken harness rather than a bad patch.
 */

const SUITE_MS = 60_000

const redSuite: GateResult = {
  name: 'tests',
  method: 'tool',
  passed: false,
  detail: '`pnpm -s test` exited 1 after 60s:\nnot ok 3 - publisher applies the patch',
}

const decide = (over: Partial<Parameters<typeof retryDecision>[0]> = {}) =>
  retryDecision({
    round: 1,
    maxRounds: MAX_MODIFIER_ROUNDS,
    permissions: 'modifier',
    gates: [redSuite],
    tests: { ran: true, passed: false, durationMs: SUITE_MS },
    remainingMs: 20 * 60_000,
    ...over,
  })

/**
 * The case the loop exists for. A red suite is evidence: the gate has just produced the
 * one thing the agent was missing, in a container it has already spent most of the budget
 * reading itself into.
 */
test('a red suite with budget left is retried, and the gate keeps its share', async () => {
  const decision = decide()
  assert.equal(decision.retry, true)
  if (!decision.retry) return
  /**
   * The reserve is a *measurement*, not a constant: what the gate will need next time is
   * what the suite just cost. A fixed number would be a second budget able to disagree
   * with `timeoutMs` — the same objection `testsCheck` makes to giving the gate a clock of
   * its own — and it would be wrong in both directions, too small for a ten-minute suite
   * and absurd for a four-second one.
   */
  assert.equal(decision.reserveMs, SUITE_MS)
  assert.equal(decision.agentBudgetMs, 20 * 60_000 - SUITE_MS)
})

/**
 * The floor is two suite-runs, and both halves are the same measurement: one for the gate
 * after the agent exits, one for the *agent*, because the skill tells a modifier to prove
 * its change before it finishes. A round that cannot afford a single suite run is a round
 * that must guess, and a guess produces a second red patch and spends the rest of the
 * budget doing it.
 */
test('a retry that could not leave the gate time to run does not happen', async () => {
  const decision = decide({ remainingMs: 90_000 })
  assert.equal(decision.retry, false)
  // Both numbers in the sentence, because "no budget" alone does not tell anyone whether
  // to raise the timeout or to speed up the suite.
  assert.match(decision.reason, /90s/)
  assert.match(decision.reason, /takes 60s/)
  assert.match(decision.reason, /the suite never ran/)
})

/**
 * A suite that never started is a failed `tests` gate that no round repairs — the reasons
 * it did not start are a missing test command and a budget already spent, and neither is
 * fixed by writing more code.
 *
 * It has to say *which* silence it is, and that is the point of asserting on the sentence
 * rather than on the boolean. "tests failed" would be true of a red suite too, and a red
 * suite is the one case that does get another round; a person reading "no second attempt"
 * needs to know whether to give the job more time or to read the patch.
 */
test('a suite that never ran produces no retry, and says which silence it was', async () => {
  const decision = decide({
    tests: { ran: false, passed: false },
    gates: [{ name: 'tests', method: 'tool', passed: false, detail: 'the budget was spent' }],
  })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, /never ran/)
})

/** Ran, was red, and the gate never got a duration out of it — a killed suite. */
test('a suite that ran without finishing produces no retry either', async () => {
  const decision = decide({ tests: { ran: true, passed: false } })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, /never finished/)
})

/**
 * `extractPatch` has `unextractable` for facts about a run that no retry changes, and the
 * gate has its own: a commit message that closes somebody's issue cannot be repaired
 * without rewriting history, which is the one thing extraction refuses outright. A retry
 * here would spend a model round to reach the same refusal, or a worse one.
 *
 * The allowlist is what makes this hold for lenses nobody has written yet: a check added
 * later gets no retry until somebody decides it deserves one.
 */
test('a rejection no round could repair is not retried', async () => {
  for (const name of ['commit-message', 'some-workers-own-lens']) {
    const decision = decide({ gates: [{ name, method: 'tool', passed: false }] })
    assert.equal(decision.retry, false, name)
    assert.match(decision.reason, /not a lens another round can repair/, name)
    assert.match(decision.reason, /fact about this run/, name)
  }
})

/**
 * One unretryable failure poisons the round even when a retryable one sits beside it —
 * fixing the suite would still leave the patch unpublishable.
 */
test('one permanent failure is enough, whatever else failed', async () => {
  const decision = decide({
    gates: [redSuite, { name: 'commit-message', method: 'tool', passed: false }],
  })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, /commit-message/)
})

/**
 * Order of refusals, which decides which sentence a person is left holding. "You are out
 * of rounds" invites somebody to raise the cap; when the failure is one no round could
 * repair, the cap was never the problem.
 */
test('a permanent failure is reported ahead of the round cap', async () => {
  const decision = decide({
    round: MAX_MODIFIER_ROUNDS,
    gates: [{ name: 'commit-message', method: 'tool', passed: false }],
  })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, /fact about this run/)
  assert.doesNotMatch(decision.reason, /rounds/)
})

/**
 * The cap is the backstop for the case the budget does not cover: a project whose suite
 * runs in four seconds would otherwise permit dozens of rounds inside one timeout, each
 * spending a full model round to re-read the same failure.
 */
test('the last round is not retried however much budget is left', async () => {
  const decision = decide({
    round: MAX_MODIFIER_ROUNDS,
    remainingMs: 60 * 60_000,
    tests: { ran: true, passed: false, durationMs: 4_000 },
  })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, new RegExp(`all ${MAX_MODIFIER_ROUNDS} of its rounds`))
})

/** §5.2, settled: retry is a modifier concept. A reviewer's gate decides persistence. */
test('a reviewer is never retried', async () => {
  const decision = decide({ permissions: 'reviewer' })
  assert.equal(decision.retry, false)
  assert.match(decision.reason, /modifier concept/)
})

test('a gate that passed is not retried', async () => {
  const decision = decide({ gates: [{ name: 'tests', method: 'tool', passed: true }] })
  assert.equal(decision.retry, false)
})

/**
 * What the agent is told, and it is the difference between a retry that costs a round and
 * one that buys one. A vague "try again" hands back nothing the agent did not already
 * have; the gate's own detail is the suite's output, naming the test that broke.
 *
 * Safe to hand back, and worth saying why: every byte of that detail came out of this
 * sandbox in the first place. Nothing in the prompt reveals anything the agent could not
 * already read.
 */
test('the retry prompt carries the rejection verbatim and the rules that lose rounds', async () => {
  const prompt = retryPrompt({
    round: 2,
    maxRounds: 2,
    gates: [redSuite, { name: 'self-gating', method: 'tool', passed: true, detail: 'noise' }],
    agentBudgetMs: 12 * 60_000,
    reserveMs: SUITE_MS,
    guestRoot: '/workspace',
    outputPath: '.ogun-out/findings.json',
  })

  assert.match(prompt, /not ok 3 - publisher applies the patch/)
  // Only what failed. A lens that passed with a note is for the person reading the run,
  // not for the agent being asked to fix something.
  assert.doesNotMatch(prompt, /noise/)

  // §5.2: the workspace is provisioned once and every retry reuses it. An agent that
  // starts over re-does work it already has and pays for it twice.
  assert.match(prompt, /still present in this workspace/)

  /**
   * The instruction whose absence loses more than the round. The obvious repair for "my
   * patch was rejected" is `--amend` or `reset`, and a HEAD that stops descending from the
   * pinned base makes the whole run unextractable — taking the *first* round's work with
   * it, seconds before the workspace is deleted.
   */
  assert.match(prompt, /Do not `--amend`, `reset`, `rebase`/)

  // The budget is shared with the gate and is not a fresh one. `fix-a-finding` sets 45
  // minutes for exactly this reason and a retry loop that hid it would defeat the setting.
  assert.match(prompt, /12 minute/)
  assert.match(prompt, /60s the gate needs/)

  // Declining is a result. The pressure at this point in a round is entirely the other
  // way, which is why it is said out loud.
  assert.match(prompt, /git revert/)
})
