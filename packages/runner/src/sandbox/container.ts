import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnJsonl } from './exec.ts'
import { readContained } from './paths.ts'
import type { Sandbox, SandboxSpec } from './types.ts'

export type ContainerOptions = SandboxSpec & {
  name: string
  memory?: string
  cpus?: string
  /**
   * `open`  — the agent runtime can reach the internet. Required today: claude calls
   *           api.anthropic.com and codex calls OpenAI's endpoint, so an airgap is not
   *           an option (§4.6).
   * `none`  — no network at all. Valid for tool-only verification passes.
   *
   * A real host allowlist needs a filtering proxy, which conflicts with the
   * no-sibling-containers rule. Tracked as an open question rather than faked.
   */
  egress?: 'open' | 'none'
}

export const GUEST_WORKSPACE = '/workspace'

/**
 * The default sandbox: real capability isolation, per-project image.
 *
 * What is deliberately absent is the point. No /var/run/docker.sock — anything holding
 * it can start a privileged container mounting /, which makes the boundary decorative.
 * No gh, no git remote, no ssh key, no GitHub token: the never-pushes rule is
 * structural rather than policed, because there is nothing to push with (§4.6).
 */
export function createContainerSandbox(opts: ContainerOptions): Sandbox {
  const image = opts.image ?? 'ogun/base:latest'

  return {
    kind: 'container',
    provision: async () => {
      if (!(await imageExists(image))) {
        throw new Error(
          `image ${image} is not present — build it with \`ogun image build\` before running`,
        )
      }
    },
    exec: (argv, exec = {}) =>
      // `docker run` per exec rather than a long-lived container + `docker exec`: the
      // job is one agent invocation, and a fresh container makes cleanup automatic.
      spawnJsonl(
        'docker',
        [
          ...buildRunArgs(exec.raw ? verificationOptions(opts) : opts, image),
          ...(exec.raw ? argv : containerCommand(opts.runtime, argv)),
        ],
        { timeoutMs: exec.timeoutMs ?? opts.timeoutMs },
      ),
    // Read through the host bind-mount rather than `docker cp`: the container may
    // already be gone, and the path check has to happen host-side anyway (§5.3).
    readFile: (relPath) => readContained(opts.hostWorkspace, relPath),
    dispose: async () => {
      // --rm handles the normal path; this catches a container left behind by a kill —
      // including the verification one, which is exactly the container most likely to
      // have been killed, since the gate is what runs against a deadline.
      for (const name of [opts.name, verificationName(opts.name)]) {
        await spawnJsonl('docker', ['rm', '-f', name], { timeoutMs: 15_000 }).done.catch(
          () => undefined,
        )
      }
    },
  }
}

/**
 * A verification command runs in its own container, under its own name.
 *
 * Not a shared one, because the agent's `docker run` may still be shutting down when the
 * gate starts — a killed agent's container outlives the `docker run` that started it —
 * and a second `--name` collision would fail the gate with "name already in use", which
 * reads as a broken test suite.
 *
 * `CI=1` because the gate needs a suite that exits. Watch mode is the default for enough
 * runners (vitest, jest --watch, cargo-watch) that a project whose `command` is a bare
 * `pnpm test` would otherwise sit there until the job's budget ran out and be reported as
 * a timeout, which points at the wrong thing entirely.
 */
const verificationOptions = (opts: ContainerOptions): ContainerOptions => ({
  ...opts,
  name: verificationName(opts.name),
  env: { CI: '1', ...opts.env },
})

const verificationName = (name: string): string => `${name}-verify`

/** Exported for the tests: the mount flags are the profile enforcement, so they are
 *  worth asserting without starting a container. */
export function buildRunArgs(opts: ContainerOptions, image: string): string[] {
  const args = [
    'run',
    '--rm',
    '--name',
    opts.name,
    '--workdir',
    GUEST_WORKSPACE,

    // Capability posture. The agent needs none of these; a compromised one should not
    // be able to raise privilege inside its own namespace.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',

    // WSL2 caps at ~50% of Windows RAM, and a container running an agent plus a test
    // suite is not small. Unbounded, one job takes the host down with it (§8).
    '--memory',
    opts.memory ?? process.env.OGUN_SANDBOX_MEMORY ?? '4g',
    '--cpus',
    opts.cpus ?? process.env.OGUN_SANDBOX_CPUS ?? '2',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,exec,size=2g',

    /**
     * The tree under review is read-only for anything that is not a modifier.
     *
     * This is what makes the permission profiles real. Until now they were a comment:
     * claude got `--disallowedTools Edit,Write,…` alongside `--dangerously-skip-permissions`,
     * so `Bash` wrote whatever it liked; codex got no profile restriction at all; and the
     * container passed `OGUN_PERMISSIONS` into an environment nothing read. `reviewer` and
     * `modifier` were the same capability.
     *
     * At the mount rather than in the runtime argv, because the mount is the one place
     * both runtimes go through. Anything expressed as a flag is applied by whichever
     * runtime happens to support it — which is how codex ended up unrestricted.
     */
    '--volume',
    `${opts.hostWorkspace}:${GUEST_WORKSPACE}:${opts.permissions === 'modifier' ? 'rw' : 'ro'}`,

    /**
     * …except where the agent is *supposed* to write. `.ogun-out/` is inside the tree, so
     * a blanket read-only mount would stop a reviewer reporting its findings at all —
     * which is not a stricter reviewer, it is a broken one. Layered over the mount above,
     * so the tree stays read-only and the one directory the harness reads back does not.
     */
    '--volume',
    `${join(opts.hostWorkspace, '.ogun-out')}:${GUEST_WORKSPACE}/.ogun-out:rw`,
  ]

  if ((opts.egress ?? 'open') === 'none') args.push('--network', 'none')

  /**
   * Individual credential files, read-only, into a staging path the entrypoint copies
   * from. The CLIs write session state, so a read-only mount at the real path makes
   * them fail; mounting the real path writable would let a container corrupt the host's
   * credentials.
   *
   * Files, not the directory. `~/.claude` is 36MB on a working machine, of which 22MB is
   * `projects/` — full transcripts of every session in every repo you have ever opened,
   * which routinely contain secrets from other projects. Handing that to an autonomous
   * agent is a much larger exposure than the rate limit §4.6 originally named as the
   * worst case. Both runtimes were verified to authenticate from these files alone.
   */
  for (const [hostPath, guestPath] of credentialMounts(opts.runtime)) {
    if (existsSync(hostPath)) args.push('--volume', `${hostPath}:${guestPath}:ro`)
  }

  // A package-manager cache volume, or every nightly run re-downloads the world.
  args.push('--volume', `ogun-cache-${opts.runtime}:/home/dev/.cache`)

  args.push('--env', `OGUN_PERMISSIONS=${opts.permissions}`)
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push('--env', `${k}=${v}`)

  args.push(image)
  return args
}

/**
 * An allowlist, not the directory. Anything not named here does not enter the sandbox —
 * notably `projects/` (session transcripts), `history.jsonl`, `plugins/` and the codex
 * `memories`/`goals` databases.
 *
 * Excluding `plugins/` also fixes a correctness problem: a personal plugin's skill was
 * being invoked in preference to the worker's, so what a nightly run actually did
 * depended on what you happened to have installed on your laptop.
 */
function credentialMounts(runtime: 'claude' | 'codex'): Array<[string, string]> {
  const home = homedir()
  if (runtime === 'claude') {
    return [
      [join(home, '.claude', '.credentials.json'), '/host-credentials/claude/.credentials.json'],
      [join(home, '.claude', 'settings.json'), '/host-credentials/claude/settings.json'],
    ]
  }
  return [
    [join(home, '.codex', 'auth.json'), '/host-credentials/codex/auth.json'],
    [join(home, '.codex', 'config.toml'), '/host-credentials/codex/config.toml'],
  ]
}

const containerCommand = (runtime: 'claude' | 'codex', argv: string[]): string[] => [
  runtime,
  ...argv,
]

async function imageExists(image: string): Promise<boolean> {
  const { done } = spawnJsonl('docker', ['image', 'inspect', image], { timeoutMs: 15_000 })
  const { code } = await done.catch(() => ({ code: 1, stderr: '' }))
  return code === 0
}
