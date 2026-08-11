import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api } from '../api.ts'
import { Empty, Page, Pill } from '../ui.tsx'

export function WorkersPage() {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const list = projects?.projects ?? []

  return (
    <Page
      title="Workers"
      subtitle="A worker is a skill plus a runtime, a model, a permission profile, and a sandbox."
    >
      {list.length === 0 && (
        <Empty>
          no projects registered
          <br />
          <span className="muted mono">ogun project sync</span>
        </Empty>
      )}
      {list.map((p) => (
        <ProjectWorkers key={p.id} slug={p.slug} />
      ))}
    </Page>
  )
}

function ProjectWorkers({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data } = useQuery({ queryKey: ['workers', slug], queryFn: () => api.workers(slug) })

  const run = useMutation({
    mutationFn: (worker: string) => api.trigger(slug, worker),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['runs'] })
      navigate('/runs')
    },
  })

  return (
    <>
      <h2>{slug}</h2>
      <table>
        <thead>
          <tr>
            <th>Worker</th>
            <th>Runtime</th>
            <th>Permissions</th>
            <th>Sandbox</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.workers ?? []).map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td className="muted">{w.runtime}</td>
              <td>
                <Pill value={w.permissions} />
              </td>
              <td className="muted">{w.sandbox}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="primary"
                  disabled={!w.enabled || run.isPending}
                  onClick={() => run.mutate(w.name)}
                >
                  Run now
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.data?.jobs.some((j) => j.state === 'skipped') && (
        <p className="error" style={{ fontSize: 13 }}>
          Admission refused that job — most likely the failure breaker is open. Coverage
          records the reason.
        </p>
      )}
    </>
  )
}
