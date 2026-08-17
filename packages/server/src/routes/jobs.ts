import { Hono } from 'hono'
import { and, arrayContained, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { claimRequestSchema, claimedJobSchema, type ClaimedJob } from '@ogun/core'
import type { Env } from '../context.ts'
import { DEFAULT_LIMITS, remainingCapacity } from '../foreman/admission.ts'
import { markCoverage } from '../foreman/cycles.ts'

const { findings, jobs, projects, runners, runs, stagedFindings, workers } = schema

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

/**
 * What a job's upstream nodes produced.
 *
 * A triage node reads findings rather than a repository (§4.12), and those findings come
 * from jobs that have already finished in the same cycle run. The runner fetches this and
 * writes it into the workspace, so the skill's input is a file rather than a database
 * query it has no way to make from inside a sandbox.
 *
 * Includes the reviewers that produced nothing and the ones that failed, because triage
 * assembles the coverage picture and cannot do that from findings alone — four reviewers
 * where one crashed is a different night from three reviewers that all ran.
 *
 * Runner-scoped, and not bound to the runner that claimed the job — the same as the run
 * reporting endpoints. Runners are your own machines and are trusted peers; if that ever
 * stops being true, this and `/api/runs/:id/*` need the same ownership check, not
 * different ones.
 */
jobsRoutes.get('/:id/inputs', async (c) => {
  const { db } = c.var.ctx
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, c.req.param('id')) })
  if (!job) return c.json({ error: 'no such job' }, 404)

  const upstream = await db
    .select({
      job: { nodeKey: jobs.nodeKey, state: jobs.state },
      worker: { name: jobs.workerName },
      run: { id: runs.id, outcome: runs.outcome, detail: runs.detail },
    })
    .from(jobs)
    .leftJoin(runs, eq(runs.jobId, jobs.id))
    .where(and(eq(jobs.cycleRunId, job.cycleRunId), inArray(jobs.nodeKey, job.dependsOn)))

  const sources = []
  for (const row of upstream) {
    const staged = row.run?.id
      ? await db.select().from(stagedFindings).where(eq(stagedFindings.runId, row.run.id))
      : []
    sources.push({
      worker: row.worker.name,
      node: row.job.nodeKey,
      outcome: row.run?.outcome ?? row.job.state,
      /**
       * Named so triage can say "three of four reviewers ran" rather than inferring it —
       * which means it has to be false for a reviewer that started and died. It was
       * `Boolean(row.run?.outcome)`, and a crashed run has an outcome (`error`), so a
       * night where a reviewer never reviewed still reported four of four. The staged
       * findings are empty either way, so nothing downstream corrected it: triage would
       * read a full complement of reviewers and an empty result set as a clean surface.
       *
       * `skipped` is the same fact arriving by a different route — admission refused it,
       * so no review happened.
       */
      ran: row.run?.outcome === 'approved' || row.run?.outcome === 'changes-requested',
      detail: row.run?.detail ?? null,
      findings: staged.map((f) => f.raw),
    })
  }

  return c.json({
    cycleRunId: job.cycleRunId,
    /** True when a dependency did not succeed, so triage marks the batch incomplete. */
    degraded: sources.some((s) => s.outcome !== 'approved'),
    sources,
  })
})

jobsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const state = c.req.query('state')
  const rows = await db
    .select({ job: jobs, worker: { id: workers.id, name: jobs.workerName } })
    .from(jobs)
    .leftJoin(workers, eq(workers.id, jobs.workerId))
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
  await markCoverage(db, cancelled.cycleRunId, cancelled, {
    outcome: 'cancelled',
    reason: 'cancelled before it ran',
  })
  return c.json({ cancelled: true })
})

/**
 * What this project's inbox already says, for a job that is about to review it.
 *
 * A reviewer is one run in a series, and re-reporting something already known costs the
 * reader attention and teaches them to skim. Both review skills therefore open by
 * checking what has already been said — and until now they did it by shelling out to
 * `ogun findings list`, which cannot work: the sandbox has no route to the control plane
 * (§4.12), so the command failed on every run and every reviewer worked with no memory.
 *
 * Same shape as `/inputs`: the runner fetches this and writes it into the workspace, so
 * the skill reads a file rather than making a query it has no way to make. Nothing new
 * is exposed to the sandbox.
 *
 * Two representations, because the reviewer asks two different questions at two different
 * moments (§4.11):
 *
 *   - `index`   — one compact record per finding. Answers "is this surface already
 *                 accounted for?", which is exactly what the fingerprint encodes. Small
 *                 enough to read whole.
 *   - `details` — the full body, keyed by fingerprint, written to disk as separate files
 *                 and opened only for the findings that turn out to matter. The body
 *                 carries the previous reviewer's *argument*, and reading sixteen of
 *                 those is how a reviewer stops generating hypotheses and starts
 *                 pattern-matching someone else's.
 *
 * `duplicate` and `obsolete` are excluded: both describe something that is not in the
 * current tree — one collapsed into another finding, the other pointing at a surface that
 * no longer exists — so neither can help decide whether a surface is taken, and both
 * would grow without bound. `fixed` stays, because a fixed finding reappearing is a
 * regression and that is worth catching. `wontfix` stays, because re-litigating a
 * decision is the loudest noise a reviewer makes. Everything else is included and
 * labelled: "seen and set aside" and "never looked at" are different facts (principle 6).
 */
jobsRoutes.get('/:id/history', async (c) => {
  const { db } = c.var.ctx
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, c.req.param('id')) })
  if (!job) return c.json({ error: 'no such job' }, 404)

  const rows = await db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.projectId, job.projectId),
        notInArray(findings.status, ['duplicate', 'obsolete']),
      ),
    )
    .orderBy(desc(findings.updatedAt))
    .limit(Number(c.req.query('limit') ?? 500))

  return c.json({
    index: rows.map((f) => ({
      fingerprint: f.fingerprint,
      status: f.status,
      severity: f.severity,
      title: f.title,
      ...(f.path ? { path: f.path } : {}),
      seenCount: f.seenCount,
      lastSeenAt: f.updatedAt.toISOString(),
      ...(f.statusReason ? { statusReason: f.statusReason } : {}),
    })),
    details: Object.fromEntries(rows.map((f) => [f.fingerprint, f.body])),
  })
})
