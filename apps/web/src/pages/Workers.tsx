import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { api, type WorkerRow } from '../api.ts'
import { Empty, exact, Page, Pill, when } from '../ui.tsx'
import { describeSchedule } from '../ScheduleField.tsx'
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
  /**
   * The breaker threshold this project's config actually asks for, from the server.
   *
   * There is deliberately no `?? 3` here. This file used to hold `BREAKER_THRESHOLD = 3`
   * with a comment saying it mirrored `policies.failureBreakerThreshold`, and it was
   * wrong for every project that had set anything else — a browser recomputing a
   * server-side rule from a copied constant is the same bug the server had, in a second
   * place. `undefined` means we have not been told, and the sentence below says less
   * rather than guessing.
   */
  const breakerThreshold = data?.policies[slug]?.policies.failureBreakerThreshold
  /**
   * Whether this project's config.yaml permits a modifier on the `worktree` sandbox.
   *
   * From the server, from the file — not from `policies` above, which is the
   * control-plane half off the `projects` row and does not carry this key by design.
   * Undefined means the control plane cannot read the file, in which case the form has
   * nothing to write to anyway.
   */
  const allowSandboxDowngrade = data?.allowSandboxDowngrade[slug] ?? false

  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const drift = projects?.projects.find((p) => p.slug === slug)?.drift

  const sync = useMutation({
    mutationFn: () => api.syncLocal(slug),
    onSuccess: async () => {
      // Everything the index feeds is now potentially different — workers, cycles,
      // skills, and the drift banner itself.
      await qc.invalidateQueries()
    },
  })

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

      {/*
        The gap between the file and what actually runs. `config.yaml` is the definition,
        but the foreman reads the database (§5.1), and only the UI publishes on its own —
        a hand-edit or a `git pull` leaves the factory on the previous definition with
        nothing saying so. Shown here because this is the page about what runs.
      */}
      {drift?.state === 'drifted' && (
        <div className="drift-banner">
          <div>
            <strong>
              {drift.what?.length === 2
                ? 'config.yaml and the skills beside it have'
                : drift.what?.[0] === 'skills'
                  ? 'A skill has'
                  : 'config.yaml has'}{' '}
              changed since last published.
            </strong>
            <p>
              The factory is still running the previous definition — a worker you added or
              a schedule you edited is not live yet.
            </p>
          </div>
          <button className="primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Publishing…' : 'Publish now'}
          </button>
        </div>
      )}
      {sync.isError && (
        <p className="muted" style={{ fontSize: 12, color: 'var(--red)' }}>
          {(sync.error as Error).message}
        </p>
      )}

      {creating && (
        <WorkerForm
          projectSlug={slug}
          allowSandboxDowngrade={allowSandboxDowngrade}
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
            allowSandboxDowngrade={allowSandboxDowngrade}
            existing={row.worker}
            {...(row.drivenBy ? { drivenBy: row.drivenBy.cycle } : {})}
            {...(hash ? { configHash: hash } : {})}
            onDone={() => setEditing(null)}
          />
        ) : (
          <WorkerCard
            key={row.worker.id}
            row={row}
            editable={editable}
            breakerThreshold={breakerThreshold}
            onRun={() => run.mutate(row.worker.name)}
            onEdit={() => setEditing(row.worker.id)}
            running={run.isPending}
          />
        ),
      )}

      {run.data?.jobs.some((j) => j.state === 'skipped') && (
        <p className="error" style={{ fontSize: 13 }}>
          Admission refused that job. If the worker shows{' '}
          <span className="pill red">breaker open</span> above, clear it here;{' '}
          <Link to="/coverage">Coverage</Link> records the reason either way.
        </p>
      )}
      {/*
        Queued and unclaimable. "Queued" is what a job about to start in four seconds also
        says, which is exactly what made this invisible — you press run, are told it
        worked, and nothing ever happens. The labels are named because the fix is on the
        line that asked for them, not on the Runners page where everything looks fine.
      */}
      {run.data?.jobs.some((j) => j.state === 'queued' && j.reach === 'unmatched') && (
        <p className="error" style={{ fontSize: 13 }}>
          Queued, but no runner registered here advertises{' '}
          <span className="mono">
            {[
              ...new Set(
                run.data.jobs.filter((j) => j.state === 'queued').flatMap((j) => j.missing ?? []),
              ),
            ].join(', ')}
          </span>
          , so nothing will claim it. <Link to="/runners">Runners</Link> — a capability Ogun
          cannot detect is declared with <span className="mono">ogun runner init --labels</span>.
        </p>
      )}
    </>
  )
}

function WorkerCard({
  row,
  editable,
  breakerThreshold,
  onRun,
  onEdit,
  running,
}: {
  row: WorkerRow
  editable: boolean
  /** This project's `policies.failureBreakerThreshold`. Undefined if the server did not
   *  say — no local default, see `breakerThreshold` above. */
  breakerThreshold: number | undefined
  onRun: () => void
  onEdit: () => void
  running: boolean
}) {
  const w = row.worker
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['allWorkers'] })
  const remove = useMutation({ mutationFn: () => api.deleteWorker(w.id), onSuccess: invalidate })
  const clearBreaker = useMutation({
    mutationFn: () => api.clearBreaker(w.id),
    onSuccess: invalidate,
  })
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
            {row.breaker?.openedAt ? (
              <span className="pill red">breaker open</span>
            ) : (row.breaker?.consecutiveFailures ?? 0) > 0 ? (
              // Visible while it is building, not only once it has stopped you. A guard
              // you first learn about by being blocked is one you experience as a
              // mystery rather than as a warning.
              <span className="pill yellow" title="consecutive failures">
                {row.breaker?.consecutiveFailures} failed in a row
              </span>
            ) : null}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            skill <Link to={`/skills/${row.project.slug}/${w.skillRef}`}>{w.skillRef}</Link> ·
            model {w.modelRole}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            {row.schedule?.cron ? (
              <>
                {/* Words first, expression on hover. "Every day at 3:00 AM" is what you
                    are checking; the cron is what you edit. */}
                <span title={`${row.schedule.cron}  (${row.schedule.tz ?? ''})`}>
                  {describeSchedule(row.schedule.cron)}
                </span>
                {' · next '}
                <span title={row.nextRun ? exact(row.nextRun) : ''}>
                  {row.nextRun ? when(row.nextRun) : 'never — expression is invalid'}
                </span>
                {/* Only worth saying when it is not the default: this is what happens if
                    the machine is asleep at 3am, which on WSL2 it often is. */}
                {row.schedule.onMissed === 'runOnce' && <span> · catches up if missed</span>}
              </>
            ) : row.drivenBy ? (
              <>
                {/* A worker in a cycle has no schedule of its own — saying "runs only
                    when triggered" here would be wrong in the direction that matters. */}
                {'part of the '}
                <span className="mono">{row.drivenBy.cycle}</span>
                {' cycle'}
                {row.drivenBy.schedule ? (
                  <>
                    {' · '}
                    <span title={row.drivenBy.schedule}>
                      {describeSchedule(row.drivenBy.schedule)}
                    </span>
                    {' · next '}
                    <span title={row.drivenBy.nextRun ? exact(row.drivenBy.nextRun) : ''}>
                      {row.drivenBy.nextRun ? when(row.drivenBy.nextRun) : 'never'}
                    </span>
                  </>
                ) : (
                  ' · runs only when the cycle is triggered'
                )}
              </>
            ) : (
              'runs only when triggered'
            )}
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

      {/* The breaker latches on purpose — it survives a restart, which is exactly when
          you would want it to hold — so clearing it has to be something you can do. */}
      {(row.breaker?.consecutiveFailures ?? 0) > 0 && (
        <div
          className="row"
          style={{ marginTop: 12, fontSize: 13, alignItems: 'flex-start', flexWrap: 'wrap' }}
        >
          {row.breaker?.openedAt ? (
            <span className="error" style={{ flex: '1 1 320px' }}>
              <strong>Not being dispatched.</strong> {row.breaker.consecutiveFailures} runs
              failed in a row, so admission stopped sending it work — the guard that keeps a
              failure loop from spending the night burning rate limit. Fix what was failing,
              then clear it.
            </span>
          ) : (
            <span className="muted" style={{ flex: '1 1 320px' }}>
              {row.breaker?.consecutiveFailures} run
              {row.breaker?.consecutiveFailures === 1 ? '' : 's'} failed in a row.{' '}
              {/* Only counted down when the real threshold is known. A guess here reads
                  exactly like a fact, and being told "1 more" when five are left is worse
                  than being told nothing. */}
              {breakerThreshold === undefined
                ? 'A success resets the count.'
                : `${breakerThreshold - (row.breaker?.consecutiveFailures ?? 0)} more and ` +
                  'admission stops dispatching this worker. A success resets the count.'}
            </span>
          )}
          <button onClick={() => clearBreaker.mutate()} disabled={clearBreaker.isPending}>
            {row.breaker?.openedAt ? 'Clear breaker' : 'Reset count'}
          </button>
        </div>
      )}

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
