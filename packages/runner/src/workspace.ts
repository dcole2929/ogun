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
  await run('git', ['-C', workspace, 'add', '-A'])
}

export async function diffAgainst(workspace: string, base: string): Promise<string> {
  const { stdout } = await run('git', ['-C', workspace, 'diff', '--unified=0', base], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}
