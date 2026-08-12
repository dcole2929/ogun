import type { ClaimedJob, RunEvent, RunReport } from '@ogun/core'
import { claimResponseSchema } from '@ogun/core'

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

  async claim(runnerId: string, labels: string[], capacity: number): Promise<ClaimedJob[]> {
    const res = await this.post('/api/jobs/claim', { runnerId, labels, capacity })
    return claimResponseSchema.parse(res).jobs
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
