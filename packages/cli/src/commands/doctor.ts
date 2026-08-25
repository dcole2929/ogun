import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  describeGrant,
  imageState,
  listOAuthApps,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
} from '@ogun/core'
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
 * Which project secrets this machine holds — by name, never by value.
 *
 * `doctor` answers "can this box actually run a job" and this is the polling half of it:
 * a control plane that is about to poll Linear every few minutes needs a key, and the key
 * lives in this machine's config.json rather than in the database (ADR-0012), so this is
 * the only place that can see it at all.
 *
 * **It reports what is stored, never what is missing**, and that limit is stated on the
 * line rather than left to be inferred. Which projects need a Linear key is a fact in each
 * repository's `.ogun/config.yaml`, and `doctor` reads no repositories — so a green line
 * here means "these exist", and the absence of a line means nothing at all. Printing
 * "linear: missing" for every project the control plane knows about would be the
 * absence-of-evidence mistake the credential preflight was careful about from the start
 * (principle 6).
 *
 * The one state worth degrading on is `empty`, which is only reachable by hand-editing the
 * file: a poller reads it as a key that exists and does not work, and the symptom is a
 * 401 that looks like a revoked key rather than a blank one.
 *
 * Never fatal. A runner-only machine holds none of these and is not broken; polling is
 * not something it does.
 */
export async function projectSecrets(path = localConfigPath()): Promise<Check> {
  const stored = await listProjectSecrets(path).catch((err: Error) => err)
  if (stored instanceof Error) {
    return { name: 'project secrets', ok: false, detail: stored.message, fatal: false }
  }
  if (stored.length === 0) {
    return {
      name: 'project secrets',
      ok: true,
      detail: 'none stored here — `ogun connect <integration>` in the project directory',
      fatal: false,
    }
  }
  const blank = stored.filter((s) => s.state === 'empty')
  // `slug/name` and a state. There is no branch of this function that could print a
  // value: `listProjectSecrets` does not return one.
  const summary = stored.map((s) => `${s.project}/${s.name}`).join(', ')
  return {
    name: 'project secrets',
    ok: blank.length === 0,
    detail:
      blank.length === 0
        ? `${summary} — set (this machine only; what a project *needs* is not checked here)`
        : `${blank.map((s) => `${s.project}/${s.name}`).join(', ')} present but empty — ` +
          'a poller reads that as a key that exists and does not work. Set it again',
    fatal: false,
  }
}

/**
 * Which projects are connected to Linear as an application, and how long each grant lasts
 * (ADR-0014).
 *
 * A separate check from `project secrets` above rather than a column on it, because the
 * two answer different questions and one of them is not a yes/no. A personal key is
 * present or it is not; a grant has an application, a workspace, a set of scopes and an
 * expiry, and the whole point of connecting is to be able to see *which workspace Ogun is
 * acting in* and *as whom*. Folding that into "linear: set" would give back exactly the
 * information the flow exists to make visible.
 *
 * **It reports what is stored, never what is missing** — the same limit `projectSecrets`
 * states, for the same reason. `doctor` reads no repositories, so it cannot know which
 * projects have a `sources:` block that needs one.
 *
 * The line that earns this function is the shadowed key. A project with both a grant and a
 * personal key authenticates with the grant (`readProjectSecret` decides, once), and an
 * operator debugging a poll failure by rotating the key would be changing something
 * nothing reads. Saying it here is the cheapest possible place to say it.
 *
 * Never fatal, and `warn` is reserved for the two states a person has to act on: an
 * application registered but never connected, and an entry this build cannot read. An
 * expired access token is *not* one of them — the next poll renews it, which is what
 * `describeGrant` says out loud.
 */
export async function linearGrants(path = localConfigPath(), now = Date.now()): Promise<Check[]> {
  const apps = await listOAuthApps(path).catch((err: Error) => err)
  if (apps instanceof Error) {
    return [{ name: 'linear oauth', ok: false, detail: apps.message, fatal: false }]
  }
  if (apps.length === 0) return []

  const keyed = new Set(
    (await listProjectSecrets(path).catch(() => [])).map((s) => `${s.project}/${s.name}`),
  )

  return apps.map((app) => {
    if (app.malformed !== undefined) {
      return {
        name: `${app.provider} ${app.project}`,
        ok: false,
        // Named as an entry problem rather than a credential problem: the fix is to
        // reconnect this one project, and nothing else on the machine is affected.
        detail: `the stored entry is not a shape this build can read (${app.malformed}) — reconnect`,
        fatal: false,
      }
    }
    const health = describeGrant(app.expiresAt, now)
    const where = app.workspace ? ` in ${app.workspace.name}` : ''
    const asWhom = app.actor === 'app' ? 'as the app' : app.actor === 'user' ? 'as you' : ''
    const shadowed = keyed.has(`${app.project}/${app.provider}`)
      ? ' — an api key is also stored for this project and is NOT being used'
      : ''
    // Which grant, because the two differ in what they can SEE: a client-credentials
    // token reaches the workspace's public teams and no others, which is the difference
    // between "connected" and "connected and finding nothing".
    const how =
      app.grantType === 'client_credentials'
        ? ', app token (public teams)'
        : app.grantType === 'authorization_code'
          ? ', by consent'
          : ''
    return {
      name: `${app.provider} ${app.project}`,
      ok: app.connected,
      detail: app.connected
        ? `${health.detail}${where}${asWhom ? `, ${asWhom}` : ''}${how}` +
          `${app.scopes.length > 0 ? `, scopes: ${app.scopes.join(' ')}` : ''}${shadowed}`
        : `application ${app.clientId} registered, never connected — ` +
          `\`ogun connect ${app.provider} --project ${app.project}\``,
      fatal: false,
    }
  })
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
        // Two causes, one fact, and the second one is the one nobody guesses: a machine
        // has a single `ogun/base`, so another checkout that ran `ogun image build` more
        // recently owns it. Either way a job started now runs an image that is not this
        // checkout, so either way the answer is the same rebuild.
        detail:
          `ogun/base was built from different source (built ${state.built.slice(0, 10)}) — ` +
          `edited since the last build, or another checkout on this machine built it — ${rebuild}`,
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
 * `present` is not the question. A token that is on disk and dead is *present*, and the
 * first version of this check reported it `ok` — the exact machine this preflight exists
 * for, an unattended runner whose token lapsed weeks ago, got a green line. So the check
 * degrades on the classification rather than on presence, and a token inside the next
 * hour is a warning too: `doctor` is run before the night, and a token with forty minutes
 * left will not survive the job it is being checked for.
 *
 * Warnings, never fatal. A machine with no OpenAI credential simply cannot run codex
 * workers, which is a normal way to be configured rather than a broken one — and an
 * expired Anthropic token does not stop this box running the codex ones, so exiting 1
 * with "this runner cannot claim jobs" would be false.
 */
export function gatewayCredentials(statuses = credentialStatuses(readCredentials())): Check[] {
  return statuses.map((status) => ({
    name: `gateway ${status.provider}`,
    ok: status.present && status.health.state !== 'expired' && status.health.state !== 'expiring',
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
  // Same file, different question: the mode above is who can read it, this is what is in
  // it for a project rather than for this machine.
  checks.push(await projectSecrets())
  // Same store, the other credential shape. Listed after the keys so the two read as one
  // answer to "what can this machine authenticate to Linear with" (ADR-0014).
  checks.push(...(await linearGrants()))
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
