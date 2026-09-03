import { strict as assert } from 'node:assert'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadLocalConfig, updateLocalConfig, writeSecretFile } from '../src/config/machine.ts'

/**
 * Paths in this file are hand-edited, so `~` has to work. It stopped being expanded when
 * the two machine-local files were merged, and the failure surfaced far away: the runner
 * passed a literal `~/.ogun/work/...` to Docker as a volume, which rejected it as an
 * invalid volume name *after* the workspace had been cloned and the image resolved.
 */
const withConfig = async (config: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-cfg-'))
  const path = join(dir, 'config.json')
  await writeFile(path, JSON.stringify(config))
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a tilde in a project path is expanded', async (t) => {
  const { path, cleanup } = await withConfig({ projects: { demo: '~/dev/demo' } })
  t.after(cleanup)
  const config = await loadLocalConfig(path)
  assert.equal(config.projects.demo, join(homedir(), 'dev/demo'))
})

test('a tilde in the scratch path is expanded', async (t) => {
  const { path, cleanup } = await withConfig({
    runner: { name: 'box', serverUrl: 'http://localhost:7777', scratch: '~/.ogun/work' },
  })
  t.after(cleanup)
  const config = await loadLocalConfig(path)
  assert.equal(config.runner?.scratch, join(homedir(), '.ogun/work'))
})

test('the default scratch path is expanded too', async (t) => {
  // The default is written as a tilde, so omitting the field must not skip expansion.
  const { path, cleanup } = await withConfig({
    runner: { name: 'box', serverUrl: 'http://localhost:7777' },
  })
  t.after(cleanup)
  assert.ok(!(await loadLocalConfig(path)).runner?.scratch.startsWith('~'))
})

test('an absolute path is left alone', async (t) => {
  const { path, cleanup } = await withConfig({ projects: { demo: '/srv/demo' } })
  t.after(cleanup)
  assert.equal((await loadLocalConfig(path)).projects.demo, '/srv/demo')
})

test('a missing file is an empty config, not an error', async () => {
  // A machine that has never been set up is an ordinary state, not a failure.
  const config = await loadLocalConfig('/nonexistent/ogun/config.json')
  assert.deepEqual(config.projects, {})
  assert.equal(config.runner, undefined)
})

const modeOf = async (path: string): Promise<string> => ((await stat(path)).mode & 0o777).toString(8)

const mintToken = (path: string) =>
  updateLocalConfig((c) => ({ ...c, server: { token: 'ogun_admin_secret' } }), path)

test('writing a token tightens a config.json that already exists world-readable', async (t) => {
  /**
   * The one that regressed: `writeFile`'s `mode` only applies on create, so a file
   * restored from a backup or copied off another machine at 0644 stayed 0644 while
   * `ogun runner join` and the server's first bind wrote credentials into it.
   */
  const { path, cleanup } = await withConfig({ projects: {} })
  t.after(cleanup)
  await chmod(path, 0o644)

  await mintToken(path)

  assert.equal(await modeOf(path), '600')
  assert.match(await readFile(path, 'utf8'), /ogun_admin_secret/)
})

test('a config.json this machine creates is 0600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-cfg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  await mintToken(join(dir, 'nested', 'config.json'))

  assert.equal(await modeOf(join(dir, 'nested', 'config.json')), '600')
})

test('a symlinked config.json is written through, not replaced', async (t) => {
  // Writing via a temp file and a rename would otherwise turn the link into a regular
  // file, silently detaching a config.json someone pointed somewhere deliberate.
  const { path, cleanup } = await withConfig({ projects: {} })
  t.after(cleanup)
  const link = `${path}.link`
  await symlink(path, link)

  await mintToken(link)

  assert.ok((await lstat(link)).isSymbolicLink())
  assert.match(await readFile(path, 'utf8'), /ogun_admin_secret/)
  assert.equal(await modeOf(path), '600')
})

/**
 * `writeSecretFile` is the same rule for the files a run writes — a findings document, a
 * workspace inbox — where the path can already exist and the mode passed to `writeFile`
 * was therefore doing nothing.
 */
test('a secret file replaces the mode of whatever was at the path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secret-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'findings.json')
  await writeFile(path, 'someone else wrote this first\n')
  await chmod(path, 0o644)

  await writeSecretFile(path, 'the secret\n')

  assert.equal(await modeOf(path), '600')
  assert.equal(await readFile(path, 'utf8'), 'the secret\n')
})

test('a secret file is never written through a symlink', async (t) => {
  // The opposite of config.json, deliberately: a link at one of these paths came from a
  // repository the runner cloned, not from a person, and following it would let that
  // repository choose a host file for the runner to overwrite (§5.3).
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secret-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outside = join(dir, 'host-file')
  await writeFile(outside, 'not yours\n')
  const path = join(dir, 'findings.json')
  await symlink(outside, path)

  await writeSecretFile(path, 'the secret\n')

  assert.equal(await readFile(outside, 'utf8'), 'not yours\n')
  assert.ok(!(await lstat(path)).isSymbolicLink(), 'the link should have been replaced')
  assert.equal(await modeOf(path), '600')
})

/**
 * The rotation setting a detached daemon reads. Two spellings because this file has two
 * kinds of reader: everything downstream wants bytes, and a person editing it by hand
 * wants to write the size they mean.
 */
test('a log size is accepted as bytes or as a size with a unit', async (t) => {
  for (const [written, expected] of [
    ['20MB', 20 * 1024 * 1024],
    ['512kb', 512 * 1024],
    ['1gb', 1024 * 1024 * 1024],
    ['4096', 4096],
    [4096, 4096],
  ] as const) {
    const { path, cleanup } = await withConfig({ logs: { maxBytes: written } })
    t.after(cleanup)
    assert.equal((await loadLocalConfig(path)).logs.maxBytes, expected, String(written))
  }
})

/**
 * A malformed size is a schema error naming the field, not a silent fallback to the
 * default. Rotation is the kind of setting nobody looks at again after they set it, so
 * `"20 megs"` quietly meaning 20MB-because-we-gave-up is how somebody ends up certain
 * they configured something they did not.
 */
test('a size that is not a size is refused, and the field is named', async (t) => {
  const { path, cleanup } = await withConfig({ logs: { maxBytes: '20 megs' } })
  t.after(cleanup)
  await assert.rejects(
    () => loadLocalConfig(path),
    (err: Error) => {
      assert.match(err.message, /logs\.maxBytes/)
      return true
    },
  )
})

/**
 * `.default({})` on this block would hand back the literal `{}` — zod does not run a
 * default through the schema — leaving `logs.dir` undefined for the overwhelmingly common
 * config that never mentions logging, and taking `expandPaths` into
 * `undefined.startsWith`. It is a `prefault` for exactly that reason.
 */
test('a config that says nothing about logging still gets every log default', async (t) => {
  const { path, cleanup } = await withConfig({ projects: {} })
  t.after(cleanup)
  const { logs } = await loadLocalConfig(path)
  assert.equal(logs.dir, join(homedir(), '.ogun/logs'))
  assert.equal(logs.maxBytes, 20 * 1024 * 1024)
  assert.equal(logs.keep, 5)
})

/** The default is written as a tilde, so omitting the block must not skip expansion. */
test('the default log directory is expanded, with or without a config file', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  assert.ok(!(await loadLocalConfig(path)).logs.dir.startsWith('~'))
  // And the path where there is no file at all, which used to skip expandPaths entirely.
  assert.ok(!(await loadLocalConfig(join(path, 'missing.json'))).logs.dir.startsWith('~'))
})
