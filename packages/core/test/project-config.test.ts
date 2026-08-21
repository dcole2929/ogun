import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readPolicies, readTestCommand } from '../src/config/project.ts'

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
