import type { ReactNode } from 'react'

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="spread">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty">{children}</div>
)

const OUTCOME_TONE: Record<string, string> = {
  approved: 'green',
  dispatched: 'green',
  succeeded: 'green',
  'changes-requested': 'red',
  error: 'red',
  failed: 'red',
  skipped: 'yellow',
  blocked: 'yellow',
  running: 'blue',
  claimed: 'blue',
  queued: 'blue',
  complete: 'green',
  degraded: 'yellow',
  clean: 'green',
  found: 'blue',
  'gate-failed': 'red',
  pending: 'blue',
  errored: 'red',
}

export const Pill = ({ value }: { value: string }) => (
  <span className={`pill ${OUTCOME_TONE[value] ?? ''}`}>{value}</span>
)

const SEVERITY_TONE: Record<string, string> = {
  critical: 'red',
  high: 'red',
  medium: 'yellow',
  low: '',
  info: '',
}

export const Severity = ({ value }: { value: string }) => (
  <span className={`pill ${SEVERITY_TONE[value] ?? ''}`}>{value}</span>
)

export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString()
}

export const duration = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
