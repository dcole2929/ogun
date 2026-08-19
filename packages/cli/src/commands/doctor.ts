import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { imageState, loadLocalConfig, localConfigPath } from '@ogun/core'
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
