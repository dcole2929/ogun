import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { loadLocalConfig, LocalConfigError, updateLocalConfig } from '../src/config/machine.ts'

/**
 * `~/.ogun/config.json` has several writers and one copy.
 *
 * Every one of them reads the whole file, changes one branch, and writes the whole file
 * back, so two in flight at once means the second was built on a config it read before the
 * first had written — and it puts back a document with the first writer's change missing.
 * `ogun project sync` prints `synced`, exits 0, and the project is not in the map.
 *
 * A naive implementation is exactly load-mutate-write with no lock, and it passes every
 * test that calls it once. These call it more than once, which is the only thing that
 * distinguishes the two implementations: the *outcome* of a lost update is a file that
 * parses, validates, and is missing something.
 *
 * The second property is the one a first attempt at a lock gets wrong. A lock has to be
 * safe to *abandon* — a `runner join` killed at the wrong moment must not leave a machine
 * where no Ogun command can ever write its config again, which is a worse and far more
 * permanent failure than the race it was added to fix.
 */

const run = promisify(execFile)
const machineModule = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config', 'machine.ts')

const withConfig = async (config: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-cfg-race-'))
  const path = join(dir, 'config.json')
  await writeFile(path, JSON.stringify(config))
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('twelve concurrent edits all land', async (t) => {
  const { path, cleanup } = await withConfig({ projects: { already: '/srv/already' } })
  t.after(cleanup)

  const slugs = Array.from({ length: 12 }, (_, i) => `p${i}`)
  await Promise.all(
    slugs.map((slug) =>
      updateLocalConfig(
        (c) => ({ ...c, projects: { ...c.projects, [slug]: `/srv/${slug}` } }),
        path,
      ),
    ),
  )

  const { projects } = await loadLocalConfig(path)
  const missing = slugs.filter((s) => !(s in projects))
  // Unlocked, this is eleven of twelve: every writer read the same starting file, so only
  // the last rename's content survives.
  assert.deepEqual(missing, [], `edits dropped: ${missing.join(', ')}`)
  assert.equal(projects.already, '/srv/already', 'the entry that was already there was lost')
})

/**
 * The edits that actually collide in practice are different *branches* of the file written
 * by different commands — `ogun runner join` and `ogun project sync`, which a setup script
 * runs one after the other and which `ogun init` chains.
 *
 * A lost update here is not a missing project path. It is a machine that reports itself
 * joined, with no runner credential on disk.
 */
test('a runner joining and a project syncing do not erase each other', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)

  await Promise.all([
    updateLocalConfig(
      (c) => ({
        ...c,
        runner: {
          name: 'box',
          labels: [],
          serverUrl: 'http://localhost:7777',
          token: 'runner-secret',
          maxConcurrentJobs: 2,
          pollIntervalMs: 3000,
          scratch: '~/.ogun/work',
        },
      }),
      path,
    ),
    updateLocalConfig((c) => ({ ...c, projects: { demo: '/srv/demo' } }), path),
    updateLocalConfig((c) => ({ ...c, server: { token: 'admin-secret' } }), path),
  ])

  const config = await loadLocalConfig(path)
  assert.equal(config.runner?.token, 'runner-secret', 'the runner credential was lost')
  assert.equal(config.projects.demo, '/srv/demo', 'the project path was lost')
  assert.equal(config.server.token, 'admin-secret', 'the admin token was lost')
})

/**
 * Separate processes, which is what these writers actually are — `ogun project sync` and
 * `ogun runner join` are two invocations of a CLI, not two calls in one program. Nothing
 * in-process can coordinate them, so this is the case a lock has to be a file for.
 */
test('eight concurrent CLI-shaped writers all land', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  const startAt = Date.now() + 400

  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      run(process.execPath, [
        '--input-type=module',
        '-e',
        `
        import { updateLocalConfig } from ${JSON.stringify(machineModule)}
        // A shared start instant: module loading takes far longer than the edit does, so
        // without it the children queue rather than collide.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startAt} - Date.now())
        await updateLocalConfig(
          (c) => ({ ...c, projects: { ...c.projects, 'p${i}': '/srv/p${i}' } }),
          ${JSON.stringify(path)},
        )
        `,
      ]),
    ),
  )

  const { projects } = await loadLocalConfig(path)
  const missing = Array.from({ length: 8 }, (_, i) => `p${i}`).filter((s) => !(s in projects))
  assert.deepEqual(missing, [], `edits dropped: ${missing.join(', ')}`)
})

/**
 * A lock left by a process that is gone must cost the next command nothing.
 *
 * Cleanup that only runs on the happy path leaks precisely as fast as the failures it was
 * written for — Ctrl-C during `ogun runner join`, an OOM kill, a container the runner
 * stops on a timeout. So the recovery path cannot be "a human notices a lockfile".
 */
test('a lock left by a dead process does not wedge the next write', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  // 2^31-1: above every pid_max Linux ships, so it cannot be a live process.
  await writeFile(`${path}.lock`, '2147483647\n')

  const started = Date.now()
  await updateLocalConfig((c) => ({ ...c, projects: { demo: '/srv/demo' } }), path)

  assert.equal((await loadLocalConfig(path)).projects.demo, '/srv/demo')
  // Immediately, not after the staleness timeout: a dead pid is proof, and waiting for a
  // clock would make every command after a crash slow for no extra safety.
  assert.ok(Date.now() - started < 1_000, 'a dead holder should not be waited out')
})

/**
 * The ordinary contended case, and the one the whole mechanism is for: somebody else holds
 * the lock and then gives it back. The waiter has to *wait* — a writer that gave up and
 * proceeded anyway would be the unlocked implementation with extra steps.
 */
test('a writer waits for a live holder rather than writing over it', async (t) => {
  const { path, cleanup } = await withConfig({ projects: { first: '/srv/first' } })
  t.after(cleanup)

  await writeFile(`${path}.lock`, `${process.pid}\n`)
  // The holder's own edit, applied while the waiter is blocked, so "did the waiter build
  // on this?" has an observable answer rather than being a claim about ordering.
  const released = (async () => {
    await new Promise((done) => setTimeout(done, 300))
    await writeFile(path, JSON.stringify({ projects: { first: '/srv/first', held: '/srv/held' } }))
    await rm(`${path}.lock`, { force: true })
  })()

  const [config] = await Promise.all([
    updateLocalConfig((c) => ({ ...c, projects: { ...c.projects, late: '/srv/late' } }), path),
    released,
  ])

  assert.equal(config.projects.held, '/srv/held', "the waiter did not see the holder's write")
  assert.equal(config.projects.late, '/srv/late')
})

/**
 * A lock held by something that really is alive is a different fact, and gets a different
 * answer: fail, and say what to look at. Waiting forever would turn a stuck writer into a
 * stuck machine with no output.
 */
test('a lock held by a live process eventually fails with a message naming the file', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  // This process, which is unambiguously alive.
  await writeFile(`${path}.lock`, `${process.pid}\n`)

  await assert.rejects(
    () => updateLocalConfig((c) => c, path),
    (err: Error) => err instanceof LocalConfigError && err.message.includes(`${path}.lock`),
  )
})

test('nothing is left beside the config once the writes are done', async (t) => {
  const { dir, path, cleanup } = await withConfig({})
  t.after(cleanup)
  await Promise.all([
    updateLocalConfig((c) => ({ ...c, projects: { a: '/srv/a' } }), path),
    updateLocalConfig((c) => ({ ...c, projects: { ...c.projects, b: '/srv/b' } }), path),
  ])
  // A stranded `.lock` is the wedge above waiting to happen; a stranded `.tmp-<pid>` is a
  // 0600 file holding a copy of the admin token.
  assert.deepEqual(await readdir(dir), ['config.json'])
  assert.ok(JSON.parse(await readFile(path, 'utf8')))
})

/**
 * The window while a lock is being *taken*, which is the one place the lock could break
 * itself.
 *
 * `claimLock` creates the file and writes the pid in a single `writeFile`, but those are
 * not one event to a reader: a waiter arriving between them sees an empty file.
 * `Number.parseInt('')` is `NaN` and `alive(NaN)` is false, so `breakAbandonedLock` used
 * to conclude the holder was gone, delete a live lock, and let both writers through —
 * precisely the lost update the lock exists to prevent.
 *
 * The concurrent-writers test above catches this about one run in eight, which is a test
 * that reports a real defect as flakiness. This one asks the question directly, and the
 * two halves are the whole rule: an unreadable owner is *waited* for while it is fresh,
 * and broken once it is older than a process could plausibly be mid-`writeFile`.
 */
test('a lock with no owner written yet is waited for, not broken', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  const { writeFile: write, rm: remove } = await import('node:fs/promises')
  const lockPath = `${path}.lock`

  // Exactly what a half-taken lock looks like: created, pid not yet landed.
  await write(lockPath, '')

  await assert.rejects(
    () => updateLocalConfig((c) => ({ ...c, projects: { taken: '/tmp/x' } }), path),
    /still held/,
    'an empty lock is a lock mid-write; breaking it lets two writers into one file',
  )

  await remove(lockPath, { force: true })
})

test('a lock with no owner written yet is broken once it is stale', async (t) => {
  const { path, cleanup } = await withConfig({})
  t.after(cleanup)
  const { writeFile: write, utimes } = await import('node:fs/promises')
  const lockPath = `${path}.lock`

  await write(lockPath, '')
  // Older than any `writeFile` could still be in flight: a crash between open and write.
  const longAgo = new Date(Date.now() - 120_000)
  await utimes(lockPath, longAgo, longAgo)

  const next = await updateLocalConfig((c) => ({ ...c, projects: { taken: '/tmp/x' } }), path)
  assert.equal(next.projects.taken, '/tmp/x', 'a genuinely abandoned lock must not wedge the file')
})
