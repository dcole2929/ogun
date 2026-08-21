import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { GIT_ENV, GIT_HARDENING, RUNNER_IDENTITY, gitIn } from './workspace.ts'

/**
 * Getting a modifier's work out of a workspace the container has just had write access to.
 *
 * This is the only thing that crosses (ADR-0005): the container has no remote and no
 * credential, so whatever the agent did exists solely as commits in a clone the runner
 * is about to delete. Extraction happens on the host, after the container has exited,
 * and produces a file the publisher can apply to a scratch worktree later.
 *
 * **`git format-patch`, not `git diff` and not `git bundle`.**
 *
 *   - A plain diff loses the commit message, and the message is the one piece of the
 *     agent's reasoning a human reviewing the PR reads first. It also loses authorship,
 *     and it needs `--binary` asking for explicitly — a diff that applies cleanly and
 *     leaves out the PNG is the worst failure of the three, because nothing reports it.
 *   - A bundle is the most faithful — exact objects, exact SHAs, merges and all — but it
 *     is an opaque binary blob. This artefact is also a review surface: it is served from
 *     the run detail page and read by a person deciding whether to publish. Faithfulness
 *     beyond "the same tree, with the same messages" buys nothing here, and readability
 *     buys a lot.
 *   - `format-patch` keeps messages, authorship, binary hunks and renames, is text, and
 *     the host applies it with `git am`, which is a one-liner in the publisher slice
 *     rather than a merge.
 *
 * The mbox is written to host scratch, never into postgres: patches are large blobs and
 * `artifacts`/`changes` hold pointers (§4.4).
 */

/**
 * A patch is agent output, and the agent decides how big it is. Committing `node_modules`
 * or a pathological binary is one shell command, and the runner is holding the other end
 * of the pipe — so the cap exists for the same reason `MAX_READBACK_BYTES` does on the
 * findings file.
 *
 * Higher than that one because a patch is legitimately larger than a findings document,
 * and because the runner never parses it: it is streamed to disk and counted on the way
 * past, so the limit protects the host without the runner ever holding in memory the
 * thing it is protecting itself from.
 */
export const MAX_PATCH_BYTES = 64 * 1024 * 1024

export type PatchExtraction = {
  /** The commit the workspace was pinned to, and what the host will apply the patch to. */
  baseSha: string
  /** Files differing between the base tree and what the agent left. Zero is a result. */
  filesChanged: number
  /** Commits in `base..HEAD` after any uncommitted work was collected. */
  commits: number
  /** Absent when nothing changed, and when the work could not be turned into a patch. */
  patch?: { ref: string; bytes: number }
  /**
   * Set only when there *is* work and no artefact came out of it. Never set for a run
   * that changed nothing — that is an ordinary outcome and must not wear the same value
   * as a failure to extract (principle 6).
   */
  unextractable?: string
}

export async function extractPatch(input: {
  workspace: string
  /** `workspace.sha` — the pinned base the clone was checked out at. */
  baseSha: string
  /** Host scratch directory for this run's patch. Created if absent. */
  destDir: string
  /**
   * Overrides `MAX_PATCH_BYTES`. A seam rather than a knob: the cap is a policy, and a
   * test that has to write 64MB to reach it is a test nobody runs.
   */
  limitBytes?: number
}): Promise<PatchExtraction> {
  const { workspace, baseSha } = input
  const limit = input.limitBytes ?? MAX_PATCH_BYTES

  /**
   * Staged first, and by extraction rather than by its caller.
   *
   * §5.3 stages before the gate so an untracked new file is not invisible to
   * `git diff <base>`; the same sentence decides this. `format-patch` reads commits, so
   * anything the agent left in the worktree is invisible to it too — and an agent that
   * edited ten files and forgot the final `git commit` would otherwise be recorded as a
   * run that changed nothing, which is the loss this whole slice exists to prevent.
   * Doing it here rather than trusting the caller means extraction is correct wherever it
   * is called from; `git add -A` twice is free.
   */
  await gitIn(workspace, ['add', '-A'])

  // Exit 1 means "there are differences", which is the whole signal. Any other failure
  // propagates — a git that cannot read the index is not a run that changed nothing.
  const leftovers = await gitIn(workspace, ['diff', '--cached', '--quiet', 'HEAD'], {
    tolerateExit: 1,
  })
  if (leftovers.code === 1) {
    /**
     * The agent's own message is worth more than anything the harness could invent, so
     * this says only what is true: nobody wrote a message for this. It is deliberately
     * unmistakable in `git log`, because a PR whose entire content arrived this way is a
     * sign the prompt or the agent is not doing what it was told.
     */
    await gitIn(workspace, [
      ...RUNNER_IDENTITY,
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      'Work the agent left uncommitted',
      '-m',
      'Collected by the ogun runner after the container exited; the agent wrote no ' +
        'commit message for it.',
    ])
  }

  /**
   * The tree, not the commit graph, decides whether anything happened. An agent that
   * committed and then reverted has a `base..HEAD` full of commits and nothing to
   * publish; recording that as a change would send an empty PR downstream.
   */
  const differs = await gitIn(workspace, ['diff', '--quiet', ...DIFF_SAFE, baseSha, 'HEAD'], {
    tolerateExit: 1,
  })
  if (differs.code === 0) return { baseSha, filesChanged: 0, commits: 0 }

  const numstat = await gitIn(workspace, ['diff', '--numstat', ...DIFF_SAFE, baseSha, 'HEAD'])
  const filesChanged = numstat.stdout.split('\n').filter(Boolean).length

  /**
   * The patch has to apply to the base the host still has. `git am` replays `base..HEAD`
   * onto that commit, so if the agent rewrote or reset past it — `commit --amend` on the
   * pinned commit, a `reset --hard HEAD~1`, a checkout of some other ref — the range is
   * either empty or describes changes relative to a commit the host will not be sitting
   * on, and applying it produces something nobody asked for.
   *
   * Reported rather than papered over: the tree really did change, and a run that says
   * "changed nothing" here would be the same lie in the other direction.
   */
  const ancestor = await gitIn(workspace, ['merge-base', '--is-ancestor', baseSha, 'HEAD'], {
    tolerateExit: 1,
  })
  if (ancestor.code !== 0) {
    return {
      baseSha,
      filesChanged,
      commits: 0,
      unextractable:
        `the workspace's HEAD is not a descendant of the pinned base ${baseSha.slice(0, 12)} — ` +
        'the agent rewrote or reset history, so no patch of this work can be applied to ' +
        'what the host has',
    }
  }

  const revList = await gitIn(workspace, ['rev-list', '--count', `${baseSha}..HEAD`])
  const commits = Number(revList.stdout.trim()) || 0

  await mkdir(input.destDir, { recursive: true })
  const ref = join(input.destDir, 'changes.patch')
  const written = await streamPatch(workspace, baseSha, ref, limit)
  if (written === 'oversize') {
    return {
      baseSha,
      filesChanged,
      commits,
      unextractable:
        `the patch is larger than the ${limit} byte limit — ${filesChanged} file(s) ` +
        'changed. A modifier this size has almost certainly committed something it should ' +
        'not have, such as a build directory or a dependency tree',
    }
  }

  return { baseSha, filesChanged, commits, patch: { ref, bytes: written } }
}

/**
 * Diff options that stop the *repository* deciding how a diff is produced.
 *
 * `.gitattributes` is content the agent can write, and it can name a diff driver whose
 * `textconv` or `command` is an arbitrary shell command; `diff.external` in the config it
 * also controls does the same for every diff. Those run on the host, as the runner, at
 * the moment the runner asks what changed. Demonstrated: a `diff.external` of
 * `sh -c 'echo pwned > …'` fires on a plain `git diff` and does not fire with these.
 */
const DIFF_SAFE = ['--no-ext-diff', '--no-textconv']

/**
 * The mbox, streamed rather than buffered.
 *
 * `execFile` would hold the whole patch in the runner's heap on the way to a file it is
 * about to write anyway, and `maxBuffer` turns "the agent committed a 2GB blob" into an
 * error whose message is about buffers. Streaming means the cap is enforced on the first
 * chunk that crosses it, the child is killed there, and the partial file is removed —
 * a half-written patch on disk is worse than none, because it applies.
 *
 * Returns the byte count, or `oversize`.
 */
async function streamPatch(
  workspace: string,
  baseSha: string,
  dest: string,
  limit: number,
): Promise<number | 'oversize'> {
  const child = spawn(
    'git',
    [
      ...GIT_HARDENING,
      '-C',
      workspace,
      'format-patch',
      // Redundant today — format-patch emits binary hunks unless told `--no-binary` —
      // and passed anyway, because "the artefact carries binaries" is a property of this
      // extraction rather than of whatever default the repository's config or a future
      // git happens to have.
      '--binary',
      ...DIFF_SAFE,
      '--stdout',
      // The repository can set `format.signature`; a signature in the middle of an mbox
      // is trailing prose `git am` has to guess about.
      '--no-signature',
      `${baseSha}..HEAD`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV },
  )

  const out = createWriteStream(dest, { mode: 0o600 })
  let bytes = 0
  let oversize = false
  let stderr = ''

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > limit && !oversize) {
      oversize = true
      child.kill('SIGKILL')
    }
  })

  const flushed = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve())
    out.on('error', reject)
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })

  child.stdout.pipe(out)
  let code: number | null
  try {
    code = await exited
    await flushed
  } catch (err) {
    // A git that never started leaves an open handle on a file with nothing in it.
    out.destroy()
    await rm(dest, { force: true })
    throw err
  }

  if (oversize) {
    await rm(dest, { force: true })
    return 'oversize'
  }
  if (code !== 0) {
    await rm(dest, { force: true })
    throw new Error(`git format-patch exited ${code}: ${stderr.slice(-1000)}`)
  }
  return bytes
}
