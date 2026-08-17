import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, asc, count, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import {
  eventBatchSchema,
  runReportSchema,
  runStartedSchema,
  type RunEvent,
  type RunReport,
} from '@ogun/core'
import type { Env } from '../context.ts'
import { finalizeRun } from '../foreman/finalize.ts'

const {
  artifacts,
  changes,
  findings,
  jobs,
  projects,
  runEvents,
  runs,
  runners: runnersTable,
  stagedFindings,
  workers,
} = schema

export const runsRoutes = new Hono<Env>()

runsRoutes.post('/:id/started', async (c) => {
  const { db } = c.var.ctx
  const body = runStartedSchema.parse({ ...(await c.req.json()), runId: c.req.param('id') })
  const [run] = await db
    .update(runs)
    .set({
      ...(body.repoSha ? { repoSha: body.repoSha } : {}),
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(body.runtime ? { runtime: body.runtime } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.skillVersion ? { skillVersion: body.skillVersion } : {}),
    })
    .where(eq(runs.id, body.runId))
    .returning()
  if (!run) return c.json({ error: 'no such run' }, 404)
  await db.update(jobs).set({ state: 'running' }).where(eq(jobs.id, run.jobId))
  return c.json({ ok: true })
})

/**
 * Batched event ingest. The unique (run_id, seq) index makes a retried flush idempotent
 * rather than duplicating — the runner assigns seq, so ordering survives out-of-order
 * delivery and the UI can detect gaps (§5.1).
 */
runsRoutes.post('/:id/events', async (c) => {
  const { db, bus } = c.var.ctx
  const body = eventBatchSchema.parse({ ...(await c.req.json()), runId: c.req.param('id') })

  await db
    .insert(runEvents)
    .values(
      body.events.map((e) => ({
        runId: body.runId,
        seq: e.seq,
        ts: new Date(e.ts),
        type: e.type,
        payload: e.payload,
      })),
    )
    .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })

  bus.publish(body.runId, body.events)
  return c.json({ accepted: body.events.length })
})

/** The single write that ends a run: outcome, findings, and coverage in one
 *  transaction. Partial findings from a crashed run are worse than none (§5.1). */
runsRoutes.post('/:id/report', async (c) => {
  const { db, bus } = c.var.ctx
  const report: RunReport = runReportSchema.parse({
    ...(await c.req.json()),
    runId: c.req.param('id'),
  })
  const result = await finalizeRun(db, report)
  bus.publish(report.runId, [
    {
      type: 'run.completed',
      ts: new Date().toISOString(),
      seq: Number.MAX_SAFE_INTEGER,
      payload: { outcome: report.outcome, detail: report.detail ?? null },
    } satisfies RunEvent,
  ])
  return c.json(result)
})

runsRoutes.get('/', async (c) => {
  const { db } = c.var.ctx
  const rows = await db
    .select({
      run: runs,
      job: { id: jobs.id, nodeKey: jobs.nodeKey, state: jobs.state, cycleRunId: jobs.cycleRunId },
      worker: { id: workers.id, name: jobs.workerName },
      project: { slug: projects.slug },
    })
    .from(runs)
    .innerJoin(jobs, eq(jobs.id, runs.jobId))
    .leftJoin(workers, eq(workers.id, jobs.workerId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .orderBy(desc(runs.startedAt))
    .limit(Number(c.req.query('limit') ?? 50))

  /**
   * Jobs waiting to be claimed, which have no run row yet. Without these, triggering a
   * worker while no runner is online showed *nothing at all* — the queue is where the
   * work is, and it was invisible.
   */
  const pending = await db
    .select({
      job: { id: jobs.id, nodeKey: jobs.nodeKey, state: jobs.state, createdAt: jobs.createdAt },
      requires: jobs.requires,
      worker: { id: workers.id, name: jobs.workerName },
      project: { slug: projects.slug },
    })
    .from(jobs)
    .leftJoin(workers, eq(workers.id, jobs.workerId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(inArray(jobs.state, ['queued', 'blocked']))
    .orderBy(desc(jobs.createdAt))
    .limit(50)

  // What could pick them up, so "queued" can say whether it is waiting on a machine or
  // just waiting its turn.
  const online = await db
    .select({ id: runnersTable.id, labels: runnersTable.labels })
    .from(runnersTable)
    .where(sql`${runnersTable.lastSeenAt} > now() - interval '60 seconds'`)

  /**
   * What each run produced, for the list. A run's result is what you are scanning for —
   * "3 findings" or "nothing found" or "failed" — and having to open each one to learn
   * that makes the list a table of timestamps.
   */
  const counts = await db
    .select({ runId: stagedFindings.runId, n: count() })
    .from(stagedFindings)
    .groupBy(stagedFindings.runId)
  const byRun = new Map(counts.map((c) => [c.runId, c.n]))

  return c.json({
    runs: rows.map((r) => ({ ...r, produced: { findings: byRun.get(r.run.id) ?? 0 } })),
    pending: pending.map((p) => ({
      ...p,
      // A job whose requirements no runner advertises will never be claimed. Saying so
      // beats leaving it queued forever with no explanation.
      claimable: online.some((r) => p.requires.every((label) => r.labels.includes(label))),
    })),
    onlineRunners: online.length,
  })
})

runsRoutes.get('/:id', async (c) => {
  const { db } = c.var.ctx
  const id = c.req.param('id')
  const [row] = await db
    .select({
      run: runs,
      job: jobs,
      worker: { id: workers.id, name: jobs.workerName, permissions: workers.permissions },
      project: { slug: projects.slug },
    })
    .from(runs)
    .innerJoin(jobs, eq(jobs.id, runs.jobId))
    .leftJoin(workers, eq(workers.id, jobs.workerId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(eq(runs.id, id))
  if (!row) return c.json({ error: 'no such run' }, 404)

  const events = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, id))
    .orderBy(asc(runEvents.seq))
  const files = await db.select().from(artifacts).where(eq(artifacts.runId, id))

  /**
   * What this run actually produced.
   *
   * A run is the primary object; findings are one kind of output it can have, not the
   * point of the system. A modifier produces a patch and a branch; an architecture
   * reviewer produces a proposed ADR; plenty produce nothing at all. The detail page was
   * showing an event timeline and nothing about the result, which made the question
   * "what did this run do?" answerable only by reading fifty tool calls.
   */
  const reported = await db
    .select()
    .from(stagedFindings)
    .where(eq(stagedFindings.runId, id))

  // Which of them were promoted, and whether this run was the first to say so.
  const promoted = await db
    .select()
    .from(findings)
    .where(or(eq(findings.firstSeenRun, id), eq(findings.lastSeenRun, id)))

  const change = await db.select().from(changes).where(eq(changes.runId, id))

  return c.json({
    ...row,
    events,
    artifacts: files,
    produced: {
      /** Exactly what the agent reported, before triage. */
      findings: reported.map((f) => f.raw),
      /** Those the control plane accepted, with their status now. */
      promoted: promoted.map((f) => ({
        id: f.id,
        fingerprint: f.fingerprint,
        title: f.title,
        severity: f.severity,
        status: f.status,
        seenCount: f.seenCount,
        firstSeenHere: f.firstSeenRun === id,
      })),
      /** Phase 3: branch, patch, PR. Empty until modifier workers exist. */
      changes: change,
    },
  })
})

/**
 * SSE, not websockets — the timeline is unidirectional and that is all it needs (§5.1).
 * A late subscriber backfills from postgres past `since` before attaching to the bus,
 * so reconnecting mid-run doesn't lose the earlier half.
 */
runsRoutes.get('/:id/stream', (c) => {
  const { db, bus } = c.var.ctx
  const id = c.req.param('id')
  const since = Number(c.req.query('since') ?? -1)

  return streamSSE(c, async (stream) => {
    let closed = false
    stream.onAbort(() => {
      closed = true
    })

    const backfill = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, id), gt(runEvents.seq, since)))
      .orderBy(asc(runEvents.seq))
    for (const e of backfill) {
      await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) })
    }

    const queue: RunEvent[] = []
    const unsubscribe = bus.subscribe(id, (events) => queue.push(...events))

    try {
      while (!closed) {
        const batch = queue.splice(0, queue.length)
        for (const e of batch) {
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) })
        }
        // A comment frame keeps proxies from reaping an idle connection during a long
        // tool call, which on a review run can be minutes of silence.
        if (batch.length === 0) await stream.writeSSE({ data: '', event: 'ping' })
        await stream.sleep(500)
      }
    } finally {
      unsubscribe()
    }
  })
})

runsRoutes.get('/:id/events', async (c) => {
  const { db } = c.var.ctx
  const rows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, c.req.param('id')))
    .orderBy(asc(runEvents.seq))
  return c.json({ events: rows })
})
