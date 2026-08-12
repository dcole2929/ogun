import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { dim, fail } from '../output.ts'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

/**
 * `ogun server` and `ogun runner start`.
 *
 * These were `pnpm server` and `pnpm runner`, which is a package-manager script standing
 * in for a product command — fine while there was one machine and one developer, wrong
 * as soon as a second machine has to run something. A runner operator should not need to
 * know Ogun is a pnpm workspace, and on a machine that only runs jobs there may be no
 * reason for pnpm to be installed at all.
 */
export function serverStart(args: string[]): never | void {
  run(resolve(repoRoot, 'packages/server/src/main.ts'), args, 'ogun-server')
}

export function runnerStart(args: string[]): never | void {
  run(resolve(repoRoot, 'packages/runner/src/main.ts'), args, 'ogun-runner')
}

function run(entry: string, args: string[], label: string): void {
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists', resolve(repoRoot, '.env'), entry, ...args],
    { stdio: 'inherit', cwd: repoRoot },
  )
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

export const serveHelp = dim(
  'The control plane binds to localhost unless OGUN_BIND says otherwise, and refuses a\n' +
    'wider bind without OGUN_TOKEN — see `ogun token new`.',
)
