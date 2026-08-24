import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { readPolicies } from '@ogun/core'
import { pinnedProjectConfig, sandboxDowngrade } from '../src/pipeline.ts'
import { createSandbox, GUEST_WORKSPACE } from '../src/sandbox/index.ts'
import { materializeWorkspace } from '../src/workspace.ts'

const run = promisify(execFile)
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args])

/**
 * `policies.allowSandboxDowngrade` — the setting that decides whether a modifier may run
 * as a process on the host instead of inside a container (§4.6).
 *
 * Two properties, and the first is the one a naive fix gets wrong. It is tempting to read
 * the policy out of `<workspace>/.ogun/config.yaml`, because that file is right there and
 * `readFile` is one line. The workspace is mounted read-write for exactly the profile
 * this policy contains, so an agent appending `allowSandboxDowngrade: true` to its own
 * checkout would be voting itself out of the container it is running in. The value has to
 * come from the blob at the pinned base — the copy a person reviewed and merged — which
 * is the same rule `tests.command` follows.
 *
 * The second is that "the project said no" and "the project's policy could not be read"
 * are different facts (principle 6). Both must fail closed, and closed is not the
 * interesting part: an unreadable config that refuses with the *false* sentence sends
 * somebody to look at a line that already says `true`.
 *
 * The whole file exists because the flag used to be the literal `false` at the
 * `createSandbox` call, so none of this could be told apart from any of it: a project
 * setting the policy got the same refusal as a project that had never heard of it.
 */
const factory = async (configYaml: string | null) => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-downgrade-'))
  const source = join(root, 'source')
  await mkdir(join(source, '.ogun'), { recursive: true })
  await git(source, ['init', '-q', '-b', 'main'])
  await writeFile(join(source, 'app.ts'), 'export const answer = 41\n')
  if (configYaml !== null) await writeFile(join(source, '.ogun', 'config.yaml'), configYaml)
  await git(source, ['add', '-A'])
  await git(source, ['-c', 'user.name=dev', '-c', 'user.email=dev@test', 'commit', '-qm', 'Base'])
  const { stdout } = await git(source, ['rev-parse', 'HEAD'])
  const baseSha = stdout.trim()
  const workspace = await materializeWorkspace({
    sourceRepo: source,
    scratch: join(root, 'scratch'),
    runId: 'run-1',
    ref: baseSha,
  })
  return { root, workspace, baseSha }
}

/** What the runner does between the git blob and the sandbox, with nothing in between. */
const decide = async (
  workspace: string,
  baseSha: string,
  over: Partial<Parameters<typeof sandboxDowngrade>[0]> = {},
) => {
  const pinned = await pinnedProjectConfig(workspace, baseSha)
  return sandboxDowngrade({
    sandbox: 'worktree',
    permissions: 'modifier',
    policies: pinned === undefined ? undefined : readPolicies(pinned),
    baseSha,
    ...over,
  })
}

const CONFIG = (allow: boolean) => `project:
  name: demo
tests:
  command: pnpm -s test
policies:
  allowSandboxDowngrade: ${allow}
workers:
  fixer:
    skill: ./skills/fix
    permissions: modifier
    sandbox: worktree
`

test('a project that allows the downgrade gets it', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(true))
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, true)
    assert.equal(decision.refusal, undefined, 'nothing to refuse — the project said yes')

    /**
     * And the flag is one `createSandbox` acts on, rather than one it merely accepts. The
     * bug this file is about was that the call site passed a constant, so the sandbox
     * below was unreachable for a modifier no matter what any project wrote.
     */
    const sandbox = createSandbox({
      kind: 'worktree',
      name: 'ogun-test',
      hostWorkspace: workspace.path,
      guestWorkspace: workspace.path,
      permissions: 'modifier',
      runtime: 'claude',
      timeoutMs: 1000,
      allowSandboxDowngrade: decision.allow,
    })
    assert.equal(sandbox.kind, 'worktree')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a project that refuses the downgrade is told which line said so', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(false))
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, false)
    assert.match(decision.refusal ?? '', /allowSandboxDowngrade: false/)
    // The commit, because "which copy of the config" is the entire question and a person
    // reading this may well be looking at a working copy that says something else.
    assert.match(decision.refusal ?? '', new RegExp(baseSha.slice(0, 12)))

    // The backstop, for a caller that skips the gate: the sandbox refuses on its own.
    assert.throws(
      () =>
        createSandbox({
          kind: 'worktree',
          name: 'ogun-test',
          hostWorkspace: workspace.path,
          guestWorkspace: workspace.path,
          permissions: 'modifier',
          runtime: 'claude',
          timeoutMs: 1000,
          allowSandboxDowngrade: decision.allow,
        }),
      /allowSandboxDowngrade/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an agent granting itself the downgrade in its own workspace does not get it', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(false))
  try {
    // One line of shell in a tree that is mounted read-write for this very profile.
    await writeFile(join(workspace.path, '.ogun', 'config.yaml'), CONFIG(true))
    await git(workspace.path, ['add', '-A'])
    await git(workspace.path, [
      '-c',
      'user.name=agent',
      '-c',
      'user.email=agent@test',
      'commit',
      '-qm',
      'Enable the worktree sandbox for faster runs',
    ])

    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, false, 'the gate is the project\'s, not the patch\'s')
    assert.match(decision.refusal ?? '', /allowSandboxDowngrade: false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a policies block that cannot be read refuses, and says so in its own words', async () => {
  // Valid yaml, unreadable policy: the file parses, `tests.command` reads fine, and the
  // one block this gate depends on is nonsense. So this is not the same case as a missing
  // config, and it is the case that proves the reason is carried rather than assumed.
  const broken = `project:
  name: demo
tests:
  command: pnpm -s test
policies:
  allowSandboxDowngrade: "sure, why not"
`
  const { root, workspace, baseSha } = await factory(broken)
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, false, 'unreadable fails closed — that part is not in doubt')
    assert.match(decision.refusal ?? '', /could not be read/)
    assert.doesNotMatch(
      decision.refusal ?? '',
      /allowSandboxDowngrade: false/,
      'a broken file must not be reported as a project that chose false — that sentence ' +
        'sends someone to edit a line that may already say true',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a repository with no config at that commit refuses rather than defaulting', async () => {
  const { root, workspace, baseSha } = await factory(null)
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, false)
    assert.match(decision.refusal ?? '', /could not be read/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * The gate is narrow on purpose. `worktree` is §4.6's documented fast path for workers
 * that are not writing code, and a policy that also had to be set for those would be a
 * policy people turn on for an unrelated reason — after which the modifier gate is open
 * and nobody decided that.
 */
test('only a modifier on a worktree is gated', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(false))
  try {
    const reviewer = await decide(workspace.path, baseSha, { permissions: 'reviewer' })
    assert.equal(reviewer.refusal, undefined, 'a reviewer on a worktree needs no policy')

    const container = await decide(workspace.path, baseSha, { sandbox: 'container' })
    assert.equal(container.refusal, undefined, 'nothing was downgraded')
    assert.equal(container.allow, false, 'and the project still said false')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A project that never wrote a `policies:` block has not failed to be read — it gets the
 * defaults, and the default is `false` (§4.6). The distinction matters because
 * `readPolicies` returns `undefined` for a block it cannot parse, and folding "absent"
 * into that would make every ordinary repository's refusal read as a broken file.
 */
test('an absent policies block is the default, not an unreadable one', async () => {
  const { root, workspace, baseSha } = await factory('project:\n  name: demo\n')
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, false)
    assert.match(decision.refusal ?? '', /allowSandboxDowngrade: false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** The container path is untouched by any of this — the flag is not consulted there. */
test('a container sandbox is built whatever the policy says', async () => {
  const sandbox = createSandbox({
    kind: 'container',
    name: 'ogun-test',
    hostWorkspace: '/tmp/ws',
    guestWorkspace: GUEST_WORKSPACE,
    permissions: 'modifier',
    runtime: 'claude',
    timeoutMs: 1000,
    image: 'ogun/base:latest',
    allowSandboxDowngrade: false,
  })
  assert.equal(sandbox.kind, 'container')
})

/**
 * What a *permitted* downgrade says, which is the half nothing else covers.
 *
 * A refusal explains itself — that is what a refusal is for. A permission is silent, and
 * this one is silent about a great deal: `allowSandboxDowngrade: true` does not relax one
 * property, it opts out of the containment model whole. No read-only mount, and the mount
 * is where the permission profile is actually enforced (`--disallowedTools` never
 * restricted `Bash`, and codex has no equivalent); no network namespace, so the worker's
 * `egress:` allowlist is dropped without a word; no gateway, so the agent reads this
 * machine's credential files directly; and the process runs as the runner's user with the
 * runner's environment.
 *
 * A person can turn all of that on having read four words of a key name. What a naive
 * implementation does is treat the flag as answered once it is honoured — `allow: true`,
 * nothing more to say — and then the only record that a night's work ran uncontained is
 * the absence of a container in a log nobody kept.
 *
 * The notice carries the base sha for the same reason the refusal does: it is a statement
 * about which copy of config.yaml was consulted, and a working copy sitting in front of
 * the reader may well say something else by now.
 */
test('a permitted downgrade says what it cost, not just that it was permitted', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(true))
  try {
    const decision = await decide(workspace.path, baseSha)
    assert.equal(decision.allow, true)
    assert.equal(decision.refusal, undefined)

    const notice = decision.notice ?? ''
    assert.match(notice, /uncontained/)
    assert.match(notice, /read-only/, 'the mount is where the permission profile is enforced')
    assert.match(notice, /egress/, 'a declared allowlist is dropped, and that must be said')
    assert.match(notice, /gateway/)
    assert.match(notice, new RegExp(baseSha.slice(0, 12)), 'which copy of the config said yes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * And it fires only for the case the policy is about.
 *
 * This is the noise bound, and it is the reason the notice is worth having at all. A
 * container run is the ordinary configuration and gives up nothing; a reviewer on a
 * worktree is §4.6's documented fast path, needs no policy, and reaches it whatever the
 * project set. Announcing "uncontained" on either would put the sentence on almost every
 * run, at which point it is scenery — and scenery is worse than silence here, because it
 * was supposed to be the loud thing.
 */
test('nothing is announced for a run that gave nothing up', async () => {
  const { root, workspace, baseSha } = await factory(CONFIG(true))
  try {
    const container = await decide(workspace.path, baseSha, { sandbox: 'container' })
    assert.equal(container.allow, true, 'the policy is true; it simply does not apply')
    assert.equal(container.notice, undefined)

    const reviewer = await decide(workspace.path, baseSha, { permissions: 'reviewer' })
    assert.equal(reviewer.notice, undefined)

    // And a refusal is not also a notice — one run produces one sentence, and the two
    // would say opposite things.
    const forbidden = await factory(CONFIG(false))
    try {
      const decision = await decide(forbidden.workspace.path, forbidden.baseSha)
      assert.ok(decision.refusal)
      assert.equal(decision.notice, undefined)
    } finally {
      await rm(forbidden.root, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
