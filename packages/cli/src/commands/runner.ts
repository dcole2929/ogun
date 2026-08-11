import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expandHome } from '@ogun/core'
import { bold, dim, fail, green } from '../output.ts'

const run = promisify(execFile)

/**
 * `ogun runner init` — write ~/.ogun/runner.json. Machine-local and never synced: the
 * repo registry is per-runner precisely because /home/doug/dev/x on WSL2 and
 * /Users/doug/dev/x on macOS are the same project at different paths (§4.5).
 */
export async function runnerInit(args: string[]): Promise<void> {
  const path = expandHome(process.env.OGUN_RUNNER_CONFIG ?? '~/.ogun/runner.json')
  if (existsSync(path) && !args.includes('--force')) {
    fail(`${path} already exists. Edit it, or pass --force to overwrite.`)
  }

  const labels = await detectLabels()
  const config = {
    runnerId: args[0] ?? hostname(),
    labels,
    projects: {} as Record<string, string>,
    scratch: '~/.ogun/work',
    // WSL2 caps at ~50% of Windows RAM and a container running an agent plus a test
    // suite is not small. Raise memory= in .wslconfig before raising this (§8).
    maxConcurrentJobs: 2,
    serverUrl: process.env.OGUN_SERVER_URL ?? 'http://localhost:7777',
    pollIntervalMs: 3000,
  }

  await mkdir(dirname(path), { recursive: true })
  await mkdir(resolve(expandHome('~/.ogun/work')), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

  console.log(green(`wrote ${path}`))
  console.log(dim(`  runnerId: ${config.runnerId}`))
  console.log(dim(`  labels:   ${labels.join(', ') || '(none detected)'}`))
  console.log(`\nAdd your repositories under ${bold('projects')}, keyed by project slug:`)
  console.log(dim(`  "projects": { "ogun": "${process.cwd()}" }`))
}

async function detectLabels(): Promise<string[]> {
  const labels: string[] = []
  for (const [bin, label] of [
    [process.env.OGUN_CLAUDE_BIN ?? 'claude', 'claude'],
    ['codex', 'codex'],
    ['docker', 'docker'],
  ] as const) {
    const ok = await run(bin, ['--version'], { timeout: 15_000 }).then(
      () => true,
      () => false,
    )
    if (ok) labels.push(label)
  }
  return labels
}
