import { Hono } from 'hono'
import { and, arrayContained, eq, isNull, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { claimRequestSchema, claimedJobSchema, type ClaimedJob } from '@ogun/core'
import type { Env } from '../context.ts'
import { DEFAULT_LIMITS, remainingCapacity } from '../foreman/admission.ts'
import { markCoverage } from '../foreman/cycles.ts'

const { jobs, projects, runners, runs, workers } = schema

const globalLimits = {
  ...DEFAULT_LIMITS,
  maxConcurrentJobs: Number(process.env.OGUN_MAX_CONCURRENT_JOBS ?? DEFAULT_LIMITS.maxConcurrentJobs),
}

export const jobsRoutes = new Hono<Env>()

jobsRoutes.post('/claim', async (c) => {
  const { db } = c.var.ctx
  const body = claimRequestSchema.parse(await c.req.json())

  // A claim is also the heartbeat, and the moment a pending enrollment becomes real.
  const runner = await db.query.runners.findFirst({
    where: and(eq(runners.name, body.runnerName), isNull(runners.revokedAt)),
  })
  if (!runner) {
    // Registration happens at join, so a claim from an unknown name means the runner was
    // revoked or forgotten out from under a still-running process. Saying so beats
    // silently re-creating the row it was removed from.
    return c.json(
      { error: `no live runner called "${body.runnerName}" — re-run \`ogun runner join\`` },
      404,
    )
  }
  await db
    .update(runners)
    .set({
      labels: body.labels,
      maxConcurrency: body.capacity,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
      pending: false,
    })
    .where(eq(runners.id, runner.id))

  /**
   * The runner's `capacity` is what *it* has free; this is what the *machine* has free.
   * The claim takes the smaller, or a runner that just started could take the whole
   * queue regardless of what else is already running.
   */
  const slots = Math.min(body.capacity, await remainingCapacity(db, globalLimits))
  if (slots <= 0) return c.json({ jobs: [] })

  /**
   * FOR UPDATE SKIP LOCKED is the whole reason postgres is here (§4.4). Two runners
   * polling at the same instant take disjoint sets without a lock table or a lease.
   *
   * `requires <@ labels` — a job's capability requirements must be a subset of what the
   * runner advertises, so a machine without docker never claims a container job.
   */
  const claimed = await db.execute(sql`
    update ${jobs} set
      state = 'claimed',
      claimed_by = ${body.runnerName},
      claimed_at = now(),
      attempts = ${jobs.attempts} + 1
    where ${jobs.id} in (
      select ${jobs.id} from ${jobs}
      where ${jobs.state} = 'queued'
        and ${jobs.availableAt} <= now()
        and ${arrayContained(jobs.requires, body.labels)}
      order by ${jobs.priority} desc, ${jobs.createdAt} asc
      limit ${slots}
      for update skip locked
    )
    returning ${jobs.id} as id
  `)

  const ids = [...claimed].map((r) => String((r as { id: string }).id))
  if (ids.length === 0) return c.json({ jobs: [] })

  const out: ClaimedJob[] = []
  for (const id of ids) {
    const row = await db
      .select({ job: jobs, worker: workers, project: projects })
      .from(jobs)
      .innerJoin(workers, eq(workers.id, jobs.workerId))
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(eq(jobs.id, id))
      .limit(1)
    const found = row[0]
    if (!found) continue

    /**
     * The run row is created here, at claim, not at completion. Admission consumes the
     * budget rather than success does — a job that crashes before finishing still
     * counts, otherwise a crash loop bypasses every guard (§4.3).
     */
    const [run] = await db
      .insert(runs)
      .values({
        jobId: found.job.id,
        runnerId: runner.id,
        runnerName: runner.name,
        runtime: found.worker.runtime,
        model: found.worker.modelRole,
        workerVersion: found.worker.versionHash,
      })
      .returning()
    if (!run) continue

    const config = found.worker.config as Record<string, unknown>
    out.push(
      claimedJobSchema.parse({
        jobId: found.job.id,
        runId: run.id,
        cycleRunId: found.job.cycleRunId,
        projectSlug: found.project.slug,
        projectDefaultBranch: found.project.defaultBranch,
        ...(found.project.remoteUrl ? { remoteUrl: found.project.remoteUrl } : {}),
        workerId: found.worker.id,
        workerName: found.worker.name,
        workerVersion: found.worker.versionHash,
        nodeKey: found.job.nodeKey,
        prompt: found.job.prompt,
        runtime: found.worker.runtime,
        model: found.worker.modelRole,
        permissions: found.worker.permissions,
        sandbox: found.worker.sandbox,
        timeoutMs: Number(config.timeoutMs ?? 30 * 60_000),
        skillRef: found.worker.skillRef,
        verify: config.verify,
        // Already incremented by the claim update above.
        attempt: found.job.attempts,
      }),
    )
  }

  return c.json({ jobs: out })
})

jobsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const state = c.req.query('state')
  const rows = await db
    .select({ job: jobs, worker: workers })
    .from(jobs)
    .innerJoin(workers, eq(workers.id, jobs.workerId))
    .where(state ? eq(jobs.state, state) : undefined)
    .orderBy(sql`${jobs.createdAt} desc`)
    .limit(100)
  return c.json({ jobs: rows })
})

/** Only a queued job can be cancelled; one already claimed belongs to a runner. */
jobsRoutes.post('/:id/cancel', async (c) => {
  const { db } = c.var.ctx
  const [cancelled] = await db
    .update(jobs)
    .set({ state: 'skipped' })
    .where(and(eq(jobs.id, c.req.param('id')), eq(jobs.state, 'queued')))
    .returning()
  if (!cancelled) return c.json({ cancelled: false })

  // The ledger has to say so. A cancelled job left at `pending` claims it is still
  // waiting for a runner, in the one table whose entire purpose is to be true about what
  // ran (principle 6).
  await markCoverage(db, cancelled.cycleRunId, cancelled.workerId, {
    outcome: 'cancelled',
    reason: 'cancelled before it ran',
  })
  return c.json({ cancelled: true })
})
