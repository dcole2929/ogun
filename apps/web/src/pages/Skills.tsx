import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { api } from '../api.ts'
import { Choice, Empty, Filters, matches, Page, Pill, Search } from '../ui.tsx'
import { Markdown } from '../Markdown.tsx'
import { useProjectScope } from '../scope.tsx'

/**
 * A skill is the durable artifact; a worker is a thin binding of one to a runtime
 * (principle 2). Listing them with their bindings is the useful part — a skill nothing
 * points at never runs, and that is invisible if you show the two lists separately.
 */
export function SkillsPage() {
  const { filter, isAll } = useProjectScope()
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState('all')
  const [bound, setBound] = useState('all')

  const { data, isLoading } = useQuery({
    queryKey: ['skills', filter ?? 'all'],
    queryFn: () => api.skills(filter),
  })
  const all = data?.skills ?? []

  /**
   * A built-in is indexed once per project, so with the scope on "All projects" the same
   * skill legitimately appears once per project it is registered for. That is the row the
   * scope exists to collapse — selecting a project is what makes this list read as "the
   * skills this project has" rather than as a list with duplicates in it.
   */
  const skills = all.filter(
    (s) =>
      matches(
        query,
        s.skill.name,
        s.skill.displayName,
        s.skill.shortDescription,
        s.skill.sourcePath,
        s.workers.map((w) => w.name).join(' '),
      ) &&
      (origin === 'all' || s.skill.origin === origin) &&
      (bound === 'all' ||
        (bound === 'bound' ? s.workers.length > 0 : s.workers.length === 0)),
  )

  const origins = [...new Set(all.map((s) => s.skill.origin))].sort()

  return (
    <Page
      title="Skills"
      subtitle="The instructions a worker runs. Edited in the repo, indexed here."
    >
      <Filters count={skills.length} total={all.length} noun="skills">
        <Search value={query} onChange={setQuery} placeholder="name, description, path, worker…" />
        <Choice
          label="Origin"
          value={origin}
          onChange={setOrigin}
          options={[['all', 'any'], ...origins.map((o) => [o, o] as [string, string])]}
        />
        <Choice
          label="Bound"
          value={bound}
          onChange={setBound}
          options={[
            ['all', 'any'],
            ['bound', 'used by a worker'],
            ['unbound', 'used by nothing'],
          ]}
        />
      </Filters>

      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && all.length > 0 && skills.length === 0 && (
        <Empty>
          nothing matches
          <br />
          <span className="muted">{all.length} skills are indexed — try a wider filter</span>
        </Empty>
      )}
      {!isLoading && all.length === 0 && (
        <Empty>
          no skills indexed
          <br />
          <span className="muted">
            Put one at <span className="mono">.agents/skills/&lt;name&gt;/SKILL.md</span> and run{' '}
            <span className="mono">ogun project sync</span>
          </span>
        </Empty>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        {skills.map((s) => (
          <Link
            key={s.skill.id}
            to={`/skills/${s.project?.slug ?? ''}/${s.skill.name}`}
            className="card"
          >
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ marginBottom: 3 }}>
                  <strong>{s.skill.displayName ?? s.skill.name}</strong>
                  <span className="pill">{s.skill.origin}</span>
                  {s.skill.allowImplicitInvocation && (
                    <span className="pill yellow" title="an agent may reach for this mid-task">
                      implicit
                    </span>
                  )}
                </div>
                <div className="mono muted">
                  {isAll && s.project?.slug && (
                    <span className="pill" style={{ marginRight: 6 }}>
                      {s.project.slug}
                    </span>
                  )}
                  {s.skill.sourcePath}
                </div>
                {s.skill.shortDescription && (
                  <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
                    {s.skill.shortDescription}
                  </p>
                )}
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {s.workers.length === 0 ? (
                  // Worth flagging: it exists, it is indexed, and nothing will ever run it.
                  <span className="pill yellow">no worker uses this</span>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {s.workers.map((w) => w.name).join(', ')}
                  </span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </Page>
  )
}

export function SkillDetailPage() {
  const { project = '', name = '' } = useParams()
  const { data, error } = useQuery({
    queryKey: ['skill', project, name],
    queryFn: () => api.skill(project, name),
  })

  if (error) return <p className="error">{String(error)}</p>
  if (!data) return <Empty>loading…</Empty>
  const s = data.skill

  return (
    <Page
      title={s.displayName ?? s.name}
      subtitle={s.shortDescription ?? undefined}
      actions={<Link to="/skills">← all skills</Link>}
    >
      <div className="card" style={{ marginBottom: 20 }}>
        <dl className="kv">
          <dt>Source</dt>
          <dd className="mono">{s.sourcePath}</dd>
          <dt>Version</dt>
          <dd className="mono muted">{s.versionHash}</dd>
          <dt>Default prompt</dt>
          <dd className="mono">{s.defaultPrompt ?? <span className="muted">none</span>}</dd>
          <dt>Implicit use</dt>
          <dd>
            {s.allowImplicitInvocation ? (
              <span className="pill yellow">an agent may reach for this mid-task</span>
            ) : (
              <span className="muted">runs only when Ogun says so</span>
            )}
          </dd>
          {s.referencePaths.length > 0 && (
            <>
              <dt>References</dt>
              <dd className="mono muted">
                {s.referencePaths.map((r) => (
                  <div key={r}>{r}</div>
                ))}
              </dd>
            </>
          )}
          <dt>Used by</dt>
          <dd>
            {data.workers.length === 0 ? (
              <span className="pill yellow">nothing — this skill never runs</span>
            ) : (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {data.workers.map((w) => (
                  <Link key={w.id} to="/workers" className="pill">
                    {w.enabled ? '● ' : '○ '}
                    {w.name} · {w.runtime}
                  </Link>
                ))}
              </div>
            )}
          </dd>
        </dl>
      </div>

      <h2>SKILL.md</h2>
      {s.body ? (
        <div className="card">
          <Markdown source={s.body} />
        </div>
      ) : (
        <Empty>
          not indexed — run <span className="mono">ogun project sync</span>
        </Empty>
      )}
    </Page>
  )
}

export { Pill }
