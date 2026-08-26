import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from './api.ts'

/**
 * The things that stop work while every page still says success.
 *
 * Each of these was already visible — on the one page that owns it. No runner online is
 * on Runners; a tripped breaker is on Workers; a drifted config was nowhere at all. That
 * is no use when you are looking at the inbox wondering why it has not changed since
 * Tuesday, which is exactly the position a fourteen-hour silent outage puts you in.
 *
 * Lives in the sidebar because it has to be true of the whole factory, not of the page.
 * Renders nothing when everything is fine: chrome that is always lit stops being read.
 */
/**
 * The three states that reach the rail, said in the words of the thing that broke.
 *
 * "Failing" alone is a status; "no tickets are being polled" is a consequence, and the
 * consequence is what makes somebody click. `overdue` gets the strongest wording because
 * it is the only one where *nothing looked at all* — the poll loop is not running, or the
 * source's stored config is one the poller skips without leaving a row.
 */
const SOURCE_LABEL: Record<string, string> = {
  failing: 'polls are failing',
  refused: 'polls cannot start',
  overdue: 'is not being polled',
}

/** Only reached when the ledger recorded no sentence of its own, which is rare. */
const SOURCE_DETAIL: Record<string, string> = {
  failing: 'Linear was asked and did not answer — no tickets are becoming work',
  refused: 'the poll never reached Linear; something on this machine is missing',
  overdue: 'nothing has looked, and no poll row says why — the loop itself is not running',
}

export function StatusRail() {
  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 10_000,
  })
  if (!data) return null

  const troubles: Array<{ key: string; to: string; label: string; detail: string }> = []

  if (data.runnersOnline === 0) {
    troubles.push({
      key: 'runners',
      to: '/runners',
      label: 'No runner online',
      detail: 'jobs will queue rather than fail — nothing is lost, but nothing runs',
    })
  }
  for (const slug of data.drifted) {
    troubles.push({
      key: `drift:${slug}`,
      to: '/workers',
      label: `${slug}: config not published`,
      detail: 'config.yaml has changed; the factory is still running the previous definition',
    })
  }
  /**
   * A source that has stopped turning tickets into work.
   *
   * The fourth member of this list and the one that had no page of its own at all: the
   * poll ledger had no reader anywhere, so a credential that expired at 3am left a perfect
   * row in a table nothing queried and a line in a terminal nobody was watching. Every
   * *other* symptom of it is an absence — no cycle runs, no jobs, an inbox that has not
   * changed since Tuesday — which is exactly what a quiet week looks like.
   *
   * **The label carries the kind, not just "failing".** `auth` is somebody's credential
   * and only a person fixes it; `local` is this machine's store; `transport` is the
   * network; `ratelimited` fixes itself. A rail entry saying "poll failed" would send
   * every one of those to the same place. Which of them are shown here at all is the
   * server's decision — see `troubledSources`.
   */
  for (const s of data.sources ?? []) {
    troubles.push({
      key: `source:${s.project}/${s.source}`,
      // Coverage, because that is where the poll ledger is read: this is the trigger's
      // half of "did the factory actually look".
      to: '/coverage',
      label: `${s.source}: ${SOURCE_LABEL[s.state] ?? s.state}${s.kind ? ` (${s.kind})` : ''}`,
      detail: s.detail ?? SOURCE_DETAIL[s.state] ?? 'no tickets are reaching the factory',
    })
  }

  for (const b of data.breakers) {
    troubles.push({
      key: `breaker:${b.project}/${b.worker}`,
      to: '/workers',
      label: `${b.worker} is halted`,
      detail: `${b.failures} consecutive failures — it will not be dispatched until cleared`,
    })
  }

  if (troubles.length === 0) return null

  return (
    <div className="status-rail">
      {troubles.map((t) => (
        <Link key={t.key} to={t.to} className="status-item" title={t.detail}>
          <span className="status-dot" aria-hidden="true" />
          <span>
            {t.label}
            <small>{t.detail}</small>
          </span>
        </Link>
      ))}
    </div>
  )
}
