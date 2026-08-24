import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { extractPatch } from '../src/patch.ts'
import { materializeWorkspace, sweepGateArtifacts } from '../src/workspace.ts'

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

/** A message with a body, which is where a closing keyword actually gets written. */
const commitBody = (repo: string, message: string) =>
  git(repo, [
    '-c',
    'user.name=agent',
    '-c',
    'user.email=agent@test',
    'commit',
    '-q',
    '-m',
    message,
    '--cleanup=verbatim',
  ])

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

/**
 * What the modifier lenses read (§4.10), gathered in the same pass that writes the mbox.
 *
 * The gate cannot go and get these itself: every git call against agent-authored content
 * has to go through `gitIn`'s hardening, and a second place for that rule to be true is a
 * second place for it to quietly stop being. So extraction reads them and the gate is
 * handed facts, exactly as it is handed `knownPaths`.
 */
test('a patch carries its commit messages, whole and in order', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await commitBody(workspace.path, 'Correct the answer\n\nThe body a reviewer reads.\n')
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 43\n')
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'And again')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  /**
   * The *body*, not just the subject, and that is the whole point: `Fixes #14` is a line a
   * reviewer's own advice puts three paragraphs down, and a check reading subjects would
   * be a gate that looks enforced and is not.
   */
  assert.deepEqual(extracted.facts?.messages, [
    'Correct the answer\n\nThe body a reviewer reads.',
    'And again',
  ])
  assert.equal(extracted.facts?.sweptUp, false)
})

/**
 * The sweep-up commit is recognisable from any round, not just the one that made it. On a
 * retry the workspace carries the previous round's history forward, so "did this call
 * commit leftovers" is not a question a later round can ask — the fact has to be readable
 * off `base..HEAD`.
 */
test('work the agent left uncommitted is recorded as such in the facts', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.equal(extracted.facts?.sweptUp, true)
  assert.equal(extracted.facts?.messages.length, 1)
})

/**
 * A rename arrives as the two paths it touches, because `--no-renames` is what makes a
 * membership test mean what a lens thinks it means. Git's default renders a rename as
 * `old => new` in one entry, and `paths.includes('.ogun/config.yaml')` against that is
 * false for a patch that moved the file away.
 */
test('a renamed file is reported as both of its paths', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await git(workspace.path, ['mv', 'app.ts', 'renamed.ts'])
  await commit(workspace.path, 'Move it')

  const extracted = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.deepEqual(extracted.facts?.paths.sort(), ['app.ts', 'renamed.ts'])
})

/**
 * The hazard the retry loop introduces, and the reason `sweepGateArtifacts` exists.
 *
 * Extraction takes the patch *before* the gate runs, so a suite writing into the tree has
 * never mattered: the workspace is deleted moments later. A retry reuses the workspace
 * (§5.2), so without this the next round's `git add -A` commits `coverage/` under "work
 * the agent left uncommitted" and publishes it.
 *
 * `-fd` and not `-fdx`: an ignored `node_modules` is what the *next* round needs to run
 * the suite at all, and removing it would turn one red suite into a second one about a
 * missing dependency.
 */
test('the gate\'s own leavings are swept before a retry, and ignored files are not', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, '.gitignore'), 'node_modules/\n')
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'The agent\'s work')
  await extractPatch({ workspace: workspace.path, baseSha, destDir })

  // Now the gate runs, and the suite writes into the tree.
  await mkdir(join(workspace.path, 'coverage'), { recursive: true })
  await writeFile(join(workspace.path, 'coverage', 'lcov.info'), 'TN:\n')
  await mkdir(join(workspace.path, 'node_modules'), { recursive: true })
  await writeFile(join(workspace.path, 'node_modules', 'installed'), 'x')

  const swept = await sweepGateArtifacts(workspace.path)
  assert.deepEqual(swept.dirty, [])
  assert.deepEqual(swept.removed, ['coverage/lcov.info'])
  assert.equal(existsSync(join(workspace.path, 'node_modules', 'installed')), true)

  // And the round after it extracts the agent's work and nothing else.
  const second = await extractPatch({ workspace: workspace.path, baseSha, destDir })
  assert.deepEqual(second.facts?.paths.sort(), ['.gitignore', 'app.ts'])
  assert.equal(second.facts?.sweptUp, false)
})

/**
 * A suite that writes into *tracked* content is reported rather than repaired.
 *
 * Putting the file back means `git checkout`, which applies `.gitattributes` smudge
 * filters — arbitrary commands, in content the agent wrote, run on the host as the runner.
 * That is the `core.fsmonitor` exposure again, and `-c` overrides cannot close it because
 * a filter is named per attribute. So the caller ends the loop instead, which is a refusal
 * naming the files rather than a repair nobody would trust.
 */
test('a suite that rewrites tracked files is reported, not restored', async () => {
  const { baseSha, workspace, destDir } = await factory()
  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 42\n')
  await git(workspace.path, ['add', '-A'])
  await commit(workspace.path, 'The agent\'s work')
  await extractPatch({ workspace: workspace.path, baseSha, destDir })

  await writeFile(join(workspace.path, 'app.ts'), 'export const answer = 999 // snapshot\n')

  const swept = await sweepGateArtifacts(workspace.path)
  assert.deepEqual(swept.dirty, ['app.ts'])
})
