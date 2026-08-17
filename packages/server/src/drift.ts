import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { discoverSkills, hashSkillSet } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import type { ConfigStore } from './config-store.ts'

const { projects } = schema

/**
 * Whether a project's `.ogun/config.yaml` still matches what the control plane indexed.
 *
 * `config.yaml` is the definition; the database is what the foreman reads at fire time
 * (§5.1). Those two only meet when something publishes the file, and only the UI does
 * that on its own — a hand-edit or a `git pull` leaves the factory running the previous
 * definition with every command reporting success. That is not hypothetical: the triage
 * fan-in merged and ran nothing for fourteen hours because the file changed and nothing
 * said so.
 *
 * Two things are compared, because `ogun project sync` publishes two: the config file,
 * and the skills it discovers from the repo beside it. Skills are not in `config.yaml` at
 * all, so hashing only the config would report `synced` after a `SKILL.md` edit while the
 * indexed copy went stale — and a stale skill version quietly corrupts `worker.version_hash`,
 * which exists to answer whether a finding stopped appearing because the code changed or
 * because the skill did (§6).
 *
 * Deliberately compared against the file on **disk** rather than against the committed
 * HEAD. Disk is what `ogun project sync` would publish, so "drifted" means exactly
 * "running sync would change something", which is the only phrasing a person can act on.
 * It does mean a half-finished edit reads as drift — which is true, and harmless, because
 * this only ever warns. Nothing here changes what runs.
 */
export type Drift =
  | { state: 'current' }
  /**
   * Something on disk differs from what was indexed. `ogun project sync` resolves it.
   * `what` names which half moved, since they are edited by different acts.
   */
  | { state: 'drifted'; path: string; what: Array<'config' | 'skills'> }
  /** No local checkout, so there is nothing to compare — the hosted case, not a problem. */
  | { state: 'unreachable' }
  /** Indexed before the hash was recorded. Absence of evidence, reported as such. */
  | { state: 'unknown' }

export async function driftOf(
  db: Db,
  config: ConfigStore,
  slug: string,
): Promise<Drift> {
  const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) })
  if (!project) return { state: 'unreachable' }
  if (!project.configHash) return { state: 'unknown' }

  const file = await config.read(slug).catch(() => null)
  // Unreachable and drifted are different facts with different remedies: one is a hosted
  // control plane working as designed, the other is a sync nobody ran.
  if (!file) return { state: 'unreachable' }

  const what: Array<'config' | 'skills'> = []
  if (file.hash !== project.configHash) what.push('config')

  /**
   * Skipped when `skillsHash` is null — indexed before this existed, which is unknown
   * rather than changed. Reading the skills off disk costs a directory walk and a read
   * per `SKILL.md`; there are a handful, they are local, and the alternative is a cache
   * that can itself go stale, which is the bug this whole file is about.
   */
  const root = await config.root(slug)
  if (project.skillsHash && root) {
    const found = await discoverSkills(root, [builtinSkillsRoot()]).catch(() => null)
    if (found && hashSkillSet(found) !== project.skillsHash) what.push('skills')
  }

  return what.length === 0 ? { state: 'current' } : { state: 'drifted', path: file.path, what }
}

/**
 * Ogun's own shipped skills, resolved from this file rather than the working directory —
 * the server starts from wherever its supervisor puts it. Deliberately not
 * `.agents/skills/`: that is Ogun reviewing Ogun, exactly as any project has its own.
 *
 * Exported because the sync-local route needs the same answer, and two components
 * computing an install path their own way is how they end up disagreeing.
 */
export function builtinSkillsRoot(): string {
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'skills')
}

/** Every project's drift, for the callers that summarise rather than inspect one. */
export async function driftAcross(
  db: Db,
  config: ConfigStore,
): Promise<Record<string, Drift>> {
  const all = await db.select({ slug: projects.slug }).from(projects)
  const out: Record<string, Drift> = {}
  for (const p of all) out[p.slug] = await driftOf(db, config, p.slug)
  return out
}
