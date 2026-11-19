import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api, isInFlight, type RunDetail, type RunEventRow } from '../api.ts'
import { Markdown } from '../Markdown.tsx'
import { duration, Empty, Page, Pill, Severity, when } from '../ui.tsx'

export function RunDetailPage() {
  const { id = '' } = useParams()
  const { data, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    // The SSE stream owns updates once it attaches; polling on top would double-render.
    refetchInterval: (q) => (isInFlight(q.state.data) ? 4000 : false),
  })

  const live = useLiveEvents(id, isInFlight(data))
  const events = useMergedEvents(data?.events ?? [], live)

  if (error) return <p className="error">{String(error)}</p>
  if (!data) return <Empty>loading…</Empty>

  const running = isInFlight(data)

  return (
    <Page
      title={`${data.worker.name} · ${data.project.slug}`}
      /**
       * Not the job prompt, which is what this was.
       *
       * The prompt is the worker's instruction with the ticket appended as fenced data —
       * `-----BEGIN TICKET-----` and a paragraph of somebody's bug report. Rendered as a
       * subtitle that is a wall of text above the page it belongs to, and a mirrored copy
       * of Linear's content, which ADR-0004 says is the thing a later reader believes is
       * current. The ticket is a link now, below; the prompt is still on the job and is
       * not what a page about a run should open with.
       */
      subtitle={`${data.job.nodeKey} · ${when(data.run.startedAt)}`}
      actions={<Link to="/runs">← all runs</Link>}
    >
      <div className="card" style={{ marginBottom: 20 }}>
        <dl className="kv">
          {/**
           * First, because on a ticket pipeline it is the question — which ticket is this
           * about — and it used to be answerable only by reading the fenced prompt.
           */}
          {data.ticket && (
            <>
              <dt>Ticket</dt>
              <dd>
                {data.ticket.url === null ? (
                  <span className="mono">{data.ticket.key}</span>
                ) : (
                  <a className="extlink" href={data.ticket.url} target="_blank" rel="noreferrer">
                    {data.ticket.key}
                  </a>
                )}
              </dd>
            </>
          )}
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
          {/* Only when there was more than one. A row saying "1" on every run would be
              noise; the whole point of the column is that a run which needed a second
              attempt should not look like one that did not. */}
          {(data.run.rounds ?? 1) > 1 && (
            <>
              <dt>Rounds</dt>
              <dd className="muted">
                {data.run.rounds} — the verify gate refused this run's first patch and it was
                given the rejection and another attempt. The timeline has both.
              </dd>
            </>
          )}
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
  const { promoted, changes, findings, suppressed } = detail.produced
  const running = isInFlight(detail)
  const outcome = detail.run.outcome

  return (
    <>
      <h2>Result</h2>
      <div className="card" style={{ marginBottom: 20 }}>
        {/*
          A run in flight. This was `if (running) return null` — no Result heading and no
          card, so the page you land on after pressing run is metadata and a timeline with
          a gap where the answer goes, and the section appears from nowhere at the end.
          There is no partial result to show and that is the point worth saying: findings,
          the patch, the coverage row and the outcome are one transaction written when the
          run reports (§5.1), precisely so that a crash cannot leave half of them. So this
          says *why* it is empty, which is a fact about the system, rather than leaving an
          emptiness that reads as "this run produced nothing".

          Anything already on the page is still rendered below — artifacts upload as the
          run goes, and a run whose report landed while `endedAt` was still being written
          should show what it reported rather than this sentence and nothing else.
        */}
        {running && (
          <p style={{ marginTop: 0, fontSize: 13 }}>
            <span className="live">still running</span>
            <span className="muted" style={{ marginLeft: 8 }}>
              — started {when(detail.run.startedAt)}. Nothing is recorded as produced yet:
              the findings, the patch and the outcome are written in one transaction when
              this run reports, so this stays empty until it finishes. The timeline below
              is live.
            </span>
          </p>
        )}

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

        {/* A decline is a result, so it is not styled as an error — but it is the whole
            output of the run and it must not be something a reader has to go and find.
            Ogun writes nothing back to the ticket and never emits it twice, so this
            sentence is all the person who filed it will ever get (§4.13). */}
        {outcome === 'declined' && (
          <p className="note" style={{ marginTop: 0, fontSize: 13 }}>
            <strong>Declined.</strong> This worker judged the work it was handed and
            refused it, so everything downstream of it in this cycle was skipped. Nothing
            failed.
            {detail.run.detail && <> {detail.run.detail}</>}
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

        {/* What this run was not allowed to say, and who decided. Suppression is the one
            thing here whose entire effect is an absence, and an absence with nothing
            beside it reads exactly like a reviewer that found nothing (principle 6). */}
        {suppressed.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
              {suppressed.length} suppressed — reported again after being dismissed, so it
              did not reach the inbox.
            </p>
            {suppressed.map((s, i) => (
              <div key={i} className="finding" style={{ paddingTop: 8 }}>
                <div className="fp">{s.dismissal}</div>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  {s.reason}
                </p>
              </div>
            ))}
          </div>
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
            {/* `output-toggle` carries the gap. Inline with no margin, the outcome and
                the link rendered as one word — a picture of this timeline read
                "okoutput (172 chars)" on every successful call. */}
            <a
              className="muted output-toggle"
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

function renderBody(type: string, p: Record<string, any>, kind: string): ReactNode {
  switch (type) {
    case 'run.started':
      return `${p.runtime}${p.model ? ` · ${p.model}` : ''}`
    /**
     * An agent's message is markdown and always was — headings, bullets, `code`, bold.
     * Rendered as preformatted text it was the source: `## What I built` and stray
     * backticks down a timeline, with the longest message on the page — the closing
     * account of what the run did — the worst affected.
     *
     * This is the renderer the skill page uses, not a second one and not a markdown
     * dependency: it builds React elements and never sets inner HTML, which matters more
     * here than there. A skill is a file from a repository; this is whatever a model
     * wrote, which is the less trustworthy of the two.
     */
    case 'agent.message':
      return <Markdown source={String(p.text ?? '')} />
    // Reasoning is not markdown — it is a thinking trace, and `.event.reasoning` already
    // sets it apart in muted italics.
    case 'agent.reasoning':
      return String(p.text ?? '')
    case 'tool.started':
      return <ToolCall name={String(p.name ?? 'tool')} input={p.input} />
    case 'tool.completed':
      return p.isError
        ? `failed${p.exitCode === undefined ? '' : ` (exit ${p.exitCode})`}`
        : `ok${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}`
    case 'run.completed':
      return p.outcome ? String(p.outcome) : 'done'
    case 'run.failed':
      return String(p.error ?? 'failed')
    /**
     * The runner talking: which skill was injected, what the patch extractor got, why a
     * gate refused. `note` is the sentence it wrote, and the rest of the payload is the
     * same thing in fields — so the default branch below rendered the note twice, once as
     * prose and once inside a JSON dump of the row it came from.
     */
    case 'runner.note':
      return typeof p.note === 'string' ? p.note : JSON.stringify(p)
    /**
     * The provider's own object, verbatim, which is how it reached the database — and as
     * a line of JSON it was the widest row on the page, two full lines of
     * `overageDisabledReason` and an epoch integer. Two fields answer what a reader is
     * asking when they notice this row at all: which window, and whether it let the call
     * through. The rest is still in the payload for anyone reading the API.
     */
    case 'rate_limit': {
      const info = (p.info ?? {}) as Record<string, unknown>
      const said = [info.rateLimitType, info.status].filter((v) => typeof v === 'string')
      return said.length > 0 ? said.join(' · ') : JSON.stringify(info)
    }
    default:
      return `${kind} ${JSON.stringify(p).slice(0, 200)}`
  }
}

/**
 * A tool call, as the thing it is rather than as a labelled row.
 *
 * It said `Bash cd /workspace && pnpm test` — the word `Bash` in front of every shell
 * command on the page, where the command is the content and the tool's name is a fact
 * about the harness. A command is now set as a command, behind a `>` prompt.
 *
 * Keyed off the payload's *shape* rather than the tool's name, deliberately: codex calls
 * the same thing `command_execution` and claude calls it `Bash`, both carrying `command`,
 * and a name list would have to grow a row for every runtime added later (§4.7). Anything
 * carrying a command is a command.
 *
 * Every other tool keeps its name, because there it carries the verb: `Read`, `Edit` and
 * `Grep` in front of a path are the difference between looking at a file and rewriting
 * it, and the argument alone does not say which happened.
 */
function ToolCall({ name, input }: { name: string; input: unknown }) {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null
  const command = typeof o?.command === 'string' ? o.command : null

  if (command !== null) {
    return (
      /**
       * `description` as the tooltip rather than a second line. Claude sends a short
       * statement of intent with most Bash calls ("Run the web suite"), which is worth
       * having and is not worth doubling the height of a timeline of a hundred calls to
       * show. Codex sends none, and then there is nothing to hover.
       */
      <div className="cmd" title={typeof o?.description === 'string' ? o.description : undefined}>
        {/* Decoration, so it is hidden from a screen reader — "greater than" read aloud
            before every command is noise, and the element after it is the command. */}
        <span className="cmd-sigil" aria-hidden="true">
          &gt;
        </span>
        <code>{command}</code>
      </div>
    )
  }

  const arg = argumentOf(o)
  return (
    <div className="tool-call">
      <span className="tool-name">{name}</span>
      {arg && <code className="tool-arg">{arg}</code>}
      {/* The window of a partial read, which is why the same file appears four times.
          One string rather than three children: React splits adjacent text nodes with a
          comment when it renders to markup, and `from line <!-- -->120` is a thing
          nothing can search for — not a test, and not ctrl-F on the page. */}
      {typeof o?.offset === 'number' && (
        <span className="muted" style={{ fontSize: 11 }}>
          {`from line ${o.offset}${typeof o.limit === 'number' ? ` (${o.limit})` : ''}`}
        </span>
      )}
    </div>
  )
}

/**
 * The one value worth showing for a tool that is not a command — the file, the pattern,
 * the skill. The order is the order the shapes actually occur in: `file_path` for
 * Read/Write/Edit, `pattern` for Grep and Glob, `path` for a listing, `skill` for a Skill
 * call, `prompt` for a subagent.
 *
 * Nothing that stands for the input falls back to the input, truncated — a row that says
 * only `TodoWrite` is a row that has told you nothing.
 */
function argumentOf(o: Record<string, unknown> | null): string {
  if (o === null) return ''
  const first = o.file_path ?? o.pattern ?? o.path ?? o.skill ?? o.prompt
  if (first === undefined || first === null) return JSON.stringify(o).slice(0, 160)
  return shortenPath(String(first).slice(0, 200))
}

/**
 * Sandbox paths are absolute and all start at the same mount, so `/workspace/` is eleven
 * characters of nothing on every row — and it pushes the part that differs off the right
 * of a narrow column. Only that prefix: a path somewhere else is somewhere else, and
 * saying so is the point of showing it.
 */
const shortenPath = (value: string): string =>
  value.startsWith('/workspace/') ? value.slice('/workspace/'.length) : value

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
