import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadLocalConfig, localConfigPath } from '@ogun/core'
import { bold, cyan, dim, green, red, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'

const run = promisify(execFile)

type Check = { name: string; ok: boolean; detail: string; fatal: boolean }

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
