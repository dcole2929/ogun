import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cycleConfigSchema,
  cycleDefinitionSchema,
  cycleGraphProblems,
  expandCycle,
} from '../src/config/cycle.ts'

/**
 * A cycle nobody can finish.
 *
 * The `nodes`/`edges` form is written by hand and stored as jsonb, and nothing looked at
 * what the graph did — only at whether it had the right keys. A loop, or an edge naming a
 * node that is not there, is accepted, and at 3am every job in it sits `blocked`: a node
 * is released only when its dependencies are terminal, and none of them ever becomes so.
 * No error, no timeout, no terminal state — which is the worst way for a nightly factory
 * to fail, because nothing says it did.
 */
const graph = (nodes: string[], edges: Array<[string, string]>) => ({
  nodes: nodes.map((key) => ({ key, worker: key })),
  edges: edges.map(([from, to]) => ({ from, to })),
})

const refusal = (cycle: unknown): string => {
  const parsed = cycleConfigSchema.safeParse(cycle)
  assert.equal(parsed.success, false, 'the graph was accepted')
  return parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('\n')
}

test('a loop is refused, and named', () => {
  // Not "the graph is invalid": the person reading this hand-wrote the edges and needs to
  // know which two lines contradict each other.
  assert.equal(
    refusal(graph(['a', 'b'], [['a', 'b'], ['b', 'a']])),
    'a loop, so nothing in it can ever start: a → b → a',
  )
})

test('a longer loop is named the whole way round', () => {
  assert.equal(
    refusal(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])),
    'a loop, so nothing in it can ever start: a → b → c → a',
  )
})

test('a loop reached through a healthy node is reported once, at the loop', () => {
  // The entry node is fine and would run. Reporting `start → a → b → a` would send someone
  // to edit an edge that is not the problem.
  assert.equal(
    refusal(graph(['start', 'a', 'b'], [['start', 'a'], ['a', 'b'], ['b', 'a']])),
    'a loop, so nothing in it can ever start: a → b → a',
  )
})

test('an edge to a node that does not exist is refused, with the keys that do', () => {
  // The whole point of this message is the typo, so it lists what could have been meant.
  assert.equal(
    refusal(graph(['adversarial-review', 'triage'], [['adversarial-review', 'triaje']])),
    'edge "adversarial-review" → "triaje": no node has the key "triaje" ' +
      "(this cycle's nodes: adversarial-review, triage)",
  )
})

test('an edge from a node that does not exist is refused too', () => {
  // The dependent waits on something that will never report, which is the same hang.
  assert.match(refusal(graph(['triage'], [['ghost', 'triage']])), /no node has the key "ghost"/)
})

test('two nodes with one key are refused', () => {
  assert.match(refusal(graph(['triage', 'triage'], [])), /two nodes share the key "triage"/)
})

test('a graph with no entry node is reported as the loop it contains', () => {
  // Every node here has an incoming edge, so nothing is ever queued. That needs no message
  // of its own: once every edge names a real node, a graph with no entry must contain a
  // loop, and the loop is the half that says which line to edit.
  const problems = cycleGraphProblems(
    cycleDefinitionSchema.parse(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['a', 'c']])),
  )
  assert.deepEqual(problems, ['a loop, so nothing in it can ever start: a → b → a'])
})

test('every problem in one graph is reported, not just the first', () => {
  // A person fixing a hand-written block should not have to sync four times to find four
  // mistakes.
  const problems = cycleGraphProblems(
    cycleDefinitionSchema.parse(graph(['a', 'a', 'b'], [['b', 'ghost'], ['b', 'b']])),
  )
  assert.equal(problems.length, 3, problems.join('\n'))
})

test('the shapes that are meant to work still parse', () => {
  // Over-refusal here means a factory that cannot be configured at all, so the fan-in,
  // the chain, the diamond and the unconnected set are all pinned.
  for (const ok of [
    graph(['a', 'b', 'triage'], [['a', 'triage'], ['b', 'triage']]),
    graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]),
    graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]),
    graph(['a', 'b'], []),
  ]) {
    assert.equal(cycleConfigSchema.safeParse(ok).success, true, JSON.stringify(ok))
  }
})

/**
 * The sugar is where this is most likely to be hit, since it is what people write. It can
 * only produce two of these — a repeated worker, and a `then:` that is also one of the
 * workers — and it says so in the file's own vocabulary rather than talking about node
 * keys and edges that the file does not contain.
 */
test('a then: that is also one of the workers is refused in the sugar\'s own words', () => {
  assert.equal(
    refusal({ workers: ['adversarial-review', 'triage'], then: 'triage' }),
    '"triage" is also in workers: — it would have to run after itself, so it would sit blocked forever',
  )
})

test('a worker listed twice in the sugar is refused', () => {
  assert.match(refusal({ workers: ['a', 'a'], then: 'triage' }), /"a" is listed twice/)
})

test('the sugar Ogun itself uses still expands', () => {
  const nightly = expandCycle(
    cycleConfigSchema.parse({ workers: ['adversarial-review', 'security-review'], then: 'triage' }),
  )
  assert.deepEqual(nightly.edges.map((e) => `${e.from}→${e.to}`), [
    'adversarial-review→triage',
    'security-review→triage',
  ])
})

test('a graph already in the database still parses, so it can be shown', () => {
  /**
   * The check is on the write path only. `cycleDefinitionSchema` also reads back the
   * jsonb in `cycles` and `cycle_runs`, where a loop written before any of this existed
   * can still be sitting — and `ogun cycles` has to be able to print that row. A schema
   * that refused it would turn the one graph worth looking at into a blank line.
   */
  const stored = cycleDefinitionSchema.parse(graph(['a', 'b'], [['a', 'b'], ['b', 'a']]))
  assert.equal(stored.nodes.length, 2)
  assert.equal(cycleGraphProblems(stored).length, 1)
})
