import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { api, type WorkerRow } from '../api.ts'
import { Empty, Page, Pill } from '../ui.tsx'
import { WorkerForm } from './WorkerForm.tsx'

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
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['allWorkers', slug],
    queryFn: () => api.allWorkers(slug),
  })
  const workers = data?.workers ?? []

  const run = useMutation({
    mutationFn: (worker: string) => api.trigger(slug, worker),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['runs'] })
      navigate('/runs')
    },
  })

  return (
    <>
      <div className="spread" style={{ alignItems: 'center', marginTop: 26 }}>
        <h2 style={{ margin: 0 }}>{slug}</h2>
        {!creating && !editing && (
          <button className="primary" onClick={() => setCreating(true)}>
            New worker
          </button>
        )}
      </div>

      {creating && (
        <WorkerForm projectSlug={slug} onDone={() => setCreating(false)} />
      )}

      {workers.length === 0 && !creating && (
        <Empty>
          no workers yet — define one in <span className="mono">.ogun/config.yaml</span> and sync,
          or create one here
        </Empty>
      )}

      {workers.map((row) =>
        editing === row.worker.id ? (
          <WorkerForm
            key={row.worker.id}
            projectSlug={slug}
            existing={row.worker}
            onDone={() => setEditing(null)}
          />
        ) : (
          <WorkerCard
            key={row.worker.id}
            row={row}
            onRun={() => run.mutate(row.worker.name)}
            onEdit={() => setEditing(row.worker.id)}
            running={run.isPending}
          />
        ),
      )}

      {run.data?.jobs.some((j) => j.state === 'skipped') && (
        <p className="error" style={{ fontSize: 13 }}>
          Admission refused that job — most likely the failure breaker is open.{' '}
          <Link to="/coverage">Coverage</Link> records the reason.
        </p>
      )}
    </>
  )
}

function WorkerCard({
  row,
  onRun,
  onEdit,
  running,
}: {
  row: WorkerRow
  onRun: () => void
  onEdit: () => void
  running: boolean
}) {
  const w = row.worker
  const qc = useQueryClient()
  const [yaml, setYaml] = useState<string | null>(null)
  const fromConfig = w.origin === 'config'

  const remove = useMutation({
    mutationFn: () => api.deleteWorker(w.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allWorkers'] }),
  })

  const toggle = useMutation({
    mutationFn: () => api.updateWorker(w.id, { enabled: !w.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allWorkers'] }),
  })

  const showYaml = useMutation({
    mutationFn: () => api.workerYaml(w.id),
    onSuccess: (d) => setYaml(d.yaml),
  })

  return (
    <div className="card" style={{ marginBottom: 10, opacity: w.enabled ? 1 : 0.65 }}>
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <strong>{w.name}</strong>
            <Pill value={w.permissions} />
            <span className="pill">{w.runtime}</span>
            <span className="pill">{w.sandbox}</span>
            {/* Where a worker is defined decides who may edit it, so it is on the card,
                not buried in a detail view. */}
            <span className={`pill ${fromConfig ? '' : 'blue'}`} title={originHelp(w.origin)}>
              {fromConfig ? 'config.yaml' : 'created here'}
            </span>
            {!w.enabled && <span className="pill yellow">disabled</span>}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            skill <Link to={`/skills/${row.project.slug}/${w.skillRef}`}>{w.skillRef}</Link> ·
            model {w.modelRole}
          </div>
          {typeof w.config?.prompt === 'string' && (
            <div className="mono muted" style={{ marginTop: 6, fontSize: 12 }}>
              {String(w.config.prompt)}
            </div>
          )}
        </div>

        <div className="row" style={{ whiteSpace: 'nowrap' }}>
          <button className="primary" disabled={!w.enabled || running} onClick={onRun}>
            Run now
          </button>
          {fromConfig ? (
            <button
              disabled
              title="defined in .ogun/config.yaml — edit it there and run `ogun project sync`"
            >
              Edit
            </button>
          ) : (
            <button onClick={onEdit}>Edit</button>
          )}
        </div>
      </div>

      {!fromConfig && (
        <div className="row" style={{ marginTop: 12, fontSize: 12 }}>
          <button onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {w.enabled ? 'Disable' : 'Enable'}
          </button>
          <button onClick={() => showYaml.mutate()} disabled={showYaml.isPending}>
            Copy into config.yaml
          </button>
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(`Delete ${w.name}? Its runs and findings go with it.`)) remove.mutate()
            }}
          >
            Delete
          </button>
          {remove.error && <span className="error">{String(remove.error)}</span>}
        </div>
      )}

      {yaml && (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Paste under <span className="mono">workers:</span> in{' '}
            <span className="mono">.ogun/config.yaml</span>, then{' '}
            <span className="mono">ogun project sync</span>. Delete this one first — the file
            cannot claim a name the UI already owns.
          </p>
          <pre className="md-code">{yaml}</pre>
        </>
      )}
    </div>
  )
}

const originHelp = (origin: string): string =>
  origin === 'config'
    ? 'defined in .ogun/config.yaml — git owns it, and sync rewrites it'
    : 'created in the UI — ogun project sync leaves it alone'
