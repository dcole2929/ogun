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

/** Status is set, never deleted. `gated` and `overflow` carry reasons for the same
 *  reason: one bad call silently dropping a real finding is the failure mode (§4.12). */
findingsRoutes.patch('/:id', async (c) => {
  const { db } = c.var.ctx
  const body = statusPatch.parse(await c.req.json())
  const [row] = await db
    .update(findings)
    .set({
      status: body.status,
      ...(body.reason !== undefined ? { statusReason: body.reason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(findings.id, c.req.param('id')))
    .returning()
  if (!row) return c.json({ error: 'no such finding' }, 404)
  return c.json({ finding: row })
})
