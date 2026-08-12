import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expandHome, loadLocalConfig, localConfigPath, updateLocalConfig } from '@ogun/core'
import { bold, cyan, dim, fail, green } from '../output.ts'
import { authHeaders } from '../auth.ts'

const run = promisify(execFile)

/**
 * `ogun runner init` — set this machine up as a runner for a control plane on this same
 * machine. The one-box case, and the common one.
 *
 * `ogun runner join` is the other machine's version of this: same result, but it has to
 * present a token because it is talking to a control plane across a network.
 */
export async function runnerInit(args: string[]): Promise<void> {
  const name = (argValue(args, '--name') ?? hostname()).toLowerCase().replace(/\..*$/, '')
  const serverUrl = argValue(args, '--url') ?? process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'
  // Detected, plus anything the operator adds for a capability Ogun cannot see.
  const labels = [...new Set([...(await detectLabels()), ...extraLabels(args)])]

  const existing = await loadLocalConfig()
  if (existing.runner && !args.includes('--force')) {
    fail(
      `this machine is already set up as "${existing.runner.name}" pointing at ` +
        `${existing.runner.serverUrl} — pass --force to replace that`,
    )
  }

  // Registers through the same endpoint `join` uses, which is the only place name
  // uniqueness is enforced. Skipping it would let two machines answer to one name and
  // silently share a claim identity and a run history.
  const res = await fetch(`${serverUrl}/api/runners/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ name, labels, maxConcurrency: 2 }),
  }).catch(() => null)

  if (!res) {
    fail(
      `cannot reach ${serverUrl}. Start it with \`ogun server\`, or pass --url if the` +
        ' control plane is elsewhere.',
    )
  }
  if (!res.ok) {
    fail(((await res.json()) as { error?: string }).error ?? 'the control plane refused this name')
  }

  await updateLocalConfig((c) => ({
    ...c,
    runner: {
      name,
      labels,
      serverUrl,
      // No token: a control plane on localhost needs none, and one across a network is
      // reached with `ogun runner join` instead, which carries an invite.
      token: undefined,
      maxConcurrentJobs: c.runner?.maxConcurrentJobs ?? 2,
      pollIntervalMs: c.runner?.pollIntervalMs ?? 3000,
      scratch: c.runner?.scratch ?? '~/.ogun/work',
    },
  }))
  await mkdir(resolve(expandHome('~/.ogun/work')), { recursive: true })

  console.log(green(`this machine is runner "${name}" for ${serverUrl}`))
  console.log(dim(`  ${localConfigPath()}`))

  const missing = ['claude', 'codex', 'docker'].filter((l) => !labels.includes(l))
  if (missing.length > 0) {
    console.log(
      `\n  ${bold('not found:')} ${missing.join(', ')}` +
        '\n  Jobs needing those will never be claimed here — see `ogun runner doctor`.',
    )
  }
  console.log(`\n  ${cyan('ogun runner start')}   to start it`)
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
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
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

  const warning = await fetch(`${serverUrl}/api/runners`, { headers: await authHeaders() })
    .then((r) => r.json() as Promise<{ reachabilityWarning: string | null }>)
    .then((d) => d.reachabilityWarning)
    .catch(() => null)

  if (warning) console.log(`${dim(warning)}\n`)
  console.log(bold('Run this on the machine you want to add:\n'))
  console.log(`  ${cyan(body.command)}\n`)
  console.log(
    dim(`  It names itself from its hostname. Add ${bold('--name <label>')} to choose.\n`),
  )
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

  const labels = [...new Set([...(await detectLabels()), ...extraLabels(args)])]
  const res = await fetch(`${url}/api/runners/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, labels, maxConcurrency: 2 }),
  }).catch(() => null)
  if (!res?.ok) {
    fail(res ? ((await res.json()) as { error?: string }).error ?? 'join refused' : 'join failed')
  }

  // Merged, not overwritten: joining must not discard repository paths already
  // registered on this machine.
  await updateLocalConfig((c) => ({
    ...c,
    runner: {
      name,
      labels,
      serverUrl: url,
      token,
      maxConcurrentJobs: c.runner?.maxConcurrentJobs ?? 2,
      pollIntervalMs: c.runner?.pollIntervalMs ?? 3000,
      scratch: c.runner?.scratch ?? '~/.ogun/work',
    },
  }))
  await mkdir(resolve(expandHome('~/.ogun/work')), { recursive: true })

  console.log(green(`joined ${url} as ${bold(name)}`))
  console.log(dim(`  ${localConfigPath()}`))

  const missing = ['claude', 'codex', 'docker'].filter((l) => !labels.includes(l))
  if (missing.length > 0) {
    console.log(
      `\n  ${bold('not found on this machine:')} ${missing.join(', ')}` +
        '\n  Jobs needing those will never be claimed here — see `ogun runner doctor`.',
    )
  }

  console.log(`\n  ${cyan('ogun runner start')}   to start it`)
  console.log(
    dim(
      [
        '',
        'Repositories are cloned from their remote as needed. To use a local checkout',
        'instead — faster, and works offline — run `ogun project add` inside it.',
      ].join('\n'),
    ),
  )
}

/**
 * Capabilities Ogun cannot detect by looking for a binary — "gpu", "vpn", "staging-db".
 * A worker asks for one with `requires:` and the job then only goes to a machine that
 * advertises it.
 */
const extraLabels = (args: string[]): string[] =>
  (argValue(args, '--labels') ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
