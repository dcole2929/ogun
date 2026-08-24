import { existsSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveEgressAllow, type EgressPolicy } from '@ogun/core'
import {
  CA_CONTAINER_PATH,
  credentialStubs,
  sandboxProxyEnv,
  type Gateway,
  type GatewaySession,
} from '@ogun/gateway'
import { spawnJsonl } from './exec.ts'
import { GUEST_EGRESS_SOCKET, GUEST_PROXY_AUTHORITY, GUEST_PROXY_PORT } from './egress.ts'
import { readContained } from './paths.ts'
import type { Sandbox, SandboxSpec } from './types.ts'

/**
 * Everything one job's containers need in order to reach the gateway, resolved once in
 * `provision()` and then pure data.
 *
 * Separated from the live `Gateway` handle on purpose: `buildRunArgs` is the function the
 * mount and environment flags are asserted against without starting anything, and it has
 * to stay a pure function of its options. A `buildRunArgs` that reached into a running
 * gateway could only be tested by running one, which is how the docker-argument model —
 * the part of this that is actually load-bearing — would stop being tested at all.
 */
export type SandboxEgress = {
  /** Host path of the runner's gateway socket. Bind-mounted in as a file, read-write. */
  socketPath: string
  /** Host path of the gateway's CA certificate. Everything in the image trusts this. */
  caCertificatePath: string
  /** `http://x:<token>@127.0.0.1:8118` — the container's view, carrying its own token. */
  proxyUrl: string
  /** Placeholder credential files on the host, and the paths they mount at. */
  stubs: ReadonlyArray<{ hostPath: string; containerPath: string }>
}

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
   * and this file used to put a live OAuth credential in every sandbox — so the default
   * was "an agent that can read its own credential and POST it anywhere". Not because an
   * agent would choose to, but because an `adversarial-review` worker is aimed at
   * untrusted repository content by design, and a crafted README is the whole of the
   * attack. Both spellings still parse, and `open` is still available as an explicit
   * opt-out — see `credentialMounts`, which is now the *only* path that mounts a real
   * credential, precisely so that the opt-out is the one place to look.
   */
  egress?: EgressPolicy
  /**
   * The runner's gateway, if there is one. Read in `provision()`, never in
   * `buildRunArgs`.
   *
   * One per runner rather than one per sandbox (ADR-0010). The gateway holds a CA
   * private key that can impersonate every host every Ogun container trusts, and it
   * reads the host's real credentials; standing up a second copy of that per job would
   * multiply the surface without buying isolation, because the isolation between jobs is
   * the per-session token and the per-session allowlist, not the listener.
   */
  gateway?: Gateway
  /**
   * This job's resolved gateway wiring.
   *
   * Passed in rather than derived from `opts.name`, because the verification container
   * runs under a *different* name (`…-verify`) and shares the agent container's session.
   * Deriving it here would have given the gate a socket nothing was listening on, and
   * `pnpm install` would have failed as a red suite rather than as an egress fault.
   */
  egressSession?: SandboxEgress
  /**
   * Whether this container gets credential files at all.
   *
   * `none` is the verification container. No agent runs in it — it runs the project's
   * own test suite — and a test suite has no business holding even a placeholder, let
   * alone the host's `settings.json`, which can carry an `env` block with secrets in it
   * (ADR-0010's named residual exposure). It still gets the proxy, the CA and the socket,
   * because a suite that begins `pnpm install` with no egress fails as a red suite and is
   * then blamed on the modifier whose patch it was gating.
   */
  credentials?: 'agent' | 'none'
}

export const GUEST_WORKSPACE = '/workspace'

/**
 * Where the placeholder credential files are staged before being mounted.
 *
 * Under `tmpdir()` rather than the job's scratch directory for the same reason the old
 * per-container socket lived there: scratch is user-configurable and can be arbitrarily
 * deep, and this is a directory only the sandbox writes and only the sandbox deletes.
 * Routing it through the pipeline would couple the sandbox to a directory layout it has
 * no other reason to know about, and would leave a stub behind on the day someone runs
 * with `OGUN_KEEP_WORKSPACES=1`.
 */
const stubStagingDir = (containerName: string): string =>
  join(tmpdir(), 'ogun-credentials', containerName)

/**
 * The default sandbox: real capability isolation, per-project image.
 *
 * What is deliberately absent is the point. No /var/run/docker.sock — anything holding
 * it can start a privileged container mounting /, which makes the boundary decorative.
 * No gh, no git remote, no ssh key, no GitHub token: the never-pushes rule is
 * structural rather than policed, because there is nothing to push with (§4.6).
 *
 * And, since ADR-0010, no credential. The container gets placeholder files at the paths
 * the real ones used to mount at, plus `HTTPS_PROXY` pointing at the runner's gateway
 * through a bind-mounted unix socket. You cannot exfiltrate a token that was never here.
 */
export function createContainerSandbox(opts: ContainerOptions): Sandbox {
  const image = opts.image ?? 'ogun/base:latest'
  const allow = resolveEgressAllow(opts.egress, opts.runtime)
  let session: GatewaySession | undefined
  let egressSession: SandboxEgress | undefined
  let stubDir: string | undefined

  /**
   * Resolved per exec rather than captured once, because `provision()` is what fills
   * `egressSession` in and `exec` may be called several times after it.
   *
   * Fixed here rather than at each exec so the agent container and the verification
   * container that follows it share one gateway session — one allowlist, one token, one
   * denial log. Two sessions would mean a test gate that could reach hosts the agent
   * could not, or the reverse, with nothing saying which.
   */
  const runOpts = (): ContainerOptions =>
    egressSession ? { ...opts, egressSession } : { ...opts }

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
        // The second clause is not rhetoric: `open` bypasses the gateway, and bypassing
        // the gateway is exactly what puts a live credential back in the container.
        console.warn(
          `[runner] ${opts.name}: egress is \`open\` — this container has unrestricted ` +
            'internet and a real mounted credential it can read, because there is no ' +
            'gateway on that path (§4.6, ADR-0010)',
        )
      }
      if (!allow) return

      /**
       * Fail closed when the runner's own lifecycle is wrong.
       *
       * A container sandbox with an allowlist and no gateway has no route out and no way
       * to authenticate, and the honest alternatives are "airgap" or "put the credential
       * back". `egressArgs` picks the airgap so a bug here cannot silently restore the
       * posture ADR-0010 removed; this is the message that says which bug it was.
       */
      if (!opts.gateway) {
        throw new Error(
          `${opts.name}: no egress gateway was passed to the sandbox — every container ` +
            'authenticates through it (ADR-0010), so this is a runner wiring bug rather ' +
            'than a configuration one',
        )
      }
      /**
       * A `--network none` container cannot reach a TCP listener, not even on loopback:
       * it has its own network namespace and the gateway is in the runner's. So the
       * socket transport is not a preference here, it is the only one that works, and
       * `OGUN_GATEWAY_HOST`/`OGUN_GATEWAY_PORT` — which exist for a `worktree` sandbox
       * and for pointing something at the gateway by hand — are refused rather than
       * accepted into a container that would then quietly reach nothing.
       */
      if (opts.gateway.listening.kind !== 'socket') {
        throw new Error(
          `${opts.name}: the gateway is listening on TCP ` +
            `(${opts.gateway.listening.host}:${opts.gateway.listening.port}), which a ` +
            '`--network none` container has no interface to reach — unset ' +
            'OGUN_GATEWAY_HOST / OGUN_GATEWAY_PORT so it listens on its unix socket',
        )
      }
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

      /**
       * A session per job, with *this worker's* allowlist rather than the gateway's.
       *
       * One gateway serves every job on the machine, so a global list would quietly
       * widen every worker to the union of all of them — a reviewer that declared
       * `egress: [docs.example.com]` inheriting a modifier's reach. That regression never
       * fails a test; it just stops refusing things.
       */
      session = opts.gateway.open(GUEST_PROXY_AUTHORITY, allow)

      /**
       * Written in `provision`, which runs ONCE per job (§5.2), so every file exists
       * before the first `docker run`. Ordering is load-bearing in a way docker will not
       * warn about: bind-mounting a source path that does not exist makes docker create
       * an empty *directory* there, and a CLI would then find a directory where it
       * expects its credential file and fail with something that reads nothing like an
       * egress fault.
       */
      stubDir = stubStagingDir(opts.name)
      await mkdir(stubDir, { recursive: true, mode: 0o700 })
      const stubs: Array<{ hostPath: string; containerPath: string }> = []
      for (const stub of credentialStubs(opts.runtime)) {
        const hostPath = join(stubDir, basename(stub.containerPath))
        await writeFile(hostPath, stub.content)
        // chmod separately: `writeFile`'s mode is masked by the process umask on create
        // and ignored entirely for a file that already exists. Every byte in here is a
        // placeholder, but the file is credential-*shaped* and sits at the path a real
        // credential used to occupy, so the mode has to already be right on the day
        // somebody reaches for this code for something that is not.
        await chmod(hostPath, stub.mode)
        stubs.push({ hostPath, containerPath: stub.containerPath })
      }

      egressSession = {
        socketPath: opts.gateway.listening.path,
        caCertificatePath: opts.gateway.caCertificatePath,
        proxyUrl: session.proxyUrl,
        stubs,
      }
    },
    exec: (argv, exec = {}) =>
      // `docker run` per exec rather than a long-lived container + `docker exec`: the
      // job is one agent invocation, and a fresh container makes cleanup automatic.
      spawnJsonl(
        'docker',
        [
          ...buildRunArgs(exec.raw ? verificationOptions(runOpts()) : runOpts(), image),
          ...(exec.raw ? argv : containerCommand(opts.runtime, argv)),
        ],
        { timeoutMs: exec.timeoutMs ?? opts.timeoutMs },
      ),
    // Read through the host bind-mount rather than `docker cp`: the container may
    // already be gone, and the path check has to happen host-side anyway (§5.3).
    readFile: (relPath) => readContained(opts.hostWorkspace, relPath),
    dispose: async () => {
      /**
       * The token dies first, before the containers are torn down.
       *
       * That is the opposite of the ordering this used to have, and the reason it
       * changed is that revoking is not closing. Closing the old per-sandbox proxy first
       * would drop a live tunnel and fail the agent's last request on the way out of a
       * job that had already finished. Revoking only affects the *next* CONNECT, and a
       * container we are about to `docker rm -f` has no legitimate next request — while
       * `docker rm -f` can hang or fail, and a token that outlived a container we failed
       * to remove is exactly the leak §3.1 revokes for.
       */
      session?.revoke()
      // --rm handles the normal path; this catches a container left behind by a kill —
      // including the verification one, which is exactly the container most likely to
      // have been killed, since the gate is what runs against a deadline.
      for (const name of [opts.name, verificationName(opts.name)]) {
        await spawnJsonl('docker', ['rm', '-f', name], { timeoutMs: 15_000 }).done.catch(
          () => undefined,
        )
      }
      // The stubs go after the containers, not before: a container still shutting down
      // still has them bind-mounted, and removing the source of a live bind mount is a
      // way to confuse docker for no gain. The runner is long-lived, so a directory left
      // here is a real leak — one per job.
      if (stubDir) await rm(stubDir, { recursive: true, force: true }).catch(() => undefined)
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
 *
 * It keeps the agent's gateway session — the same socket, the same CA, the same
 * allowlist — and loses every credential file, real or placeholder. A test suite does not
 * authenticate to a model API, and the residual exposure of `settings.json` is not one
 * worth carrying into a container that has no use for it (§3.6).
 */
const verificationOptions = (opts: ContainerOptions): ContainerOptions => ({
  ...opts,
  name: verificationName(opts.name),
  credentials: 'none',
  ...(opts.egressSession ? { egressSession: { ...opts.egressSession, stubs: [] } } : {}),
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
   * The credential files, read-only, into a staging path the entrypoint copies from.
   *
   * Two kinds arrive here and it matters which. The *placeholder* files come from
   * `egressSession.stubs` and are written per job by `provision()`; the *real* ones come
   * from `credentialMounts()` and only on the `egress: open` path, which has no gateway
   * to splice a credential in at. Under every other policy the container holds nothing
   * worth stealing (ADR-0010).
   *
   * Copied rather than mounted at the real path because the CLIs write session state, so
   * a read-only mount at `~/.claude` makes them fail; mounting the real path writable
   * would let a container corrupt the host's own files.
   *
   * Files, not directories. `~/.claude` is 36MB on a working machine, of which 22MB is
   * `projects/` — full transcripts of every session in every repo you have ever opened,
   * which routinely contain secrets from other projects.
   */
  for (const stub of opts.egressSession?.stubs ?? []) {
    args.push('--volume', `${stub.hostPath}:${stub.containerPath}:ro`)
  }
  for (const [hostPath, guestPath] of credentialMounts(opts)) {
    if (existsSync(hostPath)) args.push('--volume', `${hostPath}:${guestPath}:ro`)
  }

  /**
   * A package-manager cache volume, or every nightly run re-downloads the world (§4.6).
   *
   * One volume per *runtime*, mounted read-write into every concurrent sandbox — so with
   * `maxConcurrentJobs: 2` there are routinely two containers writing to it at once, and
   * for Ogun's own project image `tests.command` is `pnpm install` straight into it. That
   * looks exactly like every other shared mutable global, and it is the one place here
   * where sharing turns out to be correct. Written down because it is not obvious, and
   * because the next person to audit this will otherwise re-derive it from scratch:
   *
   *  - **Where the store actually is.** `PNPM_HOME=/home/dev/.cache/pnpm` in
   *    `.ogun/Dockerfile`, and pnpm resolves `store-dir` from `$PNPM_HOME/store` before
   *    anything else, so the content-addressable store lands at
   *    `/home/dev/.cache/pnpm/store/v10` — inside this volume, which is the intent. The
   *    metadata cache follows `$XDG_CACHE_HOME` / `~/.cache` and lands here too, by a
   *    different rule that happens to agree.
   *  - **Why concurrent writers do not corrupt it.** pnpm writes each store file to a
   *    temporary path and renames it over the destination, and — this is the part that
   *    matters — the temporary name is *derived from the destination*
   *    (`<dest><pid><threadId>`). The destination name is the content hash. So two
   *    containers can only collide on a temp path when they are writing the same hash,
   *    which means they are writing identical bytes, which means interleaving them is
   *    harmless and either rename produces the right file. pnpm's own source names this
   *    scenario — "two containers use the same mounted directory for their
   *    content-addressable store" — and handles a temp file that vanished before its
   *    rename by assuming the destination is correct. It is, for the same reason.
   *  - **The backstop.** `verify-store-integrity` defaults to true, so a store file whose
   *    content stops matching its name is detected when it is linked out rather than
   *    installed.
   *
   * Three things are true and worth knowing before relying on any of this:
   *
   *  - The safety claim is a pnpm maintainer's answer in a GitHub discussion, not
   *    documentation. A pull request to state it on pnpm.io has been open since 2022. The
   *    project image pins `pnpm@10`, which is what bounds the risk of it changing.
   *  - The store is on a docker volume and `node_modules` is on the bind-mounted
   *    workspace, so they are different filesystems and hardlinking fails with EXDEV.
   *    pnpm warns once and copies. The volume therefore saves the *download*, which is
   *    what §4.6 asked for, and not the disk or the linking.
   *  - Keyed by runtime, so every project on this runner shares one store, and a
   *    `modifier` has write access to it. Content-addressing plus the integrity check is
   *    the whole of what keeps that honest. A project turning `verify-store-integrity`
   *    off in its own config would remove the backstop for *itself*, not for others.
   */
  args.push('--volume', `ogun-cache-${opts.runtime}:/home/dev/.cache`)

  args.push('--env', `OGUN_PERMISSIONS=${opts.permissions}`)
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push('--env', `${k}=${v}`)

  args.push(image)
  return args
}

/**
 * The docker flags that make the allowlist real, and that point the container at the
 * gateway (§4.6, ADR-0010).
 *
 * `--network none` is the enforcement, and the socket is only the exception to it. That
 * ordering is the point and it is the opposite of how a proxy is usually deployed: on a
 * normal bridge network `HTTPS_PROXY` is advice, and a prompt-injected agent declines the
 * advice with `curl --noproxy '*'`. Here the container has no interface but `lo`, so
 * there is nothing to decline — every route out is the unix socket, and on the far side
 * of it is a host process that holds the allowlist *and* the only real credential.
 *
 * The socket is mounted as a *file*, not by mounting its directory, and that is now much
 * more than hygiene: the directory is `~/.ogun/gateway/`, which also holds `ca.key` — the
 * signing key that can impersonate every host every Ogun container trusts. Mounting the
 * directory would hand that key to every sandbox, which is a strictly worse outcome than
 * the credential mount this whole change exists to remove.
 *
 * The socket mount is read-**write**, deliberately. Connecting to a unix socket needs
 * write permission on the inode; a `:ro` mount here produces a container that cannot
 * connect at all, and the symptom is an agent that cannot reach its model API.
 */
function egressArgs(opts: ContainerOptions): string[] {
  if (opts.egress === 'open') return []
  const session = opts.egressSession
  if (opts.egress === 'none' || !session) {
    /**
     * `none` is a genuine airgap, and so is a caller that asked for an allowlist without
     * a resolved session — which can only happen if `provision()` did not run. Failing
     * closed is the only safe way to be wrong here: the alternative is a bug in the
     * runner's own lifecycle silently downgrading a container to unrestricted internet
     * with a real credential in it.
     */
    return ['--network', 'none']
  }

  return [
    '--network',
    'none',
    '--volume',
    `${session.socketPath}:${GUEST_EGRESS_SOCKET}`,
    // Everything in the image trusts this and nothing else — see `sandboxProxyEnv`,
    // which points four TLS stacks plus git at it.
    '--volume',
    `${session.caCertificatePath}:${CA_CONTAINER_PATH}:ro`,
    // Read by the entrypoint, which starts the loopback→socket forwarder. Absent, the
    // entrypoint starts nothing and the container is simply airgapped.
    '--env',
    `OGUN_EGRESS_SOCKET=${GUEST_EGRESS_SOCKET}`,
    '--env',
    `OGUN_EGRESS_PORT=${GUEST_PROXY_PORT}`,
    /**
     * Both spellings of every proxy variable, the CA for four TLS stacks, and git's
     * three separate settings — all of it from one place in `@ogun/gateway`, because the
     * list is long, every entry has a failure mode attached, and a second copy of it here
     * would drift from the one the gateway's own tests assert against.
     *
     * The `proxyUrl` carries this job's session token as HTTP basic credentials, which
     * puts it in the container's environment and in this process's `docker run` argv. The
     * socket's 0600 mode is what keeps other accounts on the host out; the token bounds a
     * *container*, so a host user who could read the argv still has nothing to connect
     * with.
     */
    ...Object.entries(sandboxProxyEnv(session.proxyUrl)).flatMap(([k, v]) => [
      '--env',
      `${k}=${v}`,
    ]),
  ]
}

/**
 * The host files that still enter a sandbox, and the one case where a real credential
 * is among them.
 *
 * An allowlist, not the directory. Anything not named here does not enter the sandbox —
 * notably `projects/` (session transcripts), `history.jsonl`, `plugins/` and the codex
 * `memories`/`goals` databases.
 *
 * Excluding `plugins/` also fixes a correctness problem: a personal plugin's skill was
 * being invoked in preference to the worker's, so what a nightly run actually did
 * depended on what you happened to have installed on your laptop.
 *
 * `settings.json` and `config.toml` are configuration the CLIs need, and neither is a
 * credential by construction — though `settings.json` *can* carry an `env` block with
 * secrets in it, which ADR-0010 records as a residual exposure rather than pretending
 * otherwise.
 *
 * The credential files themselves are the `egress: open` case and nothing else. Under any
 * other policy the container gets `credentialStubs()` at exactly these paths instead, and
 * the real token never leaves this host. `open` has no gateway to splice one in at, so
 * the choice there is between a mounted credential and an agent that cannot authenticate;
 * it mounts, loudly, once per run, from `provision()` above. Keeping the two in one
 * function is deliberate — the question "does a sandbox ever see a real token" has to
 * have exactly one place to look.
 */
function credentialMounts(opts: ContainerOptions): Array<[string, string]> {
  if (opts.credentials === 'none') return []
  const home = homedir()
  const mounts: Array<[string, string]> =
    opts.runtime === 'claude'
      ? [[join(home, '.claude', 'settings.json'), '/host-credentials/claude/settings.json']]
      : [[join(home, '.codex', 'config.toml'), '/host-credentials/codex/config.toml']]
  if (opts.egress !== 'open') return mounts
  return [
    ...mounts,
    opts.runtime === 'claude'
      ? [join(home, '.claude', '.credentials.json'), '/host-credentials/claude/.credentials.json']
      : [join(home, '.codex', 'auth.json'), '/host-credentials/codex/auth.json'],
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
