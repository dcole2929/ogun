import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api.ts'
import { duration, Empty, Page, Pill, when } from '../ui.tsx'

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
                  <td className="muted">{when(p.job.createdAt)}</td>
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
                    ) : p.claimable ? (
                      <span className="pill blue">waiting for a runner</span>
                    ) : (
                      // The difference that matters: this one will never be picked up.
                      <span className="pill red" title="no online runner advertises all of these">
                        nothing can run this
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pending.some((p) => !p.claimable) && (
            <p className="error" style={{ fontSize: 13 }}>
              {data?.onlineRunners === 0 ? (
                <>
                  No runner is online. <Link to="/runners">Runners</Link> — or start one here
                  with <span className="mono">ogun runner start</span>.
                </>
              ) : (
                <>
                  No online runner advertises everything those jobs need. See{' '}
                  <Link to="/runners">Runners</Link> for what each machine can do.
                </>
              )}
            </p>
          )}
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
              <th>Took</th>
              <th>Tokens</th>
              <th>Commit</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run.id}>
                <td>
                  <Link to={`/runs/${r.run.id}`}>{when(r.run.startedAt)}</Link>
                </td>
                <td className="muted">{r.project.slug}</td>
                <td>{r.worker.name}</td>
                <td>
                  <Pill value={r.run.outcome ?? r.job.state} />
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
