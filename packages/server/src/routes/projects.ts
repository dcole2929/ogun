import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import { cycleDefinitionSchema, policiesSchema, workerSchema } from '@ogun/core'
import { reindexProject } from '../reindex.ts'
import { parseSchedule } from '../foreman/scheduler.ts'
import type { Env } from '../context.ts'

const { coverage, cycleRuns, cycles, jobs, projects, schedules, skills, workers } = schema

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

/**
 * A project's cycles, each with what decides whether it runs at all.
 *
 * The definition alone says nothing about when — the schedule is a second table and the
 * evidence it ever fired is a third — so a caller reading only `definition` can show a
 * fan-in that has been inert for a fortnight and look entirely healthy doing it. The
 * three are assembled here rather than by the caller for the same reason the cron
 * preview is (`/api/workers/schedule/preview`): the answer wanted is what *this* foreman
 * will do, and a second cron implementation is a second set of answers.
 *
 * The cycle row is spread rather than nested, so a reader that only wants the graph is
 * unaffected by any of this.
 */
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

  // Every worker also has a one-node cycle carrying its own schedule (§5.1). It is the
  // worker, not a graph anyone wrote, so it is flagged here and the caller decides
  // whether to show it — the alternative is each caller re-deriving membership.
  const owned = new Set(
    (
      await db
        .select({ name: workers.name })
        .from(workers)
        .where(eq(workers.projectId, project.id))
    ).map((w) => w.name),
  )

  const ids = rows.map((r) => r.id)
  const scheduleRows = ids.length
    ? await db.select().from(schedules).where(inArray(schedules.cycleId, ids))
    : []
  const byCycle = new Map(scheduleRows.map((s) => [s.cycleId, s]))

  /**
   * One query per cycle, not one query with a limit: the last run of a cycle that has
   * not fired in months is exactly the row worth seeing, and it is the one a bounded
   * scan over all of them would drop. Indexed on (cycle_id, started_at).
   */
  const lastRuns = await Promise.all(
    rows.map((r) =>
      db.query.cycleRuns.findFirst({
        where: eq(cycleRuns.cycleId, r.id),
        orderBy: desc(cycleRuns.startedAt),
      }),
    ),
  )

  return c.json({
    cycles: rows.map((row, i) => {
      const schedule = byCycle.get(row.id)
      const last = lastRuns[i]
      return {
        ...row,
        standalone: owned.has(row.name),
        schedule: schedule
          ? {
              cron: schedule.cron,
              tz: schedule.tz,
              onMissed: schedule.onMissed,
              enabled: schedule.enabled,
              lastRunAt: schedule.lastRunAt,
            }
          : null,
        // Computed, never stored: a next-run time written to the database is wrong the
        // moment the process restarts or the expression changes.
        nextRuns: schedule?.enabled ? nextRuns(schedule.cron, schedule.tz) : [],
        lastRun: last
          ? {
              id: last.id,
              state: last.state,
              trigger: last.trigger,
              startedAt: last.startedAt,
              endedAt: last.endedAt,
            }
          : null,
      }
    }),
  })
})

/**
 * The next few occurrences. Three, because one date tells you nothing about the interval
 * and "every 5 minutes" only looks like itself as a list.
 *
 * An unparseable expression is an empty list rather than an error: the schedule is real,
 * it simply never fires, and one bad cron must not take the whole listing with it.
 */
function nextRuns(expression: string, tz: string, count = 3): string[] {
  const out: string[] = []
  try {
    const cron = parseSchedule(expression, tz)
    let cursor = new Date()
    for (let i = 0; i < count; i++) {
      const next = cron.nextRun(cursor)
      if (!next) break
      out.push(next.toISOString())
      cursor = next
    }
  } catch {
    return []
  }
  return out
}

/** The coverage ledger for a batch — what was selected, what ran, and why not (§4.11). */
projectsRoutes.get('/:slug/coverage', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('slug')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)
  /**
   * Names come from the snapshots on the run and the coverage row, not from `cycles` and
   * `workers`. The ledger has to survive the definitions it describes — a nightly cycle
   * you renamed last week must not erase the record of the nights it ran, which is the
   * whole of principle 6. Joining those tables would also have silently dropped exactly
   * those rows once the foreign keys went nullable.
   *
   * Scoped through `jobs`, which is where a cycle run's project is recorded and which
   * outlives any definition.
   */
  const inProject = db
    .select({ id: jobs.cycleRunId })
    .from(jobs)
    .where(eq(jobs.projectId, project.id))

  const rows = await db
    .select({
      coverage,
      cycleRun: cycleRuns,
      cycle: { name: cycleRuns.cycleName },
      worker: { name: coverage.workerName },
    })
    .from(coverage)
    .innerJoin(cycleRuns, eq(cycleRuns.id, coverage.cycleRunId))
    .where(inArray(coverage.cycleRunId, inProject))
    .orderBy(desc(cycleRuns.startedAt))
    .limit(200)
  return c.json({ coverage: rows })
})
