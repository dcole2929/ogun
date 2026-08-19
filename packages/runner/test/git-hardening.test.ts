import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { gitIn, stageAll } from '../src/workspace.ts'

const run = promisify(execFile)

/**
 * A workspace's `.git` is agent-authored by the time the runner touches it — the mount is
 * read-write for a modifier, and was read-write for every profile until the permission
 * work landed. Git executes repository configuration and hooks, on the host, as the
 * runner, with the runner's control-plane token in its environment.
 *
 * The container escapes nothing. It leaves a string behind and waits for the host to run
 * it, which is the same shape as the symlink readback §5.3 already guards — and the two
 * calls involved, `git add -A` and `git ls-files`, ran on every single run.
 *
 * The canary is a file: if git executed the command, it exists.
 */
const hostile = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-git-'))
  const repo = join(root, 'repo')
  const canary = join(root, 'EXECUTED')
  await mkdir(repo, { recursive: true })

  const git = (args: string[]) => run('git', ['-C', repo, ...args])
  await git(['init', '-q'])
  await writeFile(join(repo, 'a.txt'), 'a\n')
  await git(['add', '-A'])
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

  // Exactly what an agent with a shell and a writable workspace can leave behind.
  await git(['config', 'core.fsmonitor', `touch ${canary}; echo`])
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
  await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${canary}\n`)
  await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755)

  return { repo, canary }
}

test('a workspace cannot make the runner run its command via core.fsmonitor', async () => {
  const { repo, canary } = await hostile()
  await stageAll(repo)
  await gitIn(repo, ['ls-files'])
  assert.equal(existsSync(canary), false, 'the workspace executed a command on the host')
})

test('and cannot do it through a hook either', async () => {
  const { repo, canary } = await hostile()
  await writeFile(join(repo, 'b.txt'), 'b\n')
  await stageAll(repo)
  await gitIn(repo, ['-c', 'user.email=o@o', '-c', 'user.name=o', 'commit', '-qm', 'x']).catch(
    () => undefined,
  )
  assert.equal(existsSync(canary), false, 'a repository hook ran on the host')
})

/** The guard must not break the thing it guards: these calls still have to work. */
test('the hardened calls still do their job', async () => {
  const { repo } = await hostile()
  await writeFile(join(repo, 'new.ts'), 'export const x = 1\n')
  await stageAll(repo)
  const tracked = await gitIn(repo, ['ls-files'])
  assert.ok(tracked.includes('new.ts'), 'staging an untracked file is why stageAll exists (§5.3)')
})
