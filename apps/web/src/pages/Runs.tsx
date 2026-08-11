import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api.ts'
import { duration, Empty, Page, Pill, when } from '../ui.tsx'

export function RunsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['runs'], queryFn: api.runs })
  const runs = data?.runs ?? []

  return (
    <Page title="Runs" subtitle="Every execution attempt, including the ones that went nowhere.">
      {error && <p className="error">{String(error)}</p>}
      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && runs.length === 0 && (
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
