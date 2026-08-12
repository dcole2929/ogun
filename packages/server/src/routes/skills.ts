import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'

const { projects, skills, workers } = schema

/**
 * Skills are the durable artifact — a worker is a thin binding of one to a runtime
 * (principle 2). Until now they existed only on disk and in a row nobody could read,
 * which made "what will this worker actually do?" an unanswerable question from
 * anywhere but a text editor.
 *
 * These rows are an index of git, refreshed wholesale by `ogun project sync`. Editing a
 * skill happens in the repo, not here.
 */
export const skillsRoutes = new Hono<Env>()

skillsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const slug = c.req.query('project')

  const project = slug
    ? await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
    : undefined
  if (slug && !project) return c.json({ error: 'no such project' }, 404)

  const rows = await db
    .select({ skill: skills, project: { slug: projects.slug } })
    .from(skills)
    .leftJoin(projects, eq(projects.id, skills.projectId))
    .where(project ? eq(skills.projectId, project.id) : undefined)
    .orderBy(skills.name)

  // Which workers bind each skill. A skill nothing points at is dead weight, and that
  // is only visible if the two are shown together.
  const bindings = await db
    .select({
      skillRef: workers.skillRef,
      projectId: workers.projectId,
      name: workers.name,
      id: workers.id,
      runtime: workers.runtime,
      enabled: workers.enabled,
      origin: workers.origin,
    })
    .from(workers)

  return c.json({
    skills: rows.map((r) => ({
      ...r,
      // Body is often several KB; the list view doesn't need it.
      skill: { ...r.skill, body: undefined, bodyLength: r.skill.body?.length ?? 0 },
      workers: bindings.filter(
        (w) => w.skillRef === r.skill.name && w.projectId === r.skill.projectId,
      ),
    })),
  })
})

skillsRoutes.get('/:project/:name', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('project')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)

  const skill = await db.query.skills.findFirst({
    where: and(eq(skills.projectId, project.id), eq(skills.name, c.req.param('name'))),
  })
  if (!skill) return c.json({ error: 'no such skill' }, 404)

  const bound = await db
    .select({
      id: workers.id,
      name: workers.name,
      runtime: workers.runtime,
      permissions: workers.permissions,
      sandbox: workers.sandbox,
      enabled: workers.enabled,
      origin: workers.origin,
    })
    .from(workers)
    .where(and(eq(workers.projectId, project.id), eq(workers.skillRef, skill.name)))

  return c.json({ skill, workers: bound, project: { slug: project.slug } })
})
