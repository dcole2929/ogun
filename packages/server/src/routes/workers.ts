import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import {
  PERMISSION_PROFILES,
  RUNTIMES,
  cycleDefinitionSchema,
  cycleMembers,
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
import { ConfigInvalid, reindexProject } from '../reindex.ts'
import { parseSchedule } from '../foreman/scheduler.ts'

const { breakers, cycles, projects, schedules, skills, workers } = schema

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
  /** What happens when the machine was asleep at the scheduled time (§4.2). */
  onMissed: z.enum(['skip', 'runOnce']).default('skip'),
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
  /** An empty string removes the schedule, leaving a trigger-only worker. */
  schedule: z.string().optional(),
  onMissed: z.enum(['skip', 'runOnce']).optional(),
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
    .select({
      worker: workers,
      project: { slug: projects.slug },
      /**
       * The failure breaker for this worker. It stops a 2am failure loop from eating the
       * whole rate limit by morning (§4.3), and it latches — deliberately, so a restart
       * does not clear it — which means there has to be a way to clear it on purpose.
       */
      breaker: {
        consecutiveFailures: breakers.consecutiveFailures,
        openedAt: breakers.openedAt,
      },
      /** Null when this worker has no `schedule:` — it only runs when triggered. */
      schedule: {
        cron: schedules.cron,
        tz: schedules.tz,
        onMissed: schedules.onMissed,
        lastRunAt: schedules.lastRunAt,
        enabled: schedules.enabled,
      },
      // The prompt a run would actually use, and where it came from. A worker with no
      // prompt of its own is not a worker with no prompt — it inherits the skill's, and
      // showing a blank field invites exactly the question "why has this one got none?"
      skillPrompt: skills.defaultPrompt,
    })
    .from(workers)
    .innerJoin(projects, eq(projects.id, workers.projectId))
    .leftJoin(skills, eq(skills.id, workers.skillId))
    .leftJoin(breakers, eq(breakers.workerId, workers.id))
    // Schedules hang off the cycle, and a worker's own cycle carries its name.
    .leftJoin(cycles, and(eq(cycles.projectId, workers.projectId), eq(cycles.name, workers.name)))
    .leftJoin(schedules, eq(schedules.cycleId, cycles.id))
    .where(project ? eq(workers.projectId, project.id) : undefined)
    .orderBy(workers.name)

  /**
   * The named cycle that drives each worker, if any.
   *
   * A worker in a cycle has no schedule row of its own — the cycle carries it — so
   * without this the UI would show "runs only when triggered" for a worker that runs
   * every night. Read from the definitions rather than stored on the worker, because
   * membership is a property of the graph.
   */
  const named = await db
    .select()
    .from(cycles)
    .where(project ? eq(cycles.projectId, project.id) : undefined)
  const workerNames = new Set(rows.map((r) => r.worker.name))
  const drivenBy = new Map<string, { cycle: string; schedule: string | null; nextRun: string | null }>()
  for (const cycle of named) {
    // Skip the one-node cycle that shadows each worker's own name — it is the worker.
    if (workerNames.has(cycle.name)) continue
    const definition = cycleDefinitionSchema.safeParse(cycle.definition)
    if (!definition.success) continue
    const row = await db.query.schedules.findFirst({ where: eq(schedules.cycleId, cycle.id) })
    for (const worker of cycleMembers(definition.data)) {
      drivenBy.set(`${cycle.projectId}:${worker}`, {
        cycle: cycle.name,
        schedule: row?.cron ?? null,
        nextRun: row?.cron ? nextRunOf(row.cron, row.tz ?? 'UTC') : null,
      })
    }
  }

  // Whether this control plane can edit each project's config.yaml. The UI needs it up
  // front so it can offer a copy-this-yaml fallback rather than a button that 409s.
  const slugs = [...new Set(rows.map((r) => r.project.slug))]
  const editable: Record<string, boolean> = {}
  const hashes: Record<string, string> = {}
  for (const s of slugs) {
    editable[s] = await config.writable(s)
    if (editable[s]) hashes[s] = (await config.read(s)).hash
  }

  return c.json({
    workers: rows.map((r) => ({
      ...r,
      effectivePrompt: effectivePrompt(r.worker, r.skillPrompt),
      // Computed here rather than stored: a next-run time written to the database is
      // wrong the moment the process restarts or the expression changes.
      nextRun: r.schedule?.cron ? nextRunOf(r.schedule.cron, r.schedule.tz ?? 'UTC') : null,
      /** Null unless a named cycle runs this worker, in which case it owns the schedule. */
      drivenBy: drivenBy.get(`${r.worker.projectId}:${r.worker.name}`) ?? null,
    })),
    editable,
    hashes,
  })
})

/**
 * What a cron expression will actually do, answered by the same parser the foreman uses.
 *
 * The alternative is a cron library in the browser, which would be a second
 * implementation to disagree with the first — and the question you are really asking
 * when you type an expression is "will *this system* fire when I think", not "is this
 * valid in the abstract".
 */
workersRoutes.post('/schedule/preview', async (c) => {
  const body = z
    .object({ cron: z.string().min(1), tz: z.string().optional() })
    .parse(await c.req.json())
  const tz = body.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'

  try {
    const parsed = parseSchedule(body.cron, tz)
    const runs: string[] = []
    let cursor = new Date()
    // Three, because one tells you nothing about the interval and a list tells you
    // whether "every 5 minutes" means what you hoped.
    for (let i = 0; i < 3; i++) {
      const next = parsed.nextRun(cursor)
      if (!next) break
      runs.push(next.toISOString())
      cursor = next
    }
    return c.json({ valid: true, tz, nextRuns: runs })
  } catch (err) {
    return c.json({ valid: false, tz, nextRuns: [], error: (err as Error).message })
  }
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

const nextRunOf = (expression: string, tz: string): string | null => {
  try {
    return parseSchedule(expression, tz).nextRun()?.toISOString() ?? null
  } catch {
    // An invalid expression shows as "never" rather than breaking the whole list.
    return null
  }
}

/** Mirrors the layering in startCycleRun (§5.1), minus the per-run overrides. */
function effectivePrompt(
  worker: { skillRef: string; config: unknown },
  skillPrompt: string | null,
): { text: string; source: 'worker' | 'skill' | 'fallback' } {
  const own = (worker.config as { prompt?: string } | null)?.prompt
  if (own) return { text: own, source: 'worker' }
  if (skillPrompt) return { text: skillPrompt, source: 'skill' }
  return { text: `Use the ${worker.skillRef} skill.`, source: 'fallback' }
}

/**
 * Clearing a breaker is a deliberate human act — it is the one guard that survives a
 * restart precisely so it cannot clear itself. Scoped to the worker it guards rather
 * than living under /api/trigger, where it was unreachable from anything that displays
 * a worker.
 */
workersRoutes.post('/:id/breaker/clear', async (c) => {
  const { db } = c.var.ctx
  const worker = await db.query.workers.findFirst({ where: eq(workers.id, c.req.param('id')) })
  if (!worker) return c.json({ error: 'no such worker' }, 404)

  await db
    .update(breakers)
    .set({ consecutiveFailures: 0, openedAt: null, updatedAt: new Date() })
    .where(eq(breakers.workerId, worker.id))
  return c.json({ cleared: worker.name })
})

/** What the file looks like now, so the UI can show the diff it just caused. */
const describe = (file: { path: string; text: string; hash: string }) => ({
  path: file.path,
  hash: file.hash,
  text: file.text,
})

/**
 * The fields this UI actually edits. Everything else in a worker is hand-written yaml.
 *
 * Named as a list because `toWorkerConfig` below has to be able to say "not one of
 * these", and the PATCH handler deletes stored keys that the rebuilt node does not
 * mention. Those two facts together were a silent data-loss bug: `toWorkerConfig` built a
 * worker from this whitelist, so `verify:`, `requires:` and `timezone:` vanished from
 * `.ogun/config.yaml` the first time anyone toggled `enabled` in the UI. A worker's test
 * expectations disappearing because someone clicked a switch is not a thing that
 * announces itself — the run just stops checking what it used to check.
 *
 * `egress:` would have been the next one, and it is the one where the silent loss is a
 * container quietly returning to a wider allowlist than the file says (§4.6).
 */
const UI_MANAGED_FIELDS = [
  'skill',
  'runtime',
  'model',
  'permissions',
  'sandbox',
  'prompt',
  'schedule',
  'onMissed',
  'timeoutMs',
  'enabled',
] as const

const toWorkerConfig = (input: z.infer<typeof workerFields> & Record<string, unknown>): WorkerConfig =>
  workerSchema.parse({
    /**
     * Carried through untouched: anything in the stored config that this UI does not
     * edit. `workerSchema.parse` strips whatever it does not recognise, so a stray
     * `projectSlug` from the create body cannot ride along — only real worker fields
     * survive, which is exactly the set that should.
     */
    ...Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => !(UI_MANAGED_FIELDS as readonly string[]).includes(key),
      ),
    ),
    skill: input.skill,
    runtime: input.runtime,
    model: input.model,
    permissions: input.permissions,
    sandbox: input.sandbox,
    enabled: input.enabled,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    // Carried explicitly. It was silently dropped here, so a worker asked to catch up
    // after a missed night was written to config.yaml as `skip` and quietly did not.
    ...(input.onMissed ? { onMissed: input.onMissed } : {}),
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
type Failure = { body: Record<string, unknown>; status: 400 | 409 | 500 }

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
  /**
   * A worker edit can leave the file's `cycles:` block inconsistent — creating a worker
   * whose name a cycle already has, or deleting the last worker a cycle names. That is
   * the editor's mistake and the message names what to rename or remove, so it has to
   * reach the page rather than becoming a 500 with the sentence buried in it. This route
   * catches its own errors, so `app.onError` never sees them.
   */
  if (err instanceof ConfigInvalid) return { status: err.status, body: { error: err.message } }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
}
