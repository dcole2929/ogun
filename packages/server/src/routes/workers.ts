import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import {
  hashContent,
  PERMISSION_PROFILES,
  RUNTIMES,
  SANDBOX_KINDS,
  singleWorkerCycle,
  workerSchema,
} from '@ogun/core'
import type { Env } from '../context.ts'

const { cycles, projects, skills, workers } = schema

/**
 * Workers created and edited here are `origin: 'ui'`, and `ogun project sync` never
 * touches one (see routes/projects.ts). That split is the whole design:
 *
 *   config — committed to git, reviewed, reproducible on another machine
 *   ui     — a few clicks, live in seconds, and yours alone until you export it
 *
 * The doc says git is the source of truth for definitions, and it still is — for what
 * is committed. Making the UI write YAML back into a repo would mean the control plane
 * needs filesystem access to every project, which §4.5 spent real effort avoiding.
 * Instead `GET /api/workers/:id/yaml` renders the block to paste into config.yaml, so
 * promoting an experiment into git is a copy rather than a rewrite.
 */
export const workersRoutes = new Hono<Env>()

const createSchema = z.object({
  projectSlug: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    // The name ends up in a container name and a cycle key, so keep it boring.
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug'),
  skill: z.string().min(1),
  runtime: z.enum(RUNTIMES).default('claude'),
  model: z.string().default('worker'),
  permissions: z.enum(PERMISSION_PROFILES).default('reviewer'),
  sandbox: z.enum(SANDBOX_KINDS).default('container'),
  prompt: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  enabled: z.boolean().default(true),
})

const updateSchema = createSchema.partial().omit({ projectSlug: true, name: true })

workersRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const slug = c.req.query('project')
  const project = slug
    ? await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
    : undefined
  if (slug && !project) return c.json({ error: 'no such project' }, 404)

  const rows = await db
    .select({ worker: workers, project: { slug: projects.slug } })
    .from(workers)
    .innerJoin(projects, eq(projects.id, workers.projectId))
    .where(project ? eq(workers.projectId, project.id) : undefined)
    .orderBy(workers.name)
  return c.json({ workers: rows })
})

workersRoutes.post('/', async (c) => {
  const { db } = c.var.ctx
  const body = createSchema.parse(await c.req.json())

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, body.projectSlug),
  })
  if (!project) return c.json({ error: `no such project: ${body.projectSlug}` }, 404)

  const existing = await db.query.workers.findFirst({
    where: and(eq(workers.projectId, project.id), eq(workers.name, body.name)),
  })
  if (existing) {
    return c.json(
      {
        error: `a worker named "${body.name}" already exists${
          existing.origin === 'config' ? ' and is defined in .ogun/config.yaml' : ''
        }`,
      },
      409,
    )
  }

  const skill = await db.query.skills.findFirst({
    where: and(eq(skills.projectId, project.id), eq(skills.name, body.skill)),
  })
  // A worker pointing at a skill that isn't there produces a run that reads a prompt
  // referencing nothing and reports something vague. Refuse up front instead.
  if (!skill) {
    return c.json(
      { error: `no skill named "${body.skill}" in ${body.projectSlug} — run \`ogun project sync\`` },
      400,
    )
  }
  if (body.permissions === 'modifier' && body.sandbox === 'worktree') {
    return c.json(
      { error: 'a modifier on the worktree sandbox edits files directly on the host' },
      400,
    )
  }

  const config = configFrom(body)
  const [row] = await db
    .insert(workers)
    .values({
      projectId: project.id,
      name: body.name,
      skillId: skill.id,
      skillRef: skill.name,
      runtime: body.runtime,
      modelRole: body.model,
      permissions: body.permissions,
      sandbox: body.sandbox,
      origin: 'ui',
      versionHash: hashContent('ui', JSON.stringify(config), skill.versionHash),
      config,
      enabled: body.enabled,
    })
    .returning()
  if (!row) return c.json({ error: 'failed to create worker' }, 500)

  // Every worker is a one-node cycle so "run this now" and the eventual nightly path
  // stay the same code (§5.1).
  await db
    .insert(cycles)
    .values({ projectId: project.id, name: body.name, definition: singleWorkerCycle(body.name) })
    .onConflictDoUpdate({
      target: [cycles.projectId, cycles.name],
      set: { definition: singleWorkerCycle(body.name) },
    })

  return c.json({ worker: row }, 201)
})

workersRoutes.patch('/:id', async (c) => {
  const { db } = c.var.ctx
  const body = updateSchema.parse(await c.req.json())
  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)

  /**
   * A config worker is editable only in the repo. Allowing an edit here would produce a
   * worker whose behaviour silently disagrees with the file it came from, and the next
   * sync would revert it — the worst of both.
   */
  if (worker.origin === 'config') {
    return c.json(
      {
        error:
          'this worker is defined in .ogun/config.yaml — edit it there and run `ogun project sync`',
      },
      409,
    )
  }

  const merged = { ...(worker.config as Record<string, unknown>), ...body }
  const skillName = body.skill ?? worker.skillRef
  const skill = await db.query.skills.findFirst({
    where: and(eq(skills.projectId, worker.projectId), eq(skills.name, skillName)),
  })
  if (!skill) return c.json({ error: `no skill named "${skillName}"` }, 400)

  const permissions = body.permissions ?? worker.permissions
  const sandbox = body.sandbox ?? worker.sandbox
  if (permissions === 'modifier' && sandbox === 'worktree') {
    return c.json(
      { error: 'a modifier on the worktree sandbox edits files directly on the host' },
      400,
    )
  }

  const [row] = await db
    .update(workers)
    .set({
      skillId: skill.id,
      skillRef: skill.name,
      runtime: body.runtime ?? (worker.runtime as 'claude' | 'codex'),
      modelRole: body.model ?? worker.modelRole,
      permissions,
      sandbox,
      enabled: body.enabled ?? worker.enabled,
      config: merged,
      // Bumped on every edit so a later run can answer whether a finding stopped
      // appearing because the code changed or because the worker did (§6).
      versionHash: hashContent('ui', JSON.stringify(merged), skill.versionHash),
    })
    .where(eq(workers.id, worker.id))
    .returning()
  return c.json({ worker: row })
})

workersRoutes.delete('/:id', async (c) => {
  const { db } = c.var.ctx
  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)
  if (worker.origin === 'config') {
    return c.json(
      { error: 'remove it from .ogun/config.yaml and run `ogun project sync`' },
      409,
    )
  }
  // Runs and findings cascade from the worker. Disabling keeps the history; deleting
  // is for a worker that was a mistake.
  await db.delete(workers).where(eq(workers.id, worker.id))
  await db
    .delete(cycles)
    .where(and(eq(cycles.projectId, worker.projectId), eq(cycles.name, worker.name)))
  return c.json({ deleted: worker.name })
})

/**
 * The stored config is validated against the same schema config.yaml is, so a UI worker
 * and a file worker are indistinguishable to everything downstream — the runner reads
 * this blob either way.
 */
const configFrom = (body: z.infer<typeof createSchema>): Record<string, unknown> =>
  workerSchema.parse({
    skill: body.skill,
    runtime: body.runtime,
    model: body.model,
    permissions: body.permissions,
    sandbox: body.sandbox,
    timeoutMs: body.timeoutMs,
    enabled: body.enabled,
    ...(body.prompt ? { prompt: body.prompt } : {}),
  }) as unknown as Record<string, unknown>

/** The promotion path: render the config.yaml block for a UI worker. */
workersRoutes.get('/:id/yaml', async (c) => {
  const { db } = c.var.ctx
  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)
  const cfg = worker.config as Record<string, unknown>

  const lines = [
    `  ${worker.name}:`,
    `    skill: ${worker.skillRef}`,
    `    runtime: ${worker.runtime}`,
    `    model: ${worker.modelRole}`,
    `    permissions: ${worker.permissions}`,
    `    sandbox: ${worker.sandbox}`,
  ]
  if (typeof cfg.prompt === 'string' && cfg.prompt) {
    lines.push(`    prompt: ${JSON.stringify(cfg.prompt)}`)
  }
  if (typeof cfg.timeoutMs === 'number' && cfg.timeoutMs !== 30 * 60_000) {
    lines.push(`    timeoutMs: ${cfg.timeoutMs}`)
  }
  if (worker.enabled === false) lines.push('    enabled: false')

  return c.json({ yaml: lines.join('\n') })
})
