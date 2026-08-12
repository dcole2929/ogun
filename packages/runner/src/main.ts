import { loadRunnerConfig, RunnerConfigError } from '@ogun/core'
import { ControlPlane } from './client.ts'
import { executeJob } from './pipeline.ts'

const config = await loadRunnerConfig().catch((err) => {
  if (err instanceof RunnerConfigError) {
    console.error(`\nogun-runner: ${err.message}\n`)
    process.exit(1)
  }
  throw err
})
const serverUrl = process.env.OGUN_SERVER_URL ?? config.serverUrl
// Env first so a systemd unit can supply it from a secret store, then runner.json,
// which is where `ogun runner join` puts it.
const cp = new ControlPlane(serverUrl, process.env.OGUN_TOKEN?.trim() || config.token)

console.log(
  `ogun-runner "${config.runnerId}" -> ${serverUrl}\n` +
    `  labels:   ${config.labels.join(', ') || '(none)'}\n` +
    `  projects: ${Object.keys(config.projects).join(', ') || '(none)'}\n` +
    `  capacity: ${config.maxConcurrentJobs}`,
)

const inFlight = new Set<string>()
let stopping = false

if (!(await cp.authorized())) {
  console.error(
    `\nogun-runner: ${serverUrl} rejected this runner.\n` +
      '  A control plane bound beyond localhost requires a shared secret.\n' +
      '  Set OGUN_TOKEN to the same value the server was started with.\n',
  )
  process.exit(1)
}

const tick = async (): Promise<void> => {
  const capacity = config.maxConcurrentJobs - inFlight.size
  if (capacity <= 0 || stopping) return

  const jobs = await cp.claim(config.runnerId, config.labels, capacity)
  for (const job of jobs) {
    inFlight.add(job.runId)
    console.log(`[runner] claimed ${job.workerName} (${job.projectSlug}) run=${job.runId}`)
    void executeJob(cp, config, job)
      .then((outcome) => console.log(`[runner] run=${job.runId} -> ${outcome}`))
      .catch((err) => console.error(`[runner] run=${job.runId} crashed`, err))
      .finally(() => inFlight.delete(job.runId))
  }
}

const loop = setInterval(() => {
  tick().catch((err) => console.error('[runner] claim failed:', err.message))
}, config.pollIntervalMs)

const shutdown = () => {
  stopping = true
  clearInterval(loop)
  // Let in-flight jobs finish rather than orphaning their runs — the stale-claim sweep
  // exists for crashes, not for a clean stop.
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
