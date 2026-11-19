import { useState, type ReactNode } from 'react'

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

/**
 * What each status word means, in one sentence, for a reader who has met it on a row.
 *
 * ### Why this exists
 *
 * The taxonomy is the point of the system and it is unguessable from the outside.
 * `declined`, `error`, `changes-requested` and `skipped` are four different facts that a
 * reader with no context will read as four words for "it didn't work" — and the whole
 * reason `packages/core/src/outcomes.ts` keeps them apart is that they send a person to
 * four different places. A word nobody can decode is a word that gets collapsed in the
 * reader's head, which defeats the taxonomy just as thoroughly as collapsing it in the
 * database would.
 *
 * ### Why the text is duplicated here
 *
 * `outcomes.ts` is the source of truth and these sentences are condensed from its doc
 * comments — not invented, and not to be edited away from it. They are *copied* because
 * `apps/web` deliberately does not depend on `@ogun/core`: that package re-exports zod,
 * the config loader and the Linear client, none of which belongs in a browser bundle, and
 * the one thing wanted from it is prose. What keeps the copy honest is a test rather than
 * a convention — `render.test.tsx` imports `RUN_OUTCOMES` and `JOB_STATES` from core and
 * fails if either grows a value with no sentence here, so adding an outcome and forgetting
 * this file is a red suite rather than a pill nobody can read.
 */
export const STATUS_HELP: Record<string, string> = {
  // Run outcomes (§5.2), in the order `RUN_OUTCOMES` declares them.
  approved: 'The worker ran, the verify gate passed, and its findings — possibly zero — were persisted.',
  'changes-requested':
    'The worker ran and the verify gate rejected its output, so nothing was persisted. The gate’s word, not the worker’s: a finding that fails its own schema or cites a file that does not exist is worse than none.',
  skipped:
    'Admission refused the job before any agent ran — the failure breaker is open, or the worker is disabled. Nothing was looked at and nothing was spent.',
  dispatched: 'A modifier ran and left a patch. Whether that patch was published is a separate fact.',
  declined:
    'The worker ran, the gate passed, and its answer was no — so the work it was asked about must not go ahead. A result, not a failure: nothing broke and nothing is wrong with the worker. Everything downstream of it in the cycle was skipped.',
  error: 'The harness or the agent failed. Somebody has to go and fix this one.',

  // Job states. A row shows one of these when a job has no run to show an outcome for.
  blocked: 'Waiting on another node in its cycle. It is released when every dependency has gone terminal, or skipped when one of them did not succeed.',
  queued: 'Admitted and waiting for a runner to claim it. Not the same as clean, and not the same as about to start.',
  claimed: 'A runner has taken the job and has not started the agent yet.',
  running: 'The agent is working now. The run page streams its tool calls live.',
  succeeded: 'The job finished and released whatever depends on it.',
  failed: 'The job ended badly. Its dependents were skipped or blocked depending on the edge.',
}

/**
 * `title` from `STATUS_HELP`, on every pill in the app rather than on the Runs page.
 *
 * The same six words appear on Coverage, on Findings and in the run header, and a
 * definition that is only available where somebody thought to add a legend is one a reader
 * learns not to look for. Pills with no entry — a finding's status, a source's health —
 * get no tooltip rather than a wrong one.
 */
export const Pill = ({ value }: { value: string }) => (
  <span className={`pill ${OUTCOME_TONE[value] ?? ''}`} title={STATUS_HELP[value]}>
    {value}
  </span>
)

/**
 * The key: every status word on this page with its definition, behind a disclosure.
 *
 * Open by default was tried on paper and rejected — it is twelve rows of prose above the
 * table somebody came to read, and the second visit it is in the way. A tooltip alone was
 * also not enough: it answers "what does *this* word mean" and never "what are the
 * possible answers", which is the question somebody filtering by outcome is actually
 * asking.
 *
 * `values` is what the page has, in the order the page wants them, so the key explains the
 * vocabulary of the surface it sits on rather than every status Ogun has. A word present
 * in no row is left out: it cannot be scanned for and it pads the one thing the reader is
 * trying to find.
 */
export function StatusKey({ values, label }: { values: string[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const defined = values.filter((v) => STATUS_HELP[v] !== undefined)
  if (defined.length === 0) return null

  return (
    <div className="key">
      <button
        type="button"
        className="linklike"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'hide' : (label ?? 'what do these mean?')}
      </button>
      {open && (
        <dl className="key-list">
          {defined.map((v) => (
            <div key={v}>
              <dt>
                <Pill value={v} />
              </dt>
              <dd className="muted">{STATUS_HELP[v]}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

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

/**
 * Clock time to the second, for a column of them.
 *
 * `exact` is the tooltip form and carries a date; this is the one that goes *in* a
 * timeline, where every row shares a day and repeating it would be ninety characters of
 * noise per screen. Seconds are kept because tool calls land within the same minute.
 *
 * The locale's own 12- or 24-hour convention, via `timeStyle`, rather than a hand-rolled
 * `HH:MM:SS` — the browser already knows what this reader expects and a fixed format
 * would be wrong for half of them.
 */
export const clock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'medium' }) : ''

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
  /**
   * Hours roll over, and that is not cosmetic any more.
   *
   * This only ever formatted a *finished* run's `durationMs`, where minutes are the whole
   * range — a worker is capped at sixty of them. It now also formats the elapsed time of
   * a run still going, which has no cap at all, and the first screenshot of that read
   * `180m 0s`. Seconds are dropped past the hour for the same reason they are kept below
   * it: at three minutes the seconds are the interesting digit, and at three hours they
   * are noise in a column somebody is scanning.
   */
  if (ms >= 3_600_000) {
    const hours = Math.floor(ms / 3_600_000)
    return `${hours}h ${Math.round((ms % 3_600_000) / 60_000)}m`
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
