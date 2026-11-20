import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const ogun = (args: string[], config: string, cwd?: string): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, OGUN_CONFIG: config }, ...(cwd ? { cwd } : {}) },
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

test('adding a repository Ogun has never seen writes the config sync needs', async () => {
  const { dir, repo, config } = await bareRepo()
  try {
    const added = await ogun(['project', 'add', repo], config)

    // The file it could not have had, with the name it will be known by.
    const written = await readFile(join(repo, '.ogun', 'config.yaml'), 'utf8')
    assert.match(written, /^project:\n {2}name: clawz$/m)
    assert.match(added.stdout, /wrote .*\.ogun\/config\.yaml/)

    // The path, on this machine, which is what `add` always did.
    const machine = JSON.parse(await readFile(config, 'utf8')) as { projects: Record<string, string> }
    assert.equal(machine.projects.clawz, repo)

    // `add` does not sync. The two commands sit on opposite sides of the wire — a path
    // is a fact about this machine and never leaves it, syncing posts a config to the
    // control plane — and what was broken was never the split. It was that `add`
    // recommended `sync` to a repository `sync` could not read.
    //
    // So the recommendation stays and is now true, which is the property worth pinning:
    // the file named in it exists by the time it is printed.
    assert.match(added.stdout, /Next: `ogun project sync`/)
    assert.ok(
      !/^synced /m.test(added.stdout),
      'add registers a path; it does not reach the control plane',
    )

    // The thing that bites later, said at the moment the file appears.
    assert.match(added.stdout, /Commit it/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The config is the definition — reviewed in a pull request, read by the runner from git.
 * A command called `add` overwriting one would be the worst kind of surprise, so an
 * existing file decides the name rather than being replaced by a guess from the directory.
 */
test('an existing config is never overwritten, and names the project', async () => {
  const { dir, repo, config } = await bareRepo()
  try {
    await mkdir(join(repo, '.ogun'), { recursive: true })
    const original = 'project:\n  name: already-here\n  defaultBranch: develop\n'
    await writeFile(join(repo, '.ogun', 'config.yaml'), original)

    const added = await ogun(['project', 'add', repo], config)

    assert.equal(await readFile(join(repo, '.ogun', 'config.yaml'), 'utf8'), original)
    assert.ok(!/wrote /.test(added.stdout), 'nothing was written over it')
    const machine = JSON.parse(await readFile(config, 'utf8')) as { projects: Record<string, string> }
    assert.equal(
      machine.projects['already-here'],
      repo,
      'the configured name wins over the directory name',
    )
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

/**
 * Both commands default to the directory you are standing in.
 *
 * They always have — `resolve(first ?? process.cwd())` in each — and the behaviour was
 * asked about anyway, which is a fair thing to wonder: `[dir]` in a usage line says the
 * argument is optional and nothing about what omitting it gets you. So the default is
 * written down now, and pinned here so it cannot quietly become a required argument.
 */
test('add and sync default to the current directory', async () => {
  const { dir, repo, config } = await bareRepo()
  try {
    // No path argument, run from inside the repo.
    const added = await ogun(['project', 'add'], config, repo)
    assert.equal(added.code, 0, added.stderr)
    assert.match(added.stdout, new RegExp(`clawz → ${repo}`))

    const machine = JSON.parse(await readFile(config, 'utf8')) as {
      projects: Record<string, string>
    }
    assert.equal(machine.projects.clawz, repo, 'the path it registered is where it ran')

    // And sync reaches the same file without being told where it is. No server here, so
    // it cannot finish — what matters is that it got past resolving the directory, which
    // the ENOENT message would prove it had not.
    const synced = await ogun(['project', 'sync'], config, repo)
    assert.ok(
      !/has no \.ogun\/config\.yaml/.test(synced.stderr),
      `sync did not find the config add had just written: ${synced.stderr}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
