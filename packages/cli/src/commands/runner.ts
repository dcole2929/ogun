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
 * `ogun runner invite` — run this **on the control plane**. Mints a join token.
 *
 * Takes no machine name. The machine has not joined yet and it is the thing that knows
 * its own hostname; asking here would be guessing, and would leave a row for a machine
 * that may never appear.
 */
export async function runnerInvite(args: string[], serverUrl: string): Promise<void> {
  const note = argValue(args, '--note')
  const res = await fetch(`${serverUrl}/api/runners/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      ...(note ? { note } : {}),
      ...(argValue(args, '--url') ? { serverUrl: argValue(args, '--url') } : {}),
    }),
  }).catch(() => null)

  if (!res?.ok) {
    fail(
      res
        ? ((await res.json()) as { error?: string }).error ?? 'could not mint a join token'
        : `could not reach ${serverUrl}`,
    )
  }
  const body = (await res!.json()) as { token: string; command: string }

  const warning = await fetch(`${serverUrl}/api/runners`, { headers: authHeaders() })
    .then((r) => r.json() as Promise<{ reachabilityWarning: string | null }>)
    .then((d) => d.reachabilityWarning)
    .catch(() => null)

  if (warning) console.log(`${dim(warning)}\n`)
  console.log(bold('Run this on the machine you want to add:\n'))
  console.log(`  ${cyan(body.command)}\n`)
  console.log(
    dim(
      [
        'Single use, and shown once — only its hash is stored, so a lost token is',
        're-issued rather than recovered. That machine picks its own name; pass',
        '--name to override its hostname. Once joined, this becomes its permanent',
        'credential: it can claim work and report on it, and nothing else.',
      ].join('\n'),
    ),
  )
}

/**
 * `ogun runner join <url> --token <t>` — run this **on the machine being added**, with
 * the command `ogun runner invite` printed.
 *
 * The name defaults to this machine's hostname, because this is the machine.
 */
export async function runnerJoin(args: string[]): Promise<void> {
  const url = args.find((a) => a.startsWith('http'))?.replace(/\/$/, '')
  const token = argValue(args, '--token')
  const name = (argValue(args, '--name') ?? hostname()).toLowerCase().replace(/\..*$/, '')
  if (!url || !token) {
    fail('usage: ogun runner join <control-plane-url> --token <token> [--name <name>]')
  }

  const reachable = await fetch(`${url}/api/health`).then(
    (r) => r.ok,
    () => false,
  )
  // Checked here rather than at the first claim: a wrong address is the most likely
  // mistake in this whole flow, and it is otherwise silent.
  if (!reachable) {
    fail(
      `cannot reach ${url} from this machine.\n` +
        '  The control plane must be bound beyond localhost, and reachable from here —\n' +
        '  on WSL2 that needs mirrored networking, a mesh VPN, or a port proxy.',
    )
  }

  const labels = await detectLabels()
  const res = await fetch(`${url}/api/runners/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: name, labels, maxConcurrency: 2 }),
  }).catch(() => null)
  if (!res?.ok) {
    fail(res ? ((await res.json()) as { error?: string }).error ?? 'join refused' : 'join failed')
  }

  const path = expandHome(process.env.OGUN_RUNNER_CONFIG ?? '~/.ogun/runner.json')
  // Preserved rather than overwritten: joining must not discard repository paths already
  // registered on this machine.
  const existing: Record<string, unknown> = await readFile(path, 'utf8')
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}))

  const config = {
    ...existing,
    runnerId: name,
    labels,
    projects: (existing.projects as Record<string, string>) ?? {},
    scratch: (existing.scratch as string) ?? '~/.ogun/work',
    maxConcurrentJobs: (existing.maxConcurrentJobs as number) ?? 2,
    serverUrl: url,
    pollIntervalMs: (existing.pollIntervalMs as number) ?? 3000,
    // Persisted so starting the runner needs nothing else. The file is 0600.
    token,
  }
  await mkdir(dirname(path), { recursive: true })
  await mkdir(resolve(expandHome('~/.ogun/work')), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

  console.log(green(`joined ${url} as ${bold(name)}`))
  console.log(dim(`  ${path}  —  url, labels, and token (mode 0600)`))
  console.log(dim(`  labels: ${labels.join(', ') || '(none detected — see `ogun runner doctor`)'}`))
  console.log(`\nStart it:\n`)
  console.log(`  ${cyan('ogun runner start')}`)
  console.log(
    dim(
      [
        '',
        'Repositories are cloned from their remote automatically. If a repo is already',
        'checked out here, add its path under "projects" in that file and the runner',
        'will use the local copy instead — faster, and works offline.',
      ].join('\n'),
    ),
  )
}

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
