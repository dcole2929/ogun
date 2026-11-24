import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { api, type LinearApp, type LinearOauth, type SystemInfo } from '../api.ts'
import { Empty, Page, when } from '../ui.tsx'

/**
 * What this control plane is, and what the machine running it can actually do.
 *
 * Everything here was CLI-only — `ogun runner doctor`, `ogun token show`, the checkout
 * map. The browser is where you notice something is wrong (nothing running, a job stuck
 * queued), so it is where the reason should be legible.
 *
 * Scoped to *this* host on purpose. Runners connect outward and are not addressable, so
 * the control plane cannot probe them; the Runners page shows what each advertises.
 */
export function SettingsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['system'], queryFn: api.system })

  if (error) return <p className="error">{String(error)}</p>
  if (isLoading || !data) return <Empty>loading…</Empty>

  const { controlPlane, host, checkouts, projectSecrets } = data
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(controlPlane.bind)

  return (
    <Page title="Settings" subtitle="This control plane, and what the machine running it can do.">
      <h2>Control plane</h2>
      <div className="card">
        <dl className="kv">
          <dt>Listening on</dt>
          <dd className="mono">
            {controlPlane.bind}:{controlPlane.port}
            {localOnly && <span className="muted"> · this machine only</span>}
          </dd>

          <dt>Access</dt>
          <dd>
            {controlPlane.tokenRequired ? (
              <span className="pill green">token required</span>
            ) : (
              <>
                <span className="pill">open</span>
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  no token needed — nothing off this machine can reach it
                </span>
              </>
            )}
          </dd>

          {!localOnly && (
            <>
              <dt>Reachable at</dt>
              <dd className="mono muted">
                {controlPlane.addresses.length === 0 ? '—' : controlPlane.addresses.join('  ')}
              </dd>
            </>
          )}

          <dt>Config</dt>
          <dd className="mono muted">{controlPlane.configPath}</dd>
        </dl>

        {controlPlane.reachabilityWarning && (
          <>
            <p className="error" style={{ fontSize: 13, marginBottom: 4 }}>
              Another machine cannot reach this address.
            </p>
            <pre className="md-code" style={{ fontSize: 11 }}>
              {controlPlane.reachabilityWarning}
            </pre>
          </>
        )}

        {localOnly && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            To let another machine run jobs, restart with{' '}
            <span className="mono">OGUN_BIND=0.0.0.0</span>. A token is generated then —
            you never create one.
          </p>
        )}
      </div>

      {controlPlane.tokenRequired && <AdminToken />}

      <h2>This machine</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          What the control-plane host has installed. A job needing something absent is
          never claimed here — it waits for a runner that has it.
        </p>
        <dl className="kv">
          <Tool label="claude" value={host.claude} credentials={host.claudeCredentials} />
          <Tool label="codex" value={host.codex} credentials={host.codexCredentials} />
          <Tool label="docker" value={host.docker} />
          <Tool label="git" value={host.git} />

          <dt>ogun/base image</dt>
          <dd>
            {host.baseImage ? (
              <span className="pill green">built</span>
            ) : (
              <>
                <span className="pill red">missing</span>
                <span className="mono muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  ogun image build
                </span>
              </>
            )}
          </dd>

          <dt>Runs jobs</dt>
          <dd>
            {host.isRunner ? (
              <>
                <span className="pill green">yes</span>
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  as <span className="mono">{host.runnerName}</span>
                </span>
              </>
            ) : (
              <>
                <span className="pill yellow">no</span>
                <span className="mono muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  ogun runner init
                </span>
              </>
            )}
          </dd>
        </dl>
      </div>

      <h2>Local checkouts</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Where this machine has repositories on disk. Optional — a project with no entry
          is cloned from its remote. A checkout makes runs faster, works offline, and lets
          this control plane edit that project's{' '}
          <span className="mono">.ogun/config.yaml</span>.
        </p>
        {checkouts.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            None. Run <span className="mono">ogun project add .</span> inside a repository.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Path</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {checkouts.map((p) => (
                <tr key={p.slug}>
                  <td>{p.slug}</td>
                  <td className="mono muted">{p.path}</td>
                  <td>
                    {p.present ? (
                      <span className="pill green">ok</span>
                    ) : (
                      <span className="pill red" title="not a git repository">
                        missing
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Applications</h2>
      <Applications />

      <h2>Linear</h2>
      <LinearConnection />

      <h2>GitHub</h2>
      <GithubConnection />

      <h2>Project secrets</h2>
      <ProjectSecrets secrets={projectSecrets} writes={data.projectSecretWrites} />

      <h2>Adding a machine</h2>
      <div className="card">
        <p style={{ marginTop: 0, fontSize: 13 }}>
          Runners connect outward, so adding one means minting a token here and running one
          command there. <Link to="/runners">Runners</Link> does it.
        </p>
      </div>
    </Page>
  )
}

/**
 * Which projects have an API key on the control-plane machine, and — when the transport
 * can carry one — a field to set or replace it.
 *
 * ### The field is write-only, and that is the whole design
 *
 * A stored value is never fetched, so there is nothing to populate an input with: the
 * server's listing type has no field a value fits in (ADR-0012), and this page could not
 * render one if it wanted to. That rule predates the form and the form does not weaken it,
 * because the argument behind it is untouched — *a page that renders a secret is a secret
 * in a screenshot*, and a screenshot of this card shows a project, a name, and a row of
 * dots that were never anybody's key.
 *
 * So "already set" is shown as a state and a warning, never as a masked value. An input
 * pre-filled with eight bullets to represent an existing key would be the ordinary way to
 * build this and it is exactly wrong: it puts the value in the DOM, in the page's memory,
 * and in whatever a browser extension or a session recorder can read, in exchange for a
 * reassurance the pill already gives.
 *
 * ### What is deliberately not here
 *
 * No reveal, on the row or anywhere else — unlike the admin token above, which has one.
 * The difference is who the credential belongs to: the admin token is this machine's, it
 * is generated rather than typed, and an operator locked out of the UI on another device
 * has no other way to see it. A Linear key belongs to a workspace, its owner has it
 * already, and Linear's own settings page is where you look at it.
 *
 * The value is not passed as a mutation variable either. `useMutation` keeps `variables`
 * on the observer after the call settles, so a key sent as one would sit in React state
 * and in any devtools inspecting it long after the field was cleared — the containment
 * loss that `Secret` exists to stop on the server side, wearing a browser's clothes. The
 * mutation closes over the field instead, and the field is cleared on success.
 */
function ProjectSecrets({
  secrets,
  writes,
}: {
  secrets: SystemInfo['projectSecrets']
  writes: SystemInfo['projectSecretWrites']
}) {
  const qc = useQueryClient()
  // Only for the form: the table renders slugs the store already holds, which needs no
  // lookup and must keep working for a project that has since been removed.
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    enabled: writes.allowed,
  })
  const [project, setProject] = useState('')
  const [name, setName] = useState(writes.names[0] ?? 'linear')
  const [value, setValue] = useState('')
  const [stored, setStored] = useState<{ project: string; name: string; characters: number } | null>(
    null,
  )
  const [confirming, setConfirming] = useState<string | null>(null)

  const store = useMutation({
    mutationFn: () => api.setProjectSecret(project, name, value),
    onSuccess: (result) => {
      // Cleared first. Everything after this line is presentation, and the field should
      // not still hold the key while any of it runs.
      setValue('')
      setStored({ project, name, characters: result.characters })
      void qc.invalidateQueries({ queryKey: ['system'] })
    },
  })

  const remove = useMutation({
    mutationFn: (row: { project: string; name: string }) =>
      api.removeProjectSecret(row.project, row.name),
    onSuccess: () => {
      setConfirming(null)
      void qc.invalidateQueries({ queryKey: ['system'] })
    },
  })

  const existing = secrets.find((s) => s.project === project && s.name === name)
  const ready = project !== '' && value.trim() !== ''

  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        API keys a project needs that this machine did not already have. A Linear key is
        issued per workspace, so — unlike the credentials above — nobody&rsquo;s home
        directory has one. Stored in <span className="mono">~/.ogun/config.json</span> on
        the control-plane machine, never in the repository and never in the database.
      </p>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        For Linear this is the <em>fallback</em>. A personal key makes everything Ogun does
        appear as you — and once write-back lands, every comment it posts carries your name
        on a board other people make decisions from. Connecting an application above is
        preferred and, since it needs nobody&rsquo;s approval, is no longer harder. A
        project that connects has any key stored here removed with it; one that was left
        behind by an older build is shown below as not being used.
      </p>

      {secrets.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          None stored. Which projects need one is declared in each repository, so this list
          cannot say what is missing — only what is here.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Secret</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => {
              const key = `${s.project}/${s.name}`
              return (
                <tr key={key}>
                  <td>{s.project}</td>
                  <td className="mono">{s.name}</td>
                  <td>
                    {s.state === 'present' ? (
                      <span className="pill green">set</span>
                    ) : (
                      <span
                        className="pill red"
                        title="stored but blank — a poller reads this as a key that exists and does not work"
                      >
                        empty
                      </span>
                    )}
                  </td>
                  <td>
                    {/* Removal carries no value, so it is offered whatever the transport
                        is — and for any name, including one a hand-edit of config.json
                        put there. A row you can see has to be a row you can remove. */}
                    {confirming === key ? (
                      <span className="row">
                        <span className="muted" style={{ fontSize: 12 }}>
                          the next poll authenticates with nothing — sure?
                        </span>
                        <button
                          className="danger"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ project: s.project, name: s.name })}
                        >
                          Remove
                        </button>
                        <button onClick={() => setConfirming(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="danger" onClick={() => setConfirming(key)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {remove.error && <p className="error">{String(remove.error)}</p>}

      {writes.allowed ? (
        <>
          <div className="form" style={{ marginTop: 14 }}>
            <label>
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">choose…</option>
                {(projects.data?.projects ?? []).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
              <small className="muted">
                A key filed under a slug nothing polls is read by nothing, so the server
                refuses a project it does not know.
              </small>
            </label>

            <label>
              <span>Secret</span>
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {writes.names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <small className="muted">
                The names Ogun reads. One is added when the code that reads it lands.
              </small>
            </label>

            <label className="wide">
              <span>Key</span>
              {/*
                Never populated, and there is nothing to populate it with. type=password so
                a shared screen and a screenshot show dots; autoComplete off so a browser
                does not offer to keep it; spellCheck off so it is not sent anywhere to be
                checked.
              */}
              <input
                type="password"
                value={value}
                autoComplete="off"
                spellCheck={false}
                placeholder="paste the key"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && ready && !store.isPending && store.mutate()}
              />
              <small className={existing ? 'error' : 'muted'}>
                {existing
                  ? `${project} already has a ${name} key. Storing replaces it — there is no ` +
                    'history, and the next poll uses the new one with no restart.'
                  : 'Sent once, in the request body, and never returned. Setting it again is ' +
                    'how a key is rotated.'}
              </small>
            </label>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="primary"
              disabled={!ready || store.isPending}
              onClick={() => store.mutate()}
            >
              {store.isPending ? 'storing…' : existing ? 'Replace' : 'Store'}
            </button>
            {/* Only while the form still points at what was stored. A confirmation that
                outlives the selection it describes is one an operator reads as applying to
                the project now in the dropdown. */}
            {stored && stored.project === project && stored.name === name && (
              <span className="muted" style={{ fontSize: 12 }}>
                {/* The length and nothing else — the same answer the CLI gives. It catches
                    a truncated paste and narrows a random key by nothing. */}
                {stored.name} set for {stored.project} ({stored.characters} characters)
              </span>
            )}
          </div>
          {store.error && <p className="error">{String(store.error)}</p>}
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 4 }}>
            {/* Not a disabled field: an input you can type into and not submit collects the
                key anyway, which is the one thing this refusal is preventing. */}
            {writes.reason}
          </p>
          {/* Every input in the line, including the one that is not an argument. A usage
              line that reads as complete and is not is how an operator who had to SSH into
              a machine ends up at a hung terminal. --project rather than the directory
              default, because the control plane that refused this write is the one least
              likely to have the repo checked out on it. */}
          <pre className="md-code" style={{ fontSize: 11, marginBottom: 0 }}>
            ogun connect {writes.names[0] ?? 'linear'} --api-key &lt;key&gt; --project
            &lt;slug&gt;
          </pre>
          <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
            Leave &lt;key&gt; off and it prompts with the echo off, or pipe it on stdin.
            Passing it inline works and warns: argv is readable through{' '}
            <span className="mono">/proc</span> while the command runs, and your shell
            writes the whole line to its history.
          </p>
        </>
      )}
    </div>
  )
}

function Tool({
  label,
  value,
  credentials,
}: {
  label: string
  value: string | null
  credentials?: boolean
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ? (
          <>
            <span className="pill green">{value}</span>
            {/* A binary with no credentials authenticates nowhere, which fails at the
                first API call rather than at startup. */}
            {credentials === false && (
              <span className="pill yellow" style={{ marginLeft: 6 }}>
                not logged in
              </span>
            )}
          </>
        ) : (
          <span className="pill red">not installed</span>
        )}
      </dd>
    </>
  )
}

function AdminToken() {
  const [revealed, setRevealed] = useState(false)
  const [rotated, setRotated] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const token = useQuery({
    queryKey: ['adminToken'],
    queryFn: api.adminToken,
    enabled: revealed,
    // Never cached: it is a secret, and a stale one in memory is a secret with no owner.
    gcTime: 0,
    staleTime: 0,
  })

  const rotate = useMutation({
    mutationFn: api.rotateToken,
    onSuccess: (d) => {
      setRotated(d.token)
      setConfirming(false)
    },
  })

  return (
    <>
      <h2>Admin token</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Needed to unlock this UI from another device, or to run the CLI from one. It can
          define workers — which is to say define what runs on this machine — so runners
          get their own separate credential instead.
        </p>

        {rotated ? (
          <>
            <pre className="md-code">{rotated}</pre>
            <p className="error" style={{ fontSize: 13, marginBottom: 0 }}>
              Restart the server for this to take effect. Every browser session and every
              exported <span className="mono">OGUN_ADMIN_TOKEN</span> stops working. Runner
              tokens are unaffected — they are separate credentials.
            </p>
          </>
        ) : revealed ? (
          <>
            {token.isLoading && <p className="muted">…</p>}
            {token.data?.token && <pre className="md-code">{token.data.token}</pre>}
            {token.data?.fromEnvironment && (
              <p className="muted" style={{ fontSize: 12 }}>
                Supplied by <span className="mono">OGUN_ADMIN_TOKEN</span>, so it cannot be
                rotated here — change the environment instead.
              </p>
            )}
            <button onClick={() => setRevealed(false)}>Hide</button>
          </>
        ) : (
          <div className="row">
            <button onClick={() => setRevealed(true)}>Reveal</button>
            {confirming ? (
              <>
                <span className="muted" style={{ fontSize: 12 }}>
                  this signs out every session — sure?
                </span>
                <button className="danger" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
                  Rotate
                </button>
                <button onClick={() => setConfirming(false)}>Cancel</button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirming(true)}>
                Rotate
              </button>
            )}
          </div>
        )}
        {rotate.error && <p className="error">{String(rotate.error)}</p>}
      </div>
    </>
  )
}

/**
 * Connecting a project to Linear as an application (ADR-0014).
 *
 * ### What this card is actually for
 *
 * The failure this feature has is not "the operator could not find the button". It is a
 * **redirect URI mismatch**: they register the application in Linear with a callback URL
 * that differs from the one this control plane will receive on — by a port, a trailing
 * slash, `localhost` versus a LAN address — and Linear's refusal names nothing useful. So
 * the first thing on this card is the exact string to paste, generated by the server that
 * will receive the callback, with a copy button. Everything else is secondary.
 *
 * ### Honest status, which means saying more than "connected"
 *
 * A green pill answers the wrong question. What an operator needs to know is *which
 * workspace* Ogun is acting in, *as whom*, with *which scopes*, and *how long the token
 * has* — because the whole reason for this flow rather than a personal key is that the
 * answers are "the app", not "you". A card that hid them would have removed the evidence
 * the feature exists to produce.
 *
 * The one that costs an evening if it is missing is the **shadowed API key**: a project
 * that has connected and still has a personal key stored authenticates with the grant, and
 * an operator debugging a poll by rotating that key is changing something nothing reads.
 * It is stated in red beside the row.
 *
 * ### What is deliberately not here
 *
 * No token, no expiry countdown built from a token, and no reveal. There is nothing to
 * reveal: `LinearApp` has no field a credential fits in, so this component could not
 * render one if it wanted to (the same rule the secrets card is built on).
 *
 * The client secret field is write-only for the same reason the API key field is, and the
 * value is not passed as a mutation variable — `useMutation` keeps `variables` on the
 * observer after the call settles, so a secret sent as one sits in React state long after
 * the field is cleared. The mutation closes over the field, and the field is cleared first
 * on success.
 */
/**
 * Every registered application, and who goes through each.
 *
 * The page had no notion of one. A credential shared by three projects rendered as three
 * credentials — which is what the store itself used to do, holding a separate copy of the
 * same client secret per project, with nothing keeping them in agreement. One GitHub App
 * serves a whole organisation, so sharing is the normal case rather than the exception,
 * and "rotate this and three projects change" is a fact the page has to be able to state.
 *
 * Read-only, deliberately. Registering an application means pasting a client secret or a
 * private key, and `ogun connect` already asks for those with the echo off, proves them by
 * spending them before storing anything, and names what it displaced. A second write path
 * through a browser would be a second place for that reasoning to live, and the weaker of
 * the two.
 */
/**
 * "Use this application for another project too" — `ogun connect <p> --link <name>`.
 *
 * Shows nothing when every project already connects through this application, because an
 * empty picker beside a full list is a control that can only disappoint. The link itself
 * carries no credential: the name of something already stored is not a secret, and the
 * values it names never leave the machine holding them.
 */
function LinkProject({
  application,
  provider,
  usedBy,
  projects,
  onLinked,
}: {
  application: string
  provider: string
  usedBy: string[]
  projects: string[]
  onLinked: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const available = projects.filter((p) => !usedBy.includes(p))
  /**
   * `picked ?? available[0]`, never `useState(available[0])`. The projects query resolves
   * after the first render, so state initialised from it freezes at the empty value while
   * the `<select>` displays its first option — a form that looks ready and refuses to
   * submit, which is the exact bug the GitHub App form shipped with.
   */
  const project = picked ?? available[0] ?? ''

  const link = useMutation({
    mutationFn: () => api.linkApplication(provider, project, application),
    onSuccess: () => {
      setPicked(null)
      onLinked()
    },
  })

  if (available.length === 0) return null

  return (
    <div className="link-project">
      <select
        value={project}
        onChange={(e) => setPicked(e.target.value)}
        disabled={link.isPending}
      >
        {available.map((slug) => (
          <option key={slug} value={slug}>
            {slug}
          </option>
        ))}
      </select>
      <button onClick={() => link.mutate()} disabled={link.isPending || project === ''}>
        {link.isPending ? 'linking…' : 'Link a project'}
      </button>
      {/**
       * The refusal worth rendering: a Linear connection made through consent cannot be
       * relinked as client-credentials, because that reaches public teams only. The
       * server says so in a sentence and this shows it rather than a status code.
       */}
      {link.error ? <p className="error">{String(link.error)}</p> : null}
    </div>
  )
}

function Applications() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: api.applications,
  })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

  if (isLoading) return <div className="card">loading…</div>
  const rows = data?.applications ?? []

  if (rows.length === 0) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No application is registered on this machine. One is what lets Ogun act as
          itself rather than as you — <span className="mono">ogun connect &lt;integration&gt; --app</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Application</th>
            <th>Provider</th>
            <th>Identifies as</th>
            <th>Used by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.name}>
              <td className="mono">{a.name}</td>
              <td className="muted">
                {a.provider ?? '—'}
                {a.method ? <span className="muted"> · {a.method}</span> : null}
              </td>
              <td className="mono muted">{a.identifiesAs ?? '—'}</td>
              <td>
                {/**
                 * The point of the table. An application nothing uses is a credential
                 * sitting on disk for no reason, and one used by four projects is four
                 * things that change when it is rotated — neither was visible before.
                 */}
                {a.malformed !== null ? (
                  <span className="pill red" title={a.malformed}>
                    unreadable
                  </span>
                ) : a.usedBy.length === 0 ? (
                  <span className="muted">nothing — no project connects through it</span>
                ) : (
                  a.usedBy.join(', ')
                )}
                {/**
                 * The way back in. `disconnect` takes a project's row off this page, and
                 * without this the only route to reconnecting it is re-entering the
                 * application's credentials — which for a GitHub App nobody can do,
                 * because the private key is shown once at generation and never again.
                 *
                 * On the row rather than in the provider cards because this is where the
                 * question is already answered: the column beside it says which projects
                 * use this application, so "and this one too" belongs next to the list it
                 * extends.
                 */}
                {a.malformed === null && a.provider !== null ? (
                  <LinkProject
                    application={a.name}
                    provider={a.provider}
                    usedBy={a.usedBy}
                    projects={projects.data?.projects.map((p) => p.slug) ?? []}
                    onLinked={() => {
                      void qc.invalidateQueries({ queryKey: ['applications'] })
                      void qc.invalidateQueries({ queryKey: ['githubConnections'] })
                      void qc.invalidateQueries({ queryKey: ['linearOauth'] })
                    }}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * GitHub, which is an App rather than a consent flow.
 *
 * Deliberately not a mirror of the Linear card. That one is about a browser round trip —
 * a callback URL to paste, a redirect to approve — and GitHub's App has none of that: it
 * is registered on github.com, installed on an account, and authenticates by signing a
 * JWT with a private key it holds. The card's job is to say who Ogun is acting as and to
 * get somebody to the two places that do the work.
 *
 * No form, and that is the same decision the applications table makes. The credential is
 * a private key with push access to an organisation; `ogun connect github --app` takes it
 * with the echo off, proves it by minting a token before anything is stored, and names
 * every project it displaces. A textarea in a browser would be a second path to the same
 * store with none of that, and the weaker of the two.
 */
function GithubConnection() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['githubConnections'],
    queryFn: api.githubConnections,
  })
  const system = useQuery({ queryKey: ['system'], queryFn: api.system })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

  if (isLoading || !data) return <div className="card">loading…</div>
  const { connections } = data
  const writes = system.data?.projectSecretWrites

  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        An App gives Ogun an identity of its own. A personal access token authenticates{' '}
        <em>as you</em>, so its pull requests are yours, it cannot request changes on them —
        GitHub refuses a review of your own pull request — and the loop guard that stops
        Ogun acting on its own comments cannot tell your words from its own.
      </p>

      {connections.length === 0 ? (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            Nothing on this machine is connected to GitHub. Three steps, and only the last
            one is Ogun&rsquo;s:
          </p>
          <ol className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
            <li>
              Register an App at{' '}
              <a className="extlink" href={data.registerUrl} target="_blank" rel="noreferrer">
                github.com/settings/apps/new
              </a>
              {' '}— or under an organisation, which is where it belongs if the repositories
              are. Turn the webhook <strong>off</strong>: Ogun polls, because a control
              plane behind NAT has no address an inbound hook could reach.
            </li>
            <li>
              Give it <strong>Pull requests: read &amp; write</strong> and{' '}
              <strong>Contents: read &amp; write</strong>, and nothing else. Install it on
              the account, choosing <strong>All repositories</strong> if you would rather
              not repeat this per repo.
            </li>
            <li>
              Hand Ogun the three values. The private key is a file, so it is a path here
              rather than a paste:
              <pre className="cmd-block">
                ogun connect github --app appId=… installationId=… privateKey=./key.pem
              </pre>
            </li>
          </ol>
        </>
      ) : null}

      <GithubAppForm
        projects={(projects.data?.projects ?? []).map((p) => p.slug)}
        writes={writes}
        onConnected={() => void qc.invalidateQueries({ queryKey: ['githubConnections'] })}
      />

      {connections.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Acts as</th>
              <th>Application</th>
              <th>Token</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((g) => (
              <tr key={`${g.project}:${g.application}`}>
                <td>{g.project}</td>
                <td className="mono">
                  {/**
                   * The question this card exists to answer. `ogun[bot]` means the App is
                   * doing the work; anything else means a credential is standing in for it
                   * and the attribution, the review state and the loop guard are all a
                   * person's rather than Ogun's.
                   */}
                  {g.actor.endsWith('[bot]') ? (
                    g.actor
                  ) : (
                    <span className="pill yellow" title="not an App identity">
                      {g.actor}
                    </span>
                  )}
                </td>
                <td className="mono muted">
                  {g.application}
                  {g.account ? <span className="muted"> · {g.account}</span> : null}
                </td>
                <td className="muted">
                  {g.malformed !== undefined ? (
                    <span className="pill red" title={g.malformed}>
                      unreadable
                    </span>
                  ) : g.expiresAt === undefined ? (
                    '—'
                  ) : (
                    /* An installation token lasts an hour and renews before use, so a
                       past expiry here is ordinary rather than a fault. */
                    when(new Date(g.expiresAt).toISOString())
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

/**
 * The three values that make an App, from a browser.
 *
 * A **file picker as well as a textarea**, and the picker is the one that matters: the
 * private key arrives as a `.pem` you downloaded, so the honest gesture is to hand over
 * that file rather than to select 1,700 characters of it in a text editor. Paste stays
 * for the case where the key lives in a password manager and never touched the disk.
 *
 * The file is read in the browser and sent as text; nothing is uploaded, because there is
 * no upload endpoint and a multipart body would be a second shape for the one route to
 * parse.
 *
 * `appId` and `installationId` are plain inputs rather than password fields. Neither is a
 * secret — both are on the App's settings page and in every JWT Ogun signs — and masking
 * them would mean an operator could not check what they pasted, which is the mistake the
 * CLI's `--client-id` note already records.
 */
function GithubAppForm({
  projects,
  writes,
  onConnected,
}: {
  projects: string[]
  writes: SystemInfo['projectSecretWrites'] | undefined
  onConnected: () => void
}) {
  /**
   * Derived, not initialised — `useState(projects[0] ?? '')` runs once, and `projects`
   * arrives from a query that had not resolved yet.
   *
   * The failure is invisible, which is why it shipped: a `<select value="">` whose options
   * have no empty value *displays the first one*, so the control showed a project while
   * the state behind it was still `''`. Everything looked filled, Connect stayed disabled,
   * and nothing on screen said which field was unsatisfied.
   *
   * `picked` is null until somebody chooses, so the default follows the data instead of
   * freezing whatever happened to be there on the first render.
   */
  const [picked, setPicked] = useState<string | null>(null)
  const project = picked ?? projects[0] ?? ''
  const [appId, setAppId] = useState('')
  const [installationId, setInstallationId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)

  const connect = useMutation({
    mutationFn: () => api.connectGithubApp(project, { appId, installationId, privateKey }),
    onSuccess: () => {
      // Cleared on success and not before: a failed attempt keeps what was typed, because
      // retyping an app id to fix a key is how somebody gives up on a form.
      setAppId('')
      setInstallationId('')
      setPrivateKey('')
      setFileName(null)
      onConnected()
    },
  })

  /**
   * The same refusal the project-secret form shows, for the same reason: a private key
   * with push access to an organisation must not cross a connection that is not carrying
   * it privately. The CLI is unaffected — it writes the file and never opens a socket.
   */
  if (writes && !writes.allowed) {
    return (
      <p className="muted" style={{ fontSize: 12 }}>
        {writes.reason} Connect from the control-plane machine instead:
        <pre className="cmd-block">
          ogun connect github --app appId=… installationId=… privateKey=./key.pem
        </pre>
      </p>
    )
  }

  const ready = project !== '' && appId.trim() !== '' && installationId.trim() !== '' &&
    privateKey.trim() !== ''

  return (
    <div className="form" style={{ marginTop: 14 }}>
      <label>
        <span>Project</span>
        <select value={project} onChange={(e) => setPicked(e.target.value)}>
          {projects.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
        <small>One App can serve several — connect each, or link them with the CLI.</small>
      </label>
      <label>
        <span>App ID</span>
        <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} />
        <small>On the App&rsquo;s settings page. Not a secret.</small>
      </label>
      <label>
        <span>Installation ID</span>
        <input
          type="text"
          value={installationId}
          onChange={(e) => setInstallationId(e.target.value)}
        />
        <small>
          The number at the end of the URL after you install it:{' '}
          <span className="mono">/settings/installations/<strong>12345678</strong></span>
        </small>
      </label>
      <label className="wide">
        <span>Private key</span>
        <input
          type="file"
          accept=".pem,application/x-pem-file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setFileName(file.name)
            void file.text().then(setPrivateKey)
          }}
        />
        <textarea
          rows={4}
          value={privateKey}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          onChange={(e) => {
            setPrivateKey(e.target.value)
            setFileName(null)
          }}
        />
        <small>
          {fileName === null
            ? 'Choose the .pem you downloaded, or paste it. It is sent once and never shown again.'
            : `${fileName} — read in this browser, not uploaded.`}
        </small>
      </label>

      <div className="row wide" style={{ marginTop: 4 }}>
        <button
          className="primary"
          disabled={!ready || connect.isPending}
          onClick={() => connect.mutate()}
        >
          {connect.isPending ? 'minting a token…' : 'Connect'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {/* Said before the click, because "it stored nothing" after a failure reads as a
              bug unless somebody already knew that was the rule. */}
          proved by minting an installation token — nothing is stored if that fails
        </span>
      </div>
      {connect.error && (
        <p className="error wide" style={{ fontSize: 13 }}>
          {String(connect.error)}
        </p>
      )}
      {connect.data && (
        <p className="wide" style={{ fontSize: 13 }}>
          Connected as <span className="mono">{connect.data.connected.login}</span> on{' '}
          <span className="mono">{connect.data.connected.account}</span>.
        </p>
      )}
    </div>
  )
}

function LinearConnection() {
  const qc = useQueryClient()
  const [search, setSearch] = useSearchParams()
  const oauth = useQuery({ queryKey: ['linearOauth'], queryFn: api.linearOauth })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

  const [project, setProject] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  /**
   * The default: register and take a token in one request, with no browser anywhere in it.
   *
   * Called with credentials from the form, and with none at all from the table's Connect
   * button — where the application is already registered on the control-plane machine and
   * asking somebody to paste a client secret they already gave us would be how a trailing
   * space gets into a credential.
   */
  const connectApp = useMutation({
    mutationFn: (input: { project: string; credentials?: { clientId: string; clientSecret: string } }) =>
      api.connectLinear(input.project, input.credentials),
    onSuccess: () => {
      // Cleared first. Everything after this line is presentation, and the field must not
      // still hold the secret while any of it runs.
      setClientSecret('')
      setClientId('')
      void qc.invalidateQueries({ queryKey: ['linearOauth'] })
    },
  })

  /**
   * The consent flow: register the application, then navigate to Linear's consent screen.
   *
   * Two requests because it genuinely is two acts — the second one leaves this page. It is
   * the secondary button rather than the primary one because it needs a workspace admin and
   * reaches nothing the default cannot, *unless* the teams being polled are private, which
   * is the sentence beside it.
   */
  const consent = useMutation({
    mutationFn: async (input: {
      project: string
      credentials?: { clientId: string; clientSecret: string }
    }) => {
      if (input.credentials) {
        await api.setLinearApp(input.project, input.credentials.clientId, input.credentials.clientSecret)
      }
      return api.startLinearConnect(input.project)
    },
    onSuccess: (result) => {
      setClientSecret('')
      setClientId('')
      /**
       * A full navigation rather than a new tab. `window.open` is what a popup blocker
       * eats, and the flow ends with Linear redirecting back to this same origin — so a
       * tab would leave the operator looking at a stale copy of this page in the one they
       * started from, wondering why nothing changed.
       */
      window.location.assign(result.authorizeUrl)
    },
  })

  const disconnect = useMutation({
    mutationFn: (slug: string) => api.disconnectLinear(slug),
    onSuccess: () => {
      setConfirming(null)
      void qc.invalidateQueries({ queryKey: ['linearOauth'] })
    },
  })

  if (oauth.isLoading || !oauth.data) return <div className="card">loading…</div>
  const data = oauth.data
  const outcome = search.get('linear')

  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        The preferred way to authenticate. A personal API key makes everything Ogun does
        appear as <em>you</em> on a board other people read; an application acts as itself.
        Ogun ships no client id — it is self-hosted, so each workspace registers its own at{' '}
        <a href={data.registerUrl} target="_blank" rel="noreferrer">
          linear.app/settings/api/applications/new
        </a>
        .
      </p>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        <strong>Connect</strong> asks Linear for a token in Ogun&rsquo;s own name — no
        browser, no consent screen, nobody to approve it. That token reaches the
        workspace&rsquo;s <strong>public teams only</strong>.{' '}
        <strong>Connect with consent</strong> sends you to Linear to approve an install
        instead, which is what reaches <strong>private teams</strong> and needs a workspace
        admin.
      </p>

      {/* The result of a redirect back from Linear. A reason code, mapped to a sentence
          here, because the redirect deliberately carries no message: a URL is a place text
          gets copied out of, and part of that text would have come from an upstream error. */}
      {outcome && (
        <p className={outcome === 'connected' ? 'muted' : 'error'} style={{ fontSize: 13 }}>
          {connectOutcome(outcome, search.get('project'), data)}{' '}
          <button
            onClick={() => {
              const next = new URLSearchParams(search)
              next.delete('linear')
              next.delete('project')
              setSearch(next, { replace: true })
            }}
          >
            dismiss
          </button>
        </p>
      )}

      <dl className="kv">
        <dt>Redirect callback URL</dt>
        <dd>
          {/* The single most important string on this page. Rendered as text with a copy
              button rather than left for someone to retype: Linear matches it exactly, and
              a mismatch is the classic failure of this flow. */}
          <span className="mono">{data.redirectUri}</span>{' '}
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(data.redirectUri)
              setCopied(true)
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            <strong>Only needed for the consent flow.</strong> Paste it into{' '}
            <span className="mono">Redirect callback URLs</span> at{' '}
            <a href={data.registerUrl} target="_blank" rel="noreferrer">
              linear.app/settings/api/applications/new
            </a>
            . Linear matches it exactly — scheme, host, port and trailing slash — and its
            error for a mismatch does not say so. The plain Connect button has no browser
            round trip, so it has no redirect URI at all.
          </div>
        </dd>

        <dt>Asking for</dt>
        <dd>
          <span className="mono">{data.scopes.join(', ')}</span>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            as <span className="mono">actor={data.actor}</span> — implicit on the plain
            Connect, and a workspace-level install on the consent flow, where Linear needs a
            workspace admin to approve it. Write scopes are added when the code that needs
            them lands, not before.
          </span>
        </dd>
      </dl>

      {data.apps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Workspace</th>
              <th>Acting as</th>
              <th>How</th>
              <th>Scopes</th>
              <th>Token</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.apps.map((app) => (
              <tr key={app.project}>
                <td>{app.project}</td>
                <td className="muted">{app.workspace?.name ?? '—'}</td>
                <td>
                  {app.actor === 'app' ? (
                    <span className="pill green">the app</span>
                  ) : app.actor === 'user' ? (
                    // Worth a warning rather than a neutral label: the grant came back as
                    // a user actor, so writes will be attributed to a person — which is
                    // the exact thing connecting was meant to avoid.
                    <span className="pill yellow" title="writes would appear under your name">
                      you
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                {/* Which grant, because the two differ in what they can SEE. A row that
                    says "connected" and nothing else cannot explain a source that polls
                    successfully and finds no tickets in a workspace of private teams. */}
                <td className="muted" style={{ fontSize: 12 }}>
                  {app.grantType === 'client_credentials' ? (
                    <span title="reaches the workspace's public teams only">
                      app token
                    </span>
                  ) : app.grantType === 'authorization_code' ? (
                    <span title="reaches whatever the approver could see">by consent</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="mono muted">{app.scopes.join(' ') || '—'}</td>
                <td>{tokenState(app)}</td>
                <td>
                  {confirming === app.project ? (
                    <span className="row">
                      {/* Says what goes, because the default now takes the client id and
                          secret with it: under the app-token grant those two ARE the
                          credential, so leaving them would be a disconnection the next
                          poll undoes. */}
                      <span className="muted" style={{ fontSize: 12 }}>
                        every credential for this project goes, client id and secret
                        included — the next poll authenticates with nothing. Sure?
                      </span>
                      <button
                        className="danger"
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate(app.project)}
                      >
                        Disconnect
                      </button>
                      <button onClick={() => setConfirming(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button className="danger" onClick={() => setConfirming(app.project)}>
                      Disconnect
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {connectApp.error && <p className="error">{String(connectApp.error)}</p>}
      {consent.error && <p className="error">{String(consent.error)}</p>}
      {disconnect.error && <p className="error">{String(disconnect.error)}</p>}

      {data.writesAllowed ? (
        <>
          <div className="form" style={{ marginTop: 14 }}>
            <label>
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">choose…</option>
                {(projects.data?.projects ?? []).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Client ID</span>
              {/* Visible, unlike the secret beside it. A client id is in every
                  authorization URL a browser visits and on Linear's own settings page;
                  hiding it would only stop you checking you pasted the right one. */}
              <input
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                placeholder="from the application you created"
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
            <label className="wide">
              <span>Client secret</span>
              <input
                type="password"
                value={clientSecret}
                autoComplete="off"
                spellCheck={false}
                placeholder="paste the client secret"
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <small className="muted">
                Never returned, never rendered. Storing it again rotates it — an existing
                connection survives a new secret and does not survive a new client id,
                because tokens minted by a different application are dead.
              </small>
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="primary"
              disabled={
                project === '' ||
                clientId.trim() === '' ||
                clientSecret.trim() === '' ||
                connectApp.isPending
              }
              onClick={() =>
                connectApp.mutate({ project, credentials: { clientId, clientSecret } })
              }
            >
              {connectApp.isPending ? 'connecting…' : 'Connect'}
            </button>
            <button
              disabled={
                project === '' ||
                clientId.trim() === '' ||
                clientSecret.trim() === '' ||
                consent.isPending
              }
              onClick={() =>
                consent.mutate({ project, credentials: { clientId, clientSecret } })
              }
            >
              {consent.isPending ? 'starting…' : 'Connect with consent'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
            Connecting removes any personal API key stored for this project: a grant wins
            over a key, so leaving one would leave a credential nothing reads.
          </p>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12, marginTop: 14, marginBottom: 4 }}>
            {/* Not a disabled field: an input you can type into and not submit collects the
                secret anyway, which is the one thing this refusal prevents. The client
                secret is gated exactly like an API key — same function, same reason. */}
            This control plane will not accept a client secret over this transport. The CLI
            writes it to this machine directly and sends nothing anywhere.
          </p>
          {/* The usage line names every input, including the ones that are not arguments —
              which is the whole reason an operator being sent to a terminal should not be
              surprised when they get there. --project rather than the directory default,
              because the control plane that refused this write is the one least likely to
              have the repo checked out on it. */}
          <pre className="md-code" style={{ fontSize: 11, marginBottom: 0 }}>
            ogun connect linear --client-id &lt;id&gt; --client-secret &lt;secret&gt; --project
            &lt;slug&gt;
          </pre>
          <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
            Named flags rather than two positionals: both values are opaque strings from the
            same page, so a fixed order between them is a coin flip. Leave either flag off
            and it prompts — the Client ID visibly, the Client Secret with the echo off.
            Passing the secret inline works and warns, because argv is readable through{' '}
            <span className="mono">/proc</span> and your shell writes it to history.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * How long the access token has, in the same words `ogun runner doctor` uses.
 *
 * Green through `expired`, which looks wrong and is not: the next poll renews it from a
 * refresh token Ogun owns. Colouring that red would train an operator to act on the one
 * state that needs no action — and the gateway's Anthropic line is red for the opposite
 * reason, because nothing renews that one.
 */
function tokenState(app: LinearApp) {
  if (app.malformed !== undefined) {
    return (
      <span className="pill red" title={app.malformed}>
        unreadable
      </span>
    )
  }
  /**
   * There is no "registered but not connected" state any more, so there is no pill for it.
   *
   * It was reachable while an application could be written before anything proved it: you
   * registered, and a row sat unconnected until somebody finished the authorization.
   * Nothing unproven reaches the store now — the credentials wait in memory and the
   * application is written together with the grant — so a project either has a grant and
   * appears here, or has neither and does not appear at all.
   */
  const left = app.expiresAt === undefined ? null : app.expiresAt - Date.now()
  return (
    <span className="pill green" title="renewed by the poll that needs it">
      {left === null ? 'connected' : left > 0 ? `${humanLeft(left)} left` : 'renews next poll'}
    </span>
  )
}

const humanLeft = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(ms / 36e5)
  return hours < 48 ? `${hours}h` : `${Math.round(ms / 864e5)}d`
}

/**
 * A reason code from the callback, turned into a sentence here.
 *
 * The redirect carries a code and not a message on purpose (`routes/oauth.ts` has the
 * argument): a message in a URL is a message in a history entry and a screenshot, and part
 * of this one would have been written by Linear out of the parameters we sent them. The
 * detail is fetched from the server, where it was kept, and shown beside the sentence.
 *
 * `denied` says both of its meanings. Under `actor=app` the install is workspace-level, so
 * "not granted" is very often "the account approving it is not a workspace admin" rather
 * than a decision — and an operator who reads only the first meaning goes looking for a
 * button that was never there.
 */
function connectOutcome(result: string, project: string | null, data: LinearOauth): string {
  const detail = project ? data.failures[project]?.detail : undefined
  const suffix = detail ? ` — ${detail}` : ''
  switch (result) {
    case 'connected':
      return `Connected${project ? ` ${project}` : ''} to Linear.`
    case 'state':
      return (
        'That callback did not match an authorization this control plane started, so ' +
        'nothing was exchanged and nothing was stored. Start the connection again.'
      )
    case 'denied':
      return (
        'Linear reported that the authorization was not granted. Because Ogun installs ' +
        'as an application, this is a workspace-level install — so it also happens when ' +
        `the account approving it is not a workspace admin.${suffix}`
      )
    case 'config':
      return `Linear refused the application's configuration.${suffix}`
    case 'invalid-grant':
      return `Linear refused the authorization code.${suffix}`
    case 'no-app':
      return `That project no longer has a Linear application registered.${suffix}`
    default:
      return `The connection did not complete.${suffix}`
  }
}
