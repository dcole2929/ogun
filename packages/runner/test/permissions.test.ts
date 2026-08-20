import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildRunArgs, GUEST_WORKSPACE } from '../src/sandbox/container.ts'

/**
 * The permission profiles were a comment until this.
 *
 * `claude` got `--disallowedTools Edit,Write,…` alongside `--dangerously-skip-permissions`,
 * so `Bash` wrote whatever it liked; `codex` got no profile restriction at all; and the
 * container passed `OGUN_PERMISSIONS` into an environment nothing read, over a mount that
 * was `rw` for everyone. `reviewer` and `modifier` were the same capability, while §4.6
 * and ADR-0005 both said the profiles were "enforced by the sandbox where practical".
 *
 * Enforcement is the mount, because it is the one place both runtimes go through. A flag
 * is applied by whichever runtime happens to support it, which is exactly how codex ended
 * up unrestricted.
 */
const argsFor = (permissions: 'observer' | 'reviewer' | 'modifier') =>
  buildRunArgs(
    {
      name: 'test',
      hostWorkspace: '/tmp/ws',
      guestWorkspace: GUEST_WORKSPACE,
      permissions,
      runtime: 'claude',
      timeoutMs: 1000,
      image: 'ogun/base:latest',
    } as Parameters<typeof buildRunArgs>[0],
    'ogun/base:latest',
  )

const mountOf = (args: string[], guestPath: string): string | undefined =>
  args.find((a) => a.includes(`:${guestPath}:`))

test('a reviewer gets the tree read-only', () => {
  const mount = mountOf(argsFor('reviewer'), GUEST_WORKSPACE)
  assert.ok(mount?.endsWith(':ro'), `reviewer workspace mount was ${mount}`)
})

test('an observer gets the tree read-only', () => {
  assert.ok(mountOf(argsFor('observer'), GUEST_WORKSPACE)?.endsWith(':ro'))
})

test('a modifier gets the tree writable — it is the profile that exists to write', () => {
  assert.ok(mountOf(argsFor('modifier'), GUEST_WORKSPACE)?.endsWith(':rw'))
})

/**
 * The test gate (§9) runs the project's suite in this same mount, and a suite writes:
 * `node_modules/.cache`, a compiled `dist/`, `coverage/`, `.pytest_cache`. That it can
 * was checked against a real container rather than inferred from the flag — the reviewer
 * profile refused `touch /workspace/x` with "Read-only file system" and the modifier
 * profile left `node_modules/.cache/suite-artifact` behind in the host workspace.
 *
 * Which is also why the patch is extracted *before* the gate runs, in pipeline.ts:
 * extraction begins with `git add -A`, and that artifact is exactly what would otherwise
 * be committed into a modifier's pull request.
 */
test("a modifier's suite can write where it runs", () => {
  const args = argsFor('modifier')
  assert.ok(mountOf(args, GUEST_WORKSPACE)?.endsWith(':rw'), 'the suite writes into the tree')
  // And a scratch space that is not the tree, for the suites that respect TMPDIR.
  assert.ok(
    args.some((a) => a.startsWith('/tmp:rw')),
    'a suite needs somewhere to put temporary files',
  )
})

/**
 * The half that makes read-only survivable. `.ogun-out/` is inside the tree, so a blanket
 * read-only mount stops a reviewer writing its findings — which is not a stricter
 * reviewer, it is one that cannot report. Layered over the tree mount, and writable for
 * every profile.
 */
test('every profile can still write its findings', () => {
  for (const profile of ['observer', 'reviewer', 'modifier'] as const) {
    const mount = mountOf(argsFor(profile), `${GUEST_WORKSPACE}/.ogun-out`)
    assert.ok(mount?.endsWith(':rw'), `${profile} could not write .ogun-out (${mount})`)
  }
})

/** Ordering is load-bearing: the nested mount must come after the tree it overlays. */
test('the output mount is applied after the tree mount', () => {
  const args = argsFor('reviewer')
  const tree = args.findIndex((a) => a.endsWith(`:${GUEST_WORKSPACE}:ro`))
  const out = args.findIndex((a) => a.includes(`:${GUEST_WORKSPACE}/.ogun-out:`))
  assert.ok(tree >= 0 && out > tree, 'the writable overlay must be mounted after the tree')
})
