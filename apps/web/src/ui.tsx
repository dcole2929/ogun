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

/**
 * The filter bar every list page carries, directly under its title.
 *
 * One component rather than each page laying out its own controls, because the value of
 * a filter row is that it is in the same place on every page — a search box that moves
 * between Skills and Workers is a search box you hunt for. `count` is part of it for the
 * same reason: a filtered list that does not say it is filtered looks like a short list,
 * and "3 of 47" is the difference between "nothing matched" and "nothing is there".
 */
export function Filters({
  count,
  total,
  noun,
  children,
}: {
  count?: number
  total?: number
  noun?: string
  children: ReactNode
}) {
  const filtered = count !== undefined && total !== undefined && count !== total
  return (
    <div className="filters">
      {children}
      {count !== undefined && total !== undefined && (
        <span className="muted filter-count">
          {filtered ? `${count} of ${total}` : `${total}`} {noun ?? ''}
        </span>
      )}
    </div>
  )
}

/**
 * A search box that clears itself.
 *
 * The clear button is not decoration: this is the one control on the page that can hide
 * every row, and a page that looks empty for a reason sitting in an input you have
 * scrolled past is the most confusing state a filter can produce.
 */
export function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="search">
      <input
        type="text"
        value={value}
        placeholder={placeholder ?? 'search…'}
        onChange={(e) => onChange(e.target.value)}
      />
      {value !== '' && (
        <button type="button" className="clear" title="clear" onClick={() => onChange('')}>
          ×
        </button>
      )}
    </div>
  )
}

/**
 * An active filter that did not come from this bar — set by a link from somewhere else.
 *
 * It has to be visible and it has to be removable. A filter applied by a URL and not
 * shown is a page that is quietly lying about how much it is displaying, which is the
 * one thing a filter bar exists to prevent.
 */
export function Chip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="chip">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      <button type="button" title="show everything again" onClick={onClear}>
        ×
      </button>
    </span>
  )
}

/** A labelled `<select>` for the filter bar, so the label sits with its control. */
export function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<[value: string, label: string]>
}) {
  return (
    <label className="choice">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Case-insensitive substring match across several fields.
 *
 * Deliberately not fuzzy. These lists are tens of rows, not thousands, and a fuzzy match
 * that surfaces `plan-a-ticket` for the query `scope` costs more than it saves — the
 * whole point of typing is to narrow.
 */
export const matches = (query: string, ...fields: Array<string | null | undefined>): boolean => {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

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
  // Run outcome, coverage outcome and cycle state all use this word, and all three want
  // the same tone: not green, because nothing went ahead; not red, because nothing broke.
  declined: 'yellow',
  clean: 'green',
  found: 'blue',
  'gate-failed': 'red',
  refused: 'yellow',
  cancelled: '',
  abandoned: 'yellow',
  'not-selected': '',
  pending: 'blue',
  errored: 'red',
  /**
   * A source's states (§4.13). `healthy` and `silent` are the pair worth being careful
   * about: a source that matches nothing is *working*, so `silent` is a remark in yellow
   * and never a failure in red — colouring it red would teach people that red on this page
   * means "probably fine", which costs the reds that are not.
   *
   * `overdue` is red because nothing looked at all, which is strictly worse than a poll
   * that looked and failed: there is no row and therefore no explanation anywhere else.
   */
  healthy: 'green',
  silent: 'yellow',
  failing: 'red',
  overdue: 'red',
  'never-polled': '',
  disabled: '',
  /** Poll outcomes, as recorded on the row. `refused` above already carries yellow. */
  ok: 'green',
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

/**
 * The full timestamp, for a `title` beside every relative one. "3 days ago" is the right
 * default — you read a list to see what is recent — but the moment you care about a
 * specific run you want the actual time, and hovering is cheaper than a second column.
 */
export const exact = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : ''

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
