import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { projectTestCommand } from '../src/pipeline.ts'
import { materializeWorkspace } from '../src/workspace.ts'

const run = promisify(execFile)
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args])

/**
 * Where the test gate's command comes from, and — the point of the whole file — where it
 * does not.
 *
 * The workspace is mounted read-write for a modifier, and `.ogun/config.yaml` is inside
 * it. An agent that edits `tests.command` to `true` is setting its own gate, and the
 * harness would run it and report a pass. The blob at the pinned base is the version a
 * person reviewed and merged, and it is the one copy the agent could not reach.
 */
const factory = async (configYaml: string | null) => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-testcmd-'))
  const source = join(root, 'source')
  await mkdir(join(source, '.ogun'), { recursive: true })
  await git(source, ['init', '-q', '-b', 'main'])
  await writeFile(join(source, 'app.ts'), 'export const answer = 41\n')
  if (configYaml !== null) await writeFile(join(source, '.ogun', 'config.yaml'), configYaml)
  await git(source, ['add', '-A'])
  await git(source, [
    '-c',
    'user.name=dev',
    '-c',
    'user.email=dev@test',
    'commit',
    '-qm',
    'Base',
  ])
  const { stdout } = await git(source, ['rev-parse', 'HEAD'])
  const workspace = await materializeWorkspace({
    sourceRepo: source,
    scratch: join(root, 'scratch'),
    runId: 'run-1',
    ref: stdout.trim(),
  })
  return { root, workspace, baseSha: stdout.trim() }
}

const CONFIG = `project:
  name: demo
tests:
  command: pnpm -s test
workers:
  fixer:
    skill: ./skills/fix
    permissions: modifier
`

test('the test command is read from the project config at the pinned base', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG)
  try {
    assert.equal(await projectTestCommand(workspace.path, baseSha), 'pnpm -s test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an agent rewriting the config in its own workspace does not change its gate', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG)
  try {
    // What one line of shell in a read-write workspace looks like.
    await writeFile(
      join(workspace.path, '.ogun', 'config.yaml'),
      CONFIG.replace('pnpm -s test', 'true'),
    )
    await git(workspace.path, ['add', '-A'])
    await git(workspace.path, [
      '-c',
      'user.name=agent',
      '-c',
      'user.email=agent@test',
      'commit',
      '-qm',
      'Improve the test command',
    ])

    assert.equal(
      await projectTestCommand(workspace.path, baseSha),
      'pnpm -s test',
      'the gate is the project\'s, not the patch\'s',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project that declares no test command yields none rather than a default', async () => {
  const { root, workspace, baseSha } = await factory('project:\n  name: demo\n')
  try {
    // Not `npm test`, not `make check`. A guessed command that is missing exits non-zero
    // on some runners and zero on others, and the second one is a gate that passes
    // because nothing ran.
    assert.equal(await projectTestCommand(workspace.path, baseSha), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a repository with no .ogun/config.yaml at that commit yields none, not an error', async () => {
  const { root, workspace, baseSha } = await factory(null)
  try {
    assert.equal(await projectTestCommand(workspace.path, baseSha), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
