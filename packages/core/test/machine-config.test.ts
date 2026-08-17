import { strict as assert } from 'node:assert'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadLocalConfig, updateLocalConfig } from '../src/config/machine.ts'

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
