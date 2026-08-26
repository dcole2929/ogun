import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { findingsDocumentSchema } from '@ogun/core'

/**
 * The `scope` block of a report document (§4.13, ADR-0013) — the field a node uses to say
 * whether the work it was handed should go ahead.
 *
 * What is under test is mostly the *reason*, because the reason is the part that carries
 * the consequence. Ogun writes nothing back to the tracker and the emission ledger never
 * re-emits a ticket, so a decline is the last thing that will ever happen to that card: the
 * sentence in here is the entire trace, and a schema that accepted a blank one would let a
 * ticket disappear with the ledger recording that something happened to it.
 */

const doc = (over: Record<string, unknown> = {}) => ({ findings: [], ...over })
const ok = (input: unknown) => findingsDocumentSchema.safeParse(input).success

test('a verdict without a reason does not parse — there is no bare yes or no', () => {
  assert.equal(ok(doc({ scope: { verdict: 'decline' } })), false)
  // Required on an admit too, and that is the less obvious half: it is the record of what
  // the evaluator thought it was admitting, which is what anybody reaches for when a
  // pipeline three stages later produces something nobody recognises.
  assert.equal(ok(doc({ scope: { verdict: 'admit' } })), false)
})

test('a reason of nothing but whitespace is not a reason', () => {
  assert.equal(ok(doc({ scope: { verdict: 'decline', reason: '   \n' } })), false)
  assert.equal(ok(doc({ scope: { verdict: 'decline', reason: 'no behaviour named' } })), true)
})

/**
 * Two values and no third. "maybe", "unsure" or a free-text verdict would each have to mean
 * something to `releaseDependents`, which has exactly two things it can do with a node.
 */
test('the verdict is one of two words', () => {
  assert.equal(ok(doc({ scope: { verdict: 'admit', reason: 'r' } })), true)
  assert.equal(ok(doc({ scope: { verdict: 'decline', reason: 'r' } })), true)
  assert.equal(ok(doc({ scope: { verdict: 'maybe', reason: 'r' } })), false)
})

/**
 * The whole fleet predates this field and none of it carries one. A required `scope` would
 * have failed every reviewer and every modifier on the day it landed, which is why it is
 * optional rather than defaulted — and why a worker that *must* answer says so with the
 * `verdict` lens instead.
 */
test('a document with no scope block is still a document', () => {
  assert.equal(ok(doc()), true)
  assert.equal(ok(doc({ notes: 'inconclusive' })), true)
})

/**
 * A verdict and findings are independent. The verdict decides what happens to the *cycle*;
 * it does not decide what the node was allowed to have noticed, and a schema that coupled
 * them would be the place a modifier's observations got silently dropped for the second
 * time.
 */
test('a verdict does not preclude findings', () => {
  const withFinding = doc({
    findings: [
      {
        fingerprint: 'api/orders/isolation/id-swap',
        title: 'title',
        body: 'body',
        severity: 'high',
        citations: [{ path: 'src/orders.ts', line: 12 }],
      },
    ],
    scope: { verdict: 'admit', reason: 'the export handler is in src/export.ts' },
  })
  assert.equal(ok(withFinding), true)
})
