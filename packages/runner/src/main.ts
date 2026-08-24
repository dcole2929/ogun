import { parseArgs } from 'node:util'
import { imageState, loadLocalConfig, LocalConfigError } from '@ogun/core'
import { defaultSocketPath, startGateway } from '@ogun/gateway'
import { ControlPlane } from './client.ts'
import { executeJob } from './pipeline.ts'


// The runner takes no flags — it reads ~/.ogun/config.json. Parsed anyway so that a
// flag someone reasonably expects to work is refused rather than silently dropped.
try {
  parseArgs({ args: process.argv.slice(2), options: {}, allowPositionals: false })
} catch (err) {
  console.error(
    `\nogun-runner: ${(err as Error).message}\n` +
      `  This command takes no arguments — it is configured by \`ogun runner init\`.\n`,
  )
  process.exit(1)
}

const local = await loadLocalConfig().catch((err) => {
  if (err instanceof LocalConfigError) {
    console.error(`\nogun-runner: ${err.message}\n`)
    process.exit(1)
  }
  throw err
})

if (!local.runner) {
  console.error(
    '\nogun-runner: this machine has not joined a control plane.\n' +
      '  Run `ogun runner invite` on the control plane, then paste what it prints here.\n',
  )
  process.exit(1)
}

const runner = local.runner
const serverUrl = process.env.OGUN_SERVER_URL ?? runner.serverUrl
// OGUN_RUNNER_TOKEN, so a shell that exports the admin token for the CLI does not
// silently hand it to the runner as well — which would work, and would quietly undo the
// whole reason runner tokens cannot define workers.
const cp = new ControlPlane(serverUrl, process.env.OGUN_RUNNER_TOKEN?.trim() || runner.token)

/**
 * Deliberately terse. Labels and capacity are defaults nobody asked about, and printing
 * them on every start trains you to skim past the line that does matter.
 */
console.log(`ogun-runner "${runner.name}" -> ${serverUrl}`)

const missing = ['claude', 'codex', 'docker'].filter((l) => !runner.labels.includes(l))
if (missing.length > 0) {
  // This one is worth saying: a job needing something absent is simply never claimed,
  // which looks like nothing happening rather than like a misconfiguration.
  console.log(`  cannot run jobs needing: ${missing.join(', ')}  —  \`ogun runner doctor\``)
}

/**
 * The image is what a job actually runs inside, and a stale one is silent: every
 * container starts, every run reports success, and the CLI inside it is whatever was
 * bundled the last time somebody thought to rebuild. That went unnoticed for a week here
 * — long enough for a fix to `ogun findings schema` never to reach a reviewer, and for a
 * bundle that would not load at all to sit undetected.
 *
 * Said once at startup rather than per job. The runner is long-lived, so per-job would be
 * noise, and this is a fact about the machine rather than about any one run. Not a
 * rebuild: §4.6 builds images at project-add time, not at 2am.
 */
const image = await imageState()
if (image.state !== 'current') {
  console.log(
    image.state === 'missing'
      ? '  ogun/base is not built — jobs needing a container will fail  —  `ogun image build`'
      : image.state === 'unstamped'
        ? '  ogun/base predates stamping, so it cannot be compared  —  `ogun image build`'
        : '  ogun/base was built from different source than this checkout — edited since,\n' +
          '  or another checkout on this machine built it  —  `ogun image build`',
  )
}

/**
 * The egress gateway, in this process rather than beside it.
 *
 * It could have been a service of its own — systemd unit, health endpoint, restart
 * policy. It is not, and the reason is that a separate service creates a state that does
 * not otherwise exist: the runner up and the gateway down. That state has to be detected,
 * reported, and decided about, and every one of those is a thing to get wrong at 3am. In
 * one process there is nothing to detect. If the runner is claiming jobs, the gateway is
 * listening, because they are the same object.
 *
 * Fail-closed, and deliberately so. The tempting alternative is to fall back to mounting
 * the host's credentials when the gateway cannot start — a job runs rather than fails.
 * That trades a loud failure for a silent one: the run completes, nothing looks wrong, and
 * the container is holding a live OAuth token exactly as it did before. A failed nightly
 * review costs a night. A leaked credential costs whatever the credential can reach.
 *
 * Restarts are §8's business: "run the server and runner under whatever supervises
 * services on that host". Ogun does not supervise itself.
 */
const tcp = process.env.OGUN_GATEWAY_HOST ?? process.env.OGUN_GATEWAY_PORT
const gateway = await startGateway(
  /**
   * A unix socket by default, because that is what makes the proxy unavoidable.
   *
   * On any network — bridge, host, a dedicated one — `HTTPS_PROXY` is *advice*: a
   * prompt-injected agent declines it with `curl --noproxy '*'` and reaches the internet
   * directly, and every credential-injection guarantee above it evaporates. A container run
   * `--network none` has no interface to decline with. The socket is a file, so it crosses
   * the boundary docker already crosses for the workspace, and it is the container's only
   * route out.
   *
   * TCP remains for the cases a socket cannot serve — a `worktree` sandbox, and anyone
   * pointing something at this by hand.
   */
  tcp
    ? {
        host: process.env.OGUN_GATEWAY_HOST ?? '127.0.0.1',
        ...(process.env.OGUN_GATEWAY_PORT ? { port: Number(process.env.OGUN_GATEWAY_PORT) } : {}),
      }
    : { socketPath: defaultSocketPath() },
).catch((err: Error) => {
  console.error(
    `\nogun-runner: the egress gateway could not start: ${err.message}\n` +
      '  Every sandbox authenticates through it, so jobs cannot run without it.\n' +
      '  Set OGUN_GATEWAY_HOST / OGUN_GATEWAY_PORT to listen on TCP instead,\n' +
      '  then `ogun runner doctor`.\n',
  )
  process.exit(1)
})

console.log(
  `  gateway on ${
    gateway.listening.kind === 'tcp'
      ? `${gateway.listening.host}:${gateway.listening.port}`
      : gateway.listening.path
  }`,
)
if (gateway.listening.kind === 'tcp') {
  /**
   * Worth saying, because TCP is not a smaller version of the socket — it is a mode in
   * which container sandboxes do not work at all. A `--network none` container has its
   * own network namespace and no interface, so it cannot reach a loopback listener in the
   * runner's. `provision()` refuses rather than starting a container that would reach
   * nothing, and this is the line that says why before a job is ever claimed.
   */
  console.log('  container sandboxes need the unix socket — unset OGUN_GATEWAY_HOST/PORT')
}

/**
 * What the job pipeline needs: where repos are on this disk, somewhere to work, and the
 * gateway every sandbox authenticates through.
 *
 * One gateway for the whole runner rather than one per job. It is the only process that
 * reads the host's real credentials and it holds a CA key that can impersonate every host
 * every container trusts, so a second copy per job would multiply that surface for
 * nothing: jobs are separated by the per-session token and per-session allowlist that
 * `open()` mints, which is a stronger boundary than a separate listener anyway — it
 * survives a container that outlives its `docker run`.
 */
const context = { projects: local.projects, scratch: runner.scratch, gateway }

if (!(await cp.authorized())) {
  console.error(
    `\nogun-runner: ${serverUrl} rejected this runner's token.\n` +
      '  It may have been revoked. Run `ogun runner invite` on the control plane for a\n' +
      '  new one, then `ogun runner join` here.\n',
  )
  process.exit(1)
}

const inFlight = new Set<string>()
let stopping = false

const tick = async (): Promise<void> => {
  const capacity = runner.maxConcurrentJobs - inFlight.size
  if (capacity <= 0 || stopping) return

  const jobs = await cp.claim(runner.name, runner.labels, capacity)
  for (const job of jobs) {
    inFlight.add(job.runId)
    console.log(`[runner] claimed ${job.workerName} (${job.projectSlug}) run=${job.runId}`)
    void executeJob(cp, context, job)
      .then((outcome) => console.log(`[runner] run=${job.runId} -> ${outcome}`))
      .catch((err) => console.error(`[runner] run=${job.runId} crashed`, err))
      .finally(() => inFlight.delete(job.runId))
  }
}

const loop = setInterval(() => {
  tick().catch((err) => console.error('[runner] claim failed:', err.message))
}, runner.pollIntervalMs)

const shutdown = () => {
  stopping = true
  clearInterval(loop)
  // In-flight jobs are allowed to finish rather than being orphaned — the stale-claim
  // sweep exists for crashes, not for a clean stop.
  const wait = setInterval(() => {
    if (inFlight.size === 0) {
      clearInterval(wait)
      // After the last job, not before: a container still finishing its run is still
      // making requests, and closing the gateway underneath it would fail the job we just
      // waited for.
      void gateway.close().finally(() => process.exit(0))
      return
    }
    console.log(`[runner] waiting on ${inFlight.size} in-flight job(s)`)
  }, 1000)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await tick().catch((err) => console.error('[runner] initial claim failed:', err.message))
