import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import {
  eventBatchSchema,
  isTerminal,
  runPublishedSchema,
  runReportSchema,
  runStartedSchema,
  type JobState,
  type RunEvent,
  type RunReport,
} from '@ogun/core'
import type { Env } from '../context.ts'
import { RUNNER_STALE_MS } from '../foreman/admission.ts'
import { finalizeRun } from '../foreman/finalize.ts'
import { fleet } from '../foreman/reach.ts'
import { readGrant } from '@ogun/core'

const {
  artifacts,
  changes,
  cycleRuns,
  findings,
  jobs,
  projects,
  runEvents,
  runs,
  sourceEmissions,
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
   * Which ticket each run is about, for the runs on this page.
   *
   * A run started by a source knows its ticket only through its cycle run: the emission
   * ledger is the join, and `externalKey` is the handle a person searches for. Without
   * this the list says which *worker* ran and never what it ran *about*, which is the one
   * thing somebody scanning it wants.
   *
   * **The title is deliberately absent and the url is built rather than stored.**
   * `source_emissions` keeps a digest and not the text, and the schema says why: a column
   * holding a ticket's body is a copy of Linear's content sitting where a later caller can
   * read it and believe it current (ADR-0004). A stored URL has the same problem, because
   * Linear's canonical form carries a title-derived slug. Constructing it from the
   * identifier mirrors nothing and cannot go stale — and the slug-less form resolves,
   * which was checked against the live API rather than assumed.
   *
   * One query for the page, not one per row.
   */
  const cycleRunIds = rows.map((r) => r.job.cycleRunId).filter((id): id is string => id !== null)
  const emissionRows = cycleRunIds.length
    ? await db
        .select({
          cycleRunId: sourceEmissions.cycleRunId,
          externalKey: sourceEmissions.externalKey,
          slug: projects.slug,
        })
        .from(sourceEmissions)
        .innerJoin(projects, eq(projects.id, sourceEmissions.projectId))
        .where(inArray(sourceEmissions.cycleRunId, cycleRunIds))
    : []

  /**
   * The workspace those tickets live in, which is the other half of the address.
   *
   * Read from the project's grant rather than kept beside the emission, for the same
   * reason: it is a fact about a credential, read where it is used. A project with no live
   * grant yields no workspace and therefore no link, and the identifier still shows —
   * which is the honest degradation rather than a broken anchor.
   */
  const workspaces = new Map<string, string>()
  for (const slug of [...new Set(emissionRows.map((e) => e.slug))]) {
    const grant = await readGrant(slug, 'linear')
    const urlKey = grant.state === 'present' ? grant.grant.account?.urlKey : undefined
    if (urlKey !== undefined) workspaces.set(slug, urlKey)
  }

  const ticketFor = new Map(
    emissionRows.map((e) => {
      const urlKey = workspaces.get(e.slug)
      return [
        e.cycleRunId,
        {
          key: e.externalKey,
          url: urlKey === undefined ? null : `https://linear.app/${urlKey}/issue/${e.externalKey}`,
        },
      ] as const
    }),
  )

  /**
   * Jobs waiting to be claimed, which have no run row yet. Without these, triggering a
   * worker while no runner is online showed *nothing at all* — the queue is where the
   * work is, and it was invisible.
   */
  const pending = await db
    .select({
      job: {
        id: jobs.id,
        nodeKey: jobs.nodeKey,
        state: jobs.state,
        createdAt: jobs.createdAt,
        /**
         * The cycle run this job belongs to, and the node keys it was created waiting on.
         *
         * Both are here for one reason: a `blocked` row used to render as the bare pill
         * "waiting on a dependency", which is the shape principle 6 forbids — the fact a
         * reader needs is *which* node and what became of it, and the queue view is where
         * they are looking when they need it. `dependsOn` is the snapshot taken at
         * creation, not the live graph, which is deliberate: `releasePass` releases
         * against the frozen definition, so naming the live edges here would sometimes
         * name nodes that are not what this job is actually held by.
         */
        cycleRunId: jobs.cycleRunId,
        dependsOn: jobs.dependsOn,
      },
      requires: jobs.requires,
      /** The snapshot on the cycle run, so a renamed or deleted cycle still reads. */
      cycle: { name: cycleRuns.cycleName },
      worker: { id: workers.id, name: jobs.workerName },
      project: { slug: projects.slug },
    })
    .from(jobs)
    .leftJoin(workers, eq(workers.id, jobs.workerId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .innerJoin(cycleRuns, eq(cycleRuns.id, jobs.cycleRunId))
    .where(inArray(jobs.state, ['queued', 'blocked']))
    .orderBy(desc(jobs.createdAt))
    .limit(50)

  /**
   * What each waiting job is held by: its dependencies, by node key, with the state each
   * one is in now.
   *
   * One query for every cycle run on the page rather than one per job — the same reason
   * `fleet` is read once (see `reach.ts`): fifty round trips to answer one question about
   * one set of rows is slower and also inconsistent, since a sweep landing halfway down
   * the list would produce a page whose rows disagree about the same node.
   *
   * `terminal` is computed here, from core's `isTerminal`, rather than left to the
   * browser. The release rule in `releasePass` is "every dependency has gone terminal",
   * and a page that re-derived that from a string comparison would be a second
   * implementation of the job-state vocabulary living in a bundle — which is how the two
   * start disagreeing about a state added to `JOB_STATES` later. The UI needs the
   * distinction because the two cases are different situations: a dependency still
   * running is a job that will move on its own, and a dependency already terminal on a
   * job still sitting at `blocked` is one nothing is going to move.
   */
  const waitingOn = [
    ...new Set(pending.filter((p) => p.job.dependsOn.length > 0).map((p) => p.job.cycleRunId)),
  ]
  const siblings =
    waitingOn.length === 0
      ? []
      : await db
          .select({ cycleRunId: jobs.cycleRunId, nodeKey: jobs.nodeKey, state: jobs.state })
          .from(jobs)
          .where(inArray(jobs.cycleRunId, waitingOn))
  // Keyed on both, because node keys are unique only within a cycle run
  // (`jobs_cyclerun_node_idx`) and this map holds several runs at once.
  const siblingState = new Map(siblings.map((s) => [`${s.cycleRunId}\u0000${s.nodeKey}`, s.state]))

  // What could pick them up, so "queued" can say whether it is waiting on a machine, on
  // a machine that is asleep, or on a machine that does not exist. See `foreman/reach.ts`
  // for why that is three answers and not a boolean.
  const machines = await fleet(db)

  /**
   * What each run produced, for the list. A run's result is what you are scanning for —
   * "3 findings" or "nothing found" or "failed" — and having to open each one to learn
   * that makes the list a table of timestamps.
   *
   * Both of these are scoped to the runs on the page. The findings count was a `group by`
   * over the whole table, which costs more every night the factory runs for a number only
   * fifty rows can display; `changes` would have been worse, since it is read per row
   * rather than aggregated.
   */
  const ids = rows.map((r) => r.run.id)
  const counts =
    ids.length === 0
      ? []
      : await db
          .select({ runId: stagedFindings.runId, n: count() })
          .from(stagedFindings)
          .where(inArray(stagedFindings.runId, ids))
          .groupBy(stagedFindings.runId)
  const byRun = new Map(counts.map((c) => [c.runId, c.n]))

  /**
   * The pull request a modifier's patch was published as, for the list.
   *
   * It was already on the detail route and only there, so "what did last night produce
   * that I have to go and review" meant opening every `dispatched` run to find out which
   * ones had a link. A `changes` row with no branch is work that was done and *not*
   * published (§4.4) — the publisher refused, or has not run yet — so the two are carried
   * separately here rather than collapsed into one nullable url, because a row that
   * produced a patch nobody can see is the one worth noticing.
   */
  const published =
    ids.length === 0
      ? []
      : await db
          .select({ runId: changes.runId, branch: changes.branch, prUrl: changes.prUrl })
          .from(changes)
          .where(inArray(changes.runId, ids))
  const changeByRun = new Map(published.map((ch) => [ch.runId, ch]))

  return c.json({
    runs: rows.map((r) => {
      const change = changeByRun.get(r.run.id)
      return {
        ...r,
        ticket: (r.job.cycleRunId && ticketFor.get(r.job.cycleRunId)) || null,
        produced: {
          findings: byRun.get(r.run.id) ?? 0,
          /** Non-null exactly when this run left a patch, published or not. */
          branch: change?.branch ?? null,
          prUrl: change?.prUrl ?? null,
          changed: change !== undefined,
        },
      }
    }),
    pending: pending.map((p) => ({
      ...p,
      ...machines.verdict(p.requires),
      dependencies: p.job.dependsOn.map((nodeKey) => {
        const state = siblingState.get(`${p.job.cycleRunId}\u0000${nodeKey}`) ?? null
        // A dependency with no job row at all. Not reachable through `startCycleRun`,
        // which creates every node of the graph in one transaction — but a null here is
        // reported as "no job" rather than silently counted as satisfied, because the one
        // way it could happen is a graph edited to point at a node that was removed, and
        // that is precisely a case where guessing is worse than saying so.
        return { nodeKey, state, terminal: state !== null && isTerminal(state as JobState) }
      }),
    })),
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

  /**
   * The ticket, by the same join and on the same terms as the list — see the long note
   * there. The detail page needs it more than the list does: its subtitle was the whole
   * job prompt, fences and all, which renders a ticket's body as a wall of text nobody
   * reads and which is a mirrored copy of Linear's content to boot.
   */
  let ticket: { key: string; url: string | null } | null = null
  if (row.job.cycleRunId !== null) {
    const [emission] = await db
      .select({ externalKey: sourceEmissions.externalKey })
      .from(sourceEmissions)
      .where(eq(sourceEmissions.cycleRunId, row.job.cycleRunId))
    if (emission) {
      const grant = await readGrant(row.project.slug, 'linear')
      const urlKey = grant.state === 'present' ? grant.grant.account?.urlKey : undefined
      ticket = {
        key: emission.externalKey,
        url:
          urlKey === undefined
            ? null
            : `https://linear.app/${urlKey}/issue/${emission.externalKey}`,
      }
    }
  }

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
    ticket,
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
