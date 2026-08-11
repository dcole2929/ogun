import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnJsonl } from './exec.ts'
import { safeJoin } from './paths.ts'
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
  const runArgs = buildRunArgs(opts, image)

  return {
    kind: 'container',
    provision: async () => {
      if (!(await imageExists(image))) {
        throw new Error(
          `image ${image} is not present — build it with \`ogun image build\` before running`,
        )
      }
    },
    exec: (argv) =>
      // `docker run` per exec rather than a long-lived container + `docker exec`: the
      // job is one agent invocation, and a fresh container makes cleanup automatic.
      spawnJsonl('docker', [...runArgs, ...containerCommand(opts.runtime, argv)], {
        timeoutMs: opts.timeoutMs,
      }),
    readFile: async (relPath) => {
      // Read through the host bind-mount rather than `docker cp`: the container may
      // already be gone, and the path check has to happen host-side anyway (§5.3).
      const abs = await safeJoin(opts.hostWorkspace, relPath)
      return readFile(abs, 'utf8').catch(() => null)
    },
    dispose: async () => {
      // --rm handles the normal path; this catches a container left behind by a kill.
      await spawnJsonl('docker', ['rm', '-f', opts.name], { timeoutMs: 15_000 }).done.catch(
        () => undefined,
      )
    },
  }
}

function buildRunArgs(opts: ContainerOptions, image: string): string[] {
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

    '--volume',
    `${opts.hostWorkspace}:${GUEST_WORKSPACE}:rw`,
  ]

  if ((opts.egress ?? 'open') === 'none') args.push('--network', 'none')

  /**
   * Credentials are mounted read-only into a staging path; the entrypoint copies them
   * to a writable location the agent owns. The CLIs write session state, so a bare
   * read-only mount at the real path makes them fail — and mounting the real path
   * writable would let a container corrupt the host's credentials. Worst case here is
   * burning rate limit, which is the accepted risk (§4.6).
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

/** Staging paths the base image's entrypoint copies from. */
function credentialMounts(runtime: 'claude' | 'codex'): Array<[string, string]> {
  const home = homedir()
  if (runtime === 'claude') {
    return [
      [join(home, '.claude'), '/host-credentials/claude'],
      [join(home, '.claude.json'), '/host-credentials/claude.json'],
    ]
  }
  return [[join(home, '.codex'), '/host-credentials/codex']]
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
