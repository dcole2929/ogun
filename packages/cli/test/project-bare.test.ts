import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * A repository Ogun has never seen, which is the state every project starts in.
 *
 * Reported from a fresh clone: `ogun project add .` succeeded and printed
 * "`ogun project sync`", sync failed with `ENOENT: no such file or directory` on a path
 * nobody had chosen, and `ogun project list` did not show the project. A dead end the
 * commands walked somebody into, one step at a time, each step reporting success.
 *
 * The information needed to avoid it was already in hand: `add` had printed "has no
 * .ogun/config.yaml" two lines before recommending the command that reads one.
 */

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

type Result = { code: number; stdout: string; stderr: string }

const ogun = (args: string[], config: string): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, OGUN_CONFIG: config } },
      (err, stdout, stderr) =>
        done({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    )
    child.stdin?.end('')
  })

const bareRepo = async (): Promise<{ dir: string; repo: string; config: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-bare-'))
  const repo = join(dir, 'clawz')
  await mkdir(repo, { recursive: true })
  await new Promise<void>((done) =>
    execFile('git', ['init', '-q', repo], () => done()),
  )
  return { dir, repo, config: join(dir, 'config.json') }
}

test('adding a project with no config says what to write, not what to run', async () => {
  const { dir, repo, config } = await bareRepo()
  try {
    const added = await ogun(['project', 'add', repo], config)

    assert.equal(added.code, 0, 'registering the path still succeeds')
    assert.match(added.stdout, /cannot be until/)
    // The file by name and its contents, so it can be written without guessing.
    assert.match(added.stdout, /\.ogun\/config\.yaml/)
    assert.match(added.stdout, /name: clawz/)
    // `sync` is still named, as the step after writing the file. What must not appear is
    // the sentence that offered it as the immediate remedy to a repository that has
    // nothing for it to read.
    assert.ok(
      !/has no project called .* yet/.test(added.stdout),
      'a repository with no config is not sent straight to the command that reads one',
    )
    assert.match(added.stdout, /enough for `ogun project sync` to accept it/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncing a repository with no config names the file rather than an errno', async () => {
  const { dir, repo, config } = await bareRepo()
  try {
    const synced = await ogun(['project', 'sync', repo], config)

    assert.equal(synced.code, 1)
    assert.match(synced.stderr, /has no \.ogun\/config\.yaml, so there is nothing to sync/)
    assert.match(synced.stderr, /name: clawz/)
    // `ENOENT` is true, and is not the thing somebody needs to be told.
    assert.ok(!synced.stderr.includes('ENOENT'), 'the errno is not the message')
    // The half that is easy to leave out and expensive to learn later: the runner reads
    // this file from git, so writing it is not the same as committing it.
    assert.match(synced.stderr, /Commit it/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
