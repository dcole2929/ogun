import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { policiesSchema, type Policies, type RunOutcome } from '@ogun/core'
import { extractPatch } from '../src/patch.ts'
import { BRANCH_PREFIX, branchFor, publishPatch, type PublishRemote } from '../src/publish.ts'
import { materializeWorkspace } from '../src/workspace.ts'

const run = promisify(execFile)
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args])
const commit = (repo: string, message: string) =>
  git(repo, ['-c', 'user.name=agent', '-c', 'user.email=agent@test', 'commit', '-qm', message])

/**
 * The other half of the crossing (ADR-0005). `patch.test.ts` asserts what survives the
 * trip *out* of a workspace the runner is about to delete; this asserts what happens to it
 * on the way back in — which is the half that touches the host's real repository, runs git
 * against agent-authored content, and holds a credential.
 *
 * Almost every test here is about a gate rather than about mechanics. Getting a branch
 * onto a remote is five git commands and is hard to get wrong for long; deciding *whether*
 * to is where a naive implementation does real damage, because the obvious version — "a
 * `changes` row exists, so open a pull request" — publishes a run whose tests failed, a run
 * whose gate rejected the work, and a run that recorded nothing about tests at all.
 *
 * The remote is faked, and that fake is the credential seam paying for itself on its first
 * day: everything up to the push is exercised for real, against real git, with no token and
 * no network. The fake's `publish` really does push — to a bare repository on disk — so the
 * assertions are about a branch that exists rather than about a function having been called.
 */

const POLICIES = (over: Partial<Policies> = {}): Policies =>
  policiesSchema.parse({ ...over })

/**
 * A project as a runner sees it: a bare repository standing in for GitHub, the host's
 * checkout of it, and a workspace cloned from that checkout exactly the way a job gets one.
 */
const factory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-publish-'))
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  await run('git', ['init', '-q', '--bare', '-b', 'main', origin])

  const seed = join(root, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, ['init', '-q', '-b', 'main'])
  await writeFile(join(seed, 'app.ts'), 'export const answer = 41\n')
  await git(seed, ['add', '-A'])
  await commit(seed, 'Base')
  await git(seed, ['remote', 'add', 'origin', origin])
  await git(seed, ['push', '-q', 'origin', 'main'])

  await run('git', ['clone', '-q', origin, repo])
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()

  const workspace = await materializeWorkspace({
    sourceRepo: repo,
    scratch: join(root, 'scratch'),
    runId: 'run-1',
    ref: baseSha,
  })
  return { root, origin, repo, baseSha, workspace, scratch: join(root, 'scratch') }
}

/** What a modifier leaves behind: an edit and a commit message worth reading. */
const modify = async (
  workspace: string,
  content = 'export const answer = 42\n',
  message = 'Correct the answer',
) => {
  await writeFile(join(workspace, 'app.ts'), content)
  await git(workspace, ['add', '-A'])
  await commit(workspace, message)
}

type Recorded = {
  counted: number
  published: Array<{ branch: string; base: string; title: string; body: string }>
}

/**
 * The one implementation of `PublishRemote` that exists in tests, and the reason the seam
 * is a seam: no `gh`, no token, no network — but a real `git push`, so "published" means a
 * ref appeared on a remote and not that a spy was called.
 */
const fakeRemote = (opts: { open?: number } = {}): { remote: PublishRemote; calls: Recorded } => {
  const calls: Recorded = { counted: 0, published: [] }
  return {
    calls,
    remote: {
      async countOpenPullRequests() {
        calls.counted += 1
        return opts.open ?? 0
      },
      async publish({ from, branch, base, title, body }) {
        calls.published.push({ branch, base, title, body })
        await git(from, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`])
        return { url: `https://github.test/ogun/pull/${calls.published.length}` }
      },
    },
  }
}

type Argument = Parameters<typeof publishPatch>[0]

/** Everything `publishPatch` needs that is not about the case under test. */
const publishing = async (
  world: { open?: number } = {},
): Promise<{
  fixture: Awaited<ReturnType<typeof factory>>
  calls: Recorded
  go: (more?: Partial<Argument>) => ReturnType<typeof publishPatch>
}> => {
  const fixture = await factory()
  await modify(fixture.workspace.path)
  const extracted = await extractPatch({
    workspace: fixture.workspace.path,
    baseSha: fixture.baseSha,
    destDir: join(fixture.root, 'patches'),
  })
  assert.ok(extracted.patch, 'the fixture produced no patch to publish')
  const { remote, calls } = fakeRemote(world)

  const base: Argument = {
    repo: fixture.repo,
    scratch: fixture.scratch,
    runId: '9f3c2a10-4b5e-4c1d-8a77-000000000001',
    workerName: 'fixer',
    defaultBranch: 'main',
    baseSha: fixture.baseSha,
    patchRef: extracted.patch.ref,
    outcome: 'dispatched',
    tests: { run: true, passed: true },
    policies: POLICIES(),
    remote,
  }
  return { fixture, calls, go: (more = {}) => publishPatch({ ...base, ...more }) }
}

const remoteBranches = async (origin: string): Promise<string[]> =>
  (await run('git', ['-C', origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .stdout.split('\n')
    .filter(Boolean)

test('a modifier\'s work becomes a branch on the remote and a draft pull request', async () => {
  const { fixture, calls, go } = await publishing()
  const published = await go()

  assert.ok(published.pr, `expected a pull request, got: ${published.refused}`)
  assert.equal(published.pr!.url, 'https://github.test/ogun/pull/1')
  assert.ok(published.pr!.branch.startsWith(BRANCH_PREFIX))

  // The branch is on the remote with the agent's commit, message and authorship intact —
  // which is the entire reason extraction uses format-patch rather than a diff.
  assert.deepEqual(await remoteBranches(fixture.origin), ['main', published.pr!.branch])
  const log = await git(fixture.origin, [
    'log',
    '-1',
    '--format=%s%n%an%n%cn',
    published.pr!.branch,
  ])
  assert.equal(log.stdout.trim(), 'Correct the answer\nagent\nogun')

  // The pull request targets the default branch and is described by the agent's own words.
  assert.equal(calls.published[0]!.base, 'main')
  assert.equal(calls.published[0]!.title, 'Correct the answer')
})

/**
 * Ogun proposes. It should not also colonise your checkout to do it: no local branch, no
 * registered worktree left over, and nothing moved under you.
 *
 * The dirty file is the point of the last two assertions. A publisher that used the
 * project's own working tree instead of a detached worktree would have to stash or check
 * out to apply the patch, and it would do that at 3am while you were halfway through
 * something.
 */
test('publishing leaves the project\'s checkout exactly as it found it', async () => {
  const { fixture, go } = await publishing()
  await writeFile(join(fixture.repo, 'app.ts'), 'export const answer = 0 // mid-edit\n')
  const headBefore = (await git(fixture.repo, ['rev-parse', 'HEAD'])).stdout

  const published = await go()
  assert.ok(published.pr, published.refused)

  assert.equal(
    await readFile(join(fixture.repo, 'app.ts'), 'utf8'),
    'export const answer = 0 // mid-edit\n',
    'the publisher wrote over an uncommitted edit in the project checkout',
  )
  assert.equal((await git(fixture.repo, ['rev-parse', 'HEAD'])).stdout, headBefore)

  const branches = (await git(fixture.repo, ['branch', '--list', 'ogun/*'])).stdout.trim()
  assert.equal(branches, '', 'a local branch was left behind; the push is HEAD:refs/heads/…')

  const worktrees = (await git(fixture.repo, ['worktree', 'list'])).stdout.trim().split('\n')
  assert.equal(worktrees.length, 1, `a scratch worktree survived: ${worktrees.join(' | ')}`)
  assert.equal(existsSync(join(fixture.scratch, 'publish', '9f3c2a10-4b5e-4c1d-8a77-000000000001')), false)
})

/**
 * The gate this whole module exists for, and the one a naive implementation collapses.
 *
 * `changes.tests_passed` is nullable, and **null is not false**. It is null for a run
 * recorded before the tests gate existed and for a run whose patch could not be extracted —
 * both of which said nothing whatsoever about tests. All three cases refuse, so a test that
 * only asserted "nothing was published" would pass against an implementation that treats
 * them as one thing. What it must not do is describe them identically: one is fixed by
 * re-running the worker, one by fixing the harness, and one by fixing the code, and the
 * person reading the timeline has to be able to tell which (principle 6).
 */
test('null tests_passed is refused as an absence, not reported as a failure', async () => {
  const { calls, go } = await publishing()

  const silent = await go({ tests: {} })
  const neverRan = await go({ tests: { run: false, passed: false } })
  const failed = await go({ tests: { run: true, passed: false } })

  for (const outcome of [silent, neverRan, failed]) {
    assert.equal(outcome.pr, undefined)
    assert.ok(outcome.refused)
  }
  assert.equal(calls.published.length, 0, 'a refused run reached the remote')

  assert.match(silent.refused!, /no test result at all/)
  assert.match(silent.refused!, /absence/)
  assert.match(neverRan.refused!, /never executed/)
  assert.match(failed.refused!, /suite failed/)

  const reasons = new Set([silent.refused, neverRan.refused, failed.refused])
  assert.equal(reasons.size, 3, 'two of the three test outcomes are reported with one sentence')
})

/**
 * A `changes` row is an artifact record, not a work queue (§4.4). A row exists for a run
 * the verify gate rejected — `finalizeRun` derives such a run's `dispatched` down to
 * `changes-requested` — and the patch is on disk either way. The outcome the *control
 * plane* recorded is the only thing that says the work is publishable.
 */
test('a run whose gate rejected the work is not published, patch on disk or not', async () => {
  const { calls, go } = await publishing()
  for (const outcome of ['changes-requested', 'approved', 'error', 'skipped'] as RunOutcome[]) {
    const result = await go({ outcome })
    assert.equal(result.pr, undefined, `${outcome} was published`)
    assert.match(result.refused!, new RegExp(`"${outcome}"`))
  }
  assert.equal(calls.published.length, 0)
})

/**
 * The PR cap (§4.6), counted against what is open on the remote right now rather than
 * against anything this run knows. Merging one has to make room immediately, which is only
 * true if the count is a live read (ADR-0004).
 *
 * Zero is included because it is the useful value nobody thinks to allow: it stops
 * publishing without stopping modifiers, which is what you want while you are still
 * deciding whether to trust a worker.
 */
test('the pr cap refuses on what is already open, and zero means publish nothing', async () => {
  const atCap = await publishing({ open: 3 })
  const full = await atCap.go({ policies: POLICIES({ maxOpenPullRequests: 3 }) })
  assert.equal(full.pr, undefined)
  assert.match(full.refused!, /3 ogun pull request\(s\) are already open/)
  assert.equal(atCap.calls.published.length, 0)
  assert.equal(await remoteBranches(atCap.fixture.origin).then((b) => b.length), 1)

  const room = await publishing({ open: 2 })
  assert.ok((await room.go({ policies: POLICIES({ maxOpenPullRequests: 3 }) })).pr)

  const off = await publishing()
  const stopped = await off.go({ policies: POLICIES({ maxOpenPullRequests: 0 }) })
  assert.equal(stopped.pr, undefined)
  assert.match(stopped.refused!, /maxOpenPullRequests is 0/)
})

/**
 * The cap is read from the blob at the pinned base, so an agent cannot raise its own — and
 * when that blob cannot be read at all, nothing is published on a guessed policy. Fail
 * closed: the patch survives on disk and a fixed config makes the run publishable again,
 * where guessing the defaults would hand three pull requests to a project that had set the
 * cap to zero.
 */
test('a policy that could not be established publishes nothing', async () => {
  const { calls, go } = await publishing()
  const result = await go({ policies: undefined })
  assert.equal(result.pr, undefined)
  assert.match(result.refused!, /could not be read/)
  assert.equal(calls.counted, 0, 'the remote was consulted before the policy was known')
  assert.equal(calls.published.length, 0)
})

/**
 * A patch that will not apply is a real failure and must read like one — with the base it
 * failed against, so the reader can tell "the agent rewrote history" from "the mbox is
 * corrupt". It must also leave nothing behind: a registered worktree pointing at a deleted
 * scratch directory is what makes the *next* publish fail for an unrelated reason.
 */
test('a patch that does not apply refuses, and cleans up after itself', async () => {
  const { fixture, calls, go } = await publishing()
  const patchRef = join(fixture.root, 'broken.patch')
  const original = await readFile(join(fixture.root, 'patches', 'changes.patch'), 'utf8')
  await writeFile(patchRef, original.replace('export const answer = 41', 'something else entirely'))

  const result = await go({ patchRef })
  assert.equal(result.pr, undefined)
  assert.match(result.refused!, /does not apply to/)
  assert.match(result.refused!, new RegExp(fixture.baseSha.slice(0, 12)))
  assert.equal(calls.published.length, 0)

  const worktrees = (await git(fixture.repo, ['worktree', 'list'])).stdout.trim().split('\n')
  assert.equal(worktrees.length, 1, 'a failed apply left a worktree registered')

  // And the next publish of the same run still works, which is what the cleanup is for.
  assert.ok((await go()).pr)
})

/**
 * Branch names are **built**, never passed through.
 *
 * Nothing in the publisher goes near a shell, so the classic quoting attack is already
 * dead; what is not dead is argument injection. A ref beginning with `-` is read by git as
 * an option, and `--upload-pack=<command>` on a push is arbitrary code. A worker name is
 * project config today and a branch derived from something an agent wrote is one feature
 * away, so the property under test is about the function, not about today's inputs.
 */
test('a branch name cannot be made into an argument, a path, or an illegal ref', () => {
  const hostile = [
    '--upload-pack=touch /tmp/pwned',
    '-o ProxyCommand=sh',
    '../../../etc/passwd',
    'a b; rm -rf /',
    'refs/heads/main',
    'feature..main',
    'branch.lock',
    'HEAD@{0}',
    '...',
    '🙂',
    '',
  ]
  for (const workerName of hostile) {
    const branch = branchFor({ workerName, runId: '9f3c2a10-4b5e-4c1d-8a77-000000000001' })
    assert.match(branch, /^ogun\/[a-z0-9][a-z0-9._-]*\/[a-z0-9]{4,}$/, `${workerName} -> ${branch}`)
    assert.ok(!branch.includes('..'), branch)
    assert.ok(!branch.split('/').some((part) => part.startsWith('-') || part.endsWith('.lock')))
  }

  // Two runs of one worker never collide; one run always names itself the same way.
  const a = branchFor({ workerName: 'fixer', runId: 'aaaaaaaa-0000-0000-0000-000000000001' })
  const b = branchFor({ workerName: 'fixer', runId: 'bbbbbbbb-0000-0000-0000-000000000002' })
  assert.notEqual(a, b)
  assert.equal(a, branchFor({ workerName: 'fixer', runId: 'aaaaaaaa-0000-0000-0000-000000000001' }))
})

test('git accepts every branch name the sanitizer produces', async () => {
  for (const workerName of ['--upload-pack=x', 'Fix The Thing', 'a/b/c', 'ünïcode', '....lock']) {
    const branch = branchFor({ workerName, runId: '9f3c2a10-4b5e-4c1d-8a77-000000000001' })
    // Fully qualified, which is also the form the push uses: `check-ref-format` has no
    // `--` of its own, and `refs/heads/…` is the one shape that cannot begin with a dash
    // however the name was built.
    await run('git', ['check-ref-format', `refs/heads/${branch}`])
  }
})

/** And end to end: a hostile worker name reaches the remote as an ordinary branch. */
test('a hostile worker name publishes to an ordinary branch and runs nothing', async () => {
  const { fixture, go } = await publishing()
  const canary = join(fixture.root, 'EXECUTED')
  const published = await go({ workerName: `--upload-pack=touch ${canary}` })

  assert.ok(published.pr, published.refused)
  assert.equal(existsSync(canary), false, 'the worker name was executed as a git option')
  assert.match(published.pr!.branch, /^ogun\/upload-pack-touch-/)
  assert.ok((await remoteBranches(fixture.origin)).includes(published.pr!.branch))
})

/**
 * `git am` runs hooks, and a worktree shares `.git/config` and `core.hooksPath` with the
 * repository it was made from. That repository is not agent-authored the way a workspace
 * is — but it is a repository into which agent patches get merged, and `core.fsmonitor`
 * fires on any command that refreshes the index, which `am` does repeatedly.
 *
 * The same canary `git-hardening.test.ts` uses, for the same reason: this is the guard
 * that stops the host running a string somebody left lying around, and it is invisible
 * until it is gone.
 */
test('applying a patch does not run the repository\'s hooks or fsmonitor on the host', async () => {
  const { fixture, go } = await publishing()
  const canary = join(fixture.root, 'EXECUTED')
  await git(fixture.repo, ['config', 'core.fsmonitor', `touch ${canary}; echo`])
  await mkdir(join(fixture.repo, '.git', 'hooks'), { recursive: true })
  for (const hook of ['pre-applypatch', 'post-applypatch', 'applypatch-msg']) {
    const path = join(fixture.repo, '.git', 'hooks', hook)
    await writeFile(path, `#!/bin/sh\ntouch ${canary}\n`)
    await chmod(path, 0o755)
  }

  const published = await go()
  assert.ok(published.pr, published.refused)
  assert.equal(existsSync(canary), false, 'the host ran a command the repository supplied')
})

/**
 * The pull request body is the one place agent prose is embedded in something GitHub
 * *interprets*. `Closes #12` in a body closes issue 12 on merge, and `@name` notifies a
 * person — neither of which an agent should be able to do by writing the most natural
 * sentence in the world into a commit message.
 *
 * Inside a fence GitHub does neither, so the property is that the content cannot get out
 * of the fence: a message containing its own backtick run must not be able to close it
 * early. Asserted on the fence arithmetic rather than on a fixed string, because the point
 * is that it adapts.
 */
test('commit messages cannot escape the fence in the pull request body', async () => {
  const fixture = await factory()
  const message = [
    'Fix the retry loop',
    '',
    'Closes #12, and cc @someone.',
    '```',
    'code the agent quoted',
    '`````',
  ].join('\n')
  await modify(fixture.workspace.path, 'export const answer = 42\n', message)
  const extracted = await extractPatch({
    workspace: fixture.workspace.path,
    baseSha: fixture.baseSha,
    destDir: join(fixture.root, 'patches'),
  })
  const { remote, calls } = fakeRemote()

  const published = await publishPatch({
    repo: fixture.repo,
    scratch: fixture.scratch,
    runId: '9f3c2a10-4b5e-4c1d-8a77-000000000002',
    workerName: 'fixer',
    defaultBranch: 'main',
    baseSha: fixture.baseSha,
    patchRef: extracted.patch!.ref,
    outcome: 'dispatched',
    tests: { run: true, passed: true },
    policies: POLICIES(),
    remote,
  })
  assert.ok(published.pr, published.refused)

  const body = calls.published[0]!.body
  const fence = body.match(/^(`{3,})$/m)?.[1] ?? ''
  assert.ok(fence.length >= 6, `fence "${fence}" is not longer than the message's own`)

  const [, inside = ''] = body.split(fence)
  assert.ok(inside.includes('Closes #12'), 'the closing keyword is outside the fence')
  assert.ok(inside.includes('@someone'), 'the mention is outside the fence')
  assert.ok(body.includes('draft'), 'the body does not say nobody has read this')
})

/**
 * More than one commit gets a manufactured title rather than the first subject. "Fix the
 * retry loop" on a branch that also rewrote the scheduler misleads exactly the person the
 * title exists to inform.
 */
test('a multi-commit branch is not titled after one of its commits', async () => {
  const fixture = await factory()
  await modify(fixture.workspace.path, 'export const answer = 42\n', 'Fix the retry loop')
  await modify(fixture.workspace.path, 'export const answer = 43\n', 'Rewrite the scheduler')
  const extracted = await extractPatch({
    workspace: fixture.workspace.path,
    baseSha: fixture.baseSha,
    destDir: join(fixture.root, 'patches'),
  })
  const { remote, calls } = fakeRemote()

  const published = await publishPatch({
    repo: fixture.repo,
    scratch: fixture.scratch,
    runId: '9f3c2a10-4b5e-4c1d-8a77-000000000003',
    workerName: 'fixer',
    defaultBranch: 'main',
    baseSha: fixture.baseSha,
    patchRef: extracted.patch!.ref,
    outcome: 'dispatched',
    tests: { run: true, passed: true },
    policies: POLICIES(),
    remote,
  })
  assert.ok(published.pr, published.refused)
  assert.equal(calls.published[0]!.title, 'fixer: 2 commit(s)')
  assert.ok(calls.published[0]!.body.includes('Rewrite the scheduler'))
  assert.ok(calls.published[0]!.body.includes('Fix the retry loop'))
})

/**
 * `directPush: false` means Ogun proposes and never pushes to the default branch. The
 * `ogun/` prefix makes that true by construction for every ordinary project — this covers
 * the one case it does not: a project whose default branch is itself under `ogun/`, which
 * is a legal branch name and would otherwise be pushed to directly.
 */
test('a default branch that collides with a published branch is refused, not pushed to', async () => {
  const { calls, go } = await publishing()
  const branch = branchFor({
    workerName: 'fixer',
    runId: '9f3c2a10-4b5e-4c1d-8a77-000000000001',
  })
  const result = await go({ defaultBranch: branch })
  assert.equal(result.pr, undefined)
  assert.match(result.refused!, /default branch/)
  assert.match(result.refused!, /directPush/)
  assert.equal(calls.published.length, 0)
})

/** A base that is not an object name never reaches `git worktree add` as a revision. */
test('a base sha that is not a sha is refused before git sees it', async () => {
  const { go } = await publishing()
  for (const baseSha of ['--help', 'main', '$(touch /tmp/x)', '']) {
    const result = await go({ baseSha })
    assert.equal(result.pr, undefined)
    assert.match(result.refused!, /not an object name/)
  }
})

/**
 * The step nothing else in the system would ever tell the operator (§4.6, ADR-0016).
 *
 * Images are built at `ogun project add` and never during a run, so that a night does not
 * fail on a bad network — which means a merged `.ogun/Dockerfile` is not an installed
 * image. Without this, the next modifier for that project fails on docker's "Unable to
 * find image": an error about a thing nobody built, arriving days later on somebody who
 * never saw the run that wrote the file. The pull request is where whoever merges it is
 * standing, so the instruction goes in the body.
 *
 * The second half is about not lying. "The project's suite passed on this tree" is what an
 * ordinary body says and is the more misleading of the two available sentences here: the
 * suite passed *inside an image this patch also proposes*, which is a stronger claim about
 * the patch and a weaker one about the repository, and a reviewer has to be told which.
 */
test('a containerisation pull request says the image still has to be built', async () => {
  const { calls, go } = await publishing()
  const published = await go({
    bootstrap: {
      image: 'ogun/project-thing:candidate-9f3c2a104b5e',
      command: 'pnpm install --frozen-lockfile && pnpm -s test',
      buildSeconds: 214,
      suiteSeconds: 61,
    },
  })
  assert.ok(published.pr, published.refused)

  const body = calls.published[0]!.body
  assert.match(body, /ogun image build/)
  assert.match(body, /pnpm install --frozen-lockfile && pnpm -s test/)
  assert.match(body, /inside the image this patch builds/)
  assert.match(body, /--network none/)
  assert.doesNotMatch(
    body,
    /suite passed on this tree/,
    'the ordinary sentence claims something this run did not check',
  )
  // The candidate is gone, and saying so is what stops somebody assuming the machine is
  // already set up because a gate built an image once.
  assert.match(body, /deleted with the run/)
})

/** And an ordinary publication is untouched by any of that. */
test('an ordinary pull request says nothing about building an image', async () => {
  const { calls, go } = await publishing()
  await go()
  const body = calls.published[0]!.body
  assert.match(body, /suite passed on this tree/)
  assert.doesNotMatch(body, /ogun image build/)
})
