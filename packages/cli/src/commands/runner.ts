import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { expandHome } from '@ogun/core'
import { bold, cyan, dim, fail, green } from '../output.ts'
import { authHeaders } from '../auth.ts'

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


/**
 * `ogun runner add <name>` — enroll a machine from the CLI, the same operation the
 * Runners page performs. Prints the command to run *on that machine*.
 *
 * Note the direction: this mints a credential here and you carry it there. The control
 * plane never dials a runner, which is what lets a laptop be one.
 */
export async function runnerAdd(args: string[], serverUrl: string): Promise<void> {
  const name = args.find((a) => !a.startsWith('--'))
  if (!name) fail('usage: ogun runner add <name> [--labels claude,codex,docker] [--url <server>]')

  const labels = (argValue(args, '--labels') ?? '').split(',').filter(Boolean)
  const res = await fetch(`${serverUrl}/api/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      id: name,
      labels,
      ...(argValue(args, '--url') ? { serverUrl: argValue(args, '--url') } : {}),
    }),
  }).catch(() => null)

  if (!res?.ok) {
    fail(res ? ((await res.json()) as { error?: string }).error ?? 'enrollment failed' : `could not reach ${serverUrl}`)
  }
  const body = (await res!.json()) as { token: string; command: string }

  console.log(green(`enrolled ${name}`))
  console.log(bold('\nRun this on that machine:\n'))
  console.log(`  ${body.command.split('\n').join('\n  ')}`)
  console.log(
    dim(
      [
        '',
        'The token is shown once — only its hash is stored here, so a lost one is',
        're-issued rather than recovered. It can claim work and report on it; it cannot',
        'define a worker.',
      ].join('\n'),
    ),
  )
}

/**
 * `ogun runner join <url> --token <t> --name <n>` — run on the *new* machine. Writes
 * runner.json so `pnpm runner` needs no further arguments.
 */
export async function runnerJoin(args: string[]): Promise<void> {
  const url = args.find((a) => a.startsWith('http'))
  const token = argValue(args, '--token')
  const name = argValue(args, '--name') ?? hostname()
  if (!url || !token) {
    fail('usage: ogun runner join <control-plane-url> --token <token> [--name <name>]')
  }

  const reachable = await fetch(`${url}/api/health`).then(
    (r) => r.ok,
    () => false,
  )
  // Fail here rather than at the first claim: a wrong address at enrollment time is the
  // single most likely mistake, and it is silent otherwise.
  if (!reachable) {
    fail(
      `cannot reach ${url}. Check the address is one this machine can see — the control ` +
        'plane must be bound to something other than localhost for that.',
    )
  }

  const path = expandHome(process.env.OGUN_RUNNER_CONFIG ?? '~/.ogun/runner.json')
  // Preserved rather than overwritten: joining a control plane must not discard the
  // repository paths already registered on this machine.
  const existing: Record<string, unknown> = await readFile(path, 'utf8')
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}))

  const labels = await detectLabels()
  const config = {
    ...existing,
    runnerId: name,
    labels,
    projects: (existing.projects as Record<string, string>) ?? {},
    scratch: (existing.scratch as string) ?? '~/.ogun/work',
    maxConcurrentJobs: (existing.maxConcurrentJobs as number) ?? 2,
    serverUrl: url,
    pollIntervalMs: (existing.pollIntervalMs as number) ?? 3000,
  }
  await mkdir(dirname(path), { recursive: true })
  await mkdir(resolve(expandHome('~/.ogun/work')), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

  const authorized = await fetch(`${url}/api/jobs/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ runnerId: name, labels, capacity: 1 }),
  }).then(
    (r) => r.status !== 401 && r.status !== 403,
    () => false,
  )
  if (!authorized) fail('the control plane rejected that token — re-issue it with `ogun runner add`')

  console.log(green(`joined ${url} as ${name}`))
  console.log(dim(`  wrote ${path}`))
  console.log(dim(`  labels: ${labels.join(', ') || '(none detected)'}`))
  console.log(`\nAdd this machine's repositories under ${bold('projects')}, then start it:\n`)
  console.log(`  ${cyan(`OGUN_TOKEN=${token} pnpm runner`)}`)
  console.log(dim('\n  Keep the token in your shell profile or a systemd unit; it is per-machine.'))
}

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
