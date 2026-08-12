import { loadLocalConfig, LocalConfigError } from '@ogun/core'
import { ControlPlane } from './client.ts'
import { executeJob } from './pipeline.ts'

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

// What the job pipeline needs: where repos are on this disk, and somewhere to work.
const context = { projects: local.projects, scratch: runner.scratch }

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
      process.exit(0)
    }
    console.log(`[runner] waiting on ${inFlight.size} in-flight job(s)`)
  }, 1000)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await tick().catch((err) => console.error('[runner] initial claim failed:', err.message))
