import type { ClaimedJob, RunEvent, RunReport } from '@ogun/core'
import { claimResponseSchema } from '@ogun/core'

/** One compact record per known finding, plus its full body keyed by fingerprint. */
export type FindingsHistory = {
  index: Array<{
    fingerprint: string
    status: string
    severity: string
    title: string
    path?: string
    seenCount: number
    lastSeenAt: string
    statusReason?: string
  }>
  details: Record<string, string>
}

/**
 * The runner's only interface to state. It never opens a database connection, so
 * moving the control plane off this box is a change to `baseUrl` (§3).
 */
export class ControlPlane {
  readonly #baseUrl: string
  readonly #token: string | undefined

  constructor(baseUrl: string, token = process.env.OGUN_RUNNER_TOKEN?.trim() || undefined) {
    this.#baseUrl = baseUrl
    this.#token = token
  }

  /** Absent for a localhost control plane, which needs no token. */
  get #headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
    }
  }

  async claim(runnerName: string, labels: string[], capacity: number): Promise<ClaimedJob[]> {
    const res = await this.post('/api/jobs/claim', { runnerName, labels, capacity })
    return claimResponseSchema.parse(res).jobs
  }

  /**
   * What this job's upstream nodes produced. Null when there are none, which is every
   * one-node cycle.
   *
   * Throws rather than returning null on a transport or auth failure. Those two cases
   * look identical from here and must not: a triage node that silently receives no
   * input reads the repository, finds nothing to consolidate, and reports a clean
   * night — the exact failure the coverage ledger exists to make impossible.
   */
  async inputs(jobId: string): Promise<unknown | null> {
    const res = await fetch(`${this.#baseUrl}/api/jobs/${jobId}/inputs`, {
      headers: this.#headers,
    })
    if (!res.ok) {
      throw new Error(`could not read job inputs (${res.status}): ${await res.text()}`)
    }
    const body = (await res.json()) as { sources?: unknown[] }
    return body.sources && body.sources.length > 0 ? body : null
  }

  /**
   * What this project's inbox already says, so a reviewer is not blind to its own
   * previous nights.
   *
   * Unlike `inputs`, a failure here is not fatal. A review that runs without history is
   * degraded — it may re-report something known — but a review that does not run at all
   * is worse, and the coverage ledger would record the wrong fact about the surface. The
   * caller notes the absence on the timeline instead.
   */
  async history(jobId: string): Promise<FindingsHistory | null> {
    const res = await fetch(`${this.#baseUrl}/api/jobs/${jobId}/history`, {
      headers: this.#headers,
    })
    if (!res.ok) return null
    const body = (await res.json()) as FindingsHistory
    return body.index.length > 0 ? body : null
  }

  async started(runId: string, fields: Record<string, unknown>): Promise<void> {
    await this.post(`/api/runs/${runId}/started`, fields)
  }

  async events(runId: string, events: RunEvent[]): Promise<void> {
    await this.post(`/api/runs/${runId}/events`, { events })
  }

  async report(report: RunReport): Promise<unknown> {
    return this.post(`/api/runs/${report.runId}/report`, report)
  }

  /**
   * The branch and the draft pull request the publisher produced, filled into the
   * `changes` row the report already wrote (ADR-0005).
   *
   * Deliberately not folded into `report`: the pull request does not exist yet when the
   * report is sent, and it is sent first on purpose — a publish that fails halfway leaves
   * a `changes` row with a null branch, which is a state you can see and retry, where the
   * other order leaves a live pull request the database has never heard of.
   *
   * Throws like every other write. The caller catches it and says so on the timeline: by
   * the time this runs the pull request is already open, so a failure here is a record
   * that is behind rather than work that was lost.
   */
  async published(runId: string, branch: string, prUrl: string): Promise<void> {
    await this.post(`/api/runs/${runId}/published`, { branch, prUrl })
  }

  async health(): Promise<boolean> {
    return fetch(`${this.#baseUrl}/api/health`).then(
      (r) => r.ok,
      () => false,
    )
  }

  async authorized(): Promise<boolean> {
    return fetch(`${this.#baseUrl}/api/projects`, { headers: this.#headers }).then(
      (r) => r.status !== 401,
      () => false,
    )
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status} ${await res.text().catch(() => '')}`)
    }
    return res.json()
  }
}

/**
 * Events are high-volume and needed live, so they are batched — flush every N events or
 * M milliseconds, whichever comes first (§5.1). A failed flush is retried on the next
 * one rather than dropped: the unique (run_id, seq) index makes that safe.
 */
export class EventFlusher {
  private buffer: RunEvent[] = []
  private timer: NodeJS.Timeout | undefined

  readonly #cp: ControlPlane
  readonly #runId: string
  readonly #maxBatch: number
  readonly #maxDelayMs: number

  constructor(cp: ControlPlane, runId: string, maxBatch = 25, maxDelayMs = 750) {
    this.#cp = cp
    this.#runId = runId
    this.#maxBatch = maxBatch
    this.#maxDelayMs = maxDelayMs
  }

  push(events: RunEvent[]): void {
    this.buffer.push(...events)
    if (this.buffer.length >= this.#maxBatch) void this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.#maxDelayMs)
      this.timer.unref()
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    try {
      await this.#cp.events(this.#runId, batch)
    } catch (err) {
      // Put them back at the front — ordering is by seq anyway, but keeping them means
      // a transient control-plane blip doesn't punch a hole in the timeline.
      this.buffer = [...batch, ...this.buffer]
      console.warn(`[runner] event flush failed, ${this.buffer.length} buffered:`, err)
    }
  }
}
