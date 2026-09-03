/**
 * The process a detached `ogun server start -d` actually leaves behind.
 *
 * ### Why there is a process here at all
 *
 * The obvious detach is to spawn the server itself with its stdout pointed at an open
 * file descriptor and walk away. That works, and it is unrotatable: the kernel writes
 * through the fd the server holds, and the CLI that opened it has exited, so nothing is
 * left in the picture that could ever close that file and start a new one. The log grows
 * until the disk is full. This is the same reason Docker keeps `dockerd` in the path of
 * a container's output instead of handing the container a file, and the same reason
 * supervisord's `logfile_maxbytes` is a property of supervisord rather than of the
 * program it runs.
 *
 * So one small process stays: it owns the log file, pumps the real process's two streams
 * into it, and rolls it over at `logs.maxBytes`.
 *
 * ### What it deliberately does not do
 *
 * It does not restart anything. A crashed daemon stays dead, `ogun server status` says
 * so, and supervision remains the host's job — systemd, launchd, a Windows service —
 * exactly as `docs/architecture.md` §8 has always said. Detaching is a convenience for a
 * workstation, not a bid to become a process supervisor; keeping the foreground mode the
 * default is what leaves the supervisor path open rather than competing with it.
 */
import { spawn } from 'node:child_process'
import { open, mkdir, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { clearRecord, daemonPaths, nodeArgsFor, writeRecord, type DaemonName } from './daemon.ts'

const [marker, entry, ...args] = process.argv.slice(2)

if (!marker?.startsWith('ogun-') || !entry) {
  console.error('daemon-host: expected `ogun-<name> <entry> [args...]`')
  process.exit(1)
}

const name = marker.slice('ogun-'.length) as DaemonName
const paths = await daemonPaths(name)
await mkdir(paths.logDir, { recursive: true })

/**
 * A single-writer append log that rolls over at a size.
 *
 * Size is tracked in memory rather than stat'd per write — this sits in the path of every
 * line the server prints, and the whole point of the class is to be cheap enough that
 * nobody is tempted to remove it.
 */
class RollingLog {
  private handle: FileHandle | null = null
  private size = 0
  /** Writes are serialised through this so a rollover cannot interleave with a write. */
  private queue: Promise<void> = Promise.resolve()

  // Fields assigned in the body rather than declared as parameter properties: this
  // repo runs TypeScript through Node's type stripping, so `erasableSyntaxOnly` is on
  // and parameter properties are one of the two things it forbids.
  private readonly file: string
  private readonly maxBytes: number
  private readonly keep: number

  constructor(file: string, maxBytes: number, keep: number) {
    this.file = file
    this.maxBytes = maxBytes
    this.keep = keep
  }

  async open(): Promise<void> {
    this.handle = await open(this.file, 'a')
    this.size = await stat(this.file).then((s) => s.size, () => 0)
    // A log already over the limit when we arrive is rolled immediately rather than on
    // the next write, so that a restart is a reliable way to bound a file that grew
    // while an older build was running.
    if (this.size >= this.maxBytes) await this.rollover()
  }

  write(chunk: string | Buffer): void {
    this.queue = this.queue.then(() => this.append(chunk)).catch(() => {})
  }

  private async append(chunk: string | Buffer): Promise<void> {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.size + buf.byteLength > this.maxBytes) await this.rollover()
    await this.handle?.write(buf)
    this.size += buf.byteLength
  }

  /**
   * `server.log` → `server.log.1`, `.1` → `.2`, and so on, oldest discarded.
   *
   * Renamed rather than copied so that the rollover is atomic per file and cheap
   * regardless of size. `keep: 0` truncates instead, for a machine where the log is
   * worth bounding but not worth keeping.
   */
  private async rollover(): Promise<void> {
    await this.handle?.close()
    this.handle = null
    if (this.keep === 0) {
      await rm(this.file, { force: true })
    } else {
      await rm(`${this.file}.${this.keep}`, { force: true })
      for (let n = this.keep - 1; n >= 1; n--) {
        await rename(`${this.file}.${n}`, `${this.file}.${n + 1}`).catch(() => {})
      }
      await rename(this.file, `${this.file}.1`).catch(() => {})
    }
    this.handle = await open(this.file, 'a')
    this.size = 0
  }

  async close(): Promise<void> {
    await this.queue
    await this.handle?.close()
    this.handle = null
  }
}

const log = new RollingLog(paths.logFile, paths.maxBytes, paths.keep)
await log.open()

/** Host-level lines are stamped and marked, so they read apart from the child's output. */
const say = (message: string): void =>
  log.write(`\n[ogun ${new Date().toISOString()}] ${message}\n`)

say(`starting ${name}: ${entry} ${args.join(' ')}`.trimEnd())

/**
 * The pidfile is this process, not the child: this is what `stop` signals and what
 * `status` reports, because this is the process that lives exactly as long as the daemon
 * does and is responsible for tidying up after it.
 *
 * Written **before** the spawn, and the order is load-bearing. It used to be written
 * after, which is a race the child wins whenever it dies immediately — the `exit`
 * handler fires and calls `clearRecord` while this `await` is still resolving, so the
 * write lands *after* the delete and strands a pidfile naming a process that is already
 * gone. The next `ogun server start` then refused, pointing at a pid that no longer
 * existed, until somebody deleted the file by hand. Writing first means `exit` cannot
 * run until this has completed.
 */
await writeRecord(name, {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  command: `ogun ${name} start${args.length > 0 ? ` ${args.join(' ')}` : ''}`,
})

const child = spawn(process.execPath, nodeArgsFor(entry, args), {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: resolve(import.meta.dirname, '../../..'),
})

child.stdout?.on('data', (c: Buffer) => log.write(c))
child.stderr?.on('data', (c: Buffer) => log.write(c))

child.on('error', (err) => {
  say(`could not start: ${err.message}`)
})

/**
 * Forwarded rather than relied upon. Killing the process group would reach the child
 * too, but it would also reach anything the child has started — and for the runner that
 * is a docker CLI mid-job, which should be allowed to finish its own shutdown rather
 * than being cut down with its parent.
 */
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    say(`${signal} — asking ${name} to stop`)
    child.kill(signal)
  })
}

child.on('exit', async (code, signal) => {
  say(
    signal
      ? `${name} exited on ${signal}`
      : `${name} exited with code ${code ?? 0}`,
  )
  await log.close()
  await clearRecord(name)
  process.exit(code ?? 0)
})
