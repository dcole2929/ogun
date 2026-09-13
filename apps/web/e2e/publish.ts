import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Publish `docs/screenshots/` to the orphan `screenshots` branch and print the markdown
 * that embeds them.
 *
 * ### Why a branch nobody checks out
 *
 * A screenshot has to be reachable over HTTP for GitHub to render it in a pull request,
 * and on a private repository the only host whose auth a reviewer's browser already
 * carries is GitHub itself. An external object store means credentials, a bill, and this
 * project's unreleased interface sitting on somebody else's disk.
 *
 * Committing them alongside the code solves the hosting and creates a worse problem: a
 * binary in `main`'s history on every UI change, forever, because git keeps every version
 * of every blob a branch has ever pointed at.
 *
 * An orphan branch splits those apart. The blobs live in the repository's object store, so
 * the URLs authenticate like any other file here — and `main` never references them, the
 * working tree never carries them, and the branch is force-pushed rather than added to, so
 * only the current set is reachable. Superseded blobs become unreferenced and are
 * reclaimed by GitHub's own gc. The repository holds one set of screenshots, not one per
 * pull request.
 *
 * `gh-pages` is the same trick, for the same reason.
 *
 * ### What it deliberately is not
 *
 * Not a history. Re-pointing the branch discards what was there, so a link in a merged
 * pull request goes stale once somebody else publishes. That is the trade for a repository
 * that does not grow: the picture is for the review happening now, and the current UI is
 * always one `pnpm screenshots` away. If a before/after has to survive, put both images in
 * the comment while they are both current.
 */

const DIR = new URL('../../../docs/screenshots/', import.meta.url).pathname
const BRANCH = 'screenshots'

const ROOT = new URL('../../../', import.meta.url).pathname

/** `git mktree` reads its entries from stdin and writes the tree's hash to stdout. */
const mktree = (entries: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['mktree'], { cwd: ROOT })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c))
    child.stderr.on('data', (c: Buffer) => (err += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git mktree: ${err.trim()}`)),
    )
    child.stdin.end(`${entries.join('\n')}\n`)
  })

const git = async (...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd: new URL('../../../', import.meta.url).pathname })).stdout.trim()

async function publish(): Promise<string[]> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort()
  if (files.length === 0) throw new Error('no screenshots — run `pnpm screenshots` first')

  /**
   * Built with plumbing rather than by checking the branch out.
   *
   * `git checkout --orphan` would rewrite the working tree and the index of whatever
   * branch you are on, in a repository you are probably mid-change in. `hash-object`,
   * `mktree` and `commit-tree` write objects directly and touch neither.
   */
  const entries: string[] = []
  for (const name of files) {
    const hash = await git('hash-object', '-w', `${DIR}${name}`)
    entries.push(`100644 blob ${hash}\t${name}`)
  }
  // `spawn`, not `execFile`: this has to write to git's stdin, and promisified `execFile`
  // has no `input` option — passing one is silently ignored, so `mktree` sits waiting on
  // a stdin that never closes and the command hangs rather than failing.
  const tree = await mktree(entries)

  // No parent: the previous set is not history, it is superseded.
  const commit = await git('commit-tree', tree, '-m', `screenshots ${new Date().toISOString()}`)
  await git('push', '-f', 'origin', `${commit}:refs/heads/${BRANCH}`)
  return files
}

const remote = await git('remote', 'get-url', 'origin')
const slug = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1] ?? 'OWNER/REPO'
const files = await publish()

/**
 * `blob/<branch>/<file>?raw=1`, which is the one form that renders on a private repo.
 *
 * GitHub does not route it through camo — the reviewer's own session authenticates the
 * fetch. A `raw.githubusercontent.com` link is camo'd, camo has no credential, and the
 * image renders broken for everyone.
 */
const base = `https://github.com/${slug}/blob/${BRANCH}`
console.log(`published ${files.length} screenshots to the \`${BRANCH}\` branch\n`)
console.log(files.map((f) => `![${f.replace(/\.png$/, '')}](${base}/${f}?raw=1)`).join('\n\n'))
