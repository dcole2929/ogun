import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
import { exact, when } from './ui.tsx'

/**
 * When a worker runs.
 *
 * Cron is exact and nobody remembers it. Most schedules people actually want are "every
 * night", "every few hours", "Monday morning" — so those are pickers, and the raw
 * expression stays available for the cases they cannot express. The preview comes from
 * the server's own parser rather than a second one in the browser: the question you are
 * asking is "will *this system* fire when I think", not "is this valid in the abstract".
 */
export type ScheduleValue = { cron: string; onMissed: 'skip' | 'runOnce' }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

type Mode = 'none' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom'

/** Recognise what an expression is, so editing an existing worker opens on the right tab. */
function detect(cron: string): { mode: Mode; minutes: number; hour: number; day: number } {
  const fallback = { mode: 'custom' as Mode, minutes: 15, hour: 3, day: 1 }
  if (!cron.trim()) return { ...fallback, mode: 'none' }

  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/)
  if (dom !== '*' || mon !== '*') return fallback

  const everyN = min?.match(/^\*\/(\d+)$/)
  if (everyN && hour === '*' && dow === '*') {
    return { ...fallback, mode: 'minutes', minutes: Number(everyN[1]) }
  }
  if (min === '0' && hour === '*' && dow === '*') return { ...fallback, mode: 'hourly' }
  if (/^\d+$/.test(min ?? '') && /^\d+$/.test(hour ?? '')) {
    if (dow === '*') return { ...fallback, mode: 'daily', hour: Number(hour) }
    if (/^\d$/.test(dow ?? '')) {
      return { ...fallback, mode: 'weekly', hour: Number(hour), day: Number(dow) }
    }
  }
  return fallback
}

/** Plain words for an expression, for the workers list. Falls back to the raw text. */
export function describeSchedule(cron: string | null | undefined): string {
  if (!cron) return 'runs only when triggered'
  const d = detect(cron)
  const time = (h: number) =>
    new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  switch (d.mode) {
    case 'minutes':
      return `every ${d.minutes} minutes`
    case 'hourly':
      return 'every hour'
    case 'daily':
      return `every day at ${time(d.hour)}`
    case 'weekly':
      return `every ${DAYS[d.day]} at ${time(d.hour)}`
    default:
      return cron
  }
}

export function ScheduleField({
  value,
  onChange,
}: {
  value: ScheduleValue
  onChange: (next: ScheduleValue) => void
}) {
  const initial = detect(value.cron)
  const [mode, setMode] = useState<Mode>(initial.mode)
  const [minutes, setMinutes] = useState(initial.minutes)
  const [hour, setHour] = useState(initial.hour)
  const [day, setDay] = useState(initial.day)
  const [custom, setCustom] = useState(initial.mode === 'custom' ? value.cron : '')

  const cron =
    mode === 'none'
      ? ''
      : mode === 'minutes'
        ? `*/${minutes} * * * *`
        : mode === 'hourly'
          ? '0 * * * *'
          : mode === 'daily'
            ? `0 ${hour} * * *`
            : mode === 'weekly'
              ? `0 ${hour} * * ${day}`
              : custom

  useEffect(() => {
    if (cron !== value.cron) onChange({ ...value, cron })
  }, [cron])

  const preview = useQuery({
    queryKey: ['schedulePreview', cron],
    queryFn: () => api.previewSchedule(cron),
    enabled: cron.trim().length > 0,
    retry: false,
  })

  return (
    <label className="wide">
      <span>Schedule</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} style={{ width: 'auto' }}>
          <option value="none">only when triggered</option>
          <option value="minutes">every N minutes</option>
          <option value="hourly">every hour</option>
          <option value="daily">every day</option>
          <option value="weekly">every week</option>
          <option value="custom">cron expression</option>
        </select>

        {mode === 'minutes' && (
          <input
            type="number"
            min={1}
            max={59}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(1, Math.min(59, Number(e.target.value))))}
            style={{ width: 90 }}
          />
        )}

        {(mode === 'daily' || mode === 'weekly') && (
          <select value={hour} onChange={(e) => setHour(Number(e.target.value))} style={{ width: 'auto' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </option>
            ))}
          </select>
        )}

        {mode === 'weekly' && (
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} style={{ width: 'auto' }}>
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        )}

        {mode === 'custom' && (
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="0 3 * * *"
            className="mono"
            style={{ width: 160 }}
          />
        )}
      </div>

      {mode === 'none' ? (
        <small className="muted">
          Nothing runs it on its own. Trigger it from here or with{' '}
          <span className="mono">ogun trigger</span>.
        </small>
      ) : (
        <>
          {preview.data?.valid === false && (
            <small className="error">{preview.data.error ?? 'not a valid cron expression'}</small>
          )}
          {preview.data?.valid && (
            <small className="muted">
              {/* Actual times, not a restatement of the expression. "Every 15 minutes"
                  and three concrete timestamps answer different questions. */}
              <span className="mono">{cron}</span> · next{' '}
              {preview.data.nextRuns.slice(0, 3).map((r, i) => (
                <span key={r} title={exact(r)}>
                  {i > 0 && ', '}
                  {when(r)}
                </span>
              ))}{' '}
              <span title="the control plane's timezone">({preview.data.tz})</span>
            </small>
          )}
        </>
      )}

      {mode !== 'none' && (
        <label className="inline" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={value.onMissed === 'runOnce'}
            onChange={(e) => onChange({ ...value, onMissed: e.target.checked ? 'runOnce' : 'skip' })}
          />
          <span>
            Catch up if missed
            {/* The distinction that matters on a laptop: WSL2 stops when Windows sleeps,
                so a nightly worker misses occurrences as a matter of course. */}
            <small className="muted" style={{ display: 'block' }}>
              {value.onMissed === 'runOnce'
                ? 'If this machine was asleep, run once on waking.'
                : 'If this machine was asleep, wait for the next scheduled time.'}
            </small>
          </span>
        </label>
      )}
    </label>
  )
}
