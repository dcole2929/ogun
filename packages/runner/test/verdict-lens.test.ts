import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import type { Sandbox } from '../src/sandbox/index.ts'

/**
 * The `verdict` lens (§4.10), which is the only thing standing between a scope evaluator
 * that did not answer and a pipeline that runs anyway.
 *
 * The property is about the *absence* case, not the happy one. A worker whose whole product
 * is a decision has one way to fail that nothing else catches: it wanders off, hits its
 * timeout mid-thought, or forgets the last command in its skill, and leaves a document that
 * parses perfectly and says nothing. Without this lens that run is `approved` — the node
 * succeeds, its dependents are released, and the plan and implement stages run on a ticket
 * nobody judged. Fail-open at the one gate whose job is to be closed.
 *
 * Failing is deliberately not the same as declining, and the second test is what keeps
 * those apart. A missing verdict must never be recorded as a quiet "no": the emission
 * ledger never re-emits a ticket (ADR-0013), so a decline nobody made would refuse that
 * ticket for good.
 */

const sandbox = {
  kind: 'container',
  provision: async () => {},
  exec: () => {
    throw new Error('the verdict lens must not shell out')
  },
  readFile: async () => null,
  dispose: async () => {},
} as unknown as Sandbox

const gate = async (output: unknown) =>
  (
    await runVerifyGate({
      config: {
        expectations: [{ name: 'verdict', method: 'tool' }],
        skipDefaultLenses: [],
        lensProfile: 'default',
      },
      permissions: 'observer',
      output,
      knownPaths: new Set<string>(),
      lineCountOf: async () => null,
      sandbox,
      deadline: Date.now() + 60_000,
    })
  ).gates

const named = (gates: Awaited<ReturnType<typeof gate>>, name: string) =>
  gates.find((g) => g.name === name)

test('a document with no verdict fails the gate rather than passing as approved', async () => {
  const gates = await gate({ findings: [] })
  const verdict = named(gates, 'verdict')
  assert.equal(verdict?.passed, false)
  // The refusal has to name the fix, because the agent that reads it is the one that can
  // still act on it — this is the same round, not a post-mortem.
  assert.match(verdict?.detail ?? '', /scope/)
})

test('a verdict passes and lands on the timeline with its reason', async () => {
  for (const v of ['admit', 'decline'] as const) {
    const gates = await gate({
      findings: [],
      scope: { verdict: v, reason: 'the ticket names no behaviour to change' },
    })
    const verdict = named(gates, 'verdict')
    assert.equal(verdict?.passed, true, `${v} is a verdict, and both are`)
    // Both halves, so the one sentence that decides whether a pipeline runs is legible
    // from the run page without opening the ledger.
    assert.match(verdict?.detail ?? '', new RegExp(v))
    assert.match(verdict?.detail ?? '', /names no behaviour/)
  }
})

/**
 * The schema lens is what makes the verdict trustworthy, and it runs first: an empty
 * `reason` is the shape of a decline nobody explained, and on a decline the reason is the
 * only thing the ticket will ever produce.
 */
test('a verdict with no reason does not parse, so the whole document is refused', async () => {
  const gates = await gate({ findings: [], scope: { verdict: 'decline', reason: '   ' } })
  assert.equal(named(gates, 'schema')?.passed, false)
  assert.equal(named(gates, 'verdict'), undefined, 'a failed tool lens short-circuits the rest')
})

/**
 * Every other worker in the fleet is unaffected. The lens is declared per worker precisely
 * so that a reviewer holding no verdict is an ordinary reviewer rather than a broken one —
 * and a default here would have made the whole fleet fail on the day it landed.
 */
test('a worker that does not declare the lens is not asked for a verdict', async () => {
  const gates = (
    await runVerifyGate({
      config: undefined,
      permissions: 'reviewer',
      output: { findings: [] },
      knownPaths: new Set<string>(),
      lineCountOf: async () => null,
      sandbox,
      deadline: Date.now() + 60_000,
    })
  ).gates
  assert.equal(
    gates.find((g) => g.name === 'verdict'),
    undefined,
  )
  assert.ok(gates.every((g) => g.passed))
})
