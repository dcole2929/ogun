import { Hono } from 'hono'
import { and, desc, eq, inArray, not } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import {
  controlPlanePoliciesSchema,
  cycleDefinitionSchema,
  sourceSchema,
  workerSchema,
} from '@ogun/core'
import { discoverSkills, expandCycle, hashSkillSet, loadProjectConfig } from '@ogun/core'
import { builtinSkillsRoot, driftAcross } from '../drift.ts'
import { reindexProject } from '../reindex.ts'
import { recentEmissions, recentPolls, sourceHealth } from '../source-health.ts'
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
  /**
   * The control-plane half only, and the narrowing is the security property rather than
   * an economy.
   *
   * `allowSandboxDowngrade` and `maxOpenPullRequests` are gates on what an agent's own
   * work may become, and the runner reads them from the git blob at the pinned base
   * because a modifier can write to its checkout (§4.6, ADR-0009). Accepting them here
   * would create a second copy in the one place a future caller is most likely to reach
   * for — and a caller reading a scheduling table has no way to know that this particular
   * column must not be trusted. So they do not arrive: zod strips what the schema does
   * not name, an older CLI posting the whole block still syncs, and the extra keys are
   * dropped at the door rather than stored and then remembered not to read.
   */
  policies: controlPlanePoliciesSchema,
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
  /**
   * Integration triggers (§4.13, ADR-0013). Defaulted rather than required, so a CLI that
   * predates sources keeps syncing — an older client posting nothing means "this project
   * has no sources", which is true of every project that has not written the block.
   */
  sources: z.record(z.string(), sourceSchema).default({}),
})

export const projectsRoutes = new Hono<Env>()

export type SyncPayload = z.infer<typeof syncSchema>

/**
 * Publish a config to the database. The one implementation, called by both routes below.
 *
 * `POST /sync` is the CLI posting a payload it assembled from a repo on *its* machine;
 * `POST /:slug/sync-local` is the control plane assembling the same payload from a repo
 * on its own. Two code paths writing the same rows is how the file and the index drift
 * apart, which is the whole failure this endpoint pair exists to make visible — so there
 * is one, and the difference is only where the payload came from.
 */
async function applySync(db: Db, body: SyncPayload) {
  const policies = controlPlanePoliciesSchema.parse(body.policies)

  /**
   * `policies` is written unconditionally on both halves of the upsert, unlike
   * `remoteUrl` above which is only written when present.
   *
   * The difference is what absence means for each. A payload without a remote is a repo
   * that has none, and blanking a URL we already knew would lose a fact; a payload's
   * `policies` is never absent — `syncSchema` requires it and `projectConfigSchema`
   * prefaults an omitted block to the defaults — so what arrives is always this config's
   * complete answer. Writing it wholesale is what makes deleting a policy line take
   * effect, which is the same reasoning the skills upsert below spells out: this row is
   * an index of a file, and a stale half of it is worse than none.
   *
   * The column therefore only stays null for a project that has not synced since it
   * existed, which is exactly the fact `projectPolicies` reports as `unsynced`.
   *
   * Re-parsed here even though `body.policies` is already typed as the control-plane half.
   * It looks redundant and is not: `/sync` gets its payload through `syncSchema`, which
   * strips, but `sync-local` builds one in TypeScript out of `loaded.config.policies` — a
   * whole `Policies`, which is *structurally assignable* to the narrower type and would
   * be handed to drizzle with `maxOpenPullRequests` still on it. jsonb stores what it is
   * given. One `parse` at the single write site means the pinned-blob keys cannot reach
   * the column by any route, including one added later by someone who never read this.
   */
  const [project] = await db
    .insert(projects)
    .values({
      slug: body.slug,
      defaultBranch: body.defaultBranch,
      policies,
      ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
    })
    .onConflictDoUpdate({
      target: projects.slug,
      set: {
        defaultBranch: body.defaultBranch,
        policies,
        ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
      },
    })
    .returning()
  if (!project) throw new Error('failed to upsert project')

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

  /**
   * A skill that is no longer on disk loses its row.
   *
   * The upsert above already overwrites wholesale, "including nulling fields that
   * disappeared", on the grounds that this row is an index of a file and a stale half of
   * it is worse than none. A row for a skill that has been deleted is the same argument
   * one level up: a stale *whole* is worse still, because nothing about it looks stale.
   * `fix-a-finding` outlived its own deletion by two syncs, indexed and bound to nothing,
   * indistinguishable in the UI from a skill somebody had simply not wired up yet.
   *
   * A worker that still names it keeps its `skillRef` and loses `skillId` — the foreign
   * key is `ON DELETE SET NULL` — so it reports as a worker whose skill is not indexed,
   * which is exactly what it is, and is filterable as such on the Workers page.
   *
   * The empty case follows `reindexProject`'s removal of workers, deliberately: no names
   * means no name restriction, so a project that discovers nothing indexes nothing. It is
   * not reachable in practice — `discoverSkills` is always given Ogun's own built-in root
   * — and an exception for it would mean a project could never lose its last skill.
   */
  const names = body.skills.map((s) => s.name)
  const dropped = await db
    .delete(skills)
    .where(
      and(
        eq(skills.projectId, project.id),
        // `inArray` with an empty list is not valid SQL, which is why this is a ternary
        // rather than a plain condition — the same shape the worker removal uses.
        names.length > 0 ? not(inArray(skills.name, names)) : undefined,
      ),
    )
    .returning({ name: skills.name })

  /**
   * Recorded here rather than in `reindexProject`, because this is where the skills are
   * — that function never sees them. A UI worker edit therefore leaves this column alone,
   * which is correct: editing a worker does not change a skill.
   */
  await db
    .update(projects)
    .set({ skillsHash: hashSkillSet(body.skills) })
    .where(eq(projects.id, project.id))

  const {
    workers: indexed,
    removed,
    overriddenSchedules,
    unmetRequirements,
    registeredRunners,
    sources: indexedSources,
  } = await reindexProject(db, project.slug, {
    hash: body.configHash,
    workers: body.workers,
    cycles: body.cycles,
    sources: body.sources,
  })

  return {
    project: { id: project.id, slug: project.slug },
    workers: Object.keys(indexed),
    skills: [...skillIds.keys()],
    removedSkills: dropped.map((d) => d.name),
    removed,
    overriddenSchedules,
    /**
     * Sync is the moment somebody wrote a `requires:` label, so it is the moment to say
     * that nothing here advertises it. See `ReindexResult.unmetRequirements` for why this
     * is a warning at the point of writing rather than a refusal at admission.
     */
    unmetRequirements,
    registeredRunners,
    sources: indexedSources,
  }
}

projectsRoutes.post('/sync', async (c) => {
  return c.json(await applySync(c.var.ctx.db, syncSchema.parse(await c.req.json())))
})

/**
 * Publish this project's config without a terminal.
 *
 * Only possible where the control plane can reach the repo — the co-located case §4.1
 * describes, which is also the only case where the UI can edit `config.yaml` at all. A
 * hosted control plane has no checkout and says so rather than failing obscurely; there
 * the remedy is `ogun project sync` on the machine that has the repo.
 *
 * Reads exactly what the CLI reads: the config file, the skills discoverable from the
 * repo root, and the git remote. Anything less would make a UI sync and a CLI sync mean
 * different things, and you would not find out which you had until a run behaved oddly.
 */
projectsRoutes.post('/:slug/sync-local', async (c) => {
  const { db, config } = c.var.ctx
  const slug = c.req.param('slug')

  const root = await config.root(slug)
  if (!root) {
    return c.json(
      {
        error:
          `this control plane has no local checkout of "${slug}", so it cannot read its ` +
          'config. Run `ogun project sync` on the machine that has the repo.',
      },
      409,
    )
  }

  const loaded = await loadProjectConfig(root).catch((err: Error) => err)
  if (loaded instanceof Error) {
    return c.json({ error: `could not read ${root}/.ogun/config.yaml: ${loaded.message}` }, 400)
  }

  const cycles = Object.fromEntries(
    Object.entries(loaded.config.cycles).map(([name, cycle]) => [name, expandCycle(cycle)]),
  )

  const discovered = await discoverSkills(root, [builtinSkillsRoot()])
  const result = await applySync(db, {
    slug: loaded.config.project.name,
    defaultBranch: loaded.config.project.defaultBranch,
    ...(loaded.config.project.remoteUrl ? { remoteUrl: loaded.config.project.remoteUrl } : {}),
    configHash: loaded.configHash,
    workers: loaded.config.workers,
    policies: loaded.config.policies,
    cycles,
    sources: loaded.config.sources,
    skills: discovered.map((s) => ({
      name: s.name,
      sourcePath: s.sourcePath,
      versionHash: s.versionHash,
      origin: s.origin,
      ...(s.body ? { body: s.body } : {}),
      referencePaths: s.referencePaths,
      allowImplicitInvocation: s.agentConfig.policy.allow_implicit_invocation,
      ...(s.agentConfig.interface.display_name
        ? { displayName: s.agentConfig.interface.display_name }
        : {}),
      ...(s.agentConfig.interface.short_description
        ? { shortDescription: s.agentConfig.interface.short_description }
        : {}),
      ...(s.agentConfig.interface.default_prompt
        ? { defaultPrompt: s.agentConfig.interface.default_prompt }
        : {}),
    })),
  })
  return c.json(result)
})


projectsRoutes.get('/', async (c) => {
  const { db, config } = c.var.ctx
  const rows = await db.select().from(projects).orderBy(projects.slug)
  // Carried on the row rather than behind a second call: every caller that lists projects
  // is the sort of caller that needs to know one of them is not what it says it is.
  const drift = await driftAcross(db, config)
  return c.json({
    projects: rows.map((p) => ({ ...p, drift: drift[p.slug] ?? { state: 'unknown' } })),
  })
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

/**
 * The coverage ledger for a *trigger* — whether the factory was ever asked (§4.13).
 *
 * The sibling of `/coverage` above and deliberately shaped like it. That one answers "did
 * the workers selected for last night's batch actually run"; this one answers the question
 * one step upstream, which for a ticket-driven project is the one that goes wrong first:
 * **did anything look at Linear, and what came of it.** A dead credential produces no batch
 * at all, so the coverage ledger has nothing to report and reports nothing — an empty page
 * that reads exactly like a quiet week.
 *
 * Two things come back, because a source generates two different questions:
 *
 *  - `sources` is a *state* per source, not a log. `source_polls` gets ~288 rows a day and
 *    a page of them is a log; what an operator needs is "this one is failing, and here is
 *    which kind of failing and what to do". The recent history rides along underneath,
 *    bounded, for the follow-up question of when it started.
 *  - `emissions` is which tickets have already produced work. Ogun writes nothing back to
 *    Linear (ADR-0004), so a ticket that has been fully dealt with still sits in `Todo`
 *    looking untouched, and *"why did nothing happen for ENG-123"* has "it did, on Tuesday"
 *    as its most common answer. `?ticket=ENG-123` asks that directly.
 *
 * A project with no sources gets an empty list rather than a 404 — every project is
 * legitimately in that state, and it is the answer the UI needs in order to render nothing
 * rather than an error.
 */
projectsRoutes.get('/:slug/sources', async (c) => {
  const { db } = c.var.ctx
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, c.req.param('slug')),
  })
  if (!project) return c.json({ error: 'no such project' }, 404)

  const reports = await sourceHealth(db, { projectId: project.id })

  /**
   * The history rides under the state rather than being a second request, because the
   * follow-up question — *when did it start failing* — is asked within a second of the
   * first one and never on its own.
   *
   * Serial rather than a `Promise.all` fan-out: a project has a handful of sources, not
   * hundreds, and a bounded serial loop is a bounded amount of database at a time.
   */
  const withHistory = []
  for (const report of reports) {
    withHistory.push({ ...report, polls: await recentPolls(db, report.id) })
  }

  const ticket = c.req.query('ticket')
  return c.json({
    sources: withHistory,
    emissions: await recentEmissions(db, project.id, ticket ? { ticket } : {}),
    /**
     * Echoed back so a surface can say "nothing has been emitted for ENG-9999" rather than
     * "no emissions" — different sentences, and only one of them answers what was asked.
     */
    ticket: ticket ?? null,
  })
})
