import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type MaterializedWorkspace = {
  path: string
  sha: string
  cleanup: () => Promise<void>
}

/**
 * A clone, not the live working copy (§5.1). Three reasons, in order of force:
 *
 *  - A nightly reviewer must not review your dirty tree. At 3am it would grade whatever
 *    half-finished edit is open and churn findings about it every night.
 *  - `repo_sha` has to mean something. Re-adjudication asks "did this change since I
 *    last saw it", which requires knowing exactly what was reviewed.
 *  - Two jobs on one project, or a job while you're editing, corrupt each other.
 *
 * `--no-hardlinks` so a container cannot corrupt the source repo's object store.
 * Full history comes along, which the grounding check needs for `git diff <base>`.
 * In a cloud-runner world this same step becomes a network clone — that is the seam,
 * and the only thing that changes.
 */
export async function materializeWorkspace(input: {
  /** A path on this machine, when the repo is checked out here. */
  sourceRepo?: string
  /** Where to clone from when it is not. */
  remoteUrl?: string
  scratch: string
  runId: string
  ref?: string
}): Promise<MaterializedWorkspace> {
  const path = join(input.scratch, 'workspaces', input.runId)
  await mkdir(path, { recursive: true })

  if (input.sourceRepo) {
    await run('git', ['clone', '--local', '--no-hardlinks', input.sourceRepo, path])
  } else if (input.remoteUrl) {
    /**
     * No local checkout, so clone from the remote. This is the seam the design always
     * anticipated, and it means a runner needs no prior knowledge of a repository — a
     * fresh machine can join and immediately work on any project, with a local path as
     * an optimisation rather than a prerequisite.
     *
     * Shallow by default: a reviewer reads the current tree, and a full history clone of
     * a large repository on every run is a lot of network for something discarded after.
     */
    const depth = process.env.OGUN_CLONE_DEPTH ?? '50'
    await run('git', [
      'clone',
      ...(depth === 'full' ? [] : ['--depth', depth]),
      ...(input.ref ? ['--branch', input.ref] : []),
      input.remoteUrl,
      path,
    ])
  } else {
    throw new Error('no local path and no remote url — nothing to materialize from')
  }

  // A remote clone already checked out the branch; a local one is still on whatever HEAD
  // pointed at. Detaching pins the SHA either way, which is what repo_sha has to mean.
  if (input.ref && input.sourceRepo) await run('git', ['-C', path, 'checkout', '--detach', input.ref])

  const { stdout } = await run('git', ['-C', path, 'rev-parse', 'HEAD'])
  const sha = stdout.trim()

  // No remote inside the sandbox. Every outbound git operation happens host-side after
  // the container exits, which is what makes never-pushes structural (§4.6).
  await run('git', ['-C', path, 'remote', 'remove', 'origin']).catch(() => undefined)

  return { path, sha, cleanup: () => rm(path, { recursive: true, force: true }) }
}

export async function resolveHeadSha(repo: string, ref: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, 'rev-parse', ref])
  return stdout.trim()
}

/** Files the agent added but never staged do not appear in `git diff <base>`, so the
 *  grounding check would call a real new test file a hallucination (§5.3). */
export async function stageAll(workspace: string): Promise<void> {
  await gitIn(workspace, ['add', '-A'])
}

/**
 * Git configuration the workspace is not allowed to supply, for every git command the
 * runner runs there **after** the container has exited.
 *
 * The workspace is mounted read-write and `.git` is inside it, so by the time the agent
 * is done the repository's configuration and hooks are agent-authored — and git executes
 * both. This is not theoretical and it is not limited to `commit`:
 *
 *   core.fsmonitor   an arbitrary command, run on every command that refreshes the
 *                    index. Measured: it fires on `add`, `ls-files`, `status` and
 *                    `diff` — which is to say on the calls this runner already made
 *                    before any of this existed.
 *   .git/hooks       pre-commit and friends, run by `commit`.
 *   diff.external    an arbitrary command, run instead of the diff machinery.
 *
 * Each of those runs on the host, as the runner, with the runner's control-plane token
 * in its environment. The container never escapes anything — it leaves a string behind
 * and waits for the host to execute it, the same shape as the symlink readback in §5.3.
 *
 * `-c` beats repository configuration, so this neutralises them wherever the command is
 * run from. Diff-producing commands additionally pass `--no-ext-diff --no-textconv`,
 * since `.gitattributes` can name a driver per path.
 */
export const GIT_HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
]

/**
 * And nothing from the *host's* git configuration either.
 *
 * A patch that differs depending on whose laptop the runner is on is not an artefact —
 * one developer's global `diff.noprefix` or `format.signature` is enough to change what
 * the publisher receives. `GIT_TERMINAL_PROMPT=0` because there is no remote in a
 * workspace and a git that decides to ask for a credential must fail rather than hold a
 * nightly run open until morning.
 */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}

/**
 * Every git call the runner makes inside a workspace goes through this.
 *
 * `tolerateExit` is for the predicates — `diff --quiet` and `merge-base --is-ancestor`
 * report their answer as an exit code, and treating that as a failure would turn "there
 * are changes" into a thrown error.
 */
export async function gitIn(
  workspace: string,
  args: string[],
  opts: { tolerateExit?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('git', [...GIT_HARDENING, '-C', workspace, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      env: GIT_ENV,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    if (typeof e.code === 'number' && e.code === opts.tolerateExit) {
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
    // Named by subcommand, not just by stderr: `fatal: bad object` says nothing about
    // which of half a dozen calls in extraction produced it.
    throw new Error(
      `git ${subcommandOf(args)} failed: ${(e.stderr || e.message || '').slice(-1000)}`,
    )
  }
}

/** The first thing in the argv that is a verb rather than a `-c key=value` override. */
function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++
    else if (!args[i]!.startsWith('-')) return args[i]!
  }
  return 'command'
}
