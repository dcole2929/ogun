import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import {
  eventBatchSchema,
  runPublishedSchema,
  runReportSchema,
  runStartedSchema,
  type RunEvent,
  type RunReport,
} from '@ogun/core'
import type { Env } from '../context.ts'
import { finalizeRun } from '../foreman/finalize.ts'
import { fleet } from '../foreman/reach.ts'

const {
  artifacts,
  changes,
  findings,
  jobs,
  projects,
  runEvents,
  runs,
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
  /**
   * The outcome on record, not the one in the body. The gate can overrule what the
   * runner claims, and a report that lost the race to finalize has no outcome of its
   * own at all — publishing the body's would close the timeline with `approved` on a
   * run the database calls failed, which is the same lie the write path refuses.
   */
  bus.publish(report.runId, [
    {
      type: 'run.completed',
      ts: new Date().toISOString(),
      seq: Number.MAX_SAFE_INTEGER,
      payload: {
        outcome: result.outcome,
        detail: result.alreadyFinalized
          ? 'a report arrived after this run was finalized; nothing was applied'
          : (report.detail ?? null),
      },
    } satisfies RunEvent,
  ])
  // 200, not a conflict: a slow machine reporting after the sweep gave up on it did
  // nothing wrong, and a runner that throws here would only report again.
  return c.json(result)
})

/**
 * The publisher's write: the branch and draft pull request that now exist for a run whose
 * patch was published (ADR-0005, §4.4).
 *
 * A second call rather than two more fields on the report, because the pull request does
 * not exist when the report is sent and the report is sent first on purpose. The two
 * columns have been on this table since it was created with nothing writing them (§9);
 * this is what writes them.
 *
 * Three things are checked, and each of them is a claim a runner should not be able to
 * make on its own:
 *
 *   - the run is recorded as `dispatched`. That is the only outcome that means "there was
 *     a patch to publish" (§5.2), and it is the control plane that decides it — a gate
 *     failure derives `dispatched` down to `changes-requested` in `finalizeRun`. A runner
 *     announcing a pull request for a run this database calls failed is either confused
 *     or lying, and either way the row must not say the work was published.
 *   - a `changes` row exists. Nothing to fill in otherwise.
 *   - that row has no branch yet. Two publishes of one run means something has gone
 *     wrong upstream, and the first pull request is the one already linked from the run
 *     page; overwriting it would strand it with nothing pointing at it.
 *
 * Not part of `finalizeRun`'s transaction and not claimed the way an outcome is: this
 * writes two columns of one row that the transaction already created, so there is no
 * partial state to protect and nothing else racing for it.
 */
runsRoutes.post('/:id/published', async (c) => {
  const { db } = c.var.ctx
  const body = runPublishedSchema.parse({ ...(await c.req.json()), runId: c.req.param('id') })

  const run = await db.query.runs.findFirst({ where: eq(runs.id, body.runId) })
  if (!run) return c.json({ error: 'no such run' }, 404)
  if (run.outcome !== 'dispatched') {
    return c.json(
      {
        error: `run ${body.runId} is recorded as "${run.outcome ?? 'not finished'}", not ` +
          '"dispatched" — only a run that ended with a publishable patch can have one',
      },
      409,
    )
  }

  const [updated] = await db
    .update(changes)
    .set({ branch: body.branch, prUrl: body.prUrl })
    .where(and(eq(changes.runId, body.runId), isNull(changes.branch)))
    .returning()

  if (!updated) {
    const [existing] = await db.select().from(changes).where(eq(changes.runId, body.runId))
    return existing
      ? c.json({ error: `run ${body.runId} is already published as ${existing.branch}` }, 409)
      : c.json({ error: `run ${body.runId} recorded no change to publish` }, 404)
  }
  return c.json({ ok: true, change: updated })
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

  // What could pick them up, so "queued" can say whether it is waiting on a machine, on
  // a machine that is asleep, or on a machine that does not exist. See `foreman/reach.ts`
  // for why that is three answers and not a boolean.
  const machines = await fleet(db)

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
    pending: pending.map((p) => ({ ...p, ...machines.verdict(p.requires) })),
    onlineRunners: machines.online,
    /** Live machines, up or not. Zero is a different problem from "none match". */
    liveRunners: machines.live,
  })
})

/**
 * What the nodes had to say, most recent first, optionally scoped to one project.
 *
 * A note is written per run but read per batch: "which surface did nobody look at last
 * night" is asked on the coverage ledger, and that ledger is keyed on the cycle run
 * rather than the run. So the batch-shaped views read this and match on `runId`, instead
 * of each of them growing its own join back to `runs`.
 *
 * Registered above `GET /:id`, which would otherwise take `notes` for a run id and hand
 * postgres a string that is not a uuid.
 */
runsRoutes.get('/notes', async (c) => {
  const { db } = c.var.ctx
  const slug = c.req.query('project')
  const rows = await db
    .select({
      runId: runs.id,
      startedAt: runs.startedAt,
      outcome: runs.outcome,
      notes: runs.notes,
      cycleRunId: jobs.cycleRunId,
      worker: { name: jobs.workerName },
      project: { slug: projects.slug },
    })
    .from(runs)
    .innerJoin(jobs, eq(jobs.id, runs.jobId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(slug ? and(isNotNull(runs.notes), eq(projects.slug, slug)) : isNotNull(runs.notes))
    .orderBy(desc(runs.startedAt))
    // Wide enough to cover the batches the coverage page shows, so a row there is never
    // shown without a note that exists.
    .limit(Number(c.req.query('limit') ?? 200))
  return c.json({ notes: rows })
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
      /**
       * What this run reported and was not allowed to say, and on whose authority (§4.11).
       *
       * The page could already answer "what did this run find". It could not answer "what
       * did it stay silent about", and suppression is the one thing here whose entire
       * effect is an absence — which without a record is indistinguishable from a
       * reviewer that looked and found nothing (principle 6).
       */
      suppressed: reported
        .filter((f) => f.suppressedBy)
        .map((f) => ({
          finding: f.raw,
          dismissal: f.suppressedBy,
          reason: f.suppressionReason,
        })),
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
      /**
       * What a modifier did to the tree: base sha, files changed, and a pointer to the
       * patch when there is one. `branch` and `prUrl` are filled in by the host-side
       * publisher afterwards, and stay null when it refused — a row here is a record of
       * work done, not a claim that it was published (§4.4). Which of the two you are
       * looking at is exactly whether `branch` is set.
       */
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
