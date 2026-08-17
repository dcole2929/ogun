import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cycleDefinitionSchema, expandCycle } from '@ogun/core'
import { layersOf, shapeOf } from '../src/commands/cycles.ts'

/**
 * The shape of a cycle is the whole reason to list them, and it is derived rather than
 * stored: `definition` is jsonb the database never validated, so these tests are as much
 * about the inputs that should not exist as about the ones that should.
 */
const define = (nodes: string[], edges: Array<[string, string]>) =>
  cycleDefinitionSchema.parse({
    nodes: nodes.map((key) => ({ key, worker: key })),
    edges: edges.map(([from, to]) => ({ from, to })),
  })

test('a fan-in reads as its layers, not as a node count', () => {
  // The sugar in config.yaml, expanded exactly as `ogun project sync` expands it.
  const nightly = expandCycle({
    workers: ['adversarial-review', 'security-review'],
    then: 'triage',
    onDepFailure: 'degrade',
    onMissed: 'skip',
    enabled: true,
  })
  assert.deepEqual(layersOf(nightly), [['adversarial-review', 'security-review'], ['triage']])
  assert.equal(shapeOf(nightly), 'adversarial-review, security-review → triage')
})

test('a chain and a fan-in of the same size do not look alike', () => {
  // Both are 3 nodes and 2 edges. One is a night; the other is three nights in a row.
  const chain = define(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  const fan = define(['a', 'b', 'c'], [['a', 'c'], ['b', 'c']])
  assert.equal(shapeOf(chain), 'a → b → c')
  assert.equal(shapeOf(fan), 'a, b → c')
})

test('names give way to counts only when they will not fit', () => {
  const wide = define(
    ['adversarial-review', 'security-review', 'dependency-health', 'triage'],
    [
      ['adversarial-review', 'triage'],
      ['security-review', 'triage'],
      ['dependency-health', 'triage'],
    ],
  )
  assert.equal(shapeOf(wide), '3 workers → triage')
  // Given room, the names are what a person came to read.
  assert.equal(
    shapeOf(wide, 80),
    'adversarial-review, security-review, dependency-health → triage',
  )
})

test('a graph too wide even counted is truncated rather than wrapped', () => {
  // A cell that wraps stops being a column, and the table is the whole point.
  const long = define(['a-very-long-worker-name-indeed', 'b'], [['a-very-long-worker-name-indeed', 'b']])
  const shape = shapeOf(long, 20)
  assert.equal(shape.length, 20)
  assert.ok(shape.endsWith('…'), shape)
})

test('a cycle in the "DAG" is printed, not hung on', () => {
  // Nothing validates acyclicity on the way in. The foreman would deadlock on this; a
  // listing command must terminate and show the knot.
  const knot = define(['a', 'b'], [['a', 'b'], ['b', 'a']])
  assert.deepEqual(layersOf(knot), [['a', 'b']])
})

test('an edge from a node that is not in the graph is ignored', () => {
  // Otherwise the node waits forever on a dependency that can never arrive — which is a
  // hang in a read-only command, in service of an edge that already means nothing.
  const dangling = define(['a'], [['ghost', 'a']])
  assert.deepEqual(layersOf(dangling), [['a']])
})

test('unconnected nodes all start at once, in the order they were written', () => {
  const parallel = define(['b', 'a', 'c'], [])
  assert.deepEqual(layersOf(parallel), [['b', 'a', 'c']])
})
