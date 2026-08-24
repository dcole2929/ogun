import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  controlPlanePoliciesSchema,
  defaultControlPlanePolicies,
  projectConfigSchema,
  readPolicies,
  readTestCommand,
} from '../src/config/project.ts'

/**
 * `readTestCommand` is read by two callers that cannot afford the strict schema:
 * admission reads a working copy someone may be halfway through editing, and the runner
 * reads the blob at whatever commit the workspace was pinned to — which may have been
 * written by a different version of Ogun than the one reading it.
 *
 * The tolerance only ever widens what counts as a command. Every failure is `undefined`,
 * and both callers refuse on `undefined`, so nothing here can turn a broken file into a
 * passing gate.
 */

test('the project-level test command is read from tests.command', () => {
  assert.equal(readTestCommand('tests:\n  command: pnpm -s test\n'), 'pnpm -s test')
})

test('a config this build cannot fully parse still answers about tests', () => {
  const config = `project:
  name: demo
workers:
  fixer:
    skill: ./skills/fix
    permissions: chaotic-neutral
    someKeyFromAFutureVersion: true
tests:
  command: cargo test --all
`
  // `projectConfigSchema.parse` throws on that `permissions` value. Answering "this
  // project declares no way to test itself" because of an unrelated worker would refuse
  // every modifier in the repository for a reason that has nothing to do with tests.
  assert.equal(readTestCommand(config), 'cargo test --all')
})

test('no tests block, an empty command, and unparseable yaml are all "none"', () => {
  assert.equal(readTestCommand('project:\n  name: demo\n'), undefined)
  assert.equal(readTestCommand('tests: {}\n'), undefined)
  // Rejected rather than accepted as a command that trivially succeeds.
  assert.equal(readTestCommand('tests:\n  command: ""\n'), undefined)
  assert.equal(readTestCommand('tests:\n  command: [a, b\n'), undefined)
  assert.equal(readTestCommand(''), undefined)
})

/**
 * `readPolicies` is the publisher's half of the same idea, and the asymmetry with
 * `readTestCommand` is the thing worth pinning down.
 *
 * An absent `policies:` block is not a failure — it means the defaults, which is what
 * most repositories have. Anything the reader cannot make sense of *is* a failure, and
 * comes back `undefined` so the publisher refuses rather than publishing on a guess. Those
 * two must not converge: a project that carefully set `maxOpenPullRequests: 0` and then
 * broke its YAML would otherwise get three pull requests the next morning.
 */

test('an absent policies block means the defaults, not an unreadable one', () => {
  const defaults = readPolicies('project:\n  name: demo\n')
  assert.equal(defaults?.maxOpenPullRequests, 3)
  assert.equal(defaults?.directPush, false)
})

test('a policies block this build cannot parse is "unknown", not "the defaults"', () => {
  assert.equal(readPolicies('policies:\n  maxOpenPullRequests: nope\n'), undefined)
  assert.equal(readPolicies('policies:\n  maxOpenPullRequests: -1\n'), undefined)
  assert.equal(readPolicies('policies: [a, b\n'), undefined)
  assert.equal(readPolicies('policies: "off"\n'), undefined)
})

test('a broken workers block does not stop the policies being read', () => {
  const config = `project:
  name: demo
workers:
  fixer:
    skill: ./skills/fix
    permissions: chaotic-neutral
policies:
  maxOpenPullRequests: 0
`
  // Same reason as the test command above: an unrelated worker this build cannot parse
  // must not be able to change what the publisher believes the project's cap is.
  assert.equal(readPolicies(config)?.maxOpenPullRequests, 0)
})

/**
 * The split between the two halves of `policies:`, asserted from the core side.
 *
 * Two of these keys decide what an agent's own work may become — `allowSandboxDowngrade`
 * and `maxOpenPullRequests` — and the runner reads them out of the git blob at the pinned
 * base, because a modifier can write to its own checkout. Two decide scheduling —
 * `failureBreakerThreshold` and `maxConcurrentModifiers` — and the control plane stores
 * them, because the agent cannot influence them and the runner has no business
 * re-deriving them.
 *
 * The property protected is that neither reader can answer the other's question. A naive
 * implementation has one `Policies` type flowing everywhere, which compiles perfectly and
 * leaves `project.policies.maxOpenPullRequests` — a number out of a database row — looking
 * exactly as authoritative as the one the runner fetched from git. Types cannot be
 * asserted at runtime, so what is asserted here is the erasure they are built on: each
 * schema *drops* the other's keys rather than merely declining to mention them.
 */
test('the pinned half carries no scheduling keys, whatever the file says', () => {
  const config = `policies:
  maxOpenPullRequests: 1
  allowSandboxDowngrade: true
  failureBreakerThreshold: 9
  maxConcurrentModifiers: 7
`
  const pinned = readPolicies(config)
  assert.equal(pinned?.maxOpenPullRequests, 1)
  assert.equal(pinned?.allowSandboxDowngrade, true)
  // Not "present but ignored" — absent. A key that is there is a key someone reaches for,
  // and the point is that the runner has no scheduling answer to give at all.
  assert.equal(Object.hasOwn(pinned!, 'failureBreakerThreshold'), false)
  assert.equal(Object.hasOwn(pinned!, 'maxConcurrentModifiers'), false)
})

test('the control-plane half carries no gate that an agent could edit', () => {
  const stored = controlPlanePoliciesSchema.parse({
    failureBreakerThreshold: 9,
    maxConcurrentModifiers: 7,
    maxOpenPullRequests: 999,
    allowSandboxDowngrade: true,
    directPush: true,
  })
  assert.equal(stored.failureBreakerThreshold, 9)
  assert.equal(stored.maxConcurrentModifiers, 7)
  // This is what stops a sync payload writing a publisher gate into the database:
  // `maxOpenPullRequests: 999` arrived and did not survive the door.
  assert.equal(Object.hasOwn(stored, 'maxOpenPullRequests'), false)
  assert.equal(Object.hasOwn(stored, 'allowSandboxDowngrade'), false)
  assert.equal(Object.hasOwn(stored, 'directPush'), false)
})

test('a project the control plane has never been told about gets the schema defaults', () => {
  // Has to be the schema's own defaults rather than a second list of numbers, or the
  // fallback and the file drift apart the way `DEFAULT_LIMITS` and `policiesSchema` did.
  assert.deepEqual(defaultControlPlanePolicies(), {
    failureBreakerThreshold: 3,
    maxConcurrentModifiers: 1,
  })
})

/**
 * `extends:` was declared in the schema, shown in §4.9's example config, and read by
 * nothing — no loader, no inheritance, no consumer to remove.
 *
 * The property protected is that it now fails rather than being ignored. The naive fix is
 * to delete the field, which looks like removal and is not: zod strips keys it was not
 * told about, so every config still carrying the line would go on being silently ignored,
 * now with nothing left in the schema to explain what happened to it. Breaking loudly is
 * the point — somebody who believes they have config inheritance should find out.
 */
test('a config that sets extends is refused, not quietly ignored', () => {
  const parsed = projectConfigSchema.safeParse(
    parseYaml('project:\n  name: demo\nextends: [ogun://typescript]\n'),
  )
  assert.equal(parsed.success, false)
  assert.equal(parsed.error!.issues[0]!.path.join('.'), 'extends')
  assert.match(parsed.error!.issues[0]!.message, /extends/)
})

test('an empty extends key is refused too, since it is still a line to delete', () => {
  // `extends:` with nothing after it parses to null, not undefined. Accepting that would
  // make the refusal depend on whether the list happened to be empty.
  const parsed = projectConfigSchema.safeParse(parseYaml('project:\n  name: demo\nextends:\n'))
  assert.equal(parsed.success, false)
})

test('a config that never mentions extends is unaffected', () => {
  assert.equal(projectConfigSchema.safeParse(parseYaml('project:\n  name: demo\n')).success, true)
})
