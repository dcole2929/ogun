import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import {
  PERMISSION_PROFILES,
  RUNTIMES,
  SANDBOX_KINDS,
  workerSchema,
  type WorkerConfig,
} from '@ogun/core'
import type { Env } from '../context.ts'
import {
  ConfigConflict,
  ConfigUnreachable,
  workerToYamlBlock,
  workerToYamlNode,
} from '../config-store.ts'
import { reindexProject } from '../reindex.ts'

const { projects, skills, workers } = schema

/**
 * Creating a worker in the UI edits the repo's `.ogun/config.yaml` and re-indexes from
 * it. There is one definition of a worker and it is in git, reviewable in a diff — the
 * UI is an editor over that file, not a second place a worker can live.
 *
 * The file is written but never committed. That is deliberate: the uncommitted diff *is*
 * the review step, and auto-committing to someone's working branch is not ours to do.
 */
export const workersRoutes = new Hono<Env>()

const workerFields = z.object({
  skill: z.string().min(1),
  runtime: z.enum(RUNTIMES).default('claude'),
  model: z.string().default('worker'),
  permissions: z.enum(PERMISSION_PROFILES).default('reviewer'),
  sandbox: z.enum(SANDBOX_KINDS).default('container'),
  prompt: z.string().optional(),
  schedule: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
})

const createSchema = workerFields.extend({
  projectSlug: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    // Ends up as a yaml key, a container name, and a cycle node key. Keep it boring.
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug'),
  /** Compare-and-swap token from a prior read. Absent means "I have not read it". */
  expectedHash: z.string().optional(),
})

/**
 * Spelled out rather than derived from `workerFields.partial()`. `.partial()` makes a
 * field optional but leaves its `.default()` in place, so a PATCH of `{runtime}` came
 * back carrying `model: 'worker'` and silently reset a field the client never mentioned.
 * A patch must say nothing about what it does not send.
 */
const updateSchema = z.object({
  skill: z.string().min(1).optional(),
  runtime: z.enum(RUNTIMES).optional(),
  model: z.string().optional(),
  permissions: z.enum(PERMISSION_PROFILES).optional(),
  sandbox: z.enum(SANDBOX_KINDS).optional(),
  /** An empty string clears it — the only way to remove a prompt override. */
  prompt: z.string().optional(),
  schedule: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  expectedHash: z.string().optional(),
})

workersRoutes.get('/', async (c) => {
  const { db, config } = c.var.ctx
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

  // Whether this control plane can edit each project's config.yaml. The UI needs it up
  // front so it can offer a copy-this-yaml fallback rather than a button that 409s.
  const slugs = [...new Set(rows.map((r) => r.project.slug))]
  const editable: Record<string, boolean> = {}
  const hashes: Record<string, string> = {}
  for (const s of slugs) {
    editable[s] = await config.writable(s)
    if (editable[s]) hashes[s] = (await config.read(s)).hash
  }

  return c.json({ workers: rows, editable, hashes })
})

workersRoutes.post('/', async (c) => {
  const { db, config } = c.var.ctx
  const body = createSchema.parse(await c.req.json())

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, body.projectSlug),
  })
  if (!project) return c.json({ error: `no such project: ${body.projectSlug}` }, 404)

  const invalid = await validate(c.var.ctx.db, project.id, body)
  if (invalid) return c.json({ error: invalid }, 400)

  const existing = await db.query.workers.findFirst({
    where: and(eq(workers.projectId, project.id), eq(workers.name, body.name)),
  })
  if (existing) return c.json({ error: `a worker named "${body.name}" already exists` }, 409)

  const fields = toWorkerConfig(body)
  try {
    const file = await config.mutate(body.projectSlug, body.expectedHash, (doc) => {
      // setIn creates `workers:` if the file somehow lacks it, so a minimal config.yaml
      // still works.
      doc.setIn(['workers', body.name], workerToYamlNode(fields))
    })
    const result = await reindexProject(db, body.projectSlug, file)
    return c.json({ worker: result.workers[body.name], config: describe(file) }, 201)
  } catch (err) {
    const f = handle(err, body.projectSlug, body.name, fields)
    return c.json(f.body, f.status)
  }
})

workersRoutes.patch('/:id', async (c) => {
  const { db, config } = c.var.ctx
  const body = updateSchema.parse(await c.req.json())

  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, worker.projectId) })
  if (!project) return c.json({ error: 'no such project' }, 404)

  const merged = { ...(worker.config as Record<string, unknown>), ...stripUndefined(body) }
  const invalid = await validate(db, project.id, merged as z.infer<typeof workerFields>)
  if (invalid) return c.json({ error: invalid }, 400)

  const fields = toWorkerConfig(merged as z.infer<typeof workerFields>)
  try {
    const file = await config.mutate(project.slug, body.expectedHash, (doc) => {
      // Set each key individually rather than replacing the node, so any comment a human
      // wrote against an untouched field survives the edit.
      const node = workerToYamlNode(fields)
      for (const [key, value] of Object.entries(node)) {
        doc.setIn(['workers', worker.name, key], value)
      }
      const stale = Object.keys((worker.config as Record<string, unknown>) ?? {}).filter(
        (k) => !(k in node),
      )
      for (const key of stale) doc.deleteIn(['workers', worker.name, key])
    })
    const result = await reindexProject(db, project.slug, file)
    return c.json({ worker: result.workers[worker.name], config: describe(file) })
  } catch (err) {
    const f = handle(err, project.slug, worker.name, fields)
    return c.json(f.body, f.status)
  }
})

workersRoutes.delete('/:id', async (c) => {
  const { db, config } = c.var.ctx
  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)
  const project = await db.query.projects.findFirst({ where: eq(projects.id, worker.projectId) })
  if (!project) return c.json({ error: 'no such project' }, 404)

  try {
    const file = await config.mutate(project.slug, c.req.query('hash'), (doc) => {
      doc.deleteIn(['workers', worker.name])
    })
    // Reindex removes the row, since it is no longer in the file — the same path a
    // hand-edit followed by `ogun project sync` takes.
    await reindexProject(db, project.slug, file)
    return c.json({ deleted: worker.name, config: describe(file) })
  } catch (err) {
    const f = handle(err, project.slug, worker.name, worker.config as WorkerConfig)
    return c.json(f.body, f.status)
  }
})

/** What the file looks like now, so the UI can show the diff it just caused. */
const describe = (file: { path: string; text: string; hash: string }) => ({
  path: file.path,
  hash: file.hash,
  text: file.text,
})

const toWorkerConfig = (input: z.infer<typeof workerFields>): WorkerConfig =>
  workerSchema.parse({
    skill: input.skill,
    runtime: input.runtime,
    model: input.model,
    permissions: input.permissions,
    sandbox: input.sandbox,
    enabled: input.enabled,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  })

async function validate(
  db: Env['Variables']['ctx']['db'],
  projectId: string,
  input: { skill?: string; permissions?: string; sandbox?: string },
): Promise<string | null> {
  if (input.skill) {
    const skill = await db.query.skills.findFirst({
      where: and(eq(skills.projectId, projectId), eq(skills.name, input.skill)),
    })
    // A worker pointing at a missing skill produces a run whose prompt references
    // nothing. Refuse up front rather than at 3am.
    if (!skill) {
      return `no skill named "${input.skill}" — run \`ogun project sync\` after adding it`
    }
  }
  if (input.permissions === 'modifier' && input.sandbox === 'worktree') {
    return 'a modifier on the worktree sandbox edits files directly on the host'
  }
  return null
}

const stripUndefined = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== 'expectedHash'))

/**
 * The unreachable case is not an error so much as a different deployment: a control
 * plane on a VPS has no local copy of your repo. Hand back the yaml block so the edit is
 * still possible by hand, rather than failing with nothing to act on.
 */
type Failure = { body: Record<string, unknown>; status: 409 | 500 }

function handle(err: unknown, slug: string, name: string, fields: WorkerConfig): Failure {
  if (err instanceof ConfigUnreachable) {
    return {
      status: 409,
      body: {
        error: err.message,
        yaml: workerToYamlBlock(name, fields),
        hint: `add this under \`workers:\` in ${slug}/.ogun/config.yaml, then run \`ogun project sync\``,
      },
    }
  }
  if (err instanceof ConfigConflict) return { status: 409, body: { error: err.message } }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
}
