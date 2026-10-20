import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import {
  api,
  type CycleOption,
  type LinearOptions,
  type SourceConditions,
  type SourceReport,
} from '../api.ts'
import { Choice, Empty, exact, Filters, matches, Page, Pill, Search, when } from '../ui.tsx'
import { TokenPicker, type Suggestion } from '../TokenPicker.tsx'
import { useProjectScope } from '../scope.tsx'

/**
 * Sources — the thing that turns tickets into work, and until now the only part of
 * config.yaml with no surface at all.
 *
 * Coverage shows whether a source is healthy, which answers "is it working". It cannot
 * answer "what is it looking for", and it certainly cannot change it: every adjustment
 * to a poll interval or a status list meant editing yaml on the machine holding the
 * repo and running `ogun project sync`. That is the right story for a worker, which is
 * a durable definition somebody reviews in a diff. It is the wrong one for the question
 * a source actually gets asked — *why has this not picked up my ticket* — which is
 * answered by looking at the conditions beside the ticket that failed them.
 */

/**
 * The conditions in one line, for a reader rather than an editor.
 *
 * Shared with Coverage, which renders the same sentence under a source's health — the
 * two have to agree, and a second rendering of the same rule is how they stop agreeing.
 */
export function ConditionSummary({ conditions }: { conditions: SourceConditions }) {
  const { label } = conditions
  return (
    <span className="muted">
      team <strong>{conditions.team.join(', ')}</strong>
      {' · status '}
      <strong>{conditions.status.join(', ')}</strong>
      {label.all_of.length > 0 && <> · all of {label.all_of.join(' + ')}</>}
      {label.any_of.length > 0 && <> · any of {label.any_of.join(', ')}</>}
      {label.none_of.length > 0 && <> · none of {label.none_of.join(', ')}</>}
      {conditions.notBlocked && <> · not blocked</>}
    </span>
  )
}

export function SourcesPage() {
  const { projects, slug: scope, isAll } = useProjectScope()
  const [query, setQuery] = useState('')
  const [state, setState] = useState('all')

  const shown = isAll ? projects : projects.filter((p) => p.slug === scope)

  return (
    <Page
      title="Sources"
      subtitle="What turns a ticket into work: a team, a filter, and how often to look. Defined in .ogun/config.yaml."
    >
      <Filters>
        <Search value={query} onChange={setQuery} placeholder="name, team, cycle, label…" />
        <Choice
          label="State"
          value={state}
          onChange={setState}
          options={[
            ['all', 'any'],
            ['enabled', 'enabled'],
            ['disabled', 'disabled'],
          ]}
        />
      </Filters>

      {projects.length === 0 && (
        <Empty>
          no projects registered
          <br />
          <span className="muted mono">ogun project sync</span>
        </Empty>
      )}
      {shown.map((p) => (
        <ProjectSources
          key={p.id}
          slug={p.slug}
          heading={isAll}
          query={query}
          state={state}
        />
      ))}
    </Page>
  )
}

function ProjectSources({
  slug,
  heading,
  query,
  state,
}: {
  slug: string
  heading: boolean
  query: string
  state: string
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['sources', slug],
    queryFn: () => api.sources(slug),
  })

  const all = data?.sources ?? []
  const sources = all.filter(
    (s) =>
      matches(
        query,
        s.name,
        s.cycle,
        s.team.join(' '),
        s.conditions?.status.join(' '),
        [
          ...(s.conditions?.label.all_of ?? []),
          ...(s.conditions?.label.any_of ?? []),
          ...(s.conditions?.label.none_of ?? []),
        ].join(' '),
      ) && (state === 'all' || (state === 'enabled') === s.enabled),
  )

  if (isLoading) return <Empty>loading…</Empty>
  if (all.length === 0 && heading) return null

  return (
    <>
      {heading && (
        <div className="scope-section">
          <h2>{slug}</h2>
        </div>
      )}

      {all.length === 0 && (
        <Empty>
          no sources
          <br />
          <span className="muted">
            A <span className="mono">sources:</span> block in{' '}
            <span className="mono">.ogun/config.yaml</span> points a Linear team at a cycle.
            Nothing here can create one yet — it needs the credential too, which is{' '}
            <Link to="/settings">Settings</Link>.
          </span>
        </Empty>
      )}

      {all.length > 0 && sources.length === 0 && (
        <Empty>nothing matches the filters above</Empty>
      )}

      {sources.map((source) =>
        editing === source.name ? (
          <SourceForm
            key={source.name}
            slug={slug}
            source={source}
            onDone={() => setEditing(null)}
          />
        ) : (
          <SourceCard
            key={source.name}
            source={source}
            onEdit={() => setEditing(source.name)}
          />
        ),
      )}
    </>
  )
}

function SourceCard({ source, onEdit }: { source: SourceReport; onEdit: () => void }) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <strong>{source.name}</strong>
            <Pill value={source.health.state} />
            {!source.enabled && <span className="pill">disabled</span>}
          </div>
          {source.conditions ? (
            <p style={{ margin: '0 0 4px', fontSize: 13 }}>
              <ConditionSummary conditions={source.conditions} />
            </p>
          ) : (
            <p className="error" style={{ margin: '0 0 4px', fontSize: 13 }}>
              Its stored config is not a shape this build can read, so the poller skips it.
            </p>
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            → <span className="mono">{source.cycle}</span> · every {source.pollMinutes}m ·
            at most {source.maxPerPoll} per poll
            {source.health.lastPolledAt && (
              <>
                {' · last looked '}
                <span title={exact(source.health.lastPolledAt)}>
                  {when(source.health.lastPolledAt)}
                </span>
              </>
            )}
          </div>
          {source.health.detail && (
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              {source.health.detail}
            </p>
          )}
        </div>
        <button onClick={onEdit}>Edit</button>
      </div>
    </div>
  )
}

/**
 * The editor. Writes `.ogun/config.yaml` and reindexes, so what it saves is what the
 * next poll reads — there is no second copy to drift.
 */
/**
 * The order statuses are offered in, which is not the order Linear returns them.
 *
 * Linear's `workflowStates` comes back in whatever order the workspace stores them —
 * "In Review" first, "Todo" sixth, in the workspace this was built against. A source
 * almost always gates on something not yet started, so those go at the top, and the
 * terminal states go last where they are still reachable but not adjacent to the ones
 * somebody meant to pick. `type` is Linear's fixed vocabulary, so this list is complete
 * rather than a prefix; anything unrecognised sorts to the end rather than disappearing.
 */
const STATE_ORDER = ['triage', 'unstarted', 'backlog', 'started', 'completed', 'canceled', 'duplicate']

const STATE_GROUP: Record<string, string> = {
  triage: 'triage',
  unstarted: 'not started',
  backlog: 'backlog',
  started: 'in progress',
  completed: 'done',
  canceled: 'cancelled',
  duplicate: 'duplicate',
}

/**
 * Statuses as suggestions, narrowed to the teams the source names.
 *
 * A workflow state belongs to a team, so a source scoped to EXC should not be offered
 * HEI's columns — it would admit nothing and the picker would have helped somebody write
 * a condition that cannot match. With no teams chosen yet, everything is offered, because
 * the alternative is an empty dropdown on a fresh source.
 *
 * Deduplicated by name, which is what the rule matches on: two teams with a column called
 * `Todo` are one suggestion, not two identical rows.
 */
export const stateSuggestions = (options: LinearOptions | undefined, teams: string[]): Suggestion[] => {
  if (!options) return []
  const wanted = new Set(teams.map((t) => t.toUpperCase()))
  const states = options.states.filter(
    (s) => wanted.size === 0 || wanted.has(s.team.toUpperCase()),
  )
  const seen = new Map<string, Suggestion & { rank: number }>()
  for (const state of states) {
    const key = state.name.toLowerCase()
    if (seen.has(key)) continue
    const rank = STATE_ORDER.indexOf(state.type)
    seen.set(key, {
      value: state.name,
      group: STATE_GROUP[state.type] ?? state.type,
      rank: rank === -1 ? STATE_ORDER.length : rank,
    })
  }
  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank || a.value.localeCompare(b.value))
    .map(({ rank: _rank, ...rest }) => rest)
}

export const labelSuggestions = (options: LinearOptions | undefined): Suggestion[] =>
  (options?.labels ?? [])
    .map((l) => ({ value: l.name, ...(l.team ? { hint: l.team } : {}) }))
    .sort((a, b) => a.value.localeCompare(b.value))

/**
 * Which cycle an admitted ticket starts.
 *
 * A `<select>` rather than the picker above, because this is one value and because the
 * list is *local* — it comes from the same config.yaml being edited, so it is as
 * authoritative as anything here gets. The server refuses an unknown cycle with a 400,
 * which is the right answer: unlike a status, a cycle cannot be created by typing it.
 *
 * The escape hatch is still there, and it earns its place in one case — a cycle added to
 * the file since the last `ogun project sync`, which the index does not know about yet.
 * The current value is always an option even when the list has never heard of it, so
 * opening the editor on such a source and saving something else cannot silently rewrite
 * the cycle to whatever happened to be first.
 *
 * Workers are in their own group because every worker is a one-node cycle (§5.1) and
 * pointing a source straight at one is the smallest useful configuration — but a list
 * that mixes them with real graphs under one heading reads as twice as many pipelines as
 * the project has.
 */
function CycleField({
  value,
  onChange,
  cycles,
}: {
  value: string
  onChange: (next: string) => void
  cycles: CycleOption[] | undefined
}) {
  const [typing, setTyping] = useState(false)
  const graphs = (cycles ?? []).filter((c) => !c.standalone)
  const workers = (cycles ?? []).filter((c) => c.standalone)
  const known = (cycles ?? []).some((c) => c.name === value)

  if (typing || !cycles) {
    return (
      <label>
        <span>Cycle</span>
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} />
        <small>
          {cycles ? (
            <>
              Typed, not picked.{' '}
              <button type="button" className="linklike" onClick={() => setTyping(false)}>
                choose from the list
              </button>{' '}
              instead. The server refuses a cycle this project does not have.
            </>
          ) : (
            'Loading this project’s cycles…'
          )}
        </small>
      </label>
    )
  }

  return (
    <label>
      <span>Cycle</span>
      <select
        value={value}
        onChange={(e) => {
          // The empty string is the sentinel because the schema is `min(1)`, so no
          // cycle can be called it — unlike any readable marker, which one could.
          if (e.target.value === '') setTyping(true)
          else onChange(e.target.value)
        }}
      >
        {!known && <option value={value}>{value} — not in this project</option>}
        {graphs.length > 0 && (
          <optgroup label="Cycles">
            {graphs.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        {workers.length > 0 && (
          <optgroup label="Workers — each is a one-node cycle">
            {workers.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value="">Type a name…</option>
      </select>
      <small>
        The cycle each admitted ticket starts — scope it, then plan it, and so on. A
        worker’s own name works too.
      </small>
    </label>
  )
}

function SourceForm({
  slug,
  source,
  onDone,
}: {
  slug: string
  source: SourceReport
  onDone: () => void
}) {
  const qc = useQueryClient()
  const c = source.conditions
  const [cycle, setCycle] = useState(source.cycle)
  const [pollMinutes, setPollMinutes] = useState(String(source.pollMinutes))
  const [maxPerPoll, setMaxPerPoll] = useState(String(source.maxPerPoll))
  const [maxPages, setMaxPages] = useState(String(source.maxPages))
  const [enabled, setEnabled] = useState(source.enabled)
  const [team, setTeam] = useState<string[]>(c?.team ?? [])
  const [status, setStatus] = useState<string[]>(c?.status ?? [])
  const [allOf, setAllOf] = useState<string[]>(c?.label.all_of ?? [])
  const [anyOf, setAnyOf] = useState<string[]>(c?.label.any_of ?? [])
  const [noneOf, setNoneOf] = useState<string[]>(c?.label.none_of ?? [])
  const [notBlocked, setNotBlocked] = useState(c?.notBlocked ?? true)

  /**
   * Fetched when the editor opens, not when the page loads. This is the only outbound
   * Linear call the UI can cause, and it spends from the same hourly budget the poller
   * does — so it happens for somebody who is about to type a status, and not for somebody
   * scrolling a list.
   *
   * `retry: false` because every failure already arrives as a 200 with a reason. A retry
   * would re-ask a question that was answered, three times, while a person waits.
   */
  const { data: options } = useQuery({
    queryKey: ['linear-options', slug],
    queryFn: () => api.linearOptions(slug),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const { data: cycleData } = useQuery({
    queryKey: ['cycles', slug],
    queryFn: () => api.cycles(slug),
    staleTime: 5 * 60_000,
  })

  const reachable = options?.reachable ?? false
  const teamSuggestions = useMemo(
    (): Suggestion[] => (options?.teams ?? []).map((t) => ({ value: t.key, hint: t.name })),
    [options],
  )
  const statusSuggestions = useMemo(
    () => stateSuggestions(options, team),
    [options, team],
  )
  const labels = useMemo(() => labelSuggestions(options), [options])

  const save = useMutation({
    mutationFn: () =>
      api.saveSource(slug, source.name, {
        cycle,
        pollMinutes: Number(pollMinutes),
        maxPerPoll: Number(maxPerPoll),
        maxPages: Number(maxPages),
        enabled,
        conditions: {
          team,
          status,
          label: { all_of: allOf, any_of: anyOf, none_of: noneOf },
          notBlocked,
        },
      }),
    onSuccess: async () => {
      // Everything the index feeds may have moved: the source row, its health, the
      // coverage ledger that reads it.
      await qc.invalidateQueries()
      onDone()
    },
  })

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="spread" style={{ marginBottom: 12 }}>
        <strong>{source.name}</strong>
        <label className="row" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          enabled
        </label>
      </div>

      {options && !options.reachable && (
        /**
         * Said once, at the top, rather than under each of the five pickers. The reason is
         * the same for all of them and repeating it five times would bury the fields.
         */
        <p className="note" style={{ marginBottom: 12 }}>
          <strong>No suggestions.</strong> {options.reason} — every field below still takes
          a typed value.
        </p>
      )}

      <div className="form">
        <CycleField value={cycle} onChange={setCycle} cycles={cycleData?.cycles} />
        <label>
          <span>Poll every (minutes)</span>
          <input
            type="text"
            value={pollMinutes}
            onChange={(e) => setPollMinutes(e.target.value)}
          />
          <small>A poll asks what matches now, so a missed one is not a missed occurrence.</small>
        </label>

        <TokenPicker
          wide
          label="Teams"
          values={team}
          onChange={setTeam}
          suggestions={teamSuggestions}
          reachable={reachable}
          placeholder="pick a team, or type its key"
          hint={
            <>
              Any of them matches. This is also what the poll asks Linear for, so it bounds
              what is read — and it narrows the statuses offered below.
            </>
          }
        />

        <TokenPicker
          wide
          label="Statuses"
          values={status}
          onChange={setStatus}
          suggestions={statusSuggestions}
          reachable={reachable}
          placeholder="pick a status, or type one"
          hint={
            <>
              Matched ignoring case, against the column name your team chose. Required — a
              source with none fires on the whole team.
            </>
          }
        />

        <TokenPicker
          label="Labels — all of"
          values={allOf}
          onChange={setAllOf}
          suggestions={labels}
          reachable={reachable}
          placeholder="pick or type a label"
          hint="Every one must be present."
        />
        <TokenPicker
          label="Labels — any of"
          values={anyOf}
          onChange={setAnyOf}
          suggestions={labels}
          reachable={reachable}
          placeholder="pick or type a label"
          hint="At least one must be present. Empty means not asked."
        />
        <TokenPicker
          label="Labels — none of"
          values={noneOf}
          onChange={setNoneOf}
          suggestions={labels}
          reachable={reachable}
          placeholder="pick or type a label"
          hint="Any of these excludes the ticket."
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={notBlocked}
            onChange={(e) => setNotBlocked(e.target.checked)}
          />
          <span>Skip tickets with an unresolved blocker</span>
        </label>

        <label>
          <span>Max per poll</span>
          <input type="text" value={maxPerPoll} onChange={(e) => setMaxPerPoll(e.target.value)} />
          <small>
            The runaway bound. What it trims is not lost — the next poll takes the next few.
          </small>
        </label>
        <label>
          <span>Max pages</span>
          <input type="text" value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />
          <small>50 issues each, newest first. A team that outgrows this says so on the poll.</small>
        </label>
      </div>

      {save.error && <p className="error" style={{ fontSize: 13 }}>{String(save.error)}</p>}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button disabled={save.isPending} onClick={onDone}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          writes <span className="mono">.ogun/config.yaml</span>
        </span>
      </div>
    </div>
  )
}
