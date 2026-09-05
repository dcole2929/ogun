import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type FindingRow } from '../api.ts'
import { Choice, Empty, exact, Filters, matches, Page, Pill, Search, Severity, when } from '../ui.tsx'
import { useProjectScope } from '../scope.tsx'

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

const ALL_STATUSES = 'open,triaged,fixed,wontfix,duplicate,obsolete,gated,overflow'

/**
 * The findings inbox. Ranked by severity then recency, because the top of the list is
 * the only part that reliably gets read.
 */
export function FindingsPage() {
  // "all" first, and therefore the default. The inbox is where you look to see what the
  // factory has said, not only what is still outstanding — a fixed finding you want to
  // re-read should not require knowing which filter hides it.
  const [status, setStatus] = useState(ALL_STATUSES)
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState('all')
  const { filter, isAll } = useProjectScope()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['findings', status, filter ?? 'all'],
    queryFn: () => api.findings({ status, ...(filter ? { project: filter } : {}) }),
  })

  const setStatusMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => api.setFindingStatus(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['findings'] }),
  })

  const all = [...(data?.findings ?? [])].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity)
    return s !== 0 ? s : b.finding.updatedAt.localeCompare(a.finding.updatedAt)
  })
  const findings = all.filter(
    (f) =>
      matches(
        query,
        f.finding.title,
        f.finding.body,
        f.finding.path,
        f.finding.fingerprint,
        f.worker?.name,
      ) && (severity === 'all' || f.finding.severity === severity),
  )

  return (
    <Page
      title="Findings"
      subtitle="One row per issue, not per sighting. Dismissing something keeps it dismissed."
    >
      <Filters count={findings.length} total={all.length} noun="findings">
        <Search value={query} onChange={setQuery} placeholder="title, body, path, fingerprint…" />
        <Choice
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            [ALL_STATUSES, 'all'],
            ['open,triaged', 'open'],
            ['fixed', 'fixed'],
            ['wontfix', 'wontfix'],
            ['duplicate', 'duplicate'],
            ['gated,overflow', 'gated & overflow'],
          ]}
        />
        <Choice
          label="Severity"
          value={severity}
          onChange={setSeverity}
          options={[['all', 'any'], ...SEVERITY_ORDER.map((s) => [s, s] as [string, string])]}
        />
      </Filters>

      {error && <p className="error">{String(error)}</p>}
      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && all.length > 0 && findings.length === 0 && (
        <Empty>
          nothing matches
          <br />
          <span className="muted">{all.length} findings in this scope — try a wider filter</span>
        </Empty>
      )}
      {!isLoading && all.length === 0 && (
        <Empty>
          nothing here.
          <br />
          <span className="muted">
            That could mean the code is clean or that nothing ran — check Coverage to tell
            them apart.
          </span>
        </Empty>
      )}

      {findings.map((f) => (
        <Finding
          key={f.finding.id}
          row={f}
          showProject={isAll}
          onStatus={(next) => setStatusMutation.mutate({ id: f.finding.id, next })}
          busy={setStatusMutation.isPending}
        />
      ))}
    </Page>
  )
}

function Finding({
  row,
  showProject,
  onStatus,
  busy,
}: {
  row: FindingRow
  showProject: boolean
  onStatus: (status: string) => void
  busy: boolean
}) {
  const f = row.finding
  const [open, setOpen] = useState(false)
  return (
    <div className="finding">
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <Severity value={f.severity} />
            {f.status !== 'open' && <Pill value={f.status} />}
            {f.seenCount > 1 && (
              <span className="muted" title="times this fingerprint has been reported">
                seen {f.seenCount}×
              </span>
            )}
          </div>
          <h3>
            <a onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
              {f.title}
            </a>
          </h3>
          <div className="fp">{f.fingerprint}</div>
          {f.path && (
            <div className="mono muted" style={{ marginTop: 3 }}>
              {f.path}
              {f.line ? `:${f.line}` : ''}
            </div>
          )}
        </div>
        <div className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
          {showProject && `${row.project.slug} · `}
          {row.worker?.name ?? 'unknown'} ·{' '}
          <span title={exact(f.updatedAt)}>{when(f.updatedAt)}</span>
        </div>
      </div>

      {open && (
        <>
          <p className="body">{f.body}</p>
          <div className="actions">
            <button disabled={busy} onClick={() => onStatus('fixed')}>
              Fixed
            </button>
            <button disabled={busy} onClick={() => onStatus('wontfix')}>
              Won't fix
            </button>
            <button disabled={busy} onClick={() => onStatus('duplicate')}>
              Duplicate
            </button>
            {f.status !== 'open' && (
              <button disabled={busy} onClick={() => onStatus('open')}>
                Reopen
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
