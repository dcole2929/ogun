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
  /**
   * Which projects have an API key on the control-plane machine, by name.
   *
   * Presence only, and there is no field for a value — the server's type has none either
   * (ADR-0012). The browser is never handed a secret, so there is nothing here for a
   * screenshot, a devtools network panel, or a bug report to carry away.
   */
  projectSecrets: Array<{ project: string; name: string; state: 'present' | 'empty' }>
  checkouts: Array<{ slug: string; path: string; present: boolean }>
  counts: { projects: number; runs: number; openFindings: number; queuedJobs: number }
}

export type PendingJob = {
  job: { id: string; nodeKey: string; state: string; createdAt: string }
  requires: string[]
  worker: { id: string; name: string }
  project: { slug: string }
  /**
   * Why this job is still queued. `claimable` means a runner that could take it is up
   * right now; `offline` means one exists and is not; `unmatched` means no runner
   * registered here has ever advertised what it needs, and it will wait forever.
   *
   * This was a boolean, and the two non-claimable cases were the same value. A job whose
   * only capable machine is rebooting was reported as "nothing can run this", which is
   * both false and the same sentence shown for the case where it is true.
   */
  reach: 'claimable' | 'offline' | 'unmatched'
  /** The labels nothing here advertises. Non-empty exactly when `reach` is `unmatched`. */
  missing: string[]
}

export type RunSummary = {
  /** Only on the list; the detail route returns the full `produced` breakdown. */
  produced?: { findings: number }
  run: {
    id: string
    outcome: string | null
    detail: string | null
    /** What the node wrote for a person to read. Not `detail` — see `runs.notes`. */
    notes: string | null
    startedAt: string
    endedAt: string | null
    durationMs: number | null
    /**
     * Rounds of deliver-and-grade (§5.2). Above one only when a modifier's patch was
     * refused and it was given another attempt. Null for a run recorded by a runner that
     * predates the retry loop, which is not the same as one.
     */
    rounds: number | null
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
  /**
   * What the run produced. Findings are one kind of output, not the point — a modifier
   * produces a patch and a branch, an architecture reviewer a proposed ADR, and plenty
   * of runs produce nothing at all.
   */
  produced: {
    findings: Array<Record<string, unknown>>
    /** Reported and not allowed to be said, because somebody had already dismissed it. */
    suppressed: Array<{
      finding: Record<string, unknown>
      dismissal: string | null
      reason: string | null
    }>
    promoted: Array<{
      id: string
      fingerprint: string
      title: string
      severity: string
      status: string
      seenCount: number
      firstSeenHere: boolean
    }>
    changes: Array<{
      id: string
      branch: string | null
      filesChanged: number | null
      testsPassed: boolean | null
      prUrl: string | null
    }>
  }
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

/**
 * A note one run wrote, carrying the batch it belongs to.
 *
 * Notes are written per run and read per batch — "which surface did nobody look at last
 * night" is a coverage question — so the ledger matches these on `runId`.
 */
export type RunNote = {
  runId: string
  cycleRunId: string
  startedAt: string
  outcome: string | null
  notes: string
  worker: { name: string }
  project: { slug: string }
}

export type CoverageRow = {
  coverage: {
    outcome: string
    ran: boolean
    selected: boolean
    findingCount: number
    reason: string | null
    /** Null when the worker never ran. What a `RunNote` is matched on. */
    runId: string | null
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
  /** Null when this worker has never failed. */
  breaker: { consecutiveFailures: number; openedAt: string | null } | null
  /** Null when the worker has no `schedule:` — it only runs when triggered. */
  schedule: {
    cron: string | null
    tz: string | null
    onMissed: string | null
    lastRunAt: string | null
    enabled: boolean | null
  } | null
  nextRun: string | null
  /**
   * The named cycle that runs this worker, when one does. Its schedule replaces the
   * worker's own — a worker cannot be scheduled twice.
   */
  drivenBy: { cycle: string; schedule: string | null; nextRun: string | null } | null
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
  /** Cron expression. Empty string removes the schedule. */
  schedule?: string
  onMissed?: string
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

export type Drift = {
  state: 'current' | 'drifted' | 'unreachable' | 'unknown'
  path?: string
  /** Which half moved — config.yaml, the skills beside it, or both. */
  what?: Array<'config' | 'skills'>
}

/** The three things that stop work while every page still reports success. */
export type Status = {
  runnersOnline: number
  drifted: string[]
  breakers: Array<{ worker: string; project: string; failures: number }>
}

export const api = {
  projects: () =>
    json<{ projects: Array<{ id: string; slug: string; defaultBranch: string; drift: Drift }> }>(
      '/api/projects',
    ),
  status: () => json<Status>('/api/system/status'),
  syncLocal: (slug: string) =>
    json<{ workers: string[]; skills: string[] }>(`/api/projects/${slug}/sync-local`, {
      method: 'POST',
    }),
  workers: (slug: string) =>
    json<{ workers: Array<{ id: string; name: string; runtime: string; sandbox: string; permissions: string; enabled: boolean }> }>(
      `/api/projects/${slug}/workers`,
    ),
  coverage: (slug: string) => json<{ coverage: CoverageRow[] }>(`/api/projects/${slug}/coverage`),
  runNotes: (slug: string) => json<{ notes: RunNote[] }>(`/api/runs/notes?project=${slug}`),
  runs: () =>
    json<{
      runs: RunSummary[]
      pending: PendingJob[]
      onlineRunners: number
      /** Registered and not revoked, whether or not they are up. */
      liveRunners: number
    }>('/api/runs?limit=50'),
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
        name: string
        createdAt: string
        updatedAt: string
        labels: string[]
        maxConcurrency: number
        lastSeenAt: string
        enrolledAt: string | null
        revokedAt: string | null
        pending: boolean
        enrolled: boolean
        online: boolean
        /**
         * What this machine last told the control plane it could authenticate.
         *
         * Null means it has not said — an older build, or a report that has aged out —
         * which is deliberately not the same as "no credentials" and must not be rendered
         * as a failure. Admission admits on it, and so does this page.
         *
         * Expiries only ever leave the runner host, so there is nothing secret here to
         * put in a browser (ADR-0010). The states are `CredentialHealth['state']`, judged
         * server-side against the default worker timeout — the page does no arithmetic of
         * its own, which is how the Workers page came to display a breaker threshold no
         * project had set.
         */
        credentials: {
          reportedAt: string
          anthropic: string
          openai: string
        } | null
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
      /**
       * Per project: whether config.yaml's `policies.allowSandboxDowngrade` is true, so
       * the form can offer `modifier` + `worktree` to a project that opted into it.
       *
       * Separate from `policies` below because it is a different copy of a different
       * half. `policies` is what the control plane stored at sync; this key is
       * deliberately never stored (§4.9) and is read straight from the file. Absent for a
       * project this control plane cannot reach.
       */
      allowSandboxDowngrade: Record<string, boolean>
      /**
       * Per project: the control-plane policies actually in force, from the server.
       *
       * The page used to keep `const BREAKER_THRESHOLD = 3` and do the arithmetic itself,
       * which meant a project that had set `failureBreakerThreshold: 5` was told the wrong
       * number of runs remained. There is no default on this side on purpose — a fallback
       * constant here is how the mirror grows back.
       *
       * `source: 'unsynced'` means no config has ever been indexed for that project and
       * these are the schema defaults rather than anything the project asked for.
       */
      policies: Record<
        string,
        {
          policies: { maxConcurrentModifiers: number; failureBreakerThreshold: number }
          source: 'project' | 'unsynced'
        }
      >
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
  previewSchedule: (cron: string, tz?: string) =>
    json<{ valid: boolean; tz: string; nextRuns: string[]; error?: string }>(
      '/api/workers/schedule/preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron, tz }),
      },
    ),
  clearBreaker: (id: string) =>
    json<{ cleared: string }>(`/api/workers/${id}/breaker/clear`, { method: 'POST' }),
  deleteWorker: (id: string) =>
    json<{ deleted: string; config: ConfigSnapshot }>(`/api/workers/${id}`, { method: 'DELETE' }),

  trigger: (projectSlug: string, worker: string) =>
    json<{
      cycleRunId: string
      jobs: Array<{
        nodeKey: string
        state: string
        /** Whether anything can claim it — see the server's `foreman/reach.ts`. */
        reach: 'claimable' | 'offline' | 'unmatched'
        /** Labels no runner here advertises. Non-empty exactly when `reach` is `unmatched`. */
        missing: string[]
      }>
    }>('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug, worker }),
    }),
}
