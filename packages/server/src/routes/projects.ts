import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { cycleDefinitionSchema, policiesSchema, workerSchema } from '@ogun/core'
import { discoverSkills, expandCycle, hashSkillSet, loadProjectConfig } from '@ogun/core'
import { builtinSkillsRoot, driftAcross } from '../drift.ts'
import { reindexProject } from '../reindex.ts'
import type { Env } from '../context.ts'

const { coverage, cycleRuns, cycles, jobs, projects, skills, workers } = schema

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
   * Recorded here rather than in `reindexProject`, because this is where the skills are
   * — that function never sees them. A UI worker edit therefore leaves this column alone,
   * which is correct: editing a worker does not change a skill.
   */
  await db
    .update(projects)
    .set({ skillsHash: hashSkillSet(body.skills) })
    .where(eq(projects.id, project.id))

  const { workers: indexed, removed, overriddenSchedules } = await reindexProject(
    db,
    project.slug,
    { hash: body.configHash, workers: body.workers, cycles: body.cycles },
  )

  return {
    project: { id: project.id, slug: project.slug },
    workers: Object.keys(indexed),
    skills: [...skillIds.keys()],
    removed,
    overriddenSchedules,
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
  // The same guard the CLI applies: a typo in `then:` is otherwise a cycle that runs its
  // reviewers and then waits forever on a node no worker sits behind.
  for (const [name, definition] of Object.entries(cycles)) {
    for (const node of definition.nodes) {
      if (!loaded.config.workers[node.worker]) {
        return c.json(
          { error: `cycle "${name}" refers to worker "${node.worker}", which is not defined` },
          400,
        )
      }
    }
  }

  const discovered = await discoverSkills(root, [builtinSkillsRoot()])
  const result = await applySync(db, {
    slug: loaded.config.project.name,
    defaultBranch: loaded.config.project.defaultBranch,
    ...(loaded.config.project.remoteUrl ? { remoteUrl: loaded.config.project.remoteUrl } : {}),
    configHash: loaded.configHash,
    workers: loaded.config.workers,
    policies: loaded.config.policies,
    cycles,
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
