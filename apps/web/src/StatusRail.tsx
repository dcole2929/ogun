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
