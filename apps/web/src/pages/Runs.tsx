import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api.ts'
import { duration, Empty, exact, Page, Pill, when } from '../ui.tsx'

export function RunsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['runs'], queryFn: api.runs })
  const runs = data?.runs ?? []
  const pending = data?.pending ?? []

  return (
    <Page title="Runs" subtitle="Every execution attempt, including the ones that went nowhere.">
      {error && <p className="error">{String(error)}</p>}
      {isLoading && <Empty>loading…</Empty>}

      {/* A queued job has no run row. Without this, triggering a worker while nothing was
          online showed an empty page — the work existed and was invisible. */}
      {pending.length > 0 && (
        <>
          <h2>Waiting</h2>
          <table>
            <thead>
              <tr>
                <th>Queued</th>
                <th>Project</th>
                <th>Worker</th>
                <th>Needs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.job.id}>
                  <td className="muted" title={exact(p.job.createdAt)}>
                    {when(p.job.createdAt)}
                  </td>
                  <td className="muted">{p.project.slug}</td>
                  <td>{p.worker.name}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      {p.requires.map((r) => (
                        <span key={r} className="pill">
                          {r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {p.job.state === 'blocked' ? (
                      <span className="pill">waiting on a dependency</span>
                    ) : p.reach === 'claimable' ? (
                      <span className="pill blue">waiting for a runner</span>
                    ) : p.reach === 'offline' ? (
                      // A machine that can run this exists and is not up. It resolves
                      // itself the moment that machine comes back, so it is not the red
                      // one — calling it "nothing can run this" is how the red one stops
                      // being believed.
                      <span
                        className="pill yellow"
                        title="a runner advertising all of these is registered but offline"
                      >
                        its runner is offline
                      </span>
                    ) : (
                      // The difference that matters: this one will never be picked up,
                      // by anything, until a machine advertising those labels joins.
                      <span
                        className="pill red"
                        title={`no runner registered here advertises: ${p.missing.join(', ')}`}
                      >
                        nothing advertises {p.missing.join(', ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            Three states, three different things to go and do — which is the reason the
            server stopped answering this with a boolean. "Start a runner", "wait, or
            wake that machine", and "label a machine, or delete the line" are not
            interchangeable, and one sentence covering all three sends two thirds of
            readers to the wrong place.
          */}
          {pending.some((p) => p.reach === 'unmatched') ? (
            <p className="error" style={{ fontSize: 13 }}>
              {data?.liveRunners === 0 ? (
                <>
                  No runner has joined yet, so nothing can claim these.{' '}
                  <Link to="/runners">Runners</Link> — or set one up with{' '}
                  <span className="mono">ogun runner init</span>.
                </>
              ) : (
                <>
                  No runner registered here advertises{' '}
                  <span className="mono">
                    {[...new Set(pending.flatMap((p) => p.missing))].join(', ')}
                  </span>
                  . Those jobs will wait indefinitely. See <Link to="/runners">Runners</Link> for
                  what each machine can do — a capability Ogun cannot detect is declared with{' '}
                  <span className="mono">ogun runner init --labels</span>.
                </>
              )}
            </p>
          ) : pending.some((p) => p.reach === 'offline') ? (
            <p className="muted" style={{ fontSize: 13 }}>
              A runner that could take these is registered but offline. They will be claimed
              when it comes back — <Link to="/runners">Runners</Link>.
            </p>
          ) : null}
          <h2>Finished</h2>
        </>
      )}

      {!isLoading && runs.length === 0 && pending.length === 0 && (
        <Empty>
          no runs yet — trigger one from <Link to="/workers">Workers</Link>
        </Empty>
      )}
      {runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Project</th>
              <th>Worker</th>
              <th>Outcome</th>
              <th>Produced</th>
              <th>Took</th>
              <th>Tokens</th>
              <th>Commit</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run.id}>
                <td title={exact(r.run.startedAt)}>
                  <Link to={`/runs/${r.run.id}`}>{when(r.run.startedAt)}</Link>
                </td>
                <td className="muted">{r.project.slug}</td>
                <td>{r.worker.name}</td>
                <td>
                  <Pill value={r.run.outcome ?? r.job.state} />
                </td>
                <td className="muted">
                  {/* The result, not just the status. What a run produced is what you
                      are scanning the list for. */}
                  {r.run.outcome === 'approved'
                    ? (r.produced?.findings ?? 0) > 0
                      ? `${r.produced?.findings} finding${r.produced?.findings === 1 ? '' : 's'}`
                      : 'nothing found'
                    : r.run.outcome === 'changes-requested'
                      ? 'rejected by the gate'
                      : r.run.outcome === 'error'
                        ? 'failed'
                        : '—'}
                </td>
                <td className="muted">{duration(r.run.durationMs)}</td>
                <td className="muted mono">
                  {r.run.inputTokens || r.run.outputTokens
                    ? `${fmt(r.run.inputTokens)} / ${fmt(r.run.outputTokens)}`
                    : '—'}
                </td>
                <td className="muted mono">{r.run.repoSha?.slice(0, 7) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  )
}

const fmt = (n: number | null): string =>
  n === null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
