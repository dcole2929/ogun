export type RunSummary = {
  run: {
    id: string
    outcome: string | null
    detail: string | null
    startedAt: string
    endedAt: string | null
    durationMs: number | null
    repoSha: string | null
    runtime: string | null
    model: string | null
    inputTokens: number | null
    outputTokens: number | null
  }
  job: { id: string; nodeKey: string; state: string; cycleRunId: string; prompt?: string }
  worker: { id: string; name: string; permissions?: string }
  project: { slug: string }
}

export type RunEventRow = {
  id: string
  seq: number
  ts: string
  type: string
  payload: Record<string, unknown>
}

export type RunDetail = RunSummary & {
  events: RunEventRow[]
  artifacts: Array<{ id: string; kind: string; ref: string; bytes: number | null }>
}

export type FindingRow = {
  finding: {
    id: string
    fingerprint: string
    title: string
    body: string
    severity: string
    status: string
    path: string | null
    line: number | null
    seenCount: number
    updatedAt: string
  }
  worker: { name: string } | null
  project: { slug: string }
}

export type CoverageRow = {
  coverage: {
    outcome: string
    ran: boolean
    selected: boolean
    findingCount: number
    reason: string | null
  }
  cycleRun: { id: string; startedAt: string; state: string }
  cycle: { name: string }
  worker: { name: string }
}

const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

export const api = {
  projects: () => json<{ projects: Array<{ id: string; slug: string; defaultBranch: string }> }>('/api/projects'),
  workers: (slug: string) =>
    json<{ workers: Array<{ id: string; name: string; runtime: string; sandbox: string; permissions: string; enabled: boolean }> }>(
      `/api/projects/${slug}/workers`,
    ),
  coverage: (slug: string) => json<{ coverage: CoverageRow[] }>(`/api/projects/${slug}/coverage`),
  runs: () => json<{ runs: RunSummary[] }>('/api/runs?limit=50'),
  run: (id: string) => json<RunDetail>(`/api/runs/${id}`),
  findings: (params: { project?: string; status?: string }) => {
    const q = new URLSearchParams()
    if (params.project) q.set('project', params.project)
    if (params.status) q.set('status', params.status)
    return json<{ findings: FindingRow[] }>(`/api/findings?${q}`)
  },
  setFindingStatus: (id: string, status: string, reason?: string) =>
    json<{ finding: unknown }>(`/api/findings/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    }),
  trigger: (projectSlug: string, worker: string) =>
    json<{ cycleRunId: string; jobs: Array<{ nodeKey: string; state: string }> }>('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug, worker }),
    }),
}
