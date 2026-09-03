import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { readRecord, running, startDetached, stopDaemon, StartFailed } from '../src/daemon.ts'
import { stripDetach } from '../src/commands/serve.ts'

const exec = promisify(execFile)

/**
 * Every test here runs against its own `OGUN_CONFIG`, so the pidfile, the log directory
 * and the rotation policy are all the test's own. Nothing touches `~/.ogun`, and a failed
 * test cannot leave a daemon behind that the next one then refuses to start alongside.
 */
async function sandbox(t: { after: (fn: () => unknown) => void }, logs: unknown = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-daemon-'))
  const config = join(dir, 'config.json')
  await writeFile(config, JSON.stringify({ logs: { dir: join(dir, 'logs'), ...(logs as object) } }))
  const previous = process.env.OGUN_CONFIG
  process.env.OGUN_CONFIG = config

  t.after(async () => {
    await stopDaemon('server', { force: true, timeoutMs: 5_000 }).catch(() => {})
    if (previous === undefined) delete process.env.OGUN_CONFIG
    else process.env.OGUN_CONFIG = previous
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, logFile: join(dir, 'logs', 'server.log') }
}

/** An entry that prints and stays up until it is asked to stop. */
const alive = (dir: string, name = 'alive.ts') =>
  writeFile(
    join(dir, name),
    "console.log('up')\nsetInterval(() => {}, 1000)\n",
  ).then(() => join(dir, name))

/** An entry that writes to stderr and dies, the way a bad DATABASE_URL does. */
const dies = (dir: string) =>
  writeFile(
    join(dir, 'dies.ts'),
    "console.error('FATAL: could not connect')\nprocess.exit(1)\n",
  ).then(() => join(dir, 'dies.ts'))

/**
 * The bug this is here for: `-d` reaching the process being launched.
 *
 * The runner parses its own argv with no options declared and exits non-zero on anything
 * it does not recognise, so a forwarded `-d` does not degrade — it makes
 * `ogun runner start -d` impossible. Detaching is a property of how the launcher runs the
 * process rather than of the process, so the flag has to stop at the launcher.
 */
test('-d is consumed by the launcher and never forwarded', () => {
  assert.deepEqual(stripDetach(['-d']), { detach: true, forwarded: [] })
  assert.deepEqual(stripDetach(['--detach']), { detach: true, forwarded: [] })
  assert.deepEqual(stripDetach([]), { detach: false, forwarded: [] })

  // Everything else still goes through, which is what keeps `--port` working.
  assert.deepEqual(stripDetach(['-d', '--port', '8080']), {
    detach: true,
    forwarded: ['--port', '8080'],
  })
  assert.deepEqual(stripDetach(['--port', '8080']), {
    detach: false,
    forwarded: ['--port', '8080'],
  })
})

test('a detached daemon is its own session leader', async (t) => {
  const { dir } = await sandbox(t)
  const { pid } = await startDetached({ name: 'server', entry: await alive(dir), args: [] })

  // sid === pid is the whole claim `-d` makes: a new session, so the terminal that
  // started it closing does not take it down. This is precisely what `&` does not do.
  const { stdout } = await exec('ps', ['-o', 'sid=', '-p', String(pid)])
  assert.equal(Number(stdout.trim()), pid, 'the daemon leads its own session')
})

/**
 * The failure `-d` exists to avoid: printing a pid, and a log path, for a process that
 * was already gone by the time the message reached the terminal.
 */
test('a process that dies immediately is reported as failed, not started', async (t) => {
  const { dir } = await sandbox(t)
  const entry = await dies(dir)

  await assert.rejects(
    () => startDetached({ name: 'server', entry, args: [], settleMs: 1_000 }),
    (err: unknown) => {
      assert.ok(err instanceof StartFailed, 'a StartFailed, so the caller can show the log')
      assert.match(err.logTail, /FATAL: could not connect/, 'the reason is in the tail')
      return true
    },
  )
})

test('a failed start leaves no pidfile behind', async (t) => {
  const { dir } = await sandbox(t)
  await startDetached({ name: 'server', entry: await dies(dir), args: [], settleMs: 1_000 })
    .then(() => assert.fail('should not have reported success'))
    .catch((err: unknown) => assert.ok(err instanceof StartFailed))

  // A pidfile naming a dead process is worse than none: the next start refuses, pointing
  // at a pid that no longer exists, until somebody deletes the file by hand.
  assert.equal(await readRecord('server'), null)
})

/**
 * Pids are recycled, and the machine this is built for recycles them constantly: a WSL
 * distro stops with its Windows host, stranding a pidfile, and the next boot starts
 * numbering from the bottom again. Liveness alone would have `stop` signalling whatever
 * inherited the number.
 */
test('a pidfile whose pid now belongs to something else is not ours', async (t) => {
  const { dir } = await sandbox(t)

  // This test process is alive, and is emphatically not an ogun daemon.
  await writeFile(
    join(dir, 'server.pid'),
    JSON.stringify({ pid: process.pid, startedAt: '', command: 'ogun server start' }),
  )

  assert.notEqual(await readRecord('server'), null, 'the record is readable')
  assert.equal(await running('server'), null, 'but it is not a running ogun server')
  assert.equal(await stopDaemon('server'), 'not-running', 'so stop refuses to signal it')
})

test('stopping a daemon that is not running is not an error', async (t) => {
  await sandbox(t)
  assert.equal(await stopDaemon('server'), 'not-running')
})

test('a daemon stops on SIGTERM and clears its pidfile', async (t) => {
  const { dir } = await sandbox(t)
  await startDetached({ name: 'server', entry: await alive(dir), args: [] })
  assert.notEqual(await running('server'), null)

  assert.equal(await stopDaemon('server', { timeoutMs: 10_000 }), 'stopped')
  assert.equal(await running('server'), null)
  assert.equal(await readRecord('server'), null, 'the pidfile goes with it')
})

/**
 * Rotation, which is the reason a host process exists at all. Handing the daemon a raw
 * fd would be simpler and would grow one file until the disk was full.
 */
test('the log rolls over at maxBytes and keeps the configured number of files', async (t) => {
  const { dir, logFile } = await sandbox(t, { maxBytes: '4kb', keep: 3 })
  const entry = join(dir, 'noisy.ts')
  await writeFile(
    entry,
    "for (let i = 0; i < 300; i++) console.log(`line ${i} ${'x'.repeat(200)}`)\n" +
      'setInterval(() => {}, 1000)\n',
  )
  await startDetached({ name: 'server', entry, args: [] })

  const sizeOf = (p: string) => stat(p).then((s) => s.size, () => -1)
  assert.ok((await sizeOf(logFile)) <= 4096, 'the live file is bounded')
  for (const n of [1, 2, 3]) {
    assert.ok((await sizeOf(`${logFile}.${n}`)) > 0, `server.log.${n} was kept`)
  }
  // 60KB was written into a 4KB file with three backups, so the oldest must be gone —
  // otherwise "rotation" is just renaming on the way to the same full disk.
  assert.equal(await sizeOf(`${logFile}.4`), -1, 'beyond keep, files are discarded')
})

test('keep: 0 bounds the log without keeping any backups', async (t) => {
  const { dir, logFile } = await sandbox(t, { maxBytes: '2kb', keep: 0 })
  const entry = join(dir, 'noisy.ts')
  await writeFile(
    entry,
    "for (let i = 0; i < 200; i++) console.log(`line ${i} ${'x'.repeat(200)}`)\n" +
      'setInterval(() => {}, 1000)\n',
  )
  await startDetached({ name: 'server', entry, args: [] })

  assert.ok((await stat(logFile)).size <= 2048)
  await assert.rejects(() => stat(`${logFile}.1`), 'nothing is kept beside it')
})

test('the host records what it launched, and the log carries the exit', async (t) => {
  const { dir, logFile } = await sandbox(t)
  await startDetached({ name: 'server', entry: await alive(dir), args: [] })

  const record = await running('server')
  assert.ok(record)
  assert.match(record.command, /^ogun server start/)
  assert.ok(Date.parse(record.startedAt) > 0, 'startedAt is a real instant')

  await stopDaemon('server', { timeoutMs: 10_000 })
  const log = await readFile(logFile, 'utf8')
  assert.match(log, /up/, "the daemon's own output is captured")
  assert.match(log, /SIGTERM — asking server to stop/, 'and so is the shutdown')
  assert.match(log, /server exited/)
})
