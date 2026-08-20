import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readTestCommand } from '../src/config/project.ts'

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
