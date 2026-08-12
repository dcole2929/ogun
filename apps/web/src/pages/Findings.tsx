import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type FindingRow } from '../api.ts'
import { Empty, exact, Page, Pill, Severity, when } from '../ui.tsx'

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

const ALL_STATUSES = 'open,triaged,fixed,wontfix,duplicate,gated,overflow'

/**
 * The findings inbox. Ranked by severity then recency, because the top of the list is
 * the only part that reliably gets read.
 */
export function FindingsPage() {
  // "all" first, and therefore the default. The inbox is where you look to see what the
  // factory has said, not only what is still outstanding — a fixed finding you want to
  // re-read should not require knowing which filter hides it.
  const [status, setStatus] = useState(ALL_STATUSES)
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['findings', status],
    queryFn: () => api.findings({ status }),
  })

  const setStatusMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => api.setFindingStatus(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['findings'] }),
  })

  const findings = [...(data?.findings ?? [])].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.finding.severity) - SEVERITY_ORDER.indexOf(b.finding.severity)
    return s !== 0 ? s : b.finding.updatedAt.localeCompare(a.finding.updatedAt)
  })

  return (
    <Page
      title="Findings"
      subtitle="One row per issue, not per sighting. Dismissing something keeps it dismissed."
      actions={
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value={ALL_STATUSES}>all</option>
          <option value="open,triaged">open</option>
          <option value="fixed">fixed</option>
          <option value="wontfix">wontfix</option>
          <option value="duplicate">duplicate</option>
          <option value="gated,overflow">gated &amp; overflow</option>
        </select>
      }
    >
      {error && <p className="error">{String(error)}</p>}
      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && findings.length === 0 && (
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
          onStatus={(next) => setStatusMutation.mutate({ id: f.finding.id, next })}
          busy={setStatusMutation.isPending}
        />
      ))}
    </Page>
  )
}

function Finding({
  row,
  onStatus,
  busy,
}: {
  row: FindingRow
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
