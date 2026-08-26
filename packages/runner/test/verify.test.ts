import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import type { Sandbox } from '../src/sandbox/index.ts'

const sandbox = {
  kind: 'container',
  provision: async () => {},
  exec: () => {
    throw new Error('no tool lens should shell out in these tests')
  },
  readFile: async () => null,
  dispose: async () => {},
} as unknown as Sandbox

/**
 * A reviewer's gate never reaches the deadline — no lens it runs shells out — so this is
 * a plausible one rather than a fixture with meaning. The modifier gate, which does use
 * it, is exercised in tests-gate.test.ts.
 */
const deadline = () => Date.now() + 60_000

const gate = async (output: unknown, files: Record<string, number>) =>
  (
    await runVerifyGate({
      config: undefined,
      permissions: 'reviewer',
      output,
      knownPaths: new Set(Object.keys(files)),
      lineCountOf: async (p) => files[p] ?? null,
      sandbox,
      deadline: deadline(),
    })
  ).gates

const finding = (over: Record<string, unknown> = {}) => ({
  fingerprint: 'security/orders/isolation/id-swap',
  title: 'title',
  body: 'body',
  severity: 'high',
  citations: [{ path: 'src/orders.ts', line: 12 }],
  ...over,
})

const named = (gates: Awaited<ReturnType<typeof gate>>, name: string) =>
  gates.find((g) => g.name === name)

test('a grounded finding passes both tool checks', async () => {
  const gates = await gate({ findings: [finding()] }, { 'src/orders.ts': 40 })
  assert.equal(named(gates, 'schema')?.passed, true)
  assert.equal(named(gates, 'grounded')?.passed, true)
})

test('a citation past the end of a real file is not grounded', async () => {
  // The shape a confabulated finding actually takes: a plausible filename with an
  // invented location in it. A path-only check waves this through.
  const gates = await gate(
    { findings: [finding({ citations: [{ path: 'src/orders.ts', line: 9999 }] })] },
    { 'src/orders.ts': 40 },
  )
  const grounded = named(gates, 'grounded')
  assert.equal(grounded?.passed, false)
  assert.match(grounded?.detail ?? '', /has 40 lines/)
})

test('a citation to a file that is not in the tree is not grounded', async () => {
  const gates = await gate(
    { findings: [finding({ citations: [{ path: 'src/ghost.ts', line: 1 }] })] },
    { 'src/orders.ts': 40 },
  )
  assert.equal(named(gates, 'grounded')?.passed, false)
})

test('an unreadable file is not judged either way', async () => {
  // null means "cannot judge", which must not become a failure — a generated or
  // gitignored-but-tracked file should not discard a whole run's findings.
  const { gates } = await runVerifyGate({
    config: undefined,
    permissions: 'reviewer',
    output: { findings: [finding({ citations: [{ path: 'src/orders.ts', line: 9999 }] })] },
    knownPaths: new Set(['src/orders.ts']),
    lineCountOf: async () => null,
    sandbox,
    deadline: deadline(),
  })
  assert.equal(named(gates, 'grounded')?.passed, true)
})

test('an invalid schema short-circuits before grounding is attempted', async () => {
  const gates = await gate({ findings: [{ title: 'no fingerprint' }] }, {})
  assert.equal(gates.length, 1, 'a failed tool check must not spend the next one')
  assert.equal(gates[0]?.name, 'schema')
  assert.equal(gates[0]?.passed, false)
})

test('a missing output document fails rather than reading as clean', async () => {
  const gates = await gate(undefined, {})
  assert.equal(named(gates, 'schema')?.passed, false)
  assert.match(named(gates, 'schema')?.detail ?? '', /no findings document/)
})

test('zero findings is a valid document — clean is a real result', async () => {
  const gates = await gate({ findings: [] }, {})
  assert.ok(gates.every((g) => g.passed))
})

/**
 * An expectation somebody wrote down must never be reported as met by a build that did
 * not check it.
 *
 * This used to be the whole story for agent lenses, and for a lens this build does not
 * recognise it still is: §4.10's calibration argument means no agent rubric is in any
 * profile's *defaults*, so a worker naming one that is not wired gets a gate recorded as
 * skipped, with its own name in the reason. The one wired lens — `review` — is covered
 * in `review-lens.test.ts`, where the interesting property is the opposite one: a review
 * that could not run fails rather than being skipped.
 */
test('an agent lens this build does not know is recorded as skipped, never as silently passed', async () => {
  const { gates } = await runVerifyGate({
    config: {
      expectations: [
        { name: 'actionable', method: 'agent', prompt: 'is each finding actionable?' },
      ],
      skipDefaultLenses: [],
      lensProfile: 'default',
    },
    permissions: 'reviewer',
    output: { findings: [] },
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox,
    deadline: deadline(),
  })
  const lens = named(gates, 'actionable')
  assert.equal(lens?.method, 'agent')
  assert.match(lens?.detail ?? '', /no agent lens named "actionable" is wired/)
})
