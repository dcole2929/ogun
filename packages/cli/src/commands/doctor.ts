import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { imageState, loadLocalConfig, localConfigPath } from '@ogun/core'
import { caState, credentialStatuses, readCredentials } from '@ogun/gateway'
import { bold, cyan, dim, green, red, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'


const run = promisify(execFile)

type Check = { name: string; ok: boolean; detail: string; fatal: boolean }

/**
 * Who else on this box can read the tokens.
 *
 * Writing config.json now always creates it fresh at 0600, but that only reaches a file
 * something writes again. One left at 0644 by an older version, a backup, or a copy off
 * another machine keeps its mode and its admin token indefinitely, and nothing anywhere
 * says so — tightening on write is invisible to a file that is only ever read.
 *
 * A warning, not fatal: the runner can still claim jobs, and refusing to work over a
 * permission bit would be a worse outcome than saying it out loud every time.
 * Returns nothing when there is no config at all, which is an ordinary state for a
 * machine that has never been set up.
 */
export async function configPermissions(path = localConfigPath()): Promise<Check | undefined> {
  const mode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => null,
  )
  if (mode === null) return undefined
  const shared = (mode & 0o077) !== 0
  return {
    name: 'config permissions',
    ok: !shared,
    detail: shared
      ? `${path} is 0${mode.toString(8)} — it holds this machine's tokens. \`chmod 600 ${path}\``
      : `${path} is 0${mode.toString(8)}`,
    fatal: false,
  }
}

/**
 * Whether the sandbox image still matches the source it was built from.
 *
 * §7 says the bundled CLI "cannot drift from the validator on the way in". It drifted for
 * a week here, and hid two things while it did: a fix to `ogun findings schema` that
 * never reached a reviewer, and a bundle that would not load at all. Both were invisible
 * because nothing rebuilds the image when the CLI changes and nothing compares them.
 *
 * A warning rather than a rebuild — §4.6 builds images at project-add time, not at 2am,
 * because a nightly that has to build first is a nightly that fails on a bad network.
 */
export async function sandboxImage(): Promise<Check> {
  const state = await imageState()
  const rebuild = 'run `ogun image build`'
  switch (state.state) {
    case 'current':
      return { name: 'sandbox image', ok: true, detail: 'ogun/base matches the current source', fatal: false }
    case 'stale':
      return {
        name: 'sandbox image',
        ok: false,
        detail: `ogun/base was built from different source (built ${state.built.slice(0, 10)}) — ${rebuild}`,
        fatal: false,
      }
    case 'unstamped':
      return {
        name: 'sandbox image',
        ok: false,
        // Not "stale": it may be identical. It cannot be compared, which is its own fact.
        detail: `ogun/base predates stamping, so it cannot be compared — ${rebuild}`,
        fatal: false,
      }
    default:
      return { name: 'sandbox image', ok: false, detail: `ogun/base is not built — ${rebuild}`, fatal: true }
  }
}

/**
 * Whether the egress gateway's CA exists, and who else on this box can sign with it.
 *
 * The mode is the check that matters. Anything holding `ca.key` can mint a certificate
 * for any host that every Ogun container is configured to trust, which turns the thing
 * that protects the credentials into the way to take them. `configPermissions` above
 * exists for the same reason and this file is strictly worse to leak.
 *
 * A missing CA is a warning rather than a failure: it is generated on first use, and a
 * machine that has never started a runner has never needed one.
 */
export function gatewayCa(): Check {
  const state = caState()
  if (state.state === 'missing') {
    return {
      name: 'gateway CA',
      ok: true,
      detail: `${state.directory} — generated on the runner's first start`,
      fatal: false,
    }
  }
  const shared = (state.keyMode & 0o077) !== 0
  return {
    name: 'gateway CA',
    ok: !shared,
    detail: shared
      ? `${state.keyPath} is 0${state.keyMode.toString(8)} — anything reading it can ` +
        `impersonate every host a sandbox trusts. \`chmod 600 ${state.keyPath}\``
      : `${state.keyPath} is 0${state.keyMode.toString(8)}`,
    fatal: false,
  }
}

/**
 * Which credentials the gateway could actually splice in, and how long they last.
 *
 * This is the preflight the gateway design needs and mounting did not. When credentials
 * were bind-mounted, an expired token was the CLI's problem and the CLI said so in its own
 * words. Behind a gateway the container holds a placeholder that never expires, so an
 * expired *host* token surfaces only as a 401 inside an agent transcript — and the gateway
 * does not refresh, it re-reads the file the host's own `claude` refreshes. Saying
 * "expired 6h ago" here is the difference between a two-minute fix and an evening.
 *
 * Warnings, never fatal. A machine with no OpenAI credential simply cannot run codex
 * workers, which is a normal way to be configured rather than a broken one.
 */
export function gatewayCredentials(): Check[] {
  return credentialStatuses(readCredentials()).map((status) => ({
    name: `gateway ${status.provider}`,
    ok: status.present,
    detail: status.detail,
    fatal: false,
  }))
}

/**
 * `ogun runner doctor` — which runtimes and tools are present on *this* machine.
 * The repo registry and the toolchain are per-runner, so this is the only honest place
 * to answer "can this box actually run a job" (§4.5).
 */
export async function doctor(serverUrl: string): Promise<void> {
  const checks: Check[] = []

  checks.push(await binary('git', ['--version'], true))
  checks.push(await binary('docker', ['--version'], false))
  checks.push(await binary(process.env.OGUN_CLAUDE_BIN ?? 'claude', ['--version'], false))
  checks.push(await binary('codex', ['--version'], false))
  checks.push(await publishing())

  const home = homedir()
  checks.push({
    name: 'claude credentials',
    ok: existsSync(join(home, '.claude')),
    detail: join(home, '.claude'),
    fatal: false,
  })
  checks.push({
    name: 'codex credentials',
    ok: existsSync(join(home, '.codex')),
    detail: join(home, '.codex'),
    fatal: false,
  })

  const reachable = await fetch(`${serverUrl}/api/health`, { headers: await authHeaders() }).then(
    (r) => r.ok,
    () => false,
  )
  checks.push({
    name: 'control plane',
    ok: reachable,
    detail: serverUrl,
    fatal: true,
  })

  let config
  try {
    const local = await loadLocalConfig()
    config = local
    checks.push({
      name: 'joined',
      ok: Boolean(local.runner),
      detail: local.runner
        ? `${local.runner.name} -> ${local.runner.serverUrl}`
        : 'not set up as a runner — `ogun runner init`, or `ogun runner join <url>`',
      fatal: true,
    })
  } catch (err) {
    checks.push({
      name: 'local config',
      ok: false,
      detail: (err as Error).message,
      fatal: true,
    })
  }

  // Independent of whether it parsed: a config too broken to load is still a file with a
  // token in it and a mode.
  const permissions = await configPermissions()
  if (permissions) checks.push(permissions)
  checks.push(await sandboxImage())

  // The gateway is what a sandbox authenticates through, so "can this box run a job" now
  // includes "can the gateway sign for it, and does it have anything to inject".
  checks.push(gatewayCa())
  checks.push(...gatewayCredentials())

  const dockerOk = checks.find((c) => c.name === 'docker')?.ok === true
  if (dockerOk) {
    const { code } = await tryRun('docker', ['image', 'inspect', 'ogun/base:latest'])
    checks.push({
      name: 'ogun/base image',
      ok: code === 0,
      detail: code === 0 ? 'present' : 'missing — run `ogun image build`',
      fatal: false,
    })
  }

  console.log(bold('\nogun runner doctor\n'))
  for (const c of checks) {
    const mark = c.ok ? green('ok  ') : c.fatal ? red('FAIL') : yellow('warn')
    console.log(`  ${mark}  ${c.name.padEnd(20)} ${dim(c.detail)}`)
  }

  if (config) {
    console.log(bold('\nlocal checkouts'))
    const entries = Object.entries(config.projects)
    if (entries.length === 0) {
      console.log(dim('  none — projects are cloned from their remote instead'))
      console.log(dim('  `ogun project add .` inside a repo to use a local copy'))
    }
    for (const [slug, path] of entries) {
      const present = existsSync(join(path, '.git'))
      console.log(
        `  ${present ? green('ok  ') : red('FAIL')}  ${cyan(slug.padEnd(20))} ${dim(path)}`,
      )
    }
    const labels = new Set(config.runner?.labels ?? [])
    const derived = derivedLabels(checks)
    const missing = [...derived].filter((l) => !labels.has(l))
    if (missing.length > 0) {
      console.log(
        yellow(
          `\n  this machine could advertise: ${missing.join(', ')} — they are detected at` +
            `\n  join time, so re-run \`ogun runner init\` to pick them up`,
        ),
      )
    }
  }

  const fatal = checks.filter((c) => !c.ok && c.fatal)
  console.log('')
  if (fatal.length > 0) {
    console.log(red(`${fatal.length} blocking problem(s). This runner cannot claim jobs.`))
    process.exit(1)
  }
  console.log(green('this runner can claim jobs'))
}

const derivedLabels = (checks: Check[]): Set<string> => {
  const out = new Set<string>()
  for (const [name, label] of [
    ['docker', 'docker'],
    ['claude', 'claude'],
    ['codex', 'codex'],
  ] as const) {
    if (checks.find((c) => c.name === name)?.ok) out.add(label)
  }
  return out
}

/**
 * Whether this machine could open a pull request, which is a separate question from
 * whether it can run a job.
 *
 * Not fatal on purpose: a runner that only ever runs reviewers has no use for `gh`, and
 * making it fatal would stop such a machine claiming anything. But the alternative to
 * saying it here is finding out at the end of a modifier run — the container has exited,
 * the suite has passed, the patch is extracted and proved, and the last step of the whole
 * pipeline fails on a missing binary (ADR-0009). That is the most expensive possible
 * moment to learn it.
 *
 * Presence is checked separately from authorization because they are different problems
 * with different fixes, and `gh --version` succeeds happily for a `gh` that has never been
 * logged in.
 */
async function publishing(): Promise<Check> {
  const present = await tryRun('gh', ['--version'])
  if (present.code !== 0) {
    return {
      name: 'gh',
      ok: false,
      detail: 'not found on PATH — a modifier could produce a patch but not publish it',
      fatal: false,
    }
  }
  const auth = await tryRun('gh', ['auth', 'status'])
  return {
    name: 'gh',
    ok: auth.code === 0,
    detail:
      auth.code === 0
        ? present.out.split('\n')[0]!.trim()
        : 'installed but not logged in — `gh auth login`',
    fatal: false,
  }
}

async function binary(name: string, args: string[], fatal: boolean): Promise<Check> {
  const { code, out } = await tryRun(name, args)
  return {
    name,
    ok: code === 0,
    detail: code === 0 ? out.split('\n')[0]!.trim() : 'not found on PATH',
    fatal,
  }
}

async function tryRun(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 15_000 })
    return { code: 0, out: stdout }
  } catch {
    return { code: 1, out: '' }
  }
}
