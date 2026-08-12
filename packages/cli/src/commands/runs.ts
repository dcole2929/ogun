import { bold, cyan, dim, fail, outcomeColor, table } from '../output.ts'
import { authHeaders } from '../auth.ts'

type RunRow = {
  run: {
    id: string
    outcome: string | null
    detail: string | null
    startedAt: string
    durationMs: number | null
    repoSha: string | null
    runtime: string | null
    inputTokens: number | null
    outputTokens: number | null
  }
  job: { state: string; nodeKey: string }
  worker: { name: string }
  project: { slug: string }
}

export async function runsList(serverUrl: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/runs?limit=30`, { headers: authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { runs } = (await res.json()) as { runs: RunRow[] }
  if (runs.length === 0) {
    console.log(dim('no runs yet'))
    return
  }
  console.log(
    table([
      [bold('WHEN'), bold('PROJECT'), bold('WORKER'), bold('OUTCOME'), bold('TOOK'), bold('RUN')],
      ...runs.map((r) => [
        dim(new Date(r.run.startedAt).toLocaleString()),
        r.project.slug,
        cyan(r.worker.name),
        outcomeColor(r.run.outcome ?? r.job.state),
        r.run.durationMs ? `${Math.round(r.run.durationMs / 1000)}s` : dim('—'),
        dim(r.run.id.slice(0, 8)),
      ]),
    ]),
  )
}

/**
 * `ogun trigger <project> <worker>` — the manual trigger. Goes through the same cycle
 * machinery a schedule will, so there is no separate "run it now" code path (§5.1).
 */
export async function trigger(args: string[], serverUrl: string): Promise<void> {
  const [projectSlug, worker] = args
  if (!projectSlug || !worker) fail('usage: ogun trigger <project> <worker>')

  const res = await fetch(`${serverUrl}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ projectSlug, worker }),
  }).catch(() => null)
  if (!res?.ok) fail(`trigger failed: ${res ? await res.text() : `could not reach ${serverUrl}`}`)

  const body = (await res.json()) as {
    cycleRunId: string
    jobs: Array<{ nodeKey: string; state: string }>
  }
  for (const j of body.jobs) {
    if (j.state === 'skipped') {
      // Admission refused it. That is a recorded fact in the coverage ledger, not a
      // silent no-op — say so here too.
      console.log(
        `${cyan(j.nodeKey)}: ${outcomeColor('skipped')} — admission refused it; see \`ogun coverage\``,
      )
    } else {
      console.log(`${cyan(j.nodeKey)}: ${j.state}`)
    }
  }
  console.log(dim(`cycle run ${body.cycleRunId}`))
}

export async function coverage(args: string[], serverUrl: string): Promise<void> {
  const project = args[0]
  if (!project) fail('usage: ogun coverage <project>')
  const res = await fetch(`${serverUrl}/api/projects/${project}/coverage`, { headers: authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not read coverage for ${project}`)
  const { coverage: rows } = (await res.json()) as {
    coverage: Array<{
      coverage: { outcome: string; ran: boolean; findingCount: number; reason: string | null }
      cycleRun: { startedAt: string; state: string }
      worker: { name: string }
    }>
  }
  if (rows.length === 0) {
    console.log(dim('no coverage recorded'))
    return
  }
  console.log(
    table([
      [bold('WHEN'), bold('WORKER'), bold('OUTCOME'), bold('FINDINGS'), bold('WHY')],
      ...rows.map((r) => [
        dim(new Date(r.cycleRun.startedAt).toLocaleString()),
        cyan(r.worker.name),
        outcomeColor(r.coverage.outcome),
        String(r.coverage.findingCount),
        dim((r.coverage.reason ?? '').slice(0, 60)),
      ]),
    ]),
  )
}
