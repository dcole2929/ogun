import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { singleWorkerCycle, triggerRunSchema } from '@ogun/core'
import type { Env } from '../context.ts'
import { startCycleRun } from '../foreman/cycles.ts'
import { probeCredentials, resetBreaker } from '../foreman/admission.ts'

const { cycles, jobs, projects, workers } = schema

export const triggerRoutes = new Hono<Env>()

/**
 * Manual trigger — the only trigger in phase 1. It goes through startCycleRun rather
 * than inserting a job directly, so the manual path and the eventual cron path are the
 * same code (§5.1).
 */
triggerRoutes.post('/', async (c) => {
  const { db } = c.var.ctx
  const body = triggerRunSchema.parse(await c.req.json())

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, body.projectSlug),
  })
  if (!project) return c.json({ error: `no such project: ${body.projectSlug}` }, 404)

  const worker = await db.query.workers.findFirst({
    where: and(eq(workers.projectId, project.id), eq(workers.name, body.worker)),
  })

  // The name may address a worker (one-node cycle) or a multi-node cycle directly.
  let cycle = await db.query.cycles.findFirst({
    where: and(eq(cycles.projectId, project.id), eq(cycles.name, body.worker)),
  })
  if (!cycle) {
    if (!worker) return c.json({ error: `no such worker or cycle: ${body.worker}` }, 404)
    const [created] = await db
      .insert(cycles)
      .values({
        projectId: project.id,
        name: body.worker,
        definition: singleWorkerCycle(body.worker),
      })
      .returning()
    cycle = created
  }
  if (!cycle) return c.json({ error: 'failed to resolve cycle' }, 500)

  // A prompt override is keyed by node, so one addressed to a multi-node cycle matches
  // nothing. Silently running the cycle with its configured prompts would look like the
  // override took effect.
  if (body.prompt && !worker) {
    return c.json(
      { error: `"${body.worker}" is a cycle — a prompt override has to name one worker` },
      400,
    )
  }

  /**
   * The credential preflight applies to a manual run too, and this is where it is most
   * useful to a person: the response carries each node's state, so pressing run against a
   * lapsed token comes back `skipped` with the reason and the fix in the coverage row,
   * within the second, instead of a container starting and 401-ing three minutes later.
   */
  const result = await startCycleRun(db, {
    cycleId: cycle.id,
    trigger: 'manual',
    credentials: probeCredentials(),
    ...(body.prompt ? { promptOverrides: { [body.worker]: body.prompt } } : {}),
  })

  const queued = await db
    .select({ id: jobs.id, state: jobs.state, nodeKey: jobs.nodeKey })
    .from(jobs)
    .where(eq(jobs.cycleRunId, result.cycleRunId))
  return c.json({ ...result, jobs: queued })
})

/** Clearing a breaker is a deliberate human act — it is the one guard that stays
 *  latched across restarts precisely so it can't clear itself (§4.3). */
triggerRoutes.post('/breaker/:workerId/reset', async (c) => {
  await resetBreaker(c.var.ctx.db, c.req.param('workerId'))
  return c.json({ ok: true })
})
