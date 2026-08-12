import { and, eq, inArray, not } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { hashContent, singleWorkerCycle, type WorkerConfig } from '@ogun/core'

const { cycles, projects, skills, workers } = schema

export type ReindexResult = {
  workers: Record<string, typeof workers.$inferSelect>
  removed: string[]
}

/**
 * Bring the workers table in line with a project's config.yaml. The one place that
 * happens, whether the file was edited by hand and pushed by `ogun project sync` or by
 * the control plane on behalf of the UI — so both paths cannot drift.
 *
 * Everything not in the file is deleted. The file is the definition; a row that outlives
 * its entry is a worker nobody can find the source of.
 */
export async function reindexProject(
  db: Db,
  slug: string,
  file: { hash: string; workers: Record<string, WorkerConfig> },
): Promise<ReindexResult> {
  const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
  if (!project) throw new Error(`no such project: ${slug}`)

  const known = await db.select().from(skills).where(eq(skills.projectId, project.id))
  const skillByName = new Map(known.map((s) => [s.name, s]))

  const out: Record<string, typeof workers.$inferSelect> = {}
  const names = Object.keys(file.workers)

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
    await db
      .insert(cycles)
      .values({ projectId: project.id, name, definition: singleWorkerCycle(name) })
      .onConflictDoUpdate({
        target: [cycles.projectId, cycles.name],
        set: { definition: singleWorkerCycle(name) },
      })
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

  return { workers: out, removed: removed.map((r) => r.name) }
}
