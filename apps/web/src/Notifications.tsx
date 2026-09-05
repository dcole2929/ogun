import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router'
import { api } from './api.ts'
import { useProjectScope } from './scope.tsx'

/**
 * The things that stop work while every page still says success.
 *
 * Each of these was already visible — on the one page that owns it. No runner online is
 * on Runners; a tripped breaker is on Workers; a drifted config was nowhere at all. That
 * is no use when you are looking at the inbox wondering why it has not changed since
 * Tuesday, which is exactly the position a fourteen-hour silent outage puts you in.
 *
 * ### Why a tray and not a rail
 *
 * This was a stack of tinted boxes in the sidebar, each carrying a label *and* a full
 * explanatory sentence. Three of them — which is an ordinary Tuesday: two projects
 * drifted and a breaker open — filled the column with wrapped yellow text, and the
 * sentences are the part that suffers most, because the sidebar is the narrowest thing
 * on screen and the sentences are the longest.
 *
 * So the summary collapses to one line and the detail moves into a panel that is *not*
 * bound by the sidebar's width. The rail's own rule still holds — nothing is lit when
 * nothing is wrong — but the trigger stays put rather than vanishing, because a tray you
 * cannot find when you go looking is worse than a quiet one.
 *
 * ### Nothing here is dismissible
 *
 * These are live states, not events. "No runner online" is true until a runner comes
 * back, and a dismissed one would either lie or reappear — both worse than a count that
 * simply reflects what is true right now. Clearing an entry means fixing the thing.
 */

/**
 * Two tones, on one distinction: is work happening?
 *
 * `stopped` means it is not — no runner, a halted worker, a source that has stopped
 * turning tickets into work. `stale` means it is, but not as written: the factory is
 * running the previous definition. Splitting these finer would give the page four colours
 * and no rule for reading them.
 */
type Tone = 'stopped' | 'stale'

type Trouble = {
  key: string
  to: string
  label: string
  detail: string
  tone: Tone
  /**
   * Which project this is about, when it is about one at all.
   *
   * Load-bearing, not decoration. The app is scoped to one project, so a notification
   * about another one navigated you to a page that then filtered the very thing you
   * clicked to look at — you would land on Workers, scoped to `ogun`, having asked to see
   * a halted worker in `heirchive-api`, and find nothing wrong anywhere. Following the
   * link moves the scope with you.
   *
   * Absent for `runnersOnline`, which is machine-wide: Runners is outside the scope
   * entirely, so there is nothing to move.
   */
  project?: string
}

const SOURCE_LABEL: Record<string, string> = {
  failing: 'polls are failing',
  refused: 'polls cannot start',
  overdue: 'is not being polled',
}

const SOURCE_DETAIL: Record<string, string> = {
  failing: 'Linear was asked and did not answer — no tickets are becoming work',
  refused: 'the poll never reached Linear; something on this machine is missing',
  overdue: 'nothing has looked, and no poll row says why — the loop itself is not running',
}

export function Notifications() {
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 10_000 })
  const [open, setOpen] = useState(false)
  const tray = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()

  // Following a link inside the panel leaves it hanging over the page it just navigated
  // to, covering the thing you clicked through to look at.
  useEffect(() => setOpen(false), [pathname])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!tray.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const { setSlug } = useProjectScope()
  const troubles = data ? troublesFrom(data) : []
  const stopped = troubles.filter((t) => t.tone === 'stopped').length

  return (
    <div className="tray" ref={tray}>
      {open && troubles.length > 0 && (
        <div className="tray-panel" role="dialog" aria-label="Problems">
          <div className="tray-head">
            {troubles.length} {troubles.length === 1 ? 'problem' : 'problems'}
          </div>
          {troubles.map((t) => (
            <Link
              key={t.key}
              to={t.to}
              className={`tray-item ${t.tone}`}
              // Before the navigation, so the destination renders already looking at the
              // right project rather than filtering the reason you clicked.
              onClick={() => t.project && setSlug(t.project)}
            >
              <span className="tray-dot" aria-hidden="true" />
              <span className="tray-text">
                <strong>{t.label}</strong>
                <small>{t.detail}</small>
              </span>
            </Link>
          ))}
        </div>
      )}

      <button
        type="button"
        className={`tray-trigger${troubles.length > 0 ? ' lit' : ''}${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={troubles.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tray-dot" aria-hidden="true" />
        <span className="tray-label">
          {troubles.length === 0
            ? 'All clear'
            : `${troubles.length} ${troubles.length === 1 ? 'problem' : 'problems'}`}
        </span>
        {/* The count that matters is the one where nothing is running, so it is the one
            shown separately when the two differ. */}
        {stopped > 0 && troubles.length !== stopped && (
          <span className="tray-badge">{stopped} stopped</span>
        )}
      </button>
    </div>
  )
}

/**
 * Ordered worst first: the top of a list is the part that reliably gets read.
 *
 * Exported because the panel only exists once it is opened, and what matters about these
 * entries — that each carries the project it is about, and points at the specific thing —
 * is not observable from the collapsed trigger's markup.
 */
export function troublesFrom(data: Awaited<ReturnType<typeof api.status>>): Trouble[] {
  const troubles: Trouble[] = []

  if (data.runnersOnline === 0) {
    troubles.push({
      key: 'runners',
      to: '/runners',
      tone: 'stopped',
      label: 'No runner online',
      detail: 'jobs will queue rather than fail — nothing is lost, but nothing runs',
    })
  }

  for (const b of data.breakers) {
    troubles.push({
      key: `breaker:${b.project}/${b.worker}`,
      // Named in the URL, so the page can put it in front of you rather than leaving you
      // to find one halted worker among a project's worth of healthy ones — which the
      // filter bar could be actively hiding.
      to: `/workers?focus=${encodeURIComponent(b.worker)}`,
      project: b.project,
      tone: 'stopped',
      label: `${b.worker} is halted`,
      detail: `${b.failures} consecutive failures — it will not be dispatched until cleared`,
    })
  }

  /**
   * A source that has stopped turning tickets into work.
   *
   * The one that had no page of its own at all: the poll ledger had no reader anywhere,
   * so a credential that expired at 3am left a perfect row in a table nothing queried.
   * Every *other* symptom of it is an absence — no cycle runs, no jobs, an inbox that has
   * not changed since Tuesday — which is exactly what a quiet week looks like.
   *
   * **The label carries the kind, not just "failing".** `auth` is somebody's credential
   * and only a person fixes it; `local` is this machine's store; `transport` is the
   * network; `ratelimited` fixes itself.
   */
  for (const s of data.sources ?? []) {
    troubles.push({
      key: `source:${s.project}/${s.source}`,
      // Coverage, because that is where the poll ledger is read: this is the trigger's
      // half of "did the factory actually look".
      to: '/coverage',
      project: s.project,
      tone: 'stopped',
      label: `${s.source}: ${SOURCE_LABEL[s.state] ?? s.state}${s.kind ? ` (${s.kind})` : ''}`,
      detail: s.detail ?? SOURCE_DETAIL[s.state] ?? 'no tickets are reaching the factory',
    })
  }

  // Last, and the only `stale` one: work is still happening, it is just not the work the
  // file describes.
  for (const slug of data.drifted) {
    troubles.push({
      key: `drift:${slug}`,
      to: '/workers',
      project: slug,
      tone: 'stale',
      label: `${slug}: config not published`,
      detail: 'config.yaml has changed; the factory is still running the previous definition',
    })
  }

  return troubles
}
