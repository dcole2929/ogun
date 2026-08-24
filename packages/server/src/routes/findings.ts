import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import { FINDING_STATUSES } from '@ogun/core'
import type { Env } from '../context.ts'

const { findings, projects, workers } = schema

export const findingsRoutes = new Hono<Env>()

findingsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const slug = c.req.query('project')
  const status = c.req.query('status')?.split(',').filter(Boolean)

  const project = slug
    ? await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
    : undefined
  if (slug && !project) return c.json({ error: 'no such project' }, 404)

  const where = [
    project ? eq(findings.projectId, project.id) : undefined,
    status?.length ? inArray(findings.status, status) : undefined,
  ].filter(Boolean)

  const rows = await db
    .select({ finding: findings, worker: { name: workers.name }, project: { slug: projects.slug } })
    .from(findings)
    .leftJoin(workers, eq(workers.id, findings.workerId))
    .innerJoin(projects, eq(projects.id, findings.projectId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(findings.updatedAt))
    .limit(Number(c.req.query('limit') ?? 200))
  return c.json({ findings: rows })
})

const statusPatch = z.object({
  status: z.enum(FINDING_STATUSES),
  reason: z.string().optional(),
})

/**
 * Status is set, never deleted. `gated` and `overflow` carry reasons for the same
 * reason: one bad call silently dropping a real finding is the failure mode (§4.12).
 *
 * This is also the only route to `wontfix`, and therefore the only place a *dismissal* is
 * created (§4.11). `applyAdjudications` refuses that status outright, so nothing running
 * unattended at 3am can decide on a person's behalf that the factory should stay quiet
 * about something — and because it is a person, the dismissal is anchored here rather
 * than by a run.
 *
 * The anchor is the finding's `snippet`: the cited code as the last run that saw it read
 * it off the disk. Freezing it is what keeps a dismissal from being permanent by
 * accident. Dismiss "this retry loop is fine", let somebody rewrite the retry loop into
 * something genuinely broken, and a dismissal with no anchor would keep the one worker
 * positioned to notice permanently silent; with one, the code it was about is gone and
 * the dismissal lapses on the next sighting.
 *
 * Cleared on every status that is not `wontfix`, including a return to `open`. A basis
 * left behind on an open finding would re-arm the old suppression the moment anybody set
 * the status back, on evidence nobody re-examined.
 *
 * `statusRun` is nulled either way. It records which *run* last set the status, and a
 * person overruling a run's verdict must not leave that run's id sitting under a decision
 * it did not make (principle 6).
 */
findingsRoutes.patch('/:id', async (c) => {
  const { db } = c.var.ctx
  const body = statusPatch.parse(await c.req.json())
  const id = c.req.param('id')

  const current = await db.query.findings.findFirst({ where: eq(findings.id, id) })
  if (!current) return c.json({ error: 'no such finding' }, 404)

  const dismissal =
    body.status === 'wontfix'
      ? {
          dismissedAt: new Date(),
          dismissedSeverity: current.severity,
          // Null when the runner could never take a usable excerpt for this finding. The
          // dismissal still holds — a person's decision is not void because Ogun failed
          // to record enough — and every suppression it produces says the basis is
          // unrecorded, so it is visible rather than assumed.
          dismissedBasis: current.snippet,
          dismissedBasisPath: current.path,
        }
      : {
          dismissedAt: null,
          dismissedSeverity: null,
          dismissedBasis: null,
          dismissedBasisPath: null,
        }

  const [row] = await db
    .update(findings)
    .set({
      status: body.status,
      ...(body.reason !== undefined ? { statusReason: body.reason } : {}),
      statusRun: null,
      ...dismissal,
      updatedAt: new Date(),
    })
    .where(eq(findings.id, id))
    .returning()
  if (!row) return c.json({ error: 'no such finding' }, 404)
  return c.json({ finding: row })
})
