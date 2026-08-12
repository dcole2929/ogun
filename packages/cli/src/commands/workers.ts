import { bold, cyan, dim, fail, green, table, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'

/**
 * `ogun workers` — the `WHERE` column is the one that matters. A `config` worker is
 * owned by the repo and edited there; a `ui` worker was created in the browser and
 * sync leaves it alone. Both run identically.
 */
export async function workersList(args: string[], serverUrl: string): Promise<void> {
  const project = args.find((a) => !a.startsWith('--'))
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
        origin: string
        enabled: boolean
      }
      project: { slug: string }
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
        bold('WHERE'),
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
        dim(r.worker.origin),
      ]),
    ]),
  )
}
