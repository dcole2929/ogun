import { useQuery } from '@tanstack/react-query'
import { api } from '../api.ts'
import { Empty, Page, Pill, when } from '../ui.tsx'

/**
 * The coverage ledger. The reason this page exists at all: an empty findings inbox is
 * ambiguous, and "nothing was found" versus "nothing ran" are the two facts a reviewer
 * fleet most needs to keep apart.
 */
export function CoveragePage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const slug = projects?.projects[0]?.slug
  const { data } = useQuery({
    queryKey: ['coverage', slug],
    queryFn: () => api.coverage(slug!),
    enabled: Boolean(slug),
  })
  const rows = data?.coverage ?? []

  return (
    <Page
      title="Coverage"
      subtitle="What was selected, what actually ran, and why anything didn't."
    >
      {rows.length === 0 && <Empty>nothing recorded yet</Empty>}
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
                <td className="muted">{when(r.cycleRun.startedAt)}</td>
                <td className="muted">{r.cycle.name}</td>
                <td>{r.worker.name}</td>
                <td>
                  <Pill value={r.coverage.outcome} />
                </td>
                <td className="muted">{r.coverage.ran ? r.coverage.findingCount : '—'}</td>
                <td className="muted" style={{ maxWidth: 340 }}>
                  {r.coverage.reason ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  )
}
