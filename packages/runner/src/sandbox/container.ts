import { existsSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveEgressAllow, type ConnectedApp, type EgressPolicy } from '@ogun/core'
import {
  CA_CONTAINER_PATH,
  connectionStubs,
  credentialStubs,
  sandboxConnectionEnv,
  sandboxProxyEnv,
  type Gateway,
  type GatewaySession,
  type SessionConnections,
} from '@ogun/gateway'
import { connectionReader } from './connections.ts'
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
  /**
   * Which connected applications this job was granted (§4.13), for the environment the
   * container is given.
   *
   * The *credential* is not here and never crosses this type. What a container is told is
   * the roster, the endpoint and a placeholder; the real token is read on the host, per
   * request, behind the session `provision()` minted. Putting a credential in
   * `SandboxEgress` would put it in `docker run`'s argv, which is the one place ADR-0010
   * spent a whole component keeping it out of.
   */
  connections: readonly ConnectedApp[]
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
   * Which connected applications this worker declared (§4.13). Absent means none, which is
   * what every worker gets unless it wrote `connections:`.
   *
   * Read in `provision()` and turned into a per-session grant on the gateway, never into a
   * value this container can see. `projectSlug` is what says *whose* connection: a grant
   * is per project (ADR-0012), so a runner serving two projects must not hand one's Linear
   * token to the other's job — which is exactly what a runner-level credential would do.
   */
  connections?: readonly ConnectedApp[]
  /**
   * Which project this job belongs to, for looking that grant up. Required whenever
   * `connections` is non-empty and useless otherwise, so it is not made mandatory: every
   * existing caller has no connections and no reason to learn a new field.
   */
  projectSlug?: string
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
  const connections = opts.connections ?? []
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
      /**
       * A connection needs the gateway, and `open`/`none` have none.
       *
       * `workerSchema` already refuses this combination where it is written, which is the
       * right place for it — but the config that produced this job may have been indexed
       * by an older build, and a job arrives here through a database row rather than
       * through the parser. So the check is here too, and it fails the run rather than
       * dropping the connection quietly: a worker that asked for Linear and silently did
       * not get it reports "linear rejected the credential" from inside a container, which
       * sends an operator to rotate a credential that was never sent.
       */
      if (connections.length > 0 && !allow) {
        throw new Error(
          `${opts.name}: this worker declares \`connections: [${connections.join(', ')}]\` ` +
            `and \`egress: ${opts.egress}\`, which have no gateway between them — \`open\` ` +
            'bypasses it and `none` is an airgap, and a connected application is reached by ' +
            'the gateway splicing this project\'s credential in at the wire (ADR-0010)',
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
      /**
       * The grant, read once here and re-read per request behind a five-second memo.
       *
       * Awaited, so that the agent's first Linear call does not race a cold cache and
       * collect a 502 for a credential that was on disk all along — see `connectionReader`.
       * A project slug is required to look one up at all; a caller that declared
       * connections without one has not finished wiring the job, and guessing would mean
       * reading some *other* project's credential.
       */
      let granted: SessionConnections | undefined
      if (connections.length > 0) {
        if (!opts.projectSlug) {
          throw new Error(
            `${opts.name}: this worker declares \`connections:\` and the sandbox was given ` +
              'no project slug — a connection is stored per project (ADR-0012), so there is ' +
              'nothing to look one up by. This is a runner wiring bug',
          )
        }
        granted = await connectionReader(opts.projectSlug, connections)
      }

      session = opts.gateway.open(GUEST_PROXY_AUTHORITY, allow, granted)

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
      /**
       * The connection stubs ride the same list as the credential stubs, which is what
       * makes the verification container inherit the right posture for free:
       * `verificationOptions` empties `stubs`, so a test suite gets no connection
       * description either. A separate list here would have been a second thing to
       * remember to empty, and the one that got forgotten would be the one that mattered.
       *
       * `basename` is what flattens `/etc/ogun/connections/linear.json` and
       * `/host-credentials/claude/.credentials.json` into one staging directory. Two stubs
       * whose basenames collided would silently overwrite each other — `linear.json`,
       * `auth.json` and `.credentials.json` do not, and any future pair that does is a bug
       * worth noticing here rather than inside a container.
       */
      for (const stub of [...credentialStubs(opts.runtime), ...connectionStubs(connections)]) {
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
        connections,
      }
    },
    exec: (argv, exec = {}) =>
      // `docker run` per exec rather than a long-lived container + `docker exec`: the
      // job is one agent invocation, and a fresh container makes cleanup automatic.
      spawnJsonl(
        'docker',
        [
          ...buildRunArgs(
            exec.raw ? verificationOptions(runOpts()) : runOpts(),
            /**
             * The sandbox's own image, unless a verification command named another.
             *
             * `exec.image` is the `project-image` lens running a patch's proposed suite in
             * the image that patch proposes (ADR-0016), and it inherits everything else
             * this container gets — the read-write workspace mount, the gateway socket, the
             * memory caps, and `--network none`. That last one is the reason the override
             * lives here rather than in a second `docker run` written beside the gate: a
             * suite proved against a service on the *host* has proved nothing that will be
             * true at 3am, and every route out of a sandbox is already decided by this
             * function.
             *
             * Honoured only on a `raw` exec, which is the only kind that has one: an
             * agent-runtime invocation in an image that is not the sandbox's would be a run
             * whose transcript describes a container nobody chose. The one caller always
             * passes `raw`, so the guard is a statement of what the option means rather
             * than a branch anything takes.
             */
            exec.raw && exec.image ? exec.image : image,
          ),
          ...(exec.raw ? argv : containerCommand(opts.runtime, argv)),
        ],
        { timeoutMs: exec.timeoutMs ?? opts.timeoutMs },
      ),
    // Read through the host bind-mount rather than `docker cp`: the container may
    // already be gone, and the path check has to happen host-side anyway (§5.3).
    readFile: (relPath) => readContained(opts.hostWorkspace, relPath),
    dispose: async () => {
      /**
       * The token dies first, and now that is the whole of the credential story.
       *
       * The ordering has always been revoke-then-remove, but the reason written here used
       * to be a smaller claim than it looked: revoking deleted the token, the token was
       * checked once per CONNECT, and so a tunnel the container had *already* opened kept
       * being handed the host's live credentials on every request until something else
       * closed the socket. The comment leaned on `docker rm -f` to be that something else,
       * and then acknowledged in the same breath that `docker rm -f` can hang or fail. The
       * two halves did not add up: the case it named as the leak was exactly the case
       * nothing covered.
       *
       * `revoke()` now closes what the token opened — every tunnel, every upgraded
       * WebSocket — and every request inside one re-checks the grant besides. So this call
       * ends the container's reach at the moment the job ends, on its own, whatever docker
       * does next. `docker rm -f` is back to being what it should always have been: a
       * resource cleanup, not a security control.
       *
       * Still first, and still for a reason. A container we are about to force-remove has
       * no legitimate request left to make — every `exec()` has already resolved, so its
       * `docker run` has already exited — and a job that is finishing cleanly has nothing
       * open for this to interrupt. Reversing it would leave a window between the last
       * container dying and the token dying, which is the window §3.1 exists to close.
       */
      session?.revoke()
      /**
       * --rm handles the normal path; this catches a container left behind by a kill —
       * including the verification one, which is exactly the container most likely to have
       * been killed, since the gate is what runs against a deadline.
       *
       * The failure is reported rather than swallowed, which it was not before. Swallowing
       * it was understandable — on the normal path there is nothing here to remove, `--rm`
       * having already done it, and a report that could not tell that from a real failure
       * would print a line per job and be muted inside a week. The answer is to tell the
       * two apart rather than to say nothing. An already-gone container is the expected
       * outcome and stays silent; a daemon that is wedged, out of disk, or refusing the
       * removal leaves a container holding a workspace bind-mount and a `--name` the next
       * job of this worker will collide with, and nothing else in the system would ever
       * mention it.
       *
       * What this is no longer reporting is a credential leak. It was one before — the
       * revoked token did not close the tunnels the container had already opened, so a
       * container that survived this call went on spending the host's credentials. Now
       * `revoke()` above has ended its reach whatever docker does, and what is left to
       * report is a resource leak, which is why this warns instead of failing the run.
       *
       * Warned, never thrown. `dispose()` runs in the pipeline's `finally` and its own
       * caller already discards what it throws, so a throw here would be swallowed one
       * level up *and* would skip the stub-directory removal below — trading a reported
       * leak for two silent ones.
       */
      for (const name of [opts.name, verificationName(opts.name)]) {
        const removal = await spawnJsonl('docker', ['rm', '-f', name], {
          timeoutMs: 15_000,
        }).done.catch((err: unknown) => ({
          code: null,
          stderr: err instanceof Error ? err.message : String(err),
          timedOut: false,
        }))
        if (removal.code === 0 || alreadyGone(removal.stderr)) continue
        console.warn(
          `[runner] ${name}: docker rm -f did not remove the container` +
            `${removal.timedOut ? ' (timed out after 15s)' : ''} — its egress token is ` +
            'revoked and its tunnels are closed (ADR-0010), so it can no longer reach ' +
            `anything, but it is still holding host resources: ${lastLine(removal.stderr)}`,
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
 * The one `docker rm -f` failure that is not a failure: there was nothing to remove.
 *
 * `--rm` removes the container as the run exits, so on every clean job this command is
 * asked for a container that is already gone — which is the *expected* outcome, not an
 * error, and must not produce a line in the runner's log.
 *
 * Two checks rather than one because docker does not answer this the same way everywhere.
 * Current versions exit 0 for a missing container under `-f` (verified on the docker this
 * was written against); older ones exit 1 with `Error: No such container: …`. The caller
 * accepts exit 0, and this accepts the message — matched on the message rather than on the
 * code, because a bare exit 1 is also what a wedged daemon gives and separating those two
 * is the entire point of reporting at all.
 */
const alreadyGone = (stderr: string): boolean => /no such container/i.test(stderr)

/**
 * The last thing docker said, not the whole of it.
 *
 * `spawnJsonl` keeps up to 64KB of stderr, and a wedged daemon can fill it. One line is
 * what makes the warning readable in a runner log that is mostly job output.
 */
const lastLine = (stderr: string): string =>
  stderr.trim().split('\n').at(-1)?.trim() || 'no output from docker'

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
 * worth carrying into a container that has no use for it (docs/gateway.md §3.8).
 */
const verificationOptions = (opts: ContainerOptions): ContainerOptions => ({
  ...opts,
  name: verificationName(opts.name),
  credentials: 'none',
  /**
   * No stubs, and no connections either. A test suite does not authenticate to a model API
   * and has no business calling a project's issue tracker — and unlike the agent container,
   * nothing here was even asked to. Dropping the roster as well as the files is what stops
   * `OGUN_CONNECTIONS=linear` reaching a container with no stub to go with it, which reads
   * as a connection that exists and is broken.
   */
  ...(opts.egressSession
    ? { egressSession: { ...opts.egressSession, stubs: [], connections: [] } }
    : {}),
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
    /**
     * What the agent is told about the applications it may call (§4.13).
     *
     * Every value here is a placeholder or a public endpoint, which is why it is safe in a
     * `docker run` argv at all — `LINEAR_API_KEY=ogun-gateway-placeholder` is a string whose
     * whole purpose is to be worthless. The real token is read on the host, per request, and
     * never appears in this process's arguments, this container's environment, or any file
     * inside it.
     *
     * Empty when nothing was granted, so a container that asked for no connection has no
     * variable suggesting it might have one.
     */
    ...Object.entries(sandboxConnectionEnv(session.connections)).flatMap(([k, v]) => [
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
