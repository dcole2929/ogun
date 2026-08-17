import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api, type RunDetail, type RunEventRow } from '../api.ts'
import { duration, Empty, Page, Pill, Severity, when } from '../ui.tsx'

export function RunDetailPage() {
  const { id = '' } = useParams()
  const { data, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    // The SSE stream owns updates once it attaches; polling on top would double-render.
    refetchInterval: (q) => (q.state.data?.run.endedAt ? false : 4000),
  })

  const live = useLiveEvents(id, data?.run.endedAt === null || data?.run.endedAt === undefined)
  const events = useMergedEvents(data?.events ?? [], live)

  if (error) return <p className="error">{String(error)}</p>
  if (!data) return <Empty>loading…</Empty>

  const running = !data.run.endedAt

  return (
    <Page
      title={`${data.worker.name} · ${data.project.slug}`}
      subtitle={data.job.prompt ?? undefined}
      actions={<Link to="/runs">← all runs</Link>}
    >
      <div className="card" style={{ marginBottom: 20 }}>
        <dl className="kv">
          <dt>Outcome</dt>
          <dd>
            {running ? (
              <span className="live">running</span>
            ) : (
              <Pill value={data.run.outcome ?? data.job.state} />
            )}
          </dd>
          {data.run.detail && (
            <>
              <dt>Detail</dt>
              <dd className="muted">{data.run.detail}</dd>
            </>
          )}
          <dt>Started</dt>
          <dd className="muted">{when(data.run.startedAt)}</dd>
          <dt>Duration</dt>
          <dd className="muted">{duration(data.run.durationMs)}</dd>
          <dt>Runtime</dt>
          <dd className="muted">
            {data.run.runtime} {data.run.model && `· ${data.run.model}`}
          </dd>
          <dt>Commit</dt>
          <dd className="muted mono">{data.run.repoSha?.slice(0, 12) ?? '—'}</dd>
          <dt>Tokens</dt>
          <dd className="muted mono">
            {data.run.inputTokens ?? '—'} in / {data.run.outputTokens ?? '—'} out
          </dd>
          {data.artifacts.length > 0 && (
            <>
              <dt>Artifacts</dt>
              <dd className="muted mono">
                {data.artifacts.map((a) => (
                  <div key={a.id}>
                    {a.kind}: {a.ref}
                  </div>
                ))}
              </dd>
            </>
          )}
        </dl>
      </div>

      <Produced detail={data} />

      <h2>Timeline</h2>
      <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
        Every tool call and message, as it happened. The result is above.
      </p>
      {events.length === 0 && <Empty>no events yet</Empty>}
      <div className="timeline">
        {events.map((e) => (
          <Event key={e.seq} event={e} startedAt={data.run.startedAt} />
        ))}
      </div>
    </Page>
  )
}

/**
 * What the run produced, above the timeline.
 *
 * A run is the primary object and its result is the thing you came for. Before this, the
 * page showed an event stream and metadata, so "what did this run actually do?" was
 * answerable only by reading fifty tool calls to the end.
 */
function Produced({ detail }: { detail: RunDetail }) {
  const { promoted, changes, findings } = detail.produced
  const running = !detail.run.endedAt
  const outcome = detail.run.outcome

  if (running) return null

  return (
    <>
      <h2>Result</h2>
      <div className="card" style={{ marginBottom: 20 }}>
        {/* The failure reasons first, since that is what you opened this page for when
            something went wrong. */}
        {outcome === 'error' && (
          <p className="error" style={{ marginTop: 0, fontSize: 13 }}>
            This run failed before producing anything.
            {detail.run.detail && (
              <>
                {' '}
                <span className="mono">{detail.run.detail}</span>
              </>
            )}
          </p>
        )}
        {outcome === 'changes-requested' && (
          <p className="error" style={{ marginTop: 0, fontSize: 13 }}>
            The verify gate rejected this run's output, so nothing was persisted —
            deliberately, because a finding that fails its own schema or cites a file that
            does not exist is worse than none.
            {detail.run.detail && (
              <>
                {' '}
                <span className="mono">{detail.run.detail}</span>
              </>
            )}
          </p>
        )}

        {/* What the node wanted said, before the list of what it filed. A triage run
            that names the reviewer which crashed is telling you the inbox below is
            short by one surface, and that is not derivable from the findings. */}
        {detail.run.notes && (
          <div style={{ marginBottom: 14 }}>
            <p className="note">{detail.run.notes}</p>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
              {detail.worker.name}'s own account of this pass. Also shown against its row
              on <Link to="/coverage">Coverage</Link>.
            </p>
          </div>
        )}

        {promoted.length > 0 ? (
          <>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              {promoted.length} finding{promoted.length === 1 ? '' : 's'} from this run.
            </p>
            {promoted.map((f) => (
              <div key={f.id} className="finding" style={{ paddingTop: 8 }}>
                <div className="row" style={{ marginBottom: 3 }}>
                  <Severity value={f.severity} />
                  {f.status !== 'open' && <Pill value={f.status} />}
                  {!f.firstSeenHere && (
                    // Worth distinguishing: this run confirmed something already known
                    // rather than discovering it.
                    <span className="pill" title={`reported ${f.seenCount} times`}>
                      seen before
                    </span>
                  )}
                </div>
                <Link to="/findings" style={{ fontWeight: 550 }}>
                  {f.title}
                </Link>
                <div className="fp">{f.fingerprint}</div>
              </div>
            ))}
          </>
        ) : outcome === 'approved' ? (
          <p style={{ margin: 0, fontSize: 13 }}>
            Nothing found.{' '}
            <span className="muted">
              The worker looked and reported no issues — a result, not an absence.
            </span>
          </p>
        ) : null}

        {findings.length > promoted.length && (
          <p className="muted" style={{ fontSize: 12 }}>
            {findings.length} reported, {promoted.length} persisted — the rest were
            duplicates of findings already open.
          </p>
        )}

        {changes.map((ch) => (
          <dl className="kv" key={ch.id}>
            <dt>Branch</dt>
            <dd className="mono">{ch.branch ?? '—'}</dd>
            <dt>Files changed</dt>
            <dd className="muted">{ch.filesChanged ?? '—'}</dd>
            <dt>Tests</dt>
            <dd>{ch.testsPassed === null ? '—' : ch.testsPassed ? 'passed' : 'failed'}</dd>
            {ch.prUrl && (
              <>
                <dt>Pull request</dt>
                <dd>
                  <a href={ch.prUrl} target="_blank" rel="noreferrer noopener">
                    {ch.prUrl}
                  </a>
                </dd>
              </>
            )}
          </dl>
        ))}
      </div>
    </>
  )
}

function Event({ event, startedAt }: { event: RunEventRow; startedAt: string }) {
  const [expanded, setExpanded] = useState(false)
  const offset = Math.max(0, (new Date(event.ts).getTime() - new Date(startedAt).getTime()) / 1000)
  const p = event.payload as Record<string, any>

  const kind = event.type.replace(/^(run|agent|tool|runner)\./, '')
  const cls =
    event.type.startsWith('tool.') || event.type === 'run.started'
      ? 'tool'
      : event.type === 'agent.reasoning'
        ? 'reasoning'
        : event.type === 'run.failed'
          ? 'failed'
          : ''

  return (
    <div className={`event ${cls}`}>
      <span className="when">+{offset.toFixed(0)}s</span>
      <span className="kind">{event.type}</span>
      <div className="body">
        {renderBody(event.type, p, kind)}
        {event.type === 'tool.completed' && p.output ? (
          <>
            <a
              className="muted"
              style={{ cursor: 'pointer', fontSize: 11 }}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'hide output' : `output (${String(p.output).length} chars)`}
            </a>
            {expanded && <div className="tool-output">{String(p.output).slice(0, 20_000)}</div>}
          </>
        ) : null}
      </div>
    </div>
  )
}

function renderBody(type: string, p: Record<string, any>, kind: string): string {
  switch (type) {
    case 'run.started':
      return `${p.runtime}${p.model ? ` · ${p.model}` : ''}`
    case 'agent.message':
    case 'agent.reasoning':
      return String(p.text ?? '')
    case 'tool.started':
      return `${p.name}${p.input ? ` ${summarizeInput(p.input)}` : ''}`
    case 'tool.completed':
      return p.isError ? `failed (exit ${p.exitCode ?? '?'})` : `ok${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}`
    case 'run.completed':
      return p.outcome ? String(p.outcome) : 'done'
    case 'run.failed':
      return String(p.error ?? 'failed')
    case 'rate_limit':
      return JSON.stringify(p.info ?? {})
    default:
      return `${kind} ${JSON.stringify(p).slice(0, 200)}`
  }
}

const summarizeInput = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) return String(input)
  const o = input as Record<string, unknown>
  const first = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.prompt
  return first ? String(first).slice(0, 160) : JSON.stringify(o).slice(0, 160)
}

/**
 * SSE, not websockets — the timeline only flows one way. The server backfills anything
 * past `since` from postgres before attaching to the bus, so opening this page
 * mid-run does not lose the earlier half.
 */
function useLiveEvents(runId: string, active: boolean): RunEventRow[] {
  const [events, setEvents] = useState<RunEventRow[]>([])
  const seen = useRef(new Set<number>())

  useEffect(() => {
    if (!runId || !active) return
    const source = new EventSource(`/api/runs/${runId}/stream?since=-1`)

    const onEvent = (e: MessageEvent) => {
      if (!e.data) return
      try {
        const row = JSON.parse(e.data) as RunEventRow
        if (seen.current.has(row.seq)) return
        seen.current.add(row.seq)
        setEvents((prev) => [...prev, row])
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    }

    for (const type of [
      'run.started',
      'agent.message',
      'agent.reasoning',
      'tool.started',
      'tool.completed',
      'run.completed',
      'run.failed',
      'usage',
      'rate_limit',
      'runner.note',
    ]) {
      source.addEventListener(type, onEvent)
    }

    return () => source.close()
  }, [runId, active])

  return events
}

/** Postgres is authoritative; live events fill the gap until the next refetch. */
function useMergedEvents(persisted: RunEventRow[], live: RunEventRow[]): RunEventRow[] {
  return useMemo(() => {
    const bySeq = new Map<number, RunEventRow>()
    for (const e of [...live, ...persisted]) bySeq.set(e.seq, e)
    return [...bySeq.values()]
      .filter((e) => e.seq !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.seq - b.seq)
  }, [persisted, live])
}
