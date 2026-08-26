import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, type SourceEmission, type SourceReport } from '../api.ts'
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
   * The trigger's half of the same question, one step upstream.
   *
   * The ledger below can only describe batches that *happened*. A source whose credential
   * died produces no batch at all, so a dead integration renders here as an unchanged
   * table — the same thing a quiet week renders as, which is the exact conflation this
   * page exists to refuse. It belongs on this page rather than on a nav item of its own
   * because `source_polls` is described in the schema as "the coverage ledger for a
   * trigger": the argument this table makes about workers, applied to the thing that
   * decides whether the workers are ever asked.
   *
   * A project with no sources renders none of it. Most projects have none, and a permanent
   * empty panel about a feature you are not using is chrome that teaches you to skip the
   * top of the page.
   */
  const { data: sources } = useQuery({
    queryKey: ['sources', slug],
    queryFn: () => api.sources(slug!),
    enabled: Boolean(slug),
  })

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

      <Sources
        sources={sources?.sources ?? []}
        emissions={sources?.emissions ?? []}
      />

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

/**
 * What each source state means, in the words of what it costs.
 *
 * `silent` is the one to get right. A source that matches nothing is *working* — that is
 * the whole reason `ok` covers "looked and found nothing" — so this must not read as a
 * fault, and it must still be said, because a filter that has matched nothing for a week
 * is far more likely to be a typo than a quiet week.
 */
const SOURCE_MEANING: Record<string, string> = {
  healthy: 'polling, and the ledger has nothing to report',
  silent: 'polling normally and admitting nothing — not a failure, but worth a look',
  failing: 'asked Linear and got no answer',
  refused: 'never reached Linear: something local is missing',
  overdue: 'nothing looked at all, and no poll row says why',
  'never-polled': 'indexed, and its first poll has not come round yet',
  disabled: 'switched off in config.yaml — not a fault',
}

/**
 * The four failure kinds, each with what it means for the person reading.
 *
 * Kept apart here for the same reason `LinearUnavailable` keeps them apart at the wire:
 * **the remedies differ**, and one red "failed" pill for all four is three remedies
 * thrown away. The server sends its own `remedy` sentence per kind; this is the one-line
 * version that fits beside a pill.
 */
const KIND_MEANING: Record<string, string> = {
  auth: 'the credential — nothing retries this into working',
  ratelimited: 'Linear is throttling; it clears on its own',
  transport: 'the network, or Linear — the next poll asks again',
  local: 'a token Linear granted that this machine could not store',
}

/**
 * The trigger ledger: whether the outside world is still reaching the factory (§4.13).
 *
 * Renders nothing at all for a project with no sources, which is most of them.
 */
function Sources({
  sources,
  emissions,
}: {
  sources: SourceReport[]
  emissions: SourceEmission[]
}) {
  const [open, setOpen] = useState<string | null>(null)
  if (sources.length === 0) return null

  const emitted = emissions.filter((e) => e.outcome === 'emitted')

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>Sources</h2>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        Whether anything is <em>asking</em>. The ledger below can only describe batches that
        happened — a source whose key expired produces no batch, which looks exactly like a
        quiet week.
      </p>

      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>State</th>
            <th>Cycle</th>
            <th>Last look</th>
            <th>Last emitted</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <Fragment key={s.id}>
              <tr
                onClick={() => setOpen(open === s.id ? null : s.id)}
                style={{ cursor: 'pointer' }}
              >
                <td>{s.name}</td>
                <td title={SOURCE_MEANING[s.health.state] ?? ''}>
                  <Pill value={s.health.state} />
                  {/* The kind rides beside the state and is never folded into it: `auth`
                      sends somebody to `ogun connect` and `ratelimited` sends them nowhere. */}
                  {s.health.kind && (
                    <span
                      className="muted"
                      style={{ fontSize: 11, marginLeft: 6 }}
                      title={KIND_MEANING[s.health.kind] ?? ''}
                    >
                      {s.health.kind}
                    </span>
                  )}
                </td>
                <td className="muted">{s.cycle}</td>
                <td className="muted" title={exact(s.health.lastPolledAt)}>
                  {when(s.health.lastPolledAt)}
                </td>
                <td className="muted" title={exact(s.health.lastEmittedAt)}>
                  {/* A dash rather than "never" when nothing has ever been emitted: for a
                      source switched on this morning that is the expected state, not news. */}
                  {s.health.lastEmittedAt ? when(s.health.lastEmittedAt) : '—'}
                </td>
                <td className="muted" style={{ maxWidth: 380, fontSize: 12 }}>
                  {s.health.detail ?? SOURCE_MEANING[s.health.state] ?? ''}
                </td>
              </tr>
              {open === s.id && (
                <tr>
                  <td colSpan={6} style={{ paddingTop: 0 }}>
                    <SourceDetail source={s} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {emitted.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 6px', fontSize: 13 }}>Tickets that already produced work</p>
          {/* The answer to the question a live source generates more than any other. Ogun
              writes nothing back to Linear (ADR-0004), so a ticket that has been completely
              dealt with sits in Todo looking exactly like one nothing ever saw — and this
              row is the only record anywhere that it did. */}
          <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
            Nothing is written back to Linear, so the card looks untouched. Each of these
            became a cycle run once and will not be emitted again.
          </p>
          {emitted.slice(0, 8).map((e) => (
            <div key={e.externalId} className="muted" style={{ fontSize: 12 }}>
              <strong>{e.externalKey}</strong> · {when(e.createdAt)} · via {e.sourceName}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One source opened up: what it admits, what to do, and when its state began. */
function SourceDetail({ source }: { source: SourceReport }) {
  return (
    <div style={{ fontSize: 12 }}>
      {/**
       * The filter and the statuses the polls actually saw, side by side.
       *
       * This pairing is the whole reason the filter is on the wire. A poll that admits
       * nothing records the statuses that were on the tickets it read, and `status: [To
       * Do]` against a column the team calls `Todo` is only visibly wrong when the two
       * lists are next to each other — otherwise it is a source that polls forever,
       * matches nothing, and reports success.
       */}
      {source.filter ? (
        <p className="muted" style={{ margin: '0 0 6px' }}>
          admits: status <strong>{source.filter.status.join(', ')}</strong>
          {source.filter.labels.length > 0 && (
            <> · labels {source.filter.labels.join(' + ')}</>
          )}
          {source.filter.excludeLabels.length > 0 && (
            <> · not {source.filter.excludeLabels.join(', ')}</>
          )}
          {source.filter.notBlocked && <> · not blocked</>}
          {' · '}team {source.team || '?'} · every {source.pollMinutes}m
        </p>
      ) : (
        <p className="error" style={{ margin: '0 0 6px' }}>
          Its stored config is not a shape this build can read, so the poller skips it —
          without writing a poll row, which is why its state is <code>overdue</code> rather
          than a failure. <code>ogun project sync</code> reports what it refuses.
        </p>
      )}

      {source.health.remedy && (
        <p className="note" style={{ margin: '0 0 8px' }}>
          {source.health.remedy}
        </p>
      )}

      {source.polls.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>no polls recorded</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Outcome</th>
              <th>Seen</th>
              <th>Admitted</th>
              <th>Emitted</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {source.polls.map((p, i) => (
              <tr key={i}>
                <td className="muted" title={exact(p.startedAt)}>{when(p.startedAt)}</td>
                <td>
                  <Pill value={p.outcome} />
                  {p.kind && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      {p.kind}
                    </span>
                  )}
                </td>
                <td className="muted">{p.seen}</td>
                <td className="muted">{p.admitted}</td>
                <td className="muted">
                  {p.emitted}
                  {/* Trimmed is work queued behind `maxPerPoll`, not work lost — the next
                      poll takes it. Shown because "emitted 3" beside a backlog of 40 is a
                      different situation from "emitted 3" beside nothing. */}
                  {p.trimmed > 0 && <span> (+{p.trimmed} held)</span>}
                </td>
                <td className="muted" style={{ maxWidth: 420 }}>{p.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
