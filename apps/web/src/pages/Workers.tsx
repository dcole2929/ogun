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
      subtitle="A skill plus a runtime, a model, a permission profile, and a sandbox. Defined in .ogun/config.yaml."
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
  const editable = data?.editable[slug] ?? false
  const hash = data?.hashes[slug]

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
        {!creating && !editing && editable && (
          <button className="primary" onClick={() => setCreating(true)}>
            New worker
          </button>
        )}
      </div>

      {/* The remote-control-plane case. Saying so beats a button that fails on click. */}
      {!editable && workers.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          This control plane has no local copy of <span className="mono">{slug}</span>, so it
          cannot edit <span className="mono">.ogun/config.yaml</span>. Run{' '}
          <span className="mono">ogun project sync</span> on the machine holding the repo.
        </p>
      )}

      {creating && (
        <WorkerForm
          projectSlug={slug}
          {...(hash ? { configHash: hash } : {})}
          onDone={() => setCreating(false)}
        />
      )}

      {workers.length === 0 && !creating && (
        <Empty>
          no workers yet — create one here, or add it to{' '}
          <span className="mono">.ogun/config.yaml</span> and sync
        </Empty>
      )}

      {workers.map((row) =>
        editing === row.worker.id ? (
          <WorkerForm
            key={row.worker.id}
            projectSlug={slug}
            existing={row.worker}
            {...(hash ? { configHash: hash } : {})}
            onDone={() => setEditing(null)}
          />
        ) : (
          <WorkerCard
            key={row.worker.id}
            row={row}
            editable={editable}
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
  editable,
  onRun,
  onEdit,
  running,
}: {
  row: WorkerRow
  editable: boolean
  onRun: () => void
  onEdit: () => void
  running: boolean
}) {
  const w = row.worker
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['allWorkers'] })
  const remove = useMutation({ mutationFn: () => api.deleteWorker(w.id), onSuccess: invalidate })
  const toggle = useMutation({
    mutationFn: () => api.updateWorker(w.id, { enabled: !w.enabled }),
    onSuccess: invalidate,
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
            {!w.enabled && <span className="pill yellow">disabled</span>}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            skill <Link to={`/skills/${row.project.slug}/${w.skillRef}`}>{w.skillRef}</Link> ·
            model {w.modelRole}
          </div>
          <div className="mono muted" style={{ marginTop: 6, fontSize: 12 }}>
            {row.effectivePrompt.text}
            {row.effectivePrompt.source !== 'worker' && (
              <span
                className="pill"
                style={{ marginLeft: 8 }}
                title={
                  row.effectivePrompt.source === 'skill'
                    ? "no override on this worker — it uses the skill's default_prompt"
                    : 'the skill declares no default_prompt, so this is synthesised'
                }
              >
                from {row.effectivePrompt.source}
              </span>
            )}
          </div>
        </div>

        <div className="row" style={{ whiteSpace: 'nowrap' }}>
          <button className="primary" disabled={!w.enabled || running} onClick={onRun}>
            Run now
          </button>
          <button onClick={onEdit} disabled={!editable}>
            Edit
          </button>
        </div>
      </div>

      {editable && (
        <div className="row" style={{ marginTop: 12, fontSize: 12 }}>
          <button onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {w.enabled ? 'Disable' : 'Enable'}
          </button>
          {confirming ? (
            <>
              <span className="muted">Remove it from config.yaml?</span>
              <button
                className="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
          {remove.error && <span className="error">{String(remove.error)}</span>}
        </div>
      )}
    </div>
  )
}
