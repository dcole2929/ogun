import { eq, inArray } from 'drizzle-orm'
import { defaultControlPlanePolicies, type ControlPlanePolicies } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'

const { projects } = schema

/**
 * The control plane's side of `policies:`, and the only place the foreman gets it.
 *
 * ### What this is not
 *
 * It is not "the project's policies". It is the half of them that decides scheduling and
 * admission — `maxConcurrentModifiers` and `failureBreakerThreshold` — read from the
 * `projects` row that `ogun project sync` wrote.
 *
 * The other half — `allowSandboxDowngrade`, `maxOpenPullRequests`, `directPush` — is not
 * here and must never be. Those are gates on what an agent's own work is allowed to
 * become, and the runner reads them from `git show <baseSha>:.ogun/config.yaml` because a
 * modifier has write access to its checkout: a gate the agent can edit is not a gate
 * (§4.6, ADR-0009). If they were also stored, a caller here could answer the same
 * question from the database, get a different answer than the runner got, and neither
 * would look wrong. `ControlPlanePolicies` has no such keys, so that call does not
 * compile — which is the point of the type, and the reason to reach for it rather than
 * for `Policies` when adding anything to this file.
 *
 * The reverse direction is closed the same way: `readPolicies` in core returns only the
 * pinned half, so the runner cannot answer a scheduling question out of a repository.
 */
export type ResolvedPolicies = {
  policies: ControlPlanePolicies
  /**
   * Where the numbers came from, which the numbers themselves cannot say.
   *
   *   `project`   — the config we last indexed resolved to these. Includes a config with
   *                 no `policies:` block at all, since an absent block *is* the defaults
   *                 and we read the file that omitted it.
   *   `unsynced`  — nobody has ever told this control plane this project's policies. The
   *                 values are the schema defaults and are a guess, not a reading.
   *
   * Kept apart on principle 6's terms: "we read a config that asks for the defaults" and
   * "we have never read a config" are two facts, and folding them into one number is how
   * a person spends an afternoon wondering why `failureBreakerThreshold: 5` behaves like
   * 3. The UI shows the first without comment and can point at `ogun project sync` for
   * the second.
   */
  source: 'project' | 'unsynced'
}

const resolve = (stored: ControlPlanePolicies | null | undefined): ResolvedPolicies =>
  stored
    ? { policies: stored, source: 'project' }
    : { policies: defaultControlPlanePolicies(), source: 'unsynced' }

/**
 * One project's, by id.
 *
 * Read on demand rather than cached, for the reason `probeProject` gives about the disk:
 * `ogun project sync` rewrites this row, and changing a policy is exactly what a person
 * does in response to a limit biting. A cache would mean the fix took a server restart.
 */
export async function projectPolicies(db: Db, projectId: string): Promise<ResolvedPolicies> {
  const row = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { policies: true },
  })
  // A missing project is not a policy question. Callers here always hold a job or a cycle
  // that references one, so this is the row having been deleted mid-flight; the defaults
  // are as good an answer as exists and the caller's own foreign key will speak first.
  return resolve(row?.policies)
}

/**
 * Several projects at once, keyed by id, for callers that are looking at a queue rather
 * than at one job.
 *
 * A single statement rather than a loop, because the claim path runs this on every poll
 * from every runner and a per-project round trip there is a query count that grows with
 * the thing it is trying to limit.
 */
export async function policiesByProject(
  db: Db,
  projectIds: string[],
): Promise<Map<string, ResolvedPolicies>> {
  const out = new Map<string, ResolvedPolicies>()
  const ids = [...new Set(projectIds)]
  if (ids.length === 0) return out
  const rows = await db
    .select({ id: projects.id, policies: projects.policies })
    .from(projects)
    .where(inArray(projects.id, ids))
  const found = new Map(rows.map((r) => [r.id, r.policies]))
  // Every id asked for gets an entry, including one with no row — a caller that has to
  // check for `undefined` as well as for `unsynced` has two ways to spell the same
  // absence and will eventually handle only one of them.
  for (const id of ids) out.set(id, resolve(found.get(id)))
  return out
}
