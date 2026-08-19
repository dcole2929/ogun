import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { extractPatch } from '../src/patch.ts'
import { materializeWorkspace } from '../src/workspace.ts'

const run = promisify(execFile)

/**
 * The crossing (ADR-0005): a modifier's work exists only as commits in a clone the runner
 * deletes at the end of the job, because the container had no remote to put it anywhere
 * else. Everything below is about what survives that trip and what is recorded when
 * nothing does.
 *
 * The fixture is the real one — `materializeWorkspace`, so the workspace is a local clone
 * detached at a pinned SHA with `origin` removed, exactly as a run gets it.
 */
const factory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-patch-'))
  const source = join(root, 'source')
  await run('mkdir', ['-p', source])
  await git(source, ['init', '-q', '-b', 'main'])
  await writeFile(join(source, 'app.ts'), 'export const answer = 41\n')
  await git(source, ['add', '-A'])
  await commit(source, 'Base')
  const { stdout } = await git(source, ['rev-parse', 'HEAD'])
  const baseSha = stdout.trim()

  const workspace = await materializeWorkspace({
    sourceRepo: source,
    scratch: join(root, 'scratch'),
    runId: 'run-1',
    ref: baseSha,
  })
  return { root, source, baseSha, workspace, destDir: join(root, 'patches') }
}

const git = (repo: string, args: string[]) =>
  run('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })

const commit = (repo: string, message: string) =>
  git(repo, ['-c', 'user.name=agent', '-c', 'user.email=agent@test', 'commit', '-qm', message])

/**
 * What the host will do with the artefact in the publisher slice, run here so the tests
 * assert "applies", not "looks plausible". A fresh clone of the source at the base, then
 * `git am`.
 */
const applyOnHost = async (root: string, source: string, baseSha: string, patch: string) => {
  const target = join(root, `apply-${Math.random().toString(36).slice(2)}`)
  await run('git', ['clone', '-q', '--no-local', source, target])
  await git(target, ['checkout', '-q', '--detach', baseSha])
  await git(target, ['-c', 'user.name=host', '-c', 'user.email=host@test', 'am', patch])
  return target
}

test('a commit the agent made survives the trip, message and all', async () => {
  const { root, source, baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'Correct the answer')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.filesChanged, 1)
  assert.equal(extracted.commits, 1)
  assert.ok(extracted.patch, 'a modifier that committed produced no patch')

  const applied = await applyOnHost(root, source, baseSha, extracted.patch!.ref)
  assert.equal(await readFile(join(applied, 'app.ts'), 'utf8'), 'export const answer = 42\n')
  // The reason this is format-patch and not a diff: a diff applies just as well and
  // arrives with nothing to put in the pull request.
  const log = await git(applied, ['log', '-1', '--pretty=%s%n%an'])
  assert.equal(log.stdout.trim(), 'Correct the answer\nagent')
})

/**
 * Not every artefact format carries these: a plain `git diff` reports "Binary files
 * differ" unless asked otherwise, and a patch that applies with the image missing looks
 * like a complete branch. Asserted on the applied tree rather than on the patch text, so
 * it holds whatever the extraction is built from.
 */
test('a binary file the agent added arrives byte for byte', async () => {
  const { root, source, baseSha, workspace, destDir } = await factory()
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 42])
  await writeFile(join(workspace.path, 'logo.png'), bytes)
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'Add a logo')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  const applied = await applyOnHost(root, source, baseSha, extracted.patch!.ref)
  assert.deepEqual(await readFile(join(applied, 'logo.png')), bytes)
})

/**
 * The failure this slice exists to prevent. `format-patch` reads commits, so an agent that
 * edited the tree and never ran `git commit` is invisible to it — and the run would be
 * recorded as one that changed nothing, with the workspace deleted seconds later.
 */
test('work the agent left uncommitted is collected, not lost', async () => {
  const { root, source, baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await writeFile(join(workspace.path, 'new-file.ts'), 'export const added = true\n')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.filesChanged, 2, 'an untracked new file must be in the patch too')
  assert.ok(extracted.patch)

  const applied = await applyOnHost(root, source, baseSha, extracted.patch!.ref)
  assert.equal(await readFile(join(applied, 'new-file.ts'), 'utf8'), 'export const added = true\n')
  // Attributed to the harness rather than to the agent, because the agent wrote no
  // message and pretending otherwise would put a fiction in the pull request.
  const log = await git(applied, ['log', '-1', '--pretty=%s%n%an'])
  assert.equal(log.stdout.trim(), 'Work the agent left uncommitted\nogun')
})

test('a modifier that changed nothing records that, and is not an error', async () => {
  const { baseSha, workspace, destDir } = await factory()

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.filesChanged, 0)
  assert.equal(extracted.patch, undefined)
  // The distinction principle 6 is about: "ran and decided nothing needed doing" must not
  // arrive wearing the same value as "the patch could not be extracted".
  assert.equal(extracted.unextractable, undefined)
})

test('a change the agent committed and then reverted is not a change', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'Correct the answer')
  await git(workspace.path, ['-c', 'user.name=a', '-c', 'user.email=a@t', 'revert', '--no-edit', 'HEAD'])

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.filesChanged, 0, 'two commits netting to nothing is nothing to publish')
  assert.equal(extracted.patch, undefined)
})

/**
 * The workspace is mounted read-write, so by the time extraction runs the repository's
 * config and hooks are agent-authored — and git executes both, on the host, as the
 * runner. Measured before this test was written: an unhardened `git add` runs a
 * `core.fsmonitor` command and an unhardened `git commit` runs `.git/hooks/pre-commit`.
 *
 * The container never escapes anything. It leaves a string behind and waits for the host
 * to execute it — the same shape as the symlinked readback in §5.3.
 */
test('git config and hooks the agent planted do not run on the host', async () => {
  const { root, baseSha, workspace, destDir } = await factory()
  const canary = join(root, 'pwned')

  const hook = join(workspace.path, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, `#!/bin/sh\necho pwned > ${canary}\n`)
  await chmod(hook, 0o755)
  await git(workspace.path, ['config', 'core.fsmonitor', `sh -c 'echo pwned > ${canary}'`])
  await git(workspace.path, ['config', 'diff.external', `sh -c 'echo pwned > ${canary}'`])

  // Uncommitted, so extraction has to stage and commit — the two commands that run them.
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })

  assert.equal(existsSync(canary), false, 'the workspace made the runner execute its code')
  assert.ok(extracted.patch, 'hardening must not cost the extraction')
})

/**
 * `git am` replays `base..HEAD` onto the base the host has. An agent that amended or reset
 * past the pinned commit leaves work that cannot be expressed that way, and applying it
 * anyway would produce a branch nobody asked for.
 */
test('history rewritten off the pinned base is refused, with the fact kept', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await git(workspace.path, [
    '-c',
    'user.name=a',
    '-c',
    'user.email=a@t',
    'commit',
    '-q',
    '--amend',
    '-m',
    'Rewritten base',
  ])

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.patch, undefined)
  assert.match(extracted.unextractable ?? '', /not a descendant/)
  // Still counted: the run did change files, and after the workspace is deleted this line
  // is the only record of how much.
  assert.equal(extracted.filesChanged, 1)
})

/**
 * A patch is agent output and the agent decides how big it is — `git add node_modules` is
 * one command. The runner streams and counts rather than buffering, so the cap is reached
 * mid-stream; what it must not do is leave the part it already wrote, because a truncated
 * mbox still applies and applies wrong.
 */
test('an oversized patch is refused and leaves nothing half-written behind', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'huge.txt'), 'x'.repeat(200_000))
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'Commit something enormous')

  const extracted = await extractPatch({
    workspace: workspace.path,
    baseSha,
    destDir,
    limitBytes: 4096,
  })
  assert.equal(extracted.patch, undefined)
  assert.match(extracted.unextractable ?? '', /larger than the 4096 byte limit/)
  assert.deepEqual(
    await readdir(destDir).catch(() => []),
    [],
    'a partial patch was left on disk, and a partial patch applies',
  )
})
