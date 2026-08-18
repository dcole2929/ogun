import { and, eq, inArray, not } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { markCoverage } from './foreman/cycles.ts'
import {
  cycleGraphProblems,
  cycleMembers,
  hashContent,
  singleWorkerCycle,
  type CycleDefinition,
  type WorkerConfig,
} from '@ogun/core'

const { cycles, jobs, projects, schedules, skills, workers } = schema

/**
 * A refusal caused by what somebody wrote, not by anything going wrong in here.
 *
 * The status travels on the error because only the thrower knows whose mistake it was.
 * Every caller of `reindexProject` used to raise a plain `Error`, and `app.onError` maps
 * anything it does not recognise to 500 — so a typo in `then:` came back to the person
 * who made it as an internal server error, and the one sentence naming the line to fix
 * arrived looking like a crash. Same shape as `JoinRefused` in routes/runners.ts and the
 * `Config*` errors in config-store.ts.
 */
export class ConfigInvalid extends Error {
  readonly status = 400
}

export type ReindexResult = {
  workers: Record<string, typeof workers.$inferSelect>
  removed: string[]
  /**
   * Workers whose own `schedule:` was suppressed because a named cycle drives them.
   * Surfaced rather than silently applied — the config file still says 3am, and the
   * reason it no longer means what it looks like belongs in the sync output.
   */
  overriddenSchedules: string[]
}

/**
 * Bring the workers table in line with a project's config.yaml. The one place that
 * happens, whether the file was edited by hand and pushed by `ogun project sync` or by
 * the control plane on behalf of the UI — so both paths cannot drift.
 *
 * Everything not in the file is deleted. The file is the definition; a row that outlives
 * its entry is a worker nobody can find the source of.
 *
 * That applies to definitions only. Runs, coverage and staged output are not definitions
 * — §4.4 keeps them here precisely because nothing else can — so they survive, holding a
 * name snapshot and a nulled foreign key. Until this distinction existed, renaming a
 * worker (a delete and an insert, from here) erased everything it had ever done.
 */
export async function reindexProject(
  db: Db,
  slug: string,
  file: {
    hash: string
    workers: Record<string, WorkerConfig>
    /** Named multi-node cycles, already expanded from sugar. */
    cycles?: Record<string, CycleDefinition>
  },
): Promise<ReindexResult> {
  const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
  if (!project) throw new Error(`no such project: ${slug}`)

  const names = Object.keys(file.workers)

  /**
   * Everything about `cycles:` that a person could have got wrong, checked before a
   * single row is written.
   *
   * `ogun project sync` will not load a config.yaml containing any of it, but the sync
   * payload is parsed against a schema that checks a definition's shape and not what its
   * graph does — so a definition arriving by any other route (an older CLI, the UI's own
   * sync, a hand-made POST) was stored intact. This function is where both write paths
   * meet, which makes it the last place able to say so.
   *
   * The three failures, and what each one looks like if it gets through:
   *
   * - A graph that could never finish. The 3am run has every job sitting `blocked`: a
   *   node is released only once its dependencies are terminal, and in a loop none of
   *   them ever is. Nothing errors and nothing times out.
   * - A cycle sharing a worker's name. The worker's one-node cycle and this one fight
   *   over the same row, and whichever wrote last decides what "run nightly" means.
   * - A node naming a worker that is not in the file. `startCycleRun` throws when
   *   somebody presses run — hours later, and nowhere near the file that says it.
   *
   * Up front rather than where each is detected: `reindexProject` is not a transaction,
   * so a refusal raised mid-way leaves the workers it had already inserted behind.
   */
  for (const [name, definition] of Object.entries(file.cycles ?? {})) {
    if (names.includes(name)) {
      throw new ConfigInvalid(`cycle "${name}" has the same name as a worker — rename one`)
    }
    const problems = cycleGraphProblems(definition)
    if (problems.length > 0) {
      throw new ConfigInvalid(`cycle "${name}" could never finish — ${problems.join('; ')}`)
    }
    for (const node of definition.nodes) {
      if (!(node.worker in file.workers)) {
        throw new ConfigInvalid(
          `cycle "${name}" refers to worker "${node.worker}", which is not defined`,
        )
      }
    }
  }

  const known = await db.select().from(skills).where(eq(skills.projectId, project.id))
  const skillByName = new Map(known.map((s) => [s.name, s]))

  const out: Record<string, typeof workers.$inferSelect> = {}

  // Computed before the worker loop, because it decides whether each worker's standalone
  // schedule survives.
  const driven = new Set<string>()
  for (const definition of Object.values(file.cycles ?? {})) {
    for (const worker of cycleMembers(definition)) driven.add(worker)
  }
  const overriddenSchedules = names.filter((n) => driven.has(n) && file.workers[n]?.schedule)

  for (const [name, w] of Object.entries(file.workers)) {
    const skillName = w.skill.replace(/^\.\/skills\//, '').replace(/^ogun:\/\//, '')
    const skill = skillByName.get(skillName)
    // Folds in the skill version, so a later run can answer whether a finding stopped
    // appearing because the code changed or because the skill did (§6).
    const versionHash = hashContent(file.hash, JSON.stringify(w), skill?.versionHash ?? 'unknown')

    const [row] = await db
      .insert(workers)
      .values({
        projectId: project.id,
        name,
        ...(skill ? { skillId: skill.id } : {}),
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
          skillId: skill?.id ?? null,
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
    if (row) out[name] = row

    // Every worker is a one-node cycle, so "run this now" and the eventual nightly path
    // are the same code (§5.1).
    const [cycle] = await db
      .insert(cycles)
      .values({ projectId: project.id, name, definition: singleWorkerCycle(name) })
      .onConflictDoUpdate({
        target: [cycles.projectId, cycles.name],
        set: { definition: singleWorkerCycle(name) },
      })
      .returning()

    /**
     * A worker's `schedule:` becomes a row the foreman evaluates. `lastRunAt` is left
     * alone on update — rewriting it would either replay history or skip a due run every
     * time you touched an unrelated field in config.yaml.
     */
    if (cycle) await syncSchedule(db, cycle.id, driven.has(name) ? { ...w, schedule: undefined } : w)
  }

  /**
   * Record which file this index came from, here rather than in the sync route, because
   * both write paths pass through this function — `ogun project sync` and the control
   * plane writing on behalf of the UI. Recorded in only one of them, a UI edit would
   * land on disk, land in the database, and then read as drifted against a hash from
   * before it.
   */
  await db.update(projects).set({ configHash: file.hash }).where(eq(projects.id, project.id))

  await syncNamedCycles(db, project.id, file.cycles ?? {}, names)

  const doomed = await db
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(
      and(
        eq(workers.projectId, project.id),
        names.length > 0 ? not(inArray(workers.name, names)) : undefined,
      ),
    )

  /**
   * Retire the work queued for a worker that is about to stop existing.
   *
   * Jobs used to be deleted along with it, which is what destroyed the run history this
   * schema now protects. Keeping them creates the opposite hazard: a queued job whose
   * worker is gone can never be claimed — the claim needs its runtime and sandbox — so it
   * would sit in the queue forever, counted as pending by a ledger that says it is still
   * waiting for a machine. Retire it explicitly and say why, rather than leaving a row
   * that quietly means nothing (principle 6).
   *
   * Only work that has not started: a claimed or running job belongs to a runner and
   * finishes on its own.
   */
  for (const worker of doomed) {
    const stranded = await db
      .update(jobs)
      .set({ state: 'skipped' })
      .where(and(eq(jobs.workerId, worker.id), inArray(jobs.state, ['queued', 'blocked'])))
      .returning({ cycleRunId: jobs.cycleRunId, workerName: jobs.workerName })

    for (const job of stranded) {
      await markCoverage(db, job.cycleRunId, { workerId: worker.id, workerName: job.workerName }, {
        outcome: 'cancelled',
        reason: `"${worker.name}" was removed from config.yaml before this ran`,
      })
    }
  }

  const removed = await db
    .delete(workers)
    .where(
      and(
        eq(workers.projectId, project.id),
        names.length > 0 ? not(inArray(workers.name, names)) : undefined,
      ),
    )
    .returning({ name: workers.name })

  for (const r of removed) {
    await db.delete(cycles).where(and(eq(cycles.projectId, project.id), eq(cycles.name, r.name)))
  }

  return { workers: out, removed: removed.map((r) => r.name), overriddenSchedules }
}

/**
 * Named cycles, and the schedules that drive them.
 *
 * Everything a definition could be wrong about has already been refused above, before
 * any worker was written — this only writes.
 */
async function syncNamedCycles(
  db: Db,
  projectId: string,
  defined: Record<string, CycleDefinition>,
  workerNames: string[],
): Promise<void> {
  for (const [name, definition] of Object.entries(defined)) {
    const [cycle] = await db
      .insert(cycles)
      .values({ projectId, name, definition })
      .onConflictDoUpdate({ target: [cycles.projectId, cycles.name], set: { definition } })
      .returning()

    if (cycle) {
      await syncSchedule(db, cycle.id, {
        schedule: definition.schedule,
        timezone: definition.timezone,
        onMissed: definition.onMissed,
        enabled: definition.enabled,
      })
    }
  }

  // A cycle dropped from config.yaml stops existing, the same way a worker does. Scoped
  // to multi-node cycles so the one-node ones the worker loop owns are left alone.
  const existing = await db.select().from(cycles).where(eq(cycles.projectId, projectId))
  for (const row of existing) {
    const isNamed = !workerNames.includes(row.name)
    if (isNamed && !(row.name in defined)) {
      await db.delete(cycles).where(eq(cycles.id, row.id))
    }
  }
}


/**
 * Timezone defaults to this machine's, because "3am" in a config file means three in the
 * morning where you are, not in UTC. A project that wants otherwise says so explicitly.
 */
const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

type Scheduled = Pick<WorkerConfig, 'schedule' | 'timezone' | 'onMissed' | 'enabled'>

async function syncSchedule(db: Db, cycleId: string, worker: Scheduled): Promise<void> {
  const existing = await db.query.schedules.findFirst({ where: eq(schedules.cycleId, cycleId) })

  if (!worker.schedule) {
    // Removing `schedule:` from config.yaml stops the schedule, rather than leaving an
    // orphan that keeps firing for a worker whose definition no longer asks for it.
    if (existing) await db.delete(schedules).where(eq(schedules.id, existing.id))
    return
  }

  const values = {
    cycleId,
    cron: worker.schedule,
    tz: worker.timezone ?? localTimezone(),
    onMissed: worker.onMissed,
    enabled: worker.enabled,
  }

  if (existing) {
    await db.update(schedules).set(values).where(eq(schedules.id, existing.id))
  } else {
    await db.insert(schedules).values(values)
  }
}