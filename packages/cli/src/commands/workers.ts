import { bold, cyan, dim, fail, green, table, until, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'
import { parse } from '../args.ts'

/**
 * `ogun workers` — what is defined, and when each one next runs.
 *
 * There used to be a `WHERE` column separating repo-defined workers from UI-created
 * ones. It read `worker.origin`, which has never existed on a worker — the field is on
 * `skills` — so the command crashed off a TTY. The column went rather than the field
 * arriving: under the single-definition model there is nowhere else for a worker to
 * live. The UI edits `.ogun/config.yaml`, so every worker is a repo worker.
 */
/**
 * When this worker next runs, and what decides that.
 *
 * A worker inside a cycle has no schedule of its own — the cycle owns it — so listing it
 * as trigger-only would be wrong about the thing you are checking the table for.
 */
const runsWhen = (r: {
  schedule: { cron: string } | null
  nextRun: string | null
  drivenBy: { cycle: string; nextRun: string | null } | null
}): string => {
  if (r.drivenBy) {
    const via = `via ${r.drivenBy.cycle}`
    return r.drivenBy.nextRun ? `${via} · ${until(r.drivenBy.nextRun)}` : dim(via)
  }
  if (!r.schedule) return dim('on trigger')
  return r.nextRun ? until(r.nextRun) : yellow('never — bad expression')
}

export async function workersList(args: string[], serverUrl: string): Promise<void> {
  const { first: project } = parse(args, {}, 'ogun workers [project]')
  const url = new URL('/api/workers', serverUrl)
  if (project) url.searchParams.set('project', project)

  const res = await fetch(url, { headers: await authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { workers } = (await res.json()) as {
    workers: Array<{
      worker: {
        name: string
        skillRef: string
        runtime: string
        modelRole: string
        permissions: string
        sandbox: string
        enabled: boolean
      }
      project: { slug: string }
      schedule: { cron: string } | null
      nextRun: string | null
      drivenBy: { cycle: string; schedule: string | null; nextRun: string | null } | null
    }>
  }

  if (workers.length === 0) {
    console.log(dim('no workers — `ogun project sync`, or create one in the UI'))
    return
  }

  console.log(
    table([
      [
        bold(''),
        bold('WORKER'),
        bold('PROJECT'),
        bold('SKILL'),
        bold('RUNTIME'),
        bold('PERMISSIONS'),
        bold('SANDBOX'),
        bold('RUNS'),
      ],
      ...workers.map((r) => [
        r.worker.enabled ? green('●') : dim('○'),
        cyan(r.worker.name),
        dim(r.project.slug),
        r.worker.skillRef,
        r.worker.runtime,
        r.worker.permissions === 'modifier'
          ? yellow(r.worker.permissions)
          : r.worker.permissions,
        r.worker.sandbox,
        runsWhen(r),
      ]),
    ]),
  )
}
