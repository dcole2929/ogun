import { eq } from 'drizzle-orm'
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
 * Deliberately compared against the file on **disk** rather than against the committed
 * HEAD. Disk is what `ogun project sync` would publish, so "drifted" means exactly
 * "running sync would change something", which is the only phrasing a person can act on.
 * It does mean a half-finished edit reads as drift — which is true, and harmless, because
 * this only ever warns. Nothing here changes what runs.
 */
export type Drift =
  | { state: 'current' }
  /** The file on disk differs from what was indexed. `ogun project sync` resolves it. */
  | { state: 'drifted'; path: string }
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

  return file.hash === project.configHash ? { state: 'current' } : { state: 'drifted', path: file.path }
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
