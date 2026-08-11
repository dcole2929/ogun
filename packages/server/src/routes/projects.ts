import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import {
  cycleDefinitionSchema,
  hashContent,
  policiesSchema,
  singleWorkerCycle,
  workerSchema,
} from '@ogun/core'
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
        ...(s.displayName ? { displayName: s.displayName } : {}),
        ...(s.shortDescription ? { shortDescription: s.shortDescription } : {}),
        ...(s.defaultPrompt ? { defaultPrompt: s.defaultPrompt } : {}),
      })
      .onConflictDoUpdate({
        target: [skills.projectId, skills.name],
        set: {
          sourcePath: s.sourcePath,
          versionHash: s.versionHash,
          displayName: s.displayName ?? null,
          shortDescription: s.shortDescription ?? null,
          defaultPrompt: s.defaultPrompt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (row) skillIds.set(s.name, row.id)
  }

  const workerIds = new Map<string, string>()
  for (const [name, w] of Object.entries(body.workers)) {
    const skillName = w.skill.replace(/^\.\/skills\//, '').replace(/^ogun:\/\//, '')
    const skillId = skillIds.get(skillName)
    const skillVersion = body.skills.find((s) => s.name === skillName)?.versionHash ?? 'unknown'
    // worker_version folds in the skill so a later run can answer: did this finding stop
    // appearing because we fixed the code, or because I edited the skill? (§6)
    const versionHash = hashContent(body.configHash, JSON.stringify(w), skillVersion)

    const [row] = await db
      .insert(workers)
      .values({
        projectId: project.id,
        name,
        ...(skillId ? { skillId } : {}),
        skillRef: skillName,
        runtime: w.runtime,
        modelRole: w.model,
        permissions: w.permissions,
        sandbox: w.sandbox,
        versionHash,
        config: w as unknown as Record<string, unknown>,
        enabled: w.enabled,
      })
      .onConflictDoUpdate({
        target: [workers.projectId, workers.name],
        set: {
          skillId: skillId ?? null,
          skillRef: skillName,
          runtime: w.runtime,
          modelRole: w.model,
          permissions: w.permissions,
          sandbox: w.sandbox,
          versionHash,
          config: w as unknown as Record<string, unknown>,
          enabled: w.enabled,
        },
      })
      .returning()
    if (row) workerIds.set(name, row.id)
  }

  // Every worker gets a one-node cycle so "run this worker now" and "run the nightly
  // cycle" are the same code path from the first commit (§5.1).
  for (const name of Object.keys(body.workers)) {
    await db
      .insert(cycles)
      .values({ projectId: project.id, name, definition: singleWorkerCycle(name) })
      .onConflictDoUpdate({
        target: [cycles.projectId, cycles.name],
        set: { definition: singleWorkerCycle(name) },
      })
  }
  for (const [name, definition] of Object.entries(body.cycles)) {
    await db
      .insert(cycles)
      .values({ projectId: project.id, name, definition })
      .onConflictDoUpdate({ target: [cycles.projectId, cycles.name], set: { definition } })
  }

  return c.json({
    project: { id: project.id, slug: project.slug },
    workers: [...workerIds.keys()],
    skills: [...skillIds.keys()],
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
