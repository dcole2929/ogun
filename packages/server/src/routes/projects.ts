import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import { cycleDefinitionSchema, policiesSchema, workerSchema } from '@ogun/core'
import { reindexProject } from '../reindex.ts'
import type { Env } from '../context.ts'

const { coverage, cycleRuns, cycles, projects, skills, workers } = schema

/**
 * The CLI reads the repo and posts the resolved config here — the server never touches
 * a project's filesystem. That keeps absolute paths out of the database entirely (§4.5)
 * and is the same shape a remote control plane would need.
 */
const syncSchema = z.object({
  slug: z.string().min(1),
  defaultBranch: z.string().default('main'),
  remoteUrl: z.string().optional(),
  configHash: z.string(),
  workers: z.record(z.string(), workerSchema),
  policies: policiesSchema,
  skills: z
    .array(
      z.object({
        name: z.string(),
        sourcePath: z.string(),
        versionHash: z.string(),
        displayName: z.string().optional(),
        shortDescription: z.string().optional(),
        defaultPrompt: z.string().optional(),
        origin: z.enum(['project', 'machine', 'builtin']).default('project'),
        body: z.string().optional(),
        referencePaths: z.array(z.string()).default([]),
        allowImplicitInvocation: z.boolean().default(false),
      }),
    )
    .default([]),
  cycles: z.record(z.string(), cycleDefinitionSchema).default({}),
})

export const projectsRoutes = new Hono<Env>()

projectsRoutes.post('/sync', async (c) => {
  const { db } = c.var.ctx
  const body = syncSchema.parse(await c.req.json())

  const [project] = await db
    .insert(projects)
    .values({
      slug: body.slug,
      defaultBranch: body.defaultBranch,
      ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
    })
    .onConflictDoUpdate({
      target: projects.slug,
      set: {
        defaultBranch: body.defaultBranch,
        ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
      },
    })
    .returning()
  if (!project) return c.json({ error: 'failed to upsert project' }, 500)

  const skillIds = new Map<string, string>()
  for (const s of body.skills) {
    const [row] = await db
      .insert(skills)
      .values({
        projectId: project.id,
        name: s.name,
        sourcePath: s.sourcePath,
        versionHash: s.versionHash,
        origin: s.origin,
        referencePaths: s.referencePaths,
        allowImplicitInvocation: s.allowImplicitInvocation,
        ...(s.displayName ? { displayName: s.displayName } : {}),
        ...(s.shortDescription ? { shortDescription: s.shortDescription } : {}),
        ...(s.defaultPrompt ? { defaultPrompt: s.defaultPrompt } : {}),
        ...(s.body ? { body: s.body } : {}),
      })
      // Wholesale overwrite, including nulling fields that disappeared. This row is an
      // index of what is on disk, so a stale half of it is worse than none.
      .onConflictDoUpdate({
        target: [skills.projectId, skills.name],
        set: {
          sourcePath: s.sourcePath,
          versionHash: s.versionHash,
          origin: s.origin,
          referencePaths: s.referencePaths,
          allowImplicitInvocation: s.allowImplicitInvocation,
          displayName: s.displayName ?? null,
          shortDescription: s.shortDescription ?? null,
          defaultPrompt: s.defaultPrompt ?? null,
          body: s.body ?? null,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (row) skillIds.set(s.name, row.id)
  }

  const { workers: indexed, removed, overriddenSchedules } = await reindexProject(
    db,
    project.slug,
    { hash: body.configHash, workers: body.workers, cycles: body.cycles },
  )

  return c.json({
    project: { id: project.id, slug: project.slug },
    workers: Object.keys(indexed),
    skills: [...skillIds.keys()],
    removed,
    overriddenSchedules,
  })
})

projectsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const rows = await db.select().from(projects).orderBy(projects.slug)
  return c.json({ projects: rows })
})

projectsRoutes.get('/:slug/workers', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('slug')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)
  const rows = await db
    .select()
    .from(workers)
    .where(eq(workers.projectId, project.id))
    .orderBy(workers.name)
  return c.json({ workers: rows })
})

projectsRoutes.get('/:slug/cycles', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('slug')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)
  const rows = await db
    .select()
    .from(cycles)
    .where(eq(cycles.projectId, project.id))
    .orderBy(cycles.name)
  return c.json({ cycles: rows })
})

/** The coverage ledger for a batch — what was selected, what ran, and why not (§4.11). */
projectsRoutes.get('/:slug/coverage', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('slug')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)
  const rows = await db
    .select({ coverage, cycleRun: cycleRuns, cycle: cycles, worker: { name: workers.name } })
    .from(coverage)
    .innerJoin(cycleRuns, eq(cycleRuns.id, coverage.cycleRunId))
    .innerJoin(cycles, eq(cycles.id, cycleRuns.cycleId))
    .innerJoin(workers, eq(workers.id, coverage.workerId))
    .where(and(eq(cycles.projectId, project.id)))
    .orderBy(desc(cycleRuns.startedAt))
    .limit(200)
  return c.json({ coverage: rows })
})
