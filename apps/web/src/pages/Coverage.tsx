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
const MEANING: Record<string, string> = {
  pending: 'selected and queued — no runner has picked it up yet',
  found: 'ran, and reported findings',
  clean: 'ran, looked, and reported nothing — a result, not an absence',
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

  const neverRan = rows.filter((r) => !r.coverage.ran && r.coverage.outcome !== 'pending')

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

      {neverRan.length > 0 && (
        <p className="error" style={{ fontSize: 13 }}>
          {neverRan.length} selected {neverRan.length === 1 ? 'worker' : 'workers'} did not
          run. That surface is uncovered — whatever it would have looked at, nobody has.
        </p>
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
            {rows.map((r, i) => (
              <tr key={`${r.cycleRun.id}-${r.worker.name}-${i}`}>
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
            ))}
          </tbody>
        </table>
      )}
    </Page>
  )
}
