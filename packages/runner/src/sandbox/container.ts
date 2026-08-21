import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveEgressAllow, type EgressPolicy } from '@ogun/core'
import { spawnJsonl } from './exec.ts'
import {
  egressSocketPath,
  GUEST_EGRESS_SOCKET,
  GUEST_PROXY_PORT,
  startEgressProxy,
  type EgressProxy,
} from './egress-proxy.ts'
import { readContained } from './paths.ts'
import type { Sandbox, SandboxSpec } from './types.ts'

export type ContainerOptions = SandboxSpec & {
  name: string
  memory?: string
  cpus?: string
  /**
   * Which hosts this container may reach (§4.6). See `egressSchema` in core for the
   * three shapes and why absent means "the defaults for this runtime" rather than
   * "anywhere".
   *
   * What this replaced, kept because it is what §9 recorded as landing differently from
   * the spec: `'open' | 'none'`, defaulting to `open`. `open` is unrestricted internet,
   * and `credentialMounts()` below puts a live OAuth credential in every sandbox — so
   * the default was "an agent that can read its own credential and POST it anywhere".
   * Not because an agent would choose to, but because an `adversarial-review` worker is
   * aimed at untrusted repository content by design, and a crafted README is the whole
   * of the attack. Both spellings still parse, and `open` is still available as an
   * explicit opt-out.
   */
  egress?: EgressPolicy
  /**
   * Host path of the unix socket this container's egress proxy is listening on.
   *
   * Passed in rather than derived from `opts.name`, because the verification container
   * runs under a *different* name (`…-verify`) and shares the agent container's proxy.
   * Deriving it here would have given the gate a socket path nothing was listening on,
   * and `pnpm install` would have failed as a red suite rather than as an egress fault.
   */
  egressSocket?: string
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
  const allow = resolveEgressAllow(opts.egress, opts.runtime)
  /**
   * Fixed here rather than at each exec so the agent container and the verification
   * container that follows it share one proxy, one allowlist and one denial log.
   */
  const runOpts: ContainerOptions = allow
    ? { ...opts, egressSocket: egressSocketPath(opts.name) }
    : opts
  let proxy: EgressProxy | undefined

  return {
    kind: 'container',
    provision: async () => {
      if (!(await imageExists(image))) {
        throw new Error(
          `image ${image} is not present — build it with \`ogun image build\` before running`,
        )
      }
      if (opts.egress === 'open') {
        // Loud, once, in the runner's log. `open` is a real escape hatch and staying
        // silent about it is how a temporary exception becomes the permanent posture.
        console.warn(
          `[runner] ${opts.name}: egress is \`open\` — this container has unrestricted ` +
            'internet and a mounted credential it can read (§4.6)',
        )
      }
      /**
       * Started in `provision`, which runs ONCE per job (§5.2), so the socket file exists
       * before the first `docker run`. Ordering is load-bearing in a way docker will not
       * warn about: bind-mounting a source path that does not exist makes docker create
       * an empty *directory* there, and the container would then get a directory where it
       * expects a socket and fail with something that reads nothing like an egress fault.
       */
      if (allow && runOpts.egressSocket) {
        /**
         * Refuse an image that predates the forwarder rather than starting one that
         * cannot use it. The silent version of this is backwards in a way nobody would
         * guess from the symptom: the container still gets `--network none`, the socket
         * is still mounted, and nothing in there knows to bridge to it — so a tightened
         * egress policy presents as a total airgap, reported by the agent as an
         * authentication failure against its model API.
         *
         * Project images inherit the marker from `FROM ogun/base`, so this is telling
         * you to rebuild, which is the actual fix.
         */
        if (!(await imageDeclares(image, 'OGUN_EGRESS_FORWARDER'))) {
          throw new Error(
            `image ${image} was built before egress allowlisting and cannot reach the ` +
              'proxy — rebuild it with `ogun image build` (and `ogun image build .` for a ' +
              'project image), or set `egress: open` on this worker to opt out (§4.6)',
          )
        }
        proxy = await startEgressProxy({
          containerName: opts.name,
          allow,
          onDenied: (host) =>
            console.warn(`[runner] ${opts.name}: egress refused ${host} (not on the allowlist)`),
        })
      }
    },
    exec: (argv, exec = {}) =>
      // `docker run` per exec rather than a long-lived container + `docker exec`: the
      // job is one agent invocation, and a fresh container makes cleanup automatic.
      spawnJsonl(
        'docker',
        [
          ...buildRunArgs(exec.raw ? verificationOptions(runOpts) : runOpts, image),
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
      // After the containers, not before: a proxy closed first would drop a live tunnel
      // and the agent's last request would fail on the way out of a job that had already
      // finished. The runner is long-lived, so an unclosed socket is a real leak — one
      // per job, plus a file in tmpdir that the next run with the same name trips over.
      await proxy?.close().catch(() => undefined)
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

  args.push(...egressArgs(opts))

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
 * The docker flags that make the allowlist real (§4.6).
 *
 * `--network none` is the enforcement, and the proxy is only the exception to it. That
 * ordering is the point and it is the opposite of how a proxy is usually deployed: on a
 * normal bridge network `HTTPS_PROXY` is advice, and a prompt-injected agent declines the
 * advice with `curl --noproxy '*'`. Here the container has no interface but `lo`, so
 * there is nothing to decline — every route out is the unix socket, and the socket is a
 * host process holding the allowlist.
 *
 * The socket is mounted as a *file*, not by mounting its directory. `tmpdir()/ogun-egress`
 * holds one socket per concurrent run, and a runner runs several: mounting the directory
 * would hand every container the other jobs' sockets, so a worker with a narrow allowlist
 * could borrow a wider one from whatever else happened to be running.
 */
function egressArgs(opts: ContainerOptions): string[] {
  if (opts.egress === 'open') return []
  if (opts.egress === 'none' || !opts.egressSocket) {
    /**
     * `none` is a genuine airgap, and so is a caller that asked for an allowlist without
     * supplying a socket — which can only happen if `provision()` did not run. Failing
     * closed is the only safe way to be wrong here: the alternative is a bug in the
     * runner's own lifecycle silently downgrading a container to unrestricted internet.
     */
    return ['--network', 'none']
  }

  const proxyUrl = `http://127.0.0.1:${GUEST_PROXY_PORT}`
  return [
    '--network',
    'none',
    '--volume',
    `${opts.egressSocket}:${GUEST_EGRESS_SOCKET}`,
    // Read by the entrypoint, which starts the loopback→socket forwarder. Absent, the
    // entrypoint starts nothing and the container is simply airgapped.
    '--env',
    `OGUN_EGRESS_SOCKET=${GUEST_EGRESS_SOCKET}`,
    '--env',
    `OGUN_EGRESS_PORT=${GUEST_PROXY_PORT}`,
    ...proxyEnv(proxyUrl),
  ]
}

/**
 * Both spellings of all four variables, which is tedious and not optional.
 *
 * There is no standard here, only a convention with a security hole in it. Because CGI
 * maps a request's `Proxy:` header into the environment as `HTTP_PROXY`, a long list of
 * libraries — Go's `net/http`, Rust's `reqwest`, curl among them — deliberately ignore
 * the uppercase `HTTP_PROXY` and read only lowercase `http_proxy`. Others read only the
 * uppercase form. `codex` is reqwest and `claude` is undici; setting one spelling would
 * have silently left one of the two runtimes unproxied inside a `--network none`
 * container, which does not fail open — it fails as an agent that cannot reach its model
 * API at 3am, for a reason nothing in the error message mentions.
 *
 * `NO_PROXY` has to name loopback, in both spellings and all three ways loopback gets
 * written. The forwarder *is* on loopback: without an exemption a client resolving the
 * proxy's own address through the proxy is a request that tries to CONNECT to itself.
 * `127.0.0.1` and `localhost` and `::1` because which one a client compares against
 * depends on whether it normalises the host before checking, and the ones that do not
 * are the ones that would loop.
 */
function proxyEnv(proxyUrl: string): string[] {
  const noProxy = 'localhost,127.0.0.1,::1'
  const pairs: Array<[string, string]> = [
    ['HTTP_PROXY', proxyUrl],
    ['http_proxy', proxyUrl],
    ['HTTPS_PROXY', proxyUrl],
    ['https_proxy', proxyUrl],
    ['NO_PROXY', noProxy],
    ['no_proxy', noProxy],
  ]
  return pairs.flatMap(([k, v]) => ['--env', `${k}=${v}`])
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

/**
 * Whether an image carries a given `ENV` marker.
 *
 * Read off the image rather than probed by running a container: this is on the path of
 * every job, and a `docker run` to ask a yes/no question about a layer is a second
 * container per job for no reason.
 */
async function imageDeclares(image: string, key: string): Promise<boolean> {
  const { lines, done } = spawnJsonl(
    'docker',
    ['image', 'inspect', image, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
    { timeoutMs: 15_000 },
  )
  // Drained from `lines`, not from `done` — `spawnJsonl` deliberately keeps only stderr
  // on the result, because its callers stream agent output rather than collect it.
  let found = false
  for await (const line of lines) if (line.trim().startsWith(`${key}=`)) found = true
  const { code } = await done.catch(() => ({ code: 1 }))
  return code === 0 && found
}

async function imageExists(image: string): Promise<boolean> {
  const { done } = spawnJsonl('docker', ['image', 'inspect', image], { timeoutMs: 15_000 })
  const { code } = await done.catch(() => ({ code: 1, stderr: '' }))
  return code === 0
}
