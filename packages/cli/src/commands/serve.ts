import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ago, bold, cyan, dim, fail, green, yellow } from '../output.ts'
import { parse } from '../args.ts'
import {
  AlreadyRunning,
  StartFailed,
  daemonPaths,
  followLog,
  nodeArgsFor,
  repoRoot,
  running,
  startDetached,
  stopDaemon,
  tail,
  type DaemonName,
} from '../daemon.ts'

/**
 * `ogun server` and `ogun runner start` — foreground by default, detached with `-d`.
 *
 * These were `pnpm server` and `pnpm runner`, which is a package-manager script standing
 * in for a product command — fine while there was one machine and one developer, wrong
 * as soon as a second machine has to run something. A runner operator should not need to
 * know Ogun is a pnpm workspace, and on a machine that only runs jobs there may be no
 * reason for pnpm to be installed at all.
 *
 * ### Why foreground stays the default
 *
 * Because a supervisor wants it that way. systemd's `Type=simple`, supervisord's
 * `nodaemon`, and a container's entrypoint all want a process that runs in the
 * foreground and dies when told; a program that backgrounds itself has to be talked out
 * of it (nginx's `daemon off;`, and the reason `dockerd` dropped its own `-d` years ago).
 * `-d` is a convenience for the workstation case — the one where there is no supervisor
 * and installing one to run two processes is out of proportion — and it is additive, so
 * `docs/architecture.md` §8 stays true rather than half-true.
 */

const SERVER = resolve(repoRoot, 'packages/server/src/main.ts')
const RUNNER = resolve(repoRoot, 'packages/runner/src/main.ts')

export async function serverStart(args: string[]): Promise<void> {
  await start('server', SERVER, args)
}

export async function runnerStart(args: string[]): Promise<void> {
  await start('runner', RUNNER, args)
}

/**
 * `-d` is consumed here and never forwarded.
 *
 * It has to be. The runner parses its own argv with no options declared and exits
 * non-zero on anything it does not recognise (`packages/runner/src/main.ts`), which is
 * deliberate — a flag someone reasonably expects to work should be refused rather than
 * silently dropped. Detaching is a property of *how this launcher runs the process*
 * rather than of the process, so this is the right place for it to stop. Everything else
 * is passed straight through, which is what keeps `--port` working on the server.
 */
export const stripDetach = (
  args: string[],
): { detach: boolean; forwarded: string[] } => ({
  detach: args.some((a) => a === '-d' || a === '--detach'),
  forwarded: args.filter((a) => a !== '-d' && a !== '--detach'),
})

async function start(name: DaemonName, entry: string, args: string[]): Promise<void> {
  const { detach, forwarded } = stripDetach(args)

  if (!detach) {
    const already = await running(name)
    // Otherwise this is an EADDRINUSE from deep inside hono, or — worse, for the runner,
    // which binds nothing — two processes claiming jobs under one runner identity.
    if (already) {
      fail(
        `ogun ${name} is already running in the background (pid ${already.pid}).\n` +
          `  ogun ${name} logs -f   follow it\n` +
          `  ogun ${name} stop      stop it first`,
      )
    }
    return foreground(entry, forwarded, `ogun-${name}`)
  }

  try {
    const { pid, logFile, ready } = await startDetached({
      name,
      entry,
      args: forwarded,
      ready: name === 'server' ? await serverProbe(forwarded) : undefined,
    })
    console.log(green(`ogun ${name} started in the background`) + dim(` (pid ${pid})`))
    console.log(dim(`  ${logFile}`))
    if (!ready) {
      // Alive but not answering. Not a failure — a slow first migration looks exactly
      // like this — so it is reported rather than rolled back.
      console.log(
        yellow('  it has not answered a health check yet — still starting, or stuck'),
      )
    }
    // Padded before colouring: ANSI codes have length, so aligning on the coloured
    // string puts the descriptions in three different columns.
    const hints: Array<[string, string]> = [
      [`ogun ${name} status`, 'is it up'],
      [`ogun ${name} logs -f`, 'what it is doing'],
      [`ogun ${name} stop`, 'stop it'],
    ]
    const width = Math.max(...hints.map(([command]) => command.length))
    console.log('')
    for (const [command, description] of hints) {
      console.log(`  ${cyan(command.padEnd(width))}   ${dim(description)}`)
    }
  } catch (err) {
    if (err instanceof AlreadyRunning) fail(err.message)
    if (err instanceof StartFailed) {
      fail(
        `${err.message}\n` +
          (err.logTail === ''
            ? `  Nothing was written to ${err.logFile}.`
            : `  Last lines of ${err.logFile}:\n\n${indent(err.logTail)}`),
      )
    }
    throw err
  }
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')

/** The foreground path, unchanged in behaviour from before `-d` existed. */
function foreground(entry: string, args: string[], label: string): void {
  const child = spawn(process.execPath, nodeArgsFor(entry, args), {
    stdio: 'inherit',
    cwd: repoRoot,
  })
  child.on('error', (err) => fail(`could not start ${label}: ${err.message}`))
  // Forward signals so Ctrl-C and systemd's SIGTERM reach the real process rather than
  // orphaning it behind this launcher.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

/**
 * Readiness for the control plane: `/api/health`, which is exempt from auth precisely so
 * that something outside the process can ask whether it is up (`packages/server/src/auth.ts`).
 *
 * "The process is alive" is a weaker claim than it looks. A control plane that has bound
 * its port but cannot reach postgres is alive and useless, and that is the single most
 * likely thing to be wrong on the morning somebody runs this — the database is a
 * container, and containers do not always come back.
 */
async function serverProbe(args: string[]): Promise<() => Promise<boolean>> {
  const port = await resolvePort(args)
  const url = `http://127.0.0.1:${port}/api/health`
  return () =>
    fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      (r) => r.ok,
      () => false,
    )
}

/**
 * The port the server is about to bind, by the same precedence the server itself uses:
 * `--port`, then the environment, then `.env`, then 7777.
 *
 * `.env` is read here rather than inherited because this process never loaded it — the
 * launcher passes `--env-file-if-exists` to the *child*, so `OGUN_PORT=7777` in `.env` is
 * invisible to the parent. Probing 7777 while the server is on 8080 would report a
 * healthy start as a stuck one every time.
 */
async function resolvePort(args: string[]): Promise<string> {
  const flagIndex = args.findIndex((a) => a === '--port')
  const { flags } = parse(
    flagIndex === -1 ? [] : args.slice(flagIndex, flagIndex + 2),
    { '--port': 'string' },
    'ogun server start [-d] [--port <n>]',
  )
  if (flags.port) return flags.port
  if (process.env.OGUN_PORT) return process.env.OGUN_PORT
  const env = await readFile(resolve(repoRoot, '.env'), 'utf8').catch(() => '')
  return /^\s*OGUN_PORT\s*=\s*(\d+)/m.exec(env)?.[1] ?? '7777'
}

/** `ogun server stop` / `ogun runner stop`. */
export async function daemonStop(name: DaemonName, args: string[]): Promise<void> {
  const { flags } = parse(
    args,
    { '--force': 'boolean', '--timeout': 'string' },
    `ogun ${name} stop [--force] [--timeout <seconds>]`,
  )
  const timeoutMs = Number(flags.timeout ?? 30) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) fail('--timeout takes a number of seconds')

  const outcome = await stopDaemon(name, { force: flags.force === true, timeoutMs })
  if (outcome === 'not-running') {
    console.log(dim(`ogun ${name} is not running in the background`))
    return
  }
  if (outcome === 'stopped') {
    console.log(green(`ogun ${name} stopped`))
    return
  }
  // Draining. For the runner this is the designed behaviour rather than a hang: SIGTERM
  // means stop claiming and let in-flight jobs finish, and a job is an agent in a
  // container that can legitimately take many minutes.
  console.log(
    yellow(`ogun ${name} is still shutting down after ${timeoutMs / 1000}s.`) +
      (name === 'runner'
        ? '\n  It stops claiming on SIGTERM and lets in-flight jobs finish, so this is' +
          '\n  expected while a job is running.'
        : ''),
  )
  console.log(dim(`  ogun ${name} status         check again`))
  console.log(dim(`  ogun ${name} stop --force   kill it now, mid-job`))
}

/** `ogun server status` / `ogun runner status`. */
export async function daemonStatus(name: DaemonName): Promise<void> {
  const record = await running(name)
  const paths = await daemonPaths(name)

  if (!record) {
    console.log(`${bold(`ogun ${name}`)}  ${dim('not running in the background')}`)
    const last = await tail(paths.logFile, 3)
    if (last !== '') {
      console.log(dim(`\n  last lines of ${paths.logFile}:\n`))
      console.log(indent(last))
    }
    console.log(`\n  ${cyan(`ogun ${name} start -d`)}   ${dim('start it')}`)
    // Non-zero so this works as a check in a script, the way `runner doctor` does.
    process.exitCode = 1
    return
  }

  console.log(
    `${bold(`ogun ${name}`)}  ${green('running')}` +
      dim(`  pid ${record.pid}${record.startedAt ? `, up since ${ago(record.startedAt)}` : ''}`),
  )
  console.log(dim(`  ${paths.logFile}`))
  if (record.command) console.log(dim(`  ${record.command}`))
}

/** `ogun server logs [-f] [-n <lines>]`. */
export async function daemonLogs(name: DaemonName, args: string[]): Promise<void> {
  const { flags } = parse(
    args,
    { '-f': 'boolean', '--follow': 'boolean', '-n': 'string', '--lines': 'string' },
    `ogun ${name} logs [-f] [-n <lines>]`,
  )
  const lines = Number(flags.n ?? flags.lines ?? 50)
  if (!Number.isInteger(lines) || lines < 0) fail('-n takes a whole number of lines')

  const { logFile } = await daemonPaths(name)
  const follow = flags.f === true || flags.follow === true

  if (follow) return followLog(logFile, lines)

  const text = await tail(logFile, lines)
  if (text === '') {
    console.log(dim(`nothing in ${logFile} yet`))
    // A foreground run writes to the terminal, so an empty log is the expected state
    // rather than a fault — say which mode this file belongs to.
    if (await running(name)) {
      console.log(dim('  (it is running — a foreground run logs to its terminal, not here)'))
    }
    return
  }
  console.log(text)
}
