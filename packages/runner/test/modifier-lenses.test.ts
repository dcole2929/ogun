import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import { SWEEP_UP_SUBJECT, type PatchFacts } from '../src/patch.ts'
import type { Sandbox } from '../src/sandbox/index.ts'

/**
 * The modifier-profile lenses (§4.10): what a patch is checked for beyond "the suite
 * passed".
 *
 * A reviewer's lenses grade a findings document. A modifier produces a *patch*, which is
 * a different artefact, and the two questions here are the ones the suite structurally
 * cannot answer — because they are about what happens to the patch after it becomes a
 * pull request rather than about whether the code works.
 */

/** A sandbox that fails the test if anything tries to run in it. */
const inertSandbox = {
  kind: 'container',
  provision: async () => {},
  exec: () => {
    throw new Error('the suite must not run once a cheap deterministic lens has refused')
  },
  readFile: async () => null,
  dispose: async () => {},
} as unknown as Sandbox

/** A sandbox whose suite is green, for the cases that are meant to reach it. */
const greenSandbox = {
  kind: 'container',
  provision: async () => {},
  exec: () => ({
    lines: (async function* () {})(),
    done: Promise.resolve({ code: 0, stderr: '', timedOut: false }),
  }),
  readFile: async () => null,
  dispose: async () => {},
} as unknown as Sandbox

const facts = (over: Partial<PatchFacts> = {}): PatchFacts => ({
  messages: ['Reject a port of 0 in parseAuthority'],
  paths: ['src/authority.ts'],
  sweptUp: false,
  ...over,
})

const gate = async (
  patch: PatchFacts | undefined,
  sandbox: Sandbox = inertSandbox,
) =>
  runVerifyGate({
    config: undefined,
    permissions: 'modifier',
    // A modifier writes code, not a findings document.
    output: undefined,
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox,
    testCommand: 'pnpm -s test',
    ...(patch ? { patch } : {}),
    deadline: Date.now() + 10 * 60_000,
  })

const named = (gates: Awaited<ReturnType<typeof gate>>['gates'], name: string) =>
  gates.find((g) => g.name === name)

/**
 * ADR-0009's recorded open gap, closed on the only side it can be.
 *
 * The pull request *body* fences agent prose, so a closing keyword there is inert. The
 * commit message is not and cannot be made so: GitHub scans messages when a branch merges
 * and stripping the line would mean rewriting the artefact a person is reviewing. Until
 * now the only thing standing in that gap was a sentence in a skill, and an instruction
 * is not a gate.
 */
test('a closing keyword in a commit message refuses the patch', async () => {
  const { gates } = await gate(
    facts({ messages: ['Reject a port of 0\n\nThis is the bug from triage.\nFixes #14\n'] }),
  )
  const lens = named(gates, 'commit-message')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /Fixes #14/)
  // The detail has to explain why nothing downstream saves this, or the obvious response
  // is "so strip the line", which is the thing ADR-0009 rejected.
  assert.match(lens?.detail ?? '', /ADR-0009/)
})

/**
 * The naive implementation of the check above is "does the message contain a closing
 * keyword and an issue number", and it refuses the exact phrasing the skill tells a
 * modifier to use. GitHub only acts when the reference immediately follows the keyword,
 * so "the bug reported in #14" links and does not close — and a lens that flagged it
 * would train the next skill author to stop mentioning issues at all.
 */
test('prose that mentions an issue near a keyword is not a closing keyword', async () => {
  for (const message of [
    'Reject a port of 0\n\nThis fixes the crash reported in #14, without closing it.',
    'Reject a port of 0\n\nSee the discussion under #14.',
    'Widen the prefixes #14 allows',
  ]) {
    const { gates } = await gate(facts({ messages: [message] }), greenSandbox)
    assert.equal(named(gates, 'commit-message')?.passed, true, message)
  }
})

/**
 * Every reference form GitHub honours, because a lens that catches three of four reads as
 * enforced and is not — and the one it missed is the one somebody eventually writes.
 */
test('every closing form GitHub acts on is caught, in any case', async () => {
  for (const line of [
    'closes #7',
    'CLOSED #7',
    'Fix #7',
    'fixed: #7',
    'Resolves GH-7',
    'resolve ogun/ogun#7',
    'Closes https://github.com/ogun/ogun/issues/7',
  ]) {
    const { gates } = await gate(facts({ messages: [`Do the thing\n\n${line}\n`] }))
    assert.equal(named(gates, 'commit-message')?.passed, false, line)
  }
})

/**
 * Ordering, asserted rather than assumed. The message lens costs microseconds and the
 * suite costs minutes, so a patch that cannot be published whatever the suite says must
 * never spend the budget finding that out — `inertSandbox` throws if it does.
 *
 * The cost of this ordering is a `changes` row with null test columns, which reads as
 * "nobody said" and is true. The publisher's outcome gate refuses long before its test
 * gate is reached, so the null is never the sentence a person is handed.
 */
test('a refused message means the suite is never run', async () => {
  const { gates, tests } = await gate(facts({ messages: ['Do the thing\n\nCloses #1\n'] }))
  assert.equal(named(gates, 'tests'), undefined, 'the test lens ran anyway')
  assert.equal(tests, undefined, 'a suite that never ran must report nothing, not false')
})

/**
 * The sweep-up commit *warns*. Refusing was considered and is wrong: that commit exists to
 * save work which would otherwise be deleted with the workspace seconds later, and a gate
 * that threw it away would make the safety net pointless. What it must not do is arrive
 * silently, because a pull request whose entire content came in that way has no
 * explanation in it at all.
 */
test('work the agent left uncommitted passes, and says so', async () => {
  const { gates } = await gate(
    facts({ messages: [SWEEP_UP_SUBJECT], sweptUp: true }),
    greenSandbox,
  )
  const lens = named(gates, 'commit-message')
  assert.equal(lens?.passed, true)
  assert.match(lens?.detail ?? '', /left work in the worktree/)
})

/**
 * The self-gating lens, and the reason it never refuses.
 *
 * `.ogun/config.yaml` is a file in the repository like any other; a reviewer can file a
 * finding about it and a modifier should be able to fix it. The gates were read from the
 * blob at the pinned base before the agent started, so the edit changes nothing about how
 * the run is judged. What must not happen is that the edit is invisible — "the agent
 * edited its own exam paper" is the sentence a person wants before they read the diff,
 * and it must not depend on them spotting one path in a file list.
 */
test('a patch that edits the project\'s own gates passes, loudly', async () => {
  const { gates } = await gate(
    facts({ paths: ['src/authority.ts', '.ogun/config.yaml'] }),
    greenSandbox,
  )
  const lens = named(gates, 'self-gating')
  assert.equal(lens?.passed, true)
  assert.match(lens?.detail ?? '', /\.ogun\/config\.yaml/)
  assert.match(lens?.detail ?? '', /pinned base/)
})

test('a patch that leaves the gates alone says nothing about them', async () => {
  const { gates } = await gate(facts(), greenSandbox)
  const lens = named(gates, 'self-gating')
  assert.equal(lens?.passed, true)
  assert.equal(lens?.detail, undefined)
})

/**
 * A modifier that decided nothing needed doing has to reach `approved`, so these lenses
 * have to pass — but they pass *with a detail*, because "the messages were read and were
 * clean" and "there were no messages to read" are two different facts and the ledger has
 * to be able to tell them apart (principle 6). A bare `passed: true` here is the silent
 * pass the whole gate exists to avoid.
 */
test('a run that produced no patch passes both lenses without claiming to have read one', async () => {
  const { gates } = await gate(undefined, greenSandbox)
  for (const name of ['commit-message', 'self-gating']) {
    const lens = named(gates, name)
    assert.equal(lens?.passed, true, name)
    assert.match(lens?.detail ?? '', /no patch/, name)
  }
})

/** A reviewer produces no diff, so none of this is asked of it. */
test('the patch lenses are not resolved for a reviewer', async () => {
  const { gates } = await runVerifyGate({
    config: undefined,
    permissions: 'reviewer',
    output: { findings: [] },
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox: inertSandbox,
    deadline: Date.now() + 60_000,
  })
  assert.equal(named(gates, 'commit-message'), undefined)
  assert.equal(named(gates, 'self-gating'), undefined)
})
