import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api.ts'
import { Empty, exact, Page, Pill, when } from '../ui.tsx'

/**
 * The coverage ledger (principle 6).
 *
 * The findings inbox answers "what did the factory find". This answers the question you
 * have to ask before you can trust that: **did it actually look?** An empty inbox means
 * either that the code is clean or that nothing ran, and those are not the same fact —
 * one is a result and the other is a silent failure that looks exactly like one.
 *
 * So every worker in every batch gets a row here, including the ones that never
 * executed, with the reason.
 */
/**
 * The three "never ran" cases are separate on purpose. They used to share `blocked`,
 * which left the ledger saying a job was blocked and nothing about by what — the exact
 * conflation this table exists to prevent.
 */
/** What to do about it. A warning with no remedy is one you learn to scroll past. */
const REMEDY: Record<string, string> = {
  // A breaker guards a worker, not a machine, so it lives on Workers — where the thing
  // it is stopping is shown.
  refused: 'Clear its breaker on the Workers page, or re-enable the worker there.',
  blocked: 'Fix whatever its dependency was waiting on, then run the cycle again.',
  cancelled: 'Trigger it again from Workers when you want it.',
  errored: 'Open the run for the failure, fix it, and trigger again.',
  'gate-failed': "Open the run — its output was rejected, and the gate says why.",
}

const MEANING: Record<string, string> = {
  pending: 'selected and queued — no runner has picked it up yet',
  found: 'ran, and reported findings',
  clean: 'ran, looked, and reported nothing — a result, not an absence',
  // Falls back to this only when the reason went missing; a declined row normally shows
  // the evaluator's own sentence, which is the whole point of the row.
  declined: 'ran, judged the work it was handed, and refused it — the reason should be here',
  'gate-failed': 'ran, but the verify gate rejected its output, so nothing was persisted',
  errored: 'started and failed',
  refused: 'never ran: admission refused it — the breaker is open, or it is disabled',
  blocked: 'never ran: a dependency in its cycle did not succeed',
  cancelled: 'never ran: stopped deliberately',
  abandoned: 'never ran: ended without reporting, inferred from the job',
  'not-selected': 'not part of this batch',
}

export function CoveragePage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const slug = projects?.projects[0]?.slug
  const { data } = useQuery({
    queryKey: ['coverage', slug],
    queryFn: () => api.coverage(slug!),
    enabled: Boolean(slug),
  })
  const rows = data?.coverage ?? []

  /**
   * What the workers wrote about their own pass, keyed by the run that wrote it.
   *
   * This is the page a degraded night is read on, and triage is required to describe one
   * in `notes` — naming the reviewers that did not run, so that "three findings from four
   * reviewers" cannot be read as "three findings from three". Kept beside the ledger row
   * it is about rather than only on the run, since nobody opens four run pages to find
   * out whether the night was whole.
   */
  const { data: notes } = useQuery({
    queryKey: ['run-notes', slug],
    queryFn: () => api.runNotes(slug!),
    enabled: Boolean(slug),
  })
  const noteFor = new Map((notes?.notes ?? []).map((n) => [n.runId, n]))

  /**
   * Only the most recent batch, and only what you can act on.
   *
   * Counting every never-ran row in history produced a permanent banner about work that
   * failed weeks ago, which you could neither dismiss nor fix — and a warning you cannot
   * act on is one you learn to scroll past, taking the ones that matter with it.
   * `abandoned` is excluded for the same reason: it is the sweep's inference about a job
   * that vanished, not a surface anyone decided to skip.
   */
  const latestBatch = rows[0]?.cycleRun.id
  const actionable = rows.filter(
    (r) =>
      r.cycleRun.id === latestBatch &&
      !r.coverage.ran &&
      r.coverage.outcome !== 'pending' &&
      r.coverage.outcome !== 'abandoned',
  )

  return (
    <Page
      title="Coverage"
      subtitle="Whether the factory actually looked — not what it found."
    >
      <div className="card" style={{ marginBottom: 20 }}>
        <p style={{ marginTop: 0, fontSize: 13 }}>
          <Link to="/runs">Runs</Link> shows what happened, one row per attempt. This shows
          what was <em>supposed</em> to happen: every worker selected for a batch, including
          the ones that produced no run at all — so an empty{' '}
          <Link to="/findings">findings</Link> list can be read as "clean" rather than
          "nothing ran".
        </p>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          With one worker and manual triggers it says little that Runs does not. It earns
          its place when a nightly cycle runs several workers and three of four succeed.
        </p>
      </div>

      {rows.length === 0 && (
        <Empty>
          nothing recorded yet
          <br />
          <span className="muted">a row appears here for every worker in every batch</span>
        </Empty>
      )}

      {actionable.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 16 }}>
          <p className="error" style={{ margin: '0 0 6px', fontSize: 13 }}>
            In the most recent batch, {actionable.length}{' '}
            {actionable.length === 1 ? 'worker' : 'workers'} did not run.
          </p>
          {/* Named, with the reason and what to do — a count alone tells you something is
              wrong and nothing about what. */}
          {actionable.map((r, i) => (
            <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
              <strong>{r.worker.name}</strong>{' '}
              <span className="muted">
                — {r.coverage.reason ?? MEANING[r.coverage.outcome] ?? r.coverage.outcome}
              </span>
              <div className="muted" style={{ fontSize: 12 }}>
                {REMEDY[r.coverage.outcome] ?? 'Trigger it again from Workers.'}
              </div>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Cycle</th>
              <th>Worker</th>
              <th>Outcome</th>
              <th>Findings</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const note = r.coverage.runId ? noteFor.get(r.coverage.runId) : undefined
              return (
                <Fragment key={`${r.cycleRun.id}-${r.worker.name}-${i}`}>
                  <tr>
                    <td className="muted" title={exact(r.cycleRun.startedAt)}>
                      {when(r.cycleRun.startedAt)}
                    </td>
                    <td className="muted">{r.cycle.name}</td>
                    <td>{r.worker.name}</td>
                    <td title={MEANING[r.coverage.outcome] ?? ''}>
                      <Pill value={r.coverage.outcome} />
                    </td>
                    <td className="muted">
                      {/* A dash rather than 0 when it never ran: zero findings is a claim,
                          and a worker that did not execute has not made one. */}
                      {r.coverage.ran ? r.coverage.findingCount : '—'}
                    </td>
                    <td className="muted" style={{ maxWidth: 420, fontSize: 12 }}>
                      {/* The reason it recorded, then what the outcome means. Previously an
                          outcome with no reason showed an empty cell. */}
                      {r.coverage.reason ?? MEANING[r.coverage.outcome] ?? ''}
                    </td>
                  </tr>
                  {/* Its own row rather than a cell, because a note is a paragraph and
                      the columns beside it are words wide. Under the worker that wrote
                      it, in the batch it describes. */}
                  {note && (
                    <tr>
                      <td colSpan={6} style={{ paddingTop: 0 }}>
                        <p className="note">{note.notes}</p>
                        <Link className="muted" style={{ fontSize: 11 }} to={`/runs/${note.runId}`}>
                          the run that wrote this →
                        </Link>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </Page>
  )
}
