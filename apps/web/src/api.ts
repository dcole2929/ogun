export type SystemInfo = {
  controlPlane: {
    bind: string
    port: number
    tokenRequired: boolean
    addresses: string[]
    reachabilityWarning: string | null
    configPath: string
  }
  host: {
    git: string | null
    docker: string | null
    claude: string | null
    codex: string | null
    baseImage: boolean
    claudeCredentials: boolean
    codexCredentials: boolean
    isRunner: boolean
    runnerName: string | null
  }
  checkouts: Array<{ slug: string; path: string; present: boolean }>
  counts: { projects: number; runs: number; openFindings: number; queuedJobs: number }
}

export type PendingJob = {
  job: { id: string; nodeKey: string; state: string; createdAt: string }
  requires: string[]
  worker: { id: string; name: string }
  project: { slug: string }
  /** False when no online runner advertises everything this job needs. */
  claimable: boolean
}

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

export type SkillSummary = {
  skill: {
    id: string
    name: string
    displayName: string | null
    shortDescription: string | null
    defaultPrompt: string | null
    sourcePath: string
    origin: string
    referencePaths: string[]
    allowImplicitInvocation: boolean
    versionHash: string
    bodyLength: number
  }
  project: { slug: string } | null
  workers: Array<{ id: string; name: string; runtime: string; enabled: boolean; origin: string }>
}

export type SkillDetail = {
  skill: SkillSummary['skill'] & { body: string | null }
  workers: Array<{
    id: string
    name: string
    runtime: string
    permissions: string
    sandbox: string
    enabled: boolean
    origin: string
  }>
  project: { slug: string }
}

export type WorkerRow = {
  worker: {
    id: string
    name: string
    skillRef: string
    runtime: string
    modelRole: string
    permissions: string
    sandbox: string
    enabled: boolean
    versionHash: string
    config: Record<string, unknown>
  }
  project: { slug: string }
  /**
   * What a run would actually use. `skill` means the worker inherits its skill's
   * default_prompt rather than having none of its own.
   */
  effectivePrompt: { text: string; source: 'worker' | 'skill' | 'fallback' }
}

/** What the config.yaml looks like after an edit, so the UI can show what it changed. */
export type ConfigSnapshot = { path: string; hash: string; text: string }

export type WorkerInput = {
  projectSlug: string
  name: string
  skill: string
  runtime: string
  model: string
  permissions: string
  sandbox: string
  prompt?: string
  enabled: boolean
  /** Compare-and-swap token, so two tabs cannot silently clobber each other. */
  expectedHash?: string
}

/** Thrown when the control plane needs a token this browser has not presented yet. */
export class Unauthorized extends Error {}

const json = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  // credentials: same-origin so the session cookie rides along. Without it a
  // token-protected control plane serves a page that cannot talk to itself.
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (res.status === 401) throw new Unauthorized('this control plane requires a token')
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

/** Exchange the admin token for an httpOnly session cookie. */
export const startSession = (token: string) =>
  json<{ ok: boolean; required: boolean }>('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })

export const api = {
  projects: () => json<{ projects: Array<{ id: string; slug: string; defaultBranch: string }> }>('/api/projects'),
  workers: (slug: string) =>
    json<{ workers: Array<{ id: string; name: string; runtime: string; sandbox: string; permissions: string; enabled: boolean }> }>(
      `/api/projects/${slug}/workers`,
    ),
  coverage: (slug: string) => json<{ coverage: CoverageRow[] }>(`/api/projects/${slug}/coverage`),
  runs: () =>
    json<{ runs: RunSummary[]; pending: PendingJob[]; onlineRunners: number }>(
      '/api/runs?limit=50',
    ),
  system: () => json<SystemInfo>('/api/system'),
  adminToken: () =>
    json<{ token: string | null; reason?: string; fromEnvironment?: boolean }>('/api/system/token'),
  rotateToken: () =>
    json<{ token: string; restartRequired: boolean }>('/api/system/token/rotate', {
      method: 'POST',
    }),
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
  runners: () =>
    json<{
      runners: Array<{
        id: string
        labels: string[]
        maxConcurrency: number
        lastSeenAt: string
        enrolledAt: string | null
        revokedAt: string | null
        pending: boolean
        enrolled: boolean
        online: boolean
      }>
      /** Addresses this control plane believes it is reachable at. */
      addresses: string[]
      reachabilityWarning: string | null
      tokenRequired: boolean
    }>('/api/runners'),
  enrollRunner: (input: { id: string; labels: string[]; serverUrl?: string }) =>
    json<{ runner: { id: string }; token: string; command: string }>('/api/runners', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  revokeRunner: (id: string) =>
    json<{ revoked: string }>(`/api/runners/${id}`, { method: 'DELETE' }),
  forgetRunner: (id: string) =>
    json<{ forgotten: string }>(`/api/runners/${id}/forget`, { method: 'DELETE' }),
  skills: (project?: string) =>
    json<{ skills: SkillSummary[] }>(`/api/skills${project ? `?project=${project}` : ''}`),
  skill: (project: string, name: string) => json<SkillDetail>(`/api/skills/${project}/${name}`),

  allWorkers: (project?: string) =>
    json<{
      workers: WorkerRow[]
      /** Per project: can this control plane reach the repo to edit config.yaml? */
      editable: Record<string, boolean>
      hashes: Record<string, string>
    }>(`/api/workers${project ? `?project=${project}` : ''}`),
  createWorker: (input: WorkerInput) =>
    json<{ worker: WorkerRow['worker']; config: ConfigSnapshot }>('/api/workers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateWorker: (id: string, input: Partial<WorkerInput>) =>
    json<{ worker: WorkerRow['worker']; config: ConfigSnapshot }>(`/api/workers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  deleteWorker: (id: string) =>
    json<{ deleted: string; config: ConfigSnapshot }>(`/api/workers/${id}`, { method: 'DELETE' }),

  trigger: (projectSlug: string, worker: string) =>
    json<{ cycleRunId: string; jobs: Array<{ nodeKey: string; state: string }> }>('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug, worker }),
    }),
}
