import { eq, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import type { CoverageOutcome, JobState, RunOutcome, RunReport } from '@ogun/core'
import { DEFAULT_LIMITS } from './admission.ts'
import { finalizeCycleIfDone, markCoverage, releaseDependents } from './cycles.ts'

const { artifacts, breakers, findings, jobs, runs, stagedFindings } = schema

export type FinalizeResult = {
  ok: true
  /** The outcome as derived, which may differ from what the runner reported. */
  outcome: RunOutcome
  jobState: JobState
  findingsWritten: number
  coverage: CoverageOutcome
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

  const raw = outcome === 'approved' ? (report.findings?.findings ?? []) : []

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
        ? 'blocked'
        : raw.length > 0
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
    if (raw.length > 0) {
      await tx.insert(stagedFindings).values(
        raw.map((f) => ({
          runId: report.runId,
          workerId: job.workerId,
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

    await markCoverage(tx, job.cycleRunId, job.workerId, {
      outcome: coverageOutcome,
      ran: outcome !== 'skipped',
      runId: report.runId,
      findingCount: raw.length,
      ...(coverageReason(report, gateFailed) ? { reason: coverageReason(report, gateFailed)! } : {}),
    })

    const threshold = DEFAULT_LIMITS.failureBreakerThreshold
    if (jobState === 'failed') {
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

  return { ok: true, outcome, jobState, findingsWritten: raw.length, coverage: coverageOutcome }
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

const gateSummary = (report: RunReport): string | undefined => {
  const failed = report.gates.filter((g) => !g.passed)
  if (failed.length === 0) return undefined
  return failed.map((g) => `${g.name}: ${g.detail ?? 'failed'}`).join('; ')
}

const coverageReason = (report: RunReport, gateFailed: boolean): string | undefined =>
  gateFailed ? gateSummary(report) : (report.coverage.reason ?? report.detail)
