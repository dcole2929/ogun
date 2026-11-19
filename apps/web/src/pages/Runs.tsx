import { useState, type MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import {
  api,
  isInFlight,
  type JobDependency,
  type PendingJob,
  type RunSummary,
} from '../api.ts'
import {
  Choice,
  duration,
  Empty,
  exact,
  Filters,
  matches,
  Page,
  Pill,
  Search,
  StatusKey,
  when,
} from '../ui.tsx'
import { useProjectScope } from '../scope.tsx'

/**
 * The result column is one line in a dense table, and a decline's reason is a sentence
 * written for a person rather than a status word. Cut it here rather than letting it set
 * the column width for every other row; the run page carries it whole.
 */
const truncate = (s: string): string => (s.length > 70 ? `${s.slice(0, 69)}…` : s)

/**
 * Whole-row navigation, added *on top of* a real link rather than instead of one.
 *
 * The complaint this answers: the only clickable thing in a run row was the relative
 * timestamp, so the way to open a run was to find and hit "3h ago" — a four-character
 * target in the leftmost column of a nine-column row that is otherwise inert.
 *
 * Three ways to do it, and why this one:
 *
 *  - Wrapping the row in an anchor is not available. `<a>` cannot contain `<tr>`, and
 *    turning the table into a stack of divs to make it possible would cost the column
 *    alignment that makes this list scannable in the first place.
 *  - An anchor inside every cell gives nine tab stops per row. Ten rows is ninety stops
 *    between the filter bar and the next thing on the page, and a screen reader reads the
 *    same destination out nine times.
 *  - So: the timestamp stays a real `<Link>` — which is the accessible, keyboard-reachable
 *    and middle-clickable way to open the run, and the one tab stop the row needs — and
 *    this adds a click target over the rest of it, plus a chevron cell and a hover state
 *    so that target is visible. Nothing here is the only way to reach anything.
 *
 * The guards are the whole reason this is a function and not an inline handler. Each one
 * is a way a row-wide click handler breaks a table that was working:
 *
 *  - a click that landed on a link, a button or a form control belongs to that control.
 *    Without this, the pull-request link in the Produced column navigates to the run page
 *    instead of GitHub, and the waiting table's disclosure button toggles and is
 *    immediately navigated away from.
 *  - a modified click means "open this somewhere else", which `navigate` cannot do. The
 *    row background ignores it so the real link in the row is the thing that answers
 *    cmd-click, rather than this quietly swallowing it and opening in place.
 *  - a click that ends a text selection is somebody copying a commit sha out of the
 *    table, not asking to leave the page. Before this guard, selecting any text in a row
 *    and releasing navigated away and lost the selection.
 *  - a click inside a `.mono` cell is left alone entirely, which is the one concession
 *    this pattern cannot make any other way. Dragging across text is caught by the guard
 *    above, but *double-clicking* a word is not: the first click of a double-click
 *    arrives before the browser has selected anything, so it is indistinguishable from a
 *    plain click and the row navigates out from under the gesture. Deferring the
 *    navigation long enough to find out would put a visible delay on every row click, so
 *    instead the cells that exist to be copied — the commit sha, the token counts, a
 *    branch name — are not part of the click target. Everything else in the row is prose
 *    nobody double-clicks to copy.
 */
function useRowNav(): (to: string) => {
  className: string
  onClick: (e: MouseEvent<HTMLElement>) => void
} {
  const navigate = useNavigate()
  return (to) => ({
    className: 'rowlink',
    onClick: (e) => {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label, .mono'))
        return
      if ((window.getSelection()?.toString() ?? '') !== '') return
      navigate(to)
    },
  })
}

/**
 * The affordance, in its own column at the end of the row.
 *
 * `aria-hidden`, because it is a picture of the link that is already in the first cell and
 * announcing it again would make every row read its destination twice. Its job is for the
 * eye: a column of chevrons is what tells a sighted reader that these rows go somewhere,
 * which is the thing a hover state alone cannot do before you hover.
 */
const Chevron = ({ open }: { open?: boolean }) => (
  <span className="chev" aria-hidden="true">
    {open === undefined ? '›' : open ? '⌄' : '›'}
  </span>
)

/**
 * The word the Outcome column shows for a run.
 *
 * Not `outcome ?? job.state`, which is what it was: that is right for every row except
 * the one in flight, which has neither and rendered as whatever its job last said. See
 * `isInFlight` for why that predicate is not simply "it has not ended".
 */
const statusOf = (r: RunSummary): string =>
  isInFlight(r) ? 'running' : (r.run.outcome ?? r.job.state)

/** `https://github.com/o/r/pull/412` → `#412`, and anything else → a readable fallback. */
const prLabel = (url: string): string => {
  const n = /\/(\d+)\/?(?:[?#].*)?$/.exec(url)
  return n ? `#${n[1]}` : 'pull request'
}

export function RunsPage() {
  const { filter } = useProjectScope()
  const [query, setQuery] = useState('')
  const [outcome, setOutcome] = useState('all')
  const { data, isLoading, error } = useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    /**
     * Only while something is in flight. A run that has not ended has a duration that is
     * still growing and an outcome that does not exist yet, so a static list is wrong
     * about it the moment it is painted — and the list is where somebody watches a
     * triggered run, because the run page is one click further away than the one they
     * just pressed. Stops the moment nothing is running, so an idle factory's tab is not
     * polling a database every five seconds forever.
     */
    refetchInterval: (q) =>
      (q.state.data?.runs ?? []).some((r) => statusOf(r) === 'running') ? 5000 : false,
  })

  /**
   * Scoped in the browser rather than by refetching. `/api/runs` takes a `?project=` but
   * this page asks for `?limit=50` — a scoped request would return the last 50 runs *of
   * that project*, which is a different list from "this project's runs among the last
   * 50", and switching scope would silently change how far back the page reaches.
   */
  const inScope = <T extends { project: { slug: string } }>(rows: T[]): T[] =>
    filter === undefined ? rows : rows.filter((r) => r.project.slug === filter)

  const allRuns = inScope(data?.runs ?? [])
  const pending = inScope(data?.pending ?? [])
  const runs = allRuns.filter(
    (r) =>
      matches(query, r.worker.name, r.project.slug, r.run.outcome, r.run.detail, r.run.notes) &&
      (outcome === 'all' || r.run.outcome === outcome),
  )
  const outcomes = [...new Set(allRuns.map((r) => r.run.outcome).filter(Boolean))].sort()

  /**
   * The words in the key, in the order a reader meets them: the states of the jobs still
   * waiting at the top of the page, then the outcomes of the runs below it. Built from
   * what is actually on screen — see `StatusKey` for why the key is not the whole
   * taxonomy.
   */
  const vocabulary = [
    ...new Set([
      ...pending.map((p) => p.job.state),
      // The same function the Outcome column renders, so the key explains the words that
      // are on screen rather than the ones the payload happens to carry.
      ...runs.map(statusOf),
    ]),
  ].filter((v): v is string => Boolean(v))

  return (
    <Page title="Runs" subtitle="Every execution attempt, including the ones that went nowhere.">
      <Filters count={runs.length} total={allRuns.length} noun="runs">
        <Search value={query} onChange={setQuery} placeholder="worker, outcome, detail…" />
        <Choice
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            ['all', 'any'],
            ...outcomes.map((o) => [o, o] as [string, string]),
          ]}
        />
      </Filters>

      {error && <p className="error">{String(error)}</p>}
      {isLoading && <Empty>loading…</Empty>}

      {/* The key for every status word on this page. Directly under the filter bar,
          because the control that offers "declined" as a filter is the place somebody
          first wonders what it means. */}
      {vocabulary.length > 0 && <StatusKey values={vocabulary} />}

      {/* A queued job has no run row. Without this, triggering a worker while nothing was
          online showed an empty page — the work existed and was invisible. */}
      {pending.length > 0 && (
        <>
          <h2>Waiting</h2>
          <table>
            <thead>
              <tr>
                <th>Queued</th>
                <th>Project</th>
                <th>Worker</th>
                <th>Needs</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <PendingRows key={p.job.id} job={p} />
              ))}
            </tbody>
          </table>
          {/*
            Three states, three different things to go and do — which is the reason the
            server stopped answering this with a boolean. "Start a runner", "wait, or
            wake that machine", and "label a machine, or delete the line" are not
            interchangeable, and one sentence covering all three sends two thirds of
            readers to the wrong place.
          */}
          {pending.some((p) => p.reach === 'unmatched') ? (
            <p className="error" style={{ fontSize: 13 }}>
              {data?.liveRunners === 0 ? (
                <>
                  No runner has joined yet, so nothing can claim these.{' '}
                  <Link to="/runners">Runners</Link> — or set one up with{' '}
                  <span className="mono">ogun runner init</span>.
                </>
              ) : (
                <>
                  No runner registered here advertises{' '}
                  <span className="mono">
                    {[...new Set(pending.flatMap((p) => p.missing))].join(', ')}
                  </span>
                  . Those jobs will wait indefinitely. See <Link to="/runners">Runners</Link> for
                  what each machine can do — a capability Ogun cannot detect is declared with{' '}
                  <span className="mono">ogun runner init --labels</span>.
                </>
              )}
            </p>
          ) : pending.some((p) => p.reach === 'offline') ? (
            <p className="muted" style={{ fontSize: 13 }}>
              A runner that could take these is registered but offline. They will be claimed
              when it comes back — <Link to="/runners">Runners</Link>.
            </p>
          ) : null}
          <Stranded pending={pending} />
          <h2>Finished</h2>
        </>
      )}

      {!isLoading && allRuns.length > 0 && runs.length === 0 && (
        <Empty>
          nothing matches
          <br />
          <span className="muted">{allRuns.length} runs in this scope — try a wider filter</span>
        </Empty>
      )}
      {!isLoading && allRuns.length === 0 && pending.length === 0 && (
        <Empty>
          no runs yet — trigger one from <Link to="/workers">Workers</Link>
        </Empty>
      )}
      {runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Project</th>
              <th>Worker</th>
              <th>Outcome</th>
              <th>Produced</th>
              <th>Took</th>
              <th>Tokens</th>
              <th>Commit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow key={r.run.id} run={r} />
            ))}
          </tbody>
        </table>
      )}
    </Page>
  )
}

function RunRow({ run: r }: { run: RunSummary }) {
  const rowNav = useRowNav()
  const status = statusOf(r)
  /**
   * An unfinished run, which is a different row from a finished one and used to be
   * indistinguishable from it — the pill said whatever the job happened to say, and every
   * other column was a dash.
   */
  const running = status === 'running'

  return (
    <tr {...rowNav(`/runs/${r.run.id}`)}>
      <td title={exact(r.run.startedAt)}>
        <Link to={`/runs/${r.run.id}`}>{when(r.run.startedAt)}</Link>
      </td>
      <td className="muted">{r.project.slug}</td>
      <td>{r.worker.name}</td>
      <td>
        {/* The same pulsing dot the run page uses for the same state. A pill reading
            `running` is a status word among seven other status words; the thing that
            makes an active run findable in a list of fifty is that it is the only row
            moving. */}
        {running ? <span className="live">running</span> : <Pill value={status} />}
      </td>
      <td className="muted">
        {/* The result, not just the status. What a run produced is what you
            are scanning the list for. */}
        <Result run={r} running={running} />
      </td>
      <td className="muted">
        {/* A run in flight has no `durationMs` — that column is written when it ends — so
            this said "—" for the whole of the only period anybody is watching the clock.
            Counted from the start instead, and marked as still counting. */}
        {running
          ? `${duration(Date.now() - new Date(r.run.startedAt).getTime())}…`
          : duration(r.run.durationMs)}
      </td>
      <td className="muted mono">
        {r.run.inputTokens || r.run.outputTokens
          ? `${fmt(r.run.inputTokens)} / ${fmt(r.run.outputTokens)}`
          : '—'}
      </td>
      <td className="muted mono">{r.run.repoSha?.slice(0, 7) ?? '—'}</td>
      <td className="chev-cell">
        <Chevron />
      </td>
    </tr>
  )
}

/** What the run produced, in one cell. One branch per outcome that has something to say. */
function Result({ run: r, running }: { run: RunSummary; running: boolean }) {
  const produced = r.produced
  const findings = produced?.findings ?? 0

  if (running) {
    /**
     * Nothing, and that is the honest answer rather than a gap. Findings, the patch and
     * the coverage row are one transaction written when the run reports (§5.1), so there
     * is genuinely nothing recorded for an unfinished run — which is not the same as a
     * run that looked and found nothing, and a blank cell reads like the latter.
     */
    return <span className="muted">nothing recorded yet</span>
  }

  if (r.run.outcome === 'dispatched') {
    /**
     * The pull request, in the list. It was on the run page and only there, so finding
     * which of last night's patches are waiting for a review meant opening each
     * `dispatched` run in turn.
     *
     * The unpublished case gets a sentence instead of a blank: a `changes` row with no
     * branch is a patch that exists and that nobody can see (§4.4), which is the row most
     * worth noticing and the one a missing link renders as nothing at all.
     */
    if (produced?.prUrl) {
      return (
        <a
          className="extlink"
          href={produced.prUrl}
          target="_blank"
          rel="noreferrer noopener"
          title={produced.prUrl}
        >
          {prLabel(produced.prUrl)}
        </a>
      )
    }
    if (produced?.branch) return <span className="mono">{produced.branch}</span>
    return (
      <span title="the publisher has not run, or refused — the patch is on the run page">
        patch, not published
      </span>
    )
  }

  if (r.run.outcome === 'approved') {
    return <>{findings > 0 ? `${findings} finding${findings === 1 ? '' : 's'}` : 'nothing found'}</>
  }
  if (r.run.outcome === 'changes-requested') return <>rejected by the gate</>
  if (r.run.outcome === 'error') return <>failed</>
  // The reason, not the word `declined` again — the pill beside it already says that, and
  // the sentence is the whole result of the run (§4.13). Truncated here; the run page
  // carries it whole.
  if (r.run.outcome === 'declined') return <>{truncate(r.run.detail ?? 'declined')}</>
  return <>—</>
}

/**
 * A waiting job, and the panel under it.
 *
 * Expanding in place rather than a `/jobs/:id` page, which was the other candidate. A
 * pending job has no run, so `/runs/:id` does not exist for it and inventing an id that
 * resolves to nothing would be the worst of the options. A job page would be honest — but
 * everything it could show is four fields and a dependency list that is already on this
 * row's own payload, so it would be a route, a query, a loading state and a 404 path in
 * exchange for a page with less on it than this panel. If a job ever grows a history of
 * its own — admission decisions, claim attempts, retries — that is the point at which it
 * earns a page.
 *
 * Two `<tr>`s rather than a nested table so the panel spans the row without inheriting
 * the column widths, which is what makes a sentence legible inside a nine-column grid.
 */
function PendingRows({ job: p }: { job: PendingJob }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <tr
        className="rowlink"
        onClick={(e) => {
          // Same reasoning as `useRowNav`: a click belonging to a control inside the row
          // is not a click on the row, and a click that ends a selection is a copy.
          if ((e.target as HTMLElement).closest('a, button')) return
          if ((window.getSelection()?.toString() ?? '') !== '') return
          setOpen(!open)
        }}
      >
        <td className="muted" title={exact(p.job.createdAt)}>
          {when(p.job.createdAt)}
        </td>
        <td className="muted">{p.project.slug}</td>
        <td>{p.worker.name}</td>
        <td>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {p.requires.map((r) => (
              <span key={r} className="pill">
                {r}
              </span>
            ))}
          </div>
        </td>
        <td>
          <Waiting job={p} />
        </td>
        <td className="chev-cell">
          {/* A real button, so this is reachable and announced without the row having to
              become a widget. The row-wide click above is the enhancement; this is the
              control. */}
          <button
            type="button"
            className="chev-button"
            aria-expanded={open}
            aria-label={`${open ? 'hide' : 'show'} what ${p.worker.name} is waiting for`}
            onClick={() => setOpen(!open)}
          >
            <Chevron open={open} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="panel-row">
          <td colSpan={6}>
            <div className="card">
              <dl className="kv">
                <dt>Cycle</dt>
                <dd>
                  {p.cycle.name} · node <span className="mono">{p.job.nodeKey}</span>
                </dd>
                <dt>Needs</dt>
                <dd className="muted">
                  {/* The labels, spelled out rather than as pills, because this is the
                      place the sentence about them makes sense. */}
                  {p.requires.length > 0
                    ? `a runner advertising ${p.requires.join(', ')}`
                    : 'nothing in particular — any runner can take it'}
                  {p.reach === 'unmatched' && (
                    <>
                      {' · '}
                      <span className="error">
                        no registered runner advertises {p.missing.join(', ')}
                      </span>
                    </>
                  )}
                  {p.reach === 'offline' && ' · the machine that can is offline'}
                </dd>
                <dt>Depends on</dt>
                <dd>
                  {p.dependencies.length === 0 ? (
                    <span className="muted">nothing — it is an entry node of its cycle</span>
                  ) : (
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      {p.dependencies.map((d) => (
                        <span key={d.nodeKey} className="row" style={{ gap: 5 }}>
                          <span className="mono">{d.nodeKey}</span>
                          {d.state === null ? (
                            // Nothing in this cycle run carries that node key. Said out
                            // loud rather than rendered as a blank, because the only way
                            // it happens is an edge pointing at a node that is gone.
                            <span className="pill red" title="no job in this cycle run has that node key">
                              no job
                            </span>
                          ) : (
                            <Pill value={d.state} />
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </dd>
                <dt>Job</dt>
                <dd className="muted mono">{p.job.id}</dd>
              </dl>
              {stranded(p) && (
                <p className="note" style={{ marginTop: 12, fontSize: 13 }}>
                  Every dependency has finished, and this job is still <strong>blocked</strong>.
                  A job is released — or marked <strong>skipped</strong>, when a dependency
                  did not succeed — by the pass that runs as each dependency ends, and there
                  is no dependency left to end. The control plane reconciles cycles in this
                  state on a one-minute timer, so this normally clears itself; a row that is
                  still here well after that is one nothing is coming for.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** `plan (skipped), review (running)` — the node keys, each with what became of it. */
const named = (deps: JobDependency[]): string =>
  deps.map((d) => `${d.nodeKey} (${d.state ?? 'no job'})`).join(', ')

/**
 * A job still `blocked` behind dependencies that have all gone terminal.
 *
 * `releasePass` queues such a job, or skips it when a dependency did not succeed, and it
 * runs as each dependency ends. A job still blocked once they all have is one no further
 * ending will reach — `reconcileStalledCycles` is what picks it up, on a timer, and until
 * it does the row is waiting on nothing. Worth separating for exactly the reason `reach`
 * is three answers and not a boolean: "it is running" and "nothing is coming unless the
 * reconciler gets here" are not the same instruction, and both read as
 * "waiting on a dependency".
 */
const stranded = (p: PendingJob): boolean =>
  p.job.state === 'blocked' &&
  p.dependencies.length > 0 &&
  p.dependencies.every((d) => d.terminal)

/** Why this job has not started, in the one cell the queue table has for it. */
function Waiting({ job: p }: { job: PendingJob }) {
  if (p.job.state === 'blocked') {
    const unfinished = p.dependencies.filter((d) => !d.terminal)
    /**
     * Which node, and what became of it. This said `waiting on a dependency` — a pill
     * that names neither, on the one page where the question is "waiting on *what*". The
     * data was already a join away: `jobs.depends_on` holds the node keys and the sibling
     * jobs of the same cycle run hold the states.
     */
    // One template string rather than JSX interpolation, deliberately: React renders
    // `waiting on {x}` as two text nodes with a comment between them, which makes the
    // pill a string the page can no longer be searched or asserted for as written.
    if (unfinished.length > 0) {
      return <span className="pill">{`waiting on ${named(unfinished)}`}</span>
    }
    if (p.dependencies.length > 0) {
      return (
        <span
          className="pill yellow"
          title="these have all finished, so no job ending will release or skip this one — the control plane reconciles cycles in this state on a one-minute timer"
        >
          {`waiting on ${named(p.dependencies)} — already finished`}
        </span>
      )
    }
    // `blocked` with an empty `depends_on`. `startCycleRun` only writes that state for a
    // node with incoming edges, so this is not reachable through it — and a pill claiming
    // a dependency it cannot name would be a lie rather than a gap.
    return (
      <span className="pill yellow" title="this job records no dependencies at all">
        blocked, and names nothing
      </span>
    )
  }
  if (p.reach === 'claimable') return <span className="pill blue">waiting for a runner</span>
  if (p.reach === 'offline') {
    // A machine that can run this exists and is not up. It resolves itself the moment
    // that machine comes back, so it is not the red one — calling it "nothing can run
    // this" is how the red one stops being believed.
    return (
      <span className="pill yellow" title="a runner advertising all of these is registered but offline">
        its runner is offline
      </span>
    )
  }
  // The difference that matters: this one will never be picked up, by anything, until a
  // machine advertising those labels joins.
  return (
    <span className="pill red" title={`no runner registered here advertises: ${p.missing.join(', ')}`}>
      {`nothing advertises ${p.missing.join(', ')}`}
    </span>
  )
}

/**
 * The footnote for the stranded jobs, in the same place and the same voice as the three
 * `reach` sentences above it.
 *
 * Per-row the state is a pill; in aggregate it is a different fact — eleven jobs held by
 * dependencies that finished is not eleven rows being slow, it is a sweep that is not
 * running, and that is a sentence nobody reads off eleven pills.
 */
function Stranded({ pending }: { pending: PendingJob[] }) {
  const stuck = pending.filter(stranded)
  if (stuck.length === 0) return null
  return (
    <p className="muted" style={{ fontSize: 13 }}>
      {stuck.length === 1 ? 'One job is' : `${stuck.length} jobs are`} still{' '}
      <strong>blocked</strong> behind dependencies that have already finished, so no job
      ending will release {stuck.length === 1 ? 'it' : 'them'}. The control plane
      reconciles cycle runs in that state once a minute;{' '}
      {stuck.length === 1 ? 'a row' : 'rows'} still here after that{' '}
      {stuck.length === 1 ? 'is' : 'are'} waiting for nothing. Open{' '}
      {stuck.length === 1 ? 'the row' : 'a row'} for which node, and what became of it.
    </p>
  )
}

const fmt = (n: number | null): string =>
  n === null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
