import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadLocalConfig } from '@ogun/core'

const exec = promisify(execFile)

export const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/** The one process that is spawned detached. See `daemon-host.ts`. */
export const daemonHost = resolve(repoRoot, 'packages/cli/src/daemon-host.ts')

/**
 * How both modes launch a real entry point: Node, this repo's `.env` if it is there, then
 * the entry.
 *
 * One function because the foreground and detached paths must not drift. They did not
 * used to be two paths at all, and the failure mode if they diverge is the nastiest kind
 * — `ogun server start` reads DATABASE_URL and `ogun server start -d` does not, so the
 * background one dies on a connection error that says nothing about `.env`.
 */
export const nodeArgsFor = (entry: string, args: string[]): string[] => [
  '--env-file-if-exists',
  resolve(repoRoot, '.env'),
  entry,
  ...args,
]

/**
 * Both long-running processes, by the name they are managed under. The name is the
 * pidfile's basename, the log file's basename, and the word in every message — so
 * `ogun server stop` and `~/.ogun/server.pid` cannot drift apart.
 */
export type DaemonName = 'server' | 'runner'

export type Daemon = {
  pid: number
  /** ISO-8601. Written by the host, read back by `status` to say how long it has been up. */
  startedAt: string
  /** What was launched, for the message `status` prints. Never used to make decisions. */
  command: string
}

export type DaemonPaths = {
  pidFile: string
  logFile: string
  logDir: string
  maxBytes: number
  keep: number
}

/**
 * Where a daemon's two files live, and the rotation policy for the log.
 *
 * Read from `~/.ogun/config.json` rather than hardcoded because the log is the one part
 * of this that a person has a real reason to move — a machine with a small home
 * partition, or one where `/var/log` is what gets backed up.
 */
export async function daemonPaths(name: DaemonName): Promise<DaemonPaths> {
  const { logs } = await loadLocalConfig()
  return {
    // Beside config.json rather than in the log directory: a pidfile is machine state,
    // not output, and pointing `logs.dir` at /var/log should not move the pidfile
    // somewhere a stop command has to be told about.
    pidFile: join(expandOgunHome(), `${name}.pid`),
    logDir: logs.dir,
    logFile: join(logs.dir, `${name}.log`),
    maxBytes: logs.maxBytes,
    keep: logs.keep,
  }
}

const expandOgunHome = (): string =>
  process.env.OGUN_CONFIG ? resolve(process.env.OGUN_CONFIG, '..') : join(homeDir(), '.ogun')

const homeDir = (): string => process.env.HOME ?? process.env.USERPROFILE ?? '.'

/**
 * The record on disk, whether or not the process it names is still there. `running()` is
 * the question almost every caller actually has.
 */
export async function readRecord(name: DaemonName): Promise<Daemon | null> {
  const { pidFile } = await daemonPaths(name)
  const text = await readFile(pidFile, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<Daemon>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      command: typeof parsed.command === 'string' ? parsed.command : '',
    }
  } catch {
    // A truncated or hand-mangled pidfile is the same situation as no pidfile: there is
    // nothing here that can safely be signalled.
    return null
  }
}

export async function writeRecord(name: DaemonName, record: Daemon): Promise<void> {
  const { pidFile } = await daemonPaths(name)
  await mkdir(resolve(pidFile, '..'), { recursive: true })
  await writeFile(pidFile, `${JSON.stringify(record, null, 2)}\n`)
}

export async function clearRecord(name: DaemonName): Promise<void> {
  const { pidFile } = await daemonPaths(name)
  await rm(pidFile, { force: true })
}

/**
 * `kill(pid, 0)` asks whether a pid exists without touching it. EPERM is still a yes —
 * the process is there, it just is not ours.
 */
function signalable(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The record, but only if the process it names is both alive **and** still the daemon
 * that wrote it.
 *
 * Liveness alone is not enough, and the gap is not theoretical: pids are recycled, a
 * pidfile outlives an ungraceful kill, and the window is widest on exactly the machine
 * this is for — a WSL distro that stops with its host leaves a stale
 * `~/.ogun/server.pid` behind on every shutdown, and the next boot starts numbering pids
 * from the bottom again. Signalling on liveness alone means `ogun server stop` sending
 * SIGTERM to whatever inherited the number.
 *
 * So the command line is checked too. `ps -o args=` is POSIX and works on Linux and
 * macOS; where it is unavailable or says nothing we fall back to liveness, which is the
 * behaviour every pidfile in the world already has.
 */
export async function running(name: DaemonName): Promise<Daemon | null> {
  const record = await readRecord(name)
  if (!record || !signalable(record.pid)) return null

  const args = await exec('ps', ['-o', 'args=', '-p', String(record.pid)], { timeout: 5_000 })
    .then((r) => r.stdout.trim())
    .catch(() => null)
  if (!args) return record
  return args.includes('daemon-host') && args.includes(`ogun-${name}`) ? record : null
}

/**
 * Start `entry` as a detached background process, and do not return until it has either
 * come up or died.
 *
 * The waiting is the point. Node cannot `fork(2)`, so detaching means spawning a fresh
 * process and letting go of it — and the moment you let go, a crash three hundred
 * milliseconds later is invisible. Printing a pid for a process that is already gone is
 * the worst thing a `-d` flag can do, because the next thing the person does is walk
 * away. So the host writes its pidfile on the way up and removes it on the way down, and
 * this polls that file: still there means running, gone means it died and the log has the
 * reason.
 */
export async function startDetached(options: {
  name: DaemonName
  entry: string
  args: string[]
  /** Extra readiness beyond "the process is still alive" — an HTTP probe, usually. */
  ready?: () => Promise<boolean>
  readyTimeoutMs?: number
  /** How long it has to stay up before we are willing to call it started. */
  settleMs?: number
}): Promise<{ pid: number; logFile: string; ready: boolean }> {
  const { name, entry, args, ready, readyTimeoutMs = 15_000, settleMs = 1_500 } = options
  const paths = await daemonPaths(name)

  const existing = await running(name)
  if (existing) {
    throw new AlreadyRunning(
      `ogun ${name} is already running in the background (pid ${existing.pid}).\n` +
        `  ogun ${name} status   what it is doing\n` +
        `  ogun ${name} stop     stop it first`,
    )
  }
  // A record naming a process that is gone is not a conflict, it is litter — from a
  // WSL shutdown, a `kill -9`, or a host that died with its machine. Clear it rather
  // than refusing to start because of it.
  await clearRecord(name)

  await mkdir(paths.logDir, { recursive: true })

  const child = spawn(
    process.execPath,
    [daemonHost, `ogun-${name}`, entry, ...args],
    {
      // A new session, so this survives the terminal that started it. This is the half
      // that `&` does not do, and the reason `ogun server &` kept dying on logout.
      detached: true,
      // Nothing is read from stdin, and the two output streams are the host's problem:
      // it pumps them into a rotating file rather than letting the kernel write straight
      // through to an fd nothing can roll over.
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: repoRoot,
      env: { ...process.env, OGUN_DAEMON: name },
    },
  )
  child.unref()

  const deadline = Date.now() + readyTimeoutMs
  const settled = Date.now() + settleMs
  let record: Daemon | null = null
  // Up first: the host writes its pidfile before it spawns anything, so this settles in
  // a tick or two and only spins when something is badly wrong.
  while (Date.now() < deadline) {
    record = await running(name)
    if (record) break
    await pause(50)
  }
  if (!record) {
    throw new StartFailed(
      `ogun ${name} did not start.`,
      await tail(paths.logFile, 20),
      paths.logFile,
    )
  }

  // Then readiness. A process that is alive is not the same as a control plane that
  // answers, and the failures that matter here — a port already taken, a database that
  // is not up — happen after the process exists.
  let isReady = ready === undefined
  while (!isReady && Date.now() < deadline) {
    if (!(await running(name))) {
      throw new StartFailed(
        `ogun ${name} started and then exited.`,
        await tail(paths.logFile, 20),
        paths.logFile,
      )
    }
    isReady = await ready!()
    if (!isReady) await pause(250)
  }

  /**
   * One last look, after a settling window.
   *
   * The pidfile appearing proves the *host* came up, and the host comes up whether or
   * not the thing it was asked to run does — it lives long enough to spawn a child, log
   * the child's dying words, and exit. So a server that fails on its first database
   * query was reported as started, with a pid, moments before all of it went away. This
   * is `startsecs` in supervisord and the reason Docker's `--health-start-period`
   * exists: "the process was created" and "the process is running" are different
   * claims, and only the second one is worth printing.
   */
  while (Date.now() < settled) await pause(50)
  if (!(await running(name))) {
    throw new StartFailed(
      `ogun ${name} started and then exited.`,
      await tail(paths.logFile, 20),
      paths.logFile,
    )
  }

  return { pid: record.pid, logFile: paths.logFile, ready: isReady }
}

export class AlreadyRunning extends Error {}

export class StartFailed extends Error {
  readonly logTail: string
  readonly logFile: string

  constructor(message: string, logTail: string, logFile: string) {
    super(message)
    this.logTail = logTail
    this.logFile = logFile
  }
}

/**
 * SIGTERM, then wait — and on timeout say so rather than escalating.
 *
 * Escalating would be wrong for the runner specifically. It handles SIGTERM by refusing
 * new claims and letting in-flight jobs finish (`runner start`), and a job is an agent
 * inside a container that can legitimately run for many minutes. A SIGKILL after thirty
 * seconds would abandon a container mid-run and hand the control plane a claim it has to
 * sweep. So the timeout reports what is happening and leaves it draining; `--force` is
 * how you say you meant it.
 */
export async function stopDaemon(
  name: DaemonName,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<'stopped' | 'draining' | 'not-running'> {
  const { force = false, timeoutMs = 30_000 } = options
  const record = await running(name)
  if (!record) {
    await clearRecord(name)
    return 'not-running'
  }

  try {
    process.kill(record.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      await clearRecord(name)
      return 'not-running'
    }
    throw err
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await running(name))) {
      await clearRecord(name)
      return 'stopped'
    }
    await pause(100)
  }
  return 'draining'
}

/** Last `lines` lines of a file, or '' if there is nothing to read. */
export async function tail(file: string, lines: number): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (text === '') return ''
  const all = text.split('\n')
  // A trailing newline produces an empty final element that is not a line.
  if (all.at(-1) === '') all.pop()
  return all.slice(-lines).join('\n')
}

/**
 * `ogun server logs -f`.
 *
 * Follows by position rather than by handle so that a rollover is survivable: when the
 * file shrinks, the log this was reading has been renamed out from under it and the
 * right move is to start again at the top of the new one. Watching the handle would
 * leave you tailing a `server.log.1` nothing writes to any more — which looks exactly
 * like a daemon that has gone quiet.
 */
export async function followLog(file: string, initialLines: number): Promise<void> {
  const head = await tail(file, initialLines)
  if (head !== '') process.stdout.write(`${head}\n`)

  let position = await stat(file).then((s) => s.size, () => 0)
  let reading = false

  const drain = async (): Promise<void> => {
    if (reading) return
    reading = true
    try {
      for (;;) {
        const size = await stat(file).then((s) => s.size, () => 0)
        if (size === position) break
        if (size < position) position = 0 // rolled over
        const chunk = await readRange(file, position, size)
        if (chunk === '') break
        position += Buffer.byteLength(chunk)
        process.stdout.write(chunk)
      }
    } finally {
      reading = false
    }
  }

  // fs.watch misses events on some filesystems — notably the DrvFs mounts a WSL setup
  // can end up with — so a slow poll runs beside it rather than instead of it.
  const timer = setInterval(() => void drain(), 1000)
  try {
    watch(file, () => void drain())
  } catch {
    // No watcher available; the poll above is the whole implementation then.
  }
  // Until Ctrl-C. The interval is deliberately never cleared: this function does not
  // return, and the process exiting is what stops it.
  void timer
  await new Promise(() => {})
}

const readRange = (file: string, from: number, to: number): Promise<string> =>
  new Promise((done) => {
    let out = ''
    createReadStream(file, { start: from, end: Math.max(from, to - 1), encoding: 'utf8' })
      .on('data', (c) => (out += c))
      .on('close', () => done(out))
      .on('error', () => done(''))
  })

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

