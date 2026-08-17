import { and, eq, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { cycleDefinitionSchema, nodesWithDependents } from '@ogun/core'
import type { CoverageOutcome, JobState, RunOutcome, RunReport } from '@ogun/core'
import { DEFAULT_LIMITS } from './admission.ts'
import { finalizeCycleIfDone, markCoverage, releaseDependents } from './cycles.ts'

const { artifacts, breakers, cycleRuns, cycles, findings, jobs, runs, stagedFindings } = schema

export type FinalizeResult = {
  ok: true
  /** Findings reported but withheld from the inbox because triage will consolidate them. */
  staged: number
  /** The outcome as derived, which may differ from what the runner reported. */
  outcome: RunOutcome
  jobState: JobState
  findingsWritten: number
  coverage: CoverageOutcome
  /** One entry per verdict on a pre-existing finding, applied or refused with a reason. */
  adjudicated: AdjudicationOutcome[]
}

/**
 * The end of a run, as one transaction (§5.1).
 *
 * Coverage is derived from the outcome rather than trusted from the runner for the
 * cases the runner can't know, so "gate failed" can never be filed as "clean".
 */
export async function finalizeRun(db: Db, report: RunReport): Promise<FinalizeResult> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, report.runId) })
  if (!run) throw new Error(`no such run: ${report.runId}`)
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, run.jobId) })
  if (!job) throw new Error(`run ${report.runId} has no job`)

  const gateFailed = report.gates.some((g) => !g.passed)

  /**
   * The outcome is derived here, not taken on trust. A runner that reports `approved`
   * alongside a failed gate is describing what the agent did, not what the gate
   * decided — and the gate decides. A reviewer whose output keeps failing the schema or
   * grounding check is malfunctioning, so this also feeds the breaker (§4.3): three
   * consecutive gate failures stop the worker being dispatched at all.
   */
  const outcome: RunOutcome =
    gateFailed && report.outcome === 'approved' ? 'changes-requested' : report.outcome

  /**
   * Whether this run's findings reach the inbox, or only the staging area.
   *
   * Triage is the only thing that writes to the findings table (§4.12). A reviewer that
   * feeds one must stage only — otherwise the inbox shows the raw findings *and* the
   * consolidated ones, which is worse than having no triage at all.
   *
   * Decided from the graph rather than from a flag on the worker: the same reviewer can
   * be a standalone one-node cycle on Monday and feed triage on Tuesday, and it should
   * publish in the first case without being reconfigured.
   */
  const consumed = await hasDependents(db, job.cycleRunId, job.nodeKey)
  let adjudicated: AdjudicationOutcome[] = []
  const reported = outcome === 'approved' ? (report.findings?.findings ?? []) : []
  const raw = consumed ? [] : reported

  const jobState: JobState =
    outcome === 'approved' || outcome === 'dispatched'
      ? 'succeeded'
      : outcome === 'skipped'
        ? 'skipped'
        : 'failed'

  const coverageOutcome: CoverageOutcome = gateFailed
    ? 'gate-failed'
    : outcome === 'error'
      ? 'errored'
      : outcome === 'skipped'
        ? 'refused'
        : // What the run reported, not what reached the inbox. A reviewer feeding triage
          // still found what it found; the ledger recording `clean` would be a lie that
          // makes the coverage picture depend on whether triage has run yet.
          reported.length > 0
          ? 'found'
          : 'clean'

  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        outcome,
        detail: report.detail ?? gateSummary(report),
        endedAt: new Date(),
        ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
        ...(report.usage?.inputTokens !== undefined ? { inputTokens: report.usage.inputTokens } : {}),
        ...(report.usage?.outputTokens !== undefined
          ? { outputTokens: report.usage.outputTokens }
          : {}),
        ...(report.usage?.costCents !== undefined ? { costCents: report.usage.costCents } : {}),
      })
      .where(eq(runs.id, report.runId))

    await tx.update(jobs).set({ state: jobState }).where(eq(jobs.id, job.id))

    if (report.artifacts.length > 0) {
      await tx.insert(artifacts).values(
        report.artifacts.map((a) => ({
          runId: report.runId,
          kind: a.kind,
          ref: a.ref,
          ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
        })),
      )
    }

    /**
     * Reviewers write to staging; only triage promotes to `findings` (§4.12). Phase 1
     * has no triage node, so a reviewer's output is promoted directly — but it goes
     * through staging first regardless, so wiring triage in phase 2 changes who reads
     * staging rather than who writes it.
     */
    // Staged regardless of whether they are promoted — this is what triage reads, and
    // what makes a discarded finding recoverable rather than gone.
    if (reported.length > 0) {
      await tx.insert(stagedFindings).values(
        reported.map((f) => ({
          runId: report.runId,
          workerId: job.workerId,
          workerName: job.workerName,
          raw: f as unknown as Record<string, unknown>,
        })),
      )
    }

    for (const f of raw) {
      const primary = f.citations[0]
      await tx
        .insert(findings)
        .values({
          projectId: job.projectId,
          workerId: job.workerId,
          fingerprint: f.fingerprint,
          ...(primary?.path ? { path: primary.path } : {}),
          ...(primary?.line ? { line: primary.line } : {}),
          severity: f.severity,
          ...(f.confidence !== undefined ? { confidence: Math.round(f.confidence * 100) } : {}),
          title: f.title,
          body: f.body,
          status: 'open',
          ...(f.revisitOf ? { revisitOf: f.revisitOf } : {}),
          ...(f.revisitReason ? { revisitReason: f.revisitReason } : {}),
          firstSeenRun: report.runId,
          lastSeenRun: report.runId,
          seenCount: 1,
        })
        // Seeing the same fingerprint again is not a new finding — it bumps the count
        // and the last-seen run. Without this, night two regenerates every row from
        // night one and "I already dismissed this" is unrepresentable (§4.11).
        .onConflictDoUpdate({
          target: [findings.projectId, findings.fingerprint],
          set: {
            lastSeenRun: report.runId,
            seenCount: sql`${findings.seenCount} + 1`,
            severity: f.severity,
            title: f.title,
            body: f.body,
            ...(f.revisitOf ? { revisitOf: f.revisitOf } : {}),
            ...(f.revisitReason ? { revisitReason: f.revisitReason } : {}),
            status: reopenClause,
            statusReason: reopenReasonClause,
            updatedAt: new Date(),
          },
        })
    }

    /**
     * Re-adjudication (§4.11): verdicts on findings nobody re-reported this run.
     *
     * Applied under exactly the same gate as findings — only a node that publishes may
     * change the inbox, read off the graph rather than declared (§4.12). A reviewer
     * feeding triage stages its verdicts along with everything else and triage decides.
     */
    adjudicated = consumed ? [] : await applyAdjudications(tx, job.projectId, report)

    await markCoverage(tx, job.cycleRunId, job, {
      outcome: coverageOutcome,
      ran: outcome !== 'skipped',
      runId: report.runId,
      // What it reported, not what was promoted. A reviewer feeding triage found what it
      // found; the ledger should say so rather than showing zero because triage has not
      // run yet.
      findingCount: reported.length,
      ...(coverageReason(report, gateFailed) ? { reason: coverageReason(report, gateFailed)! } : {}),
    })

    /**
     * The breaker is live state about a worker that still exists, not history — so it
     * keeps its cascade, and there is nothing to record when the worker is already gone.
     * A run can outlive its worker now; a breaker cannot.
     */
    const threshold = DEFAULT_LIMITS.failureBreakerThreshold
    if (job.workerId === null) {
      // nothing to latch
    } else if (jobState === 'failed') {
      await tx
        .insert(breakers)
        .values({ workerId: job.workerId, consecutiveFailures: 1 })
        .onConflictDoUpdate({
          target: breakers.workerId,
          set: {
            consecutiveFailures: sql`${breakers.consecutiveFailures} + 1`,
            updatedAt: new Date(),
            openedAt: sql`case when ${breakers.consecutiveFailures} + 1 >= ${threshold}
                               then coalesce(${breakers.openedAt}, now()) else ${breakers.openedAt} end`,
          },
        })
    } else if (jobState === 'succeeded') {
      await tx
        .insert(breakers)
        .values({ workerId: job.workerId, consecutiveFailures: 0 })
        .onConflictDoUpdate({
          target: breakers.workerId,
          set: { consecutiveFailures: 0, openedAt: null, updatedAt: new Date() },
        })
    }
  })

  await releaseDependents(db, job.cycleRunId)
  await finalizeCycleIfDone(db, job.cycleRunId)

  return {
    ok: true,
    outcome,
    jobState,
    findingsWritten: raw.length,
    adjudicated,
    /** Reported but held for triage rather than published. */
    staged: consumed ? reported.length : 0,
    coverage: coverageOutcome,
  }
}

/**
 * A re-sighting is not always just a repeat, and the difference matters per status:
 *
 *   fixed              -> reopen. The fix did not hold, or the bug regressed. Leaving it
 *                         `fixed` hides a confirmed-broken row from the one query the
 *                         review protocol tells every reviewer to run first.
 *   gated | overflow   -> reopen. Those mean triage set it aside, not that anyone
 *                         decided anything. A fresh sighting is new evidence.
 *   wontfix | duplicate-> hold. Those are human decisions, and a reviewer re-reporting
 *                         something does not overrule one. The seen count still bumps,
 *                         so the pressure is visible without the row nagging.
 *   open | triaged     -> unchanged.
 *
 * Found by ogun's own adversarial-review worker on its first real run.
 */
const reopenClause = sql`case
  when ${findings.status} in ('fixed', 'gated', 'overflow') then 'open'
  else ${findings.status}
end`

const reopenReasonClause = sql`case
  when ${findings.status} = 'fixed'
    then 'reopened: reported again after being marked fixed'
  when ${findings.status} in ('gated', 'overflow')
    then 'reopened: reported again after being set aside by triage'
  else ${findings.statusReason}
end`

/**
 * Does anything downstream in this cycle run depend on this node? Read from the
 * definition rather than from the jobs, so it is true even before the dependent has been
 * released.
 *
 * From the run's frozen copy, not the live `cycles` row. This decides whether a
 * reviewer stages or publishes, and it is the more dangerous of the two live reads: drop
 * a reviewer from the cycle's `workers:` list while it is running, sync, and the run that
 * started as a staged input finishes as a direct publish — putting raw findings in the
 * inbox alongside whatever triage later consolidates, which is the exact outcome the
 * fan-in exists to prevent.
 */
async function hasDependents(db: Db, cycleRunId: string, nodeKey: string): Promise<boolean> {
  const cycleRun = await db.query.cycleRuns.findFirst({ where: eq(cycleRuns.id, cycleRunId) })
  if (!cycleRun) return false

  const definition = cycleDefinitionSchema.safeParse(cycleRun.definition)
  if (!definition.success) return false
  return nodesWithDependents(definition.data).has(nodeKey)
}

const gateSummary = (report: RunReport): string | undefined => {
  const failed = report.gates.filter((g) => !g.passed)
  if (failed.length === 0) return undefined
  return failed.map((g) => `${g.name}: ${g.detail ?? 'failed'}`).join('; ')
}

const coverageReason = (report: RunReport, gateFailed: boolean): string | undefined =>
  gateFailed ? gateSummary(report) : (report.coverage.reason ?? report.detail)


/**
 * What happened to one verdict. Refusals are returned rather than thrown: a single bad
 * adjudication must not discard a night's real work, and "triage tried to close
 * something that does not exist" is a fact about triage worth surfacing.
 */
export type AdjudicationOutcome = {
  fingerprint: string
  verdict: string
  applied: boolean
  /** Present when `applied` is false. */
  refused?: string
}

/**
 * Statuses a verdict may move a finding *to*.
 *
 * `wontfix` is not reachable from here and must not become so. It means a person looked
 * at a real problem and accepted it, and nothing that runs unattended at 3am should be
 * able to write that down on their behalf.
 */
const VERDICT_STATUS: Record<string, string> = {
  'still-applies': 'open',
  fixed: 'fixed',
  'no-longer-applicable': 'obsolete',
  'duplicate-of': 'duplicate',
}

async function applyAdjudications(
  tx: Db,
  projectId: string,
  report: RunReport,
): Promise<AdjudicationOutcome[]> {
  const verdicts = report.findings?.adjudications ?? []
  if (verdicts.length === 0) return []

  const known = await tx
    .select({ fingerprint: findings.fingerprint, status: findings.status })
    .from(findings)
    .where(eq(findings.projectId, projectId))
  const statusOf = new Map(known.map((f) => [f.fingerprint, f.status]))

  const out: AdjudicationOutcome[] = []
  for (const a of verdicts) {
    const refuse = (why: string): void => {
      out.push({ fingerprint: a.fingerprint, verdict: a.verdict, applied: false, refused: why })
    }

    const current = statusOf.get(a.fingerprint)
    if (current === undefined) {
      // The adjudicator was handed this inbox; naming something absent from it means it
      // invented the fingerprint, which is the same class of error as a hallucinated
      // citation and gets the same treatment.
      refuse('no such finding in this project')
      continue
    }

    /**
     * A `wontfix` is a decision a person made. Re-opening it, closing it, or merging it
     * away are all forms of overruling them, and the skills already say to treat it like
     * an ADR. Enforced here rather than only in prose.
     */
    if (current === 'wontfix') {
      refuse('wontfix is a human decision and is not adjudicable')
      continue
    }

    if (a.verdict === 'duplicate-of') {
      if (a.duplicateOf === a.fingerprint) {
        refuse('a finding cannot be a duplicate of itself')
        continue
      }
      const target = statusOf.get(a.duplicateOf)
      if (target === undefined) {
        refuse(`merge target ${a.duplicateOf} is not a finding in this project`)
        continue
      }
      // Otherwise a chain of merges can end nowhere, and the row a reader is sent to is
      // itself pointing somewhere else.
      if (target === 'duplicate') {
        refuse(`merge target ${a.duplicateOf} is itself a duplicate`)
        continue
      }
    }

    await tx
      .update(findings)
      .set({
        status: VERDICT_STATUS[a.verdict]!,
        statusReason: `${a.verdict}: ${a.reason}`,
        statusRun: report.runId,
        ...(a.verdict === 'duplicate-of' ? { duplicateOf: a.duplicateOf } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(findings.projectId, projectId), eq(findings.fingerprint, a.fingerprint)))

    // Keep the local view current, so two verdicts in one document that disagree about
    // the same finding cannot both look valid.
    statusOf.set(a.fingerprint, VERDICT_STATUS[a.verdict]!)
    out.push({ fingerprint: a.fingerprint, verdict: a.verdict, applied: true })
  }
  return out
}
