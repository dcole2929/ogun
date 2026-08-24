import { bold, cyan, dim, fail, outcomeColor, table, yellow } from '../output.ts'
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
  const res = await fetch(`${serverUrl}/api/runs?limit=30`, { headers: await authHeaders() }).catch(() => null)
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
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ projectSlug, worker }),
  }).catch(() => null)
  if (!res?.ok) fail(`trigger failed: ${res ? await res.text() : `could not reach ${serverUrl}`}`)

  const body = (await res.json()) as {
    cycleRunId: string
    jobs: Array<{ nodeKey: string; state: string; reach?: string; missing?: string[] }>
  }
  for (const j of body.jobs) {
    if (j.state === 'skipped') {
      // Admission refused it. That is a recorded fact in the coverage ledger, not a
      // silent no-op — say so here too.
      console.log(
        `${cyan(j.nodeKey)}: ${outcomeColor('skipped')} — admission refused it; see \`ogun coverage\``,
      )
    } else if (j.state !== 'queued') {
      // `blocked` waits on a dependency, not on a machine. Saying anything about runners
      // here would point at the wrong thing entirely.
      console.log(`${cyan(j.nodeKey)}: ${j.state}`)
    } else if (j.reach === 'unmatched') {
      /**
       * `queued` is the truth and not the whole truth. This job asks for a capability no
       * runner registered here advertises, so nothing will ever claim it — and the word
       * "queued" is precisely what makes that invisible, since it is also what a job
       * about to run in four seconds says. Printed at the moment somebody pressed run,
       * which is when they decide the system is working.
       */
      console.log(
        `${cyan(j.nodeKey)}: ${j.state} — ${yellow(
          `no runner advertises ${(j.missing ?? []).join(', ')}, so nothing will claim this`,
        )}`,
      )
    } else if (j.reach === 'offline') {
      // Different, and not a warning: the machine exists and is asleep. It runs when the
      // machine comes back, which is what an unattended fleet is supposed to do.
      console.log(`${cyan(j.nodeKey)}: ${j.state} — ${dim('its runner is offline')}`)
    } else {
      console.log(`${cyan(j.nodeKey)}: ${j.state}`)
    }
  }
  console.log(dim(`cycle run ${body.cycleRunId}`))
}

export async function coverage(args: string[], serverUrl: string): Promise<void> {
  const project = args[0]
  if (!project) fail('usage: ogun coverage <project>')
  const res = await fetch(`${serverUrl}/api/projects/${project}/coverage`, { headers: await authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not read coverage for ${project}`)
  const { coverage: rows } = (await res.json()) as {
    coverage: Array<{
      coverage: {
        outcome: string
        ran: boolean
        findingCount: number
        reason: string | null
        runId: string | null
      }
      cycleRun: { id: string; startedAt: string; state: string }
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

  /**
   * What the workers said about the most recent batch, in full.
   *
   * The table above is derived facts; this is the one place a node gets to speak, and
   * triage is required to use it when a reviewer did not run — so a terminal that showed
   * the ledger and swallowed the note would leave the reader knowing something failed and
   * nothing about what went unexamined. Only the latest batch: this command is read to
   * ask about last night, and the Coverage page carries every note against its own row.
   */
  const latest = rows[0]?.cycleRun.id
  const inBatch = new Set(
    rows.filter((r) => r.cycleRun.id === latest && r.coverage.runId).map((r) => r.coverage.runId!),
  )
  for (const note of await runNotes(project, serverUrl)) {
    if (!inBatch.has(note.runId)) continue
    console.log(`\n${cyan(note.worker.name)} ${dim('·')} ${note.notes}`)
  }
}

type RunNote = { runId: string; notes: string; worker: { name: string } }

/** Notes are written per run and read per batch, so the ledger matches them on `runId`. */
async function runNotes(project: string, serverUrl: string): Promise<RunNote[]> {
  const res = await fetch(`${serverUrl}/api/runs/notes?project=${project}`, {
    headers: await authHeaders(),
  }).catch(() => null)
  // The ledger is the point of the command; a note it could not fetch is not worth
  // failing over having already printed it.
  if (!res?.ok) return []
  const { notes } = (await res.json()) as { notes: RunNote[] }
  return notes
}
