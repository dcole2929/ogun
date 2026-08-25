import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { api, type LinearApp, type LinearOauth, type SystemInfo } from '../api.ts'
import { Empty, Page } from '../ui.tsx'

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

      <h2>Linear</h2>
      <LinearConnection />

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
        For Linear this is now the <em>fallback</em>. A personal key makes everything Ogun
        does appear as you, so connecting an application above is preferred — and a project
        that has connected ignores any key stored here. The key stays supported for a
        workspace where you are not an admin, since installing an application needs one.
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
          {/* The whole command, redirection included. `ogun secret set linear` on its own
              reads as complete and is not — the key arrives on stdin, and an operator who
              copies a line that does not say so gets a hung terminal at a machine they had
              to SSH into. --project rather than the directory default, because the control
              plane that refused this write is the one least likely to have the repo on it. */}
          <pre className="md-code" style={{ fontSize: 11, marginBottom: 0 }}>
            ogun secret set {writes.names[0] ?? 'linear'} --project &lt;slug&gt; &lt; key.txt
          </pre>
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

  const register = useMutation({
    mutationFn: () => api.setLinearApp(project, clientId, clientSecret),
    onSuccess: () => {
      // Cleared first. Everything after this line is presentation, and the field must not
      // still hold the secret while any of it runs.
      setClientSecret('')
      setClientId('')
      void qc.invalidateQueries({ queryKey: ['linearOauth'] })
    },
  })

  const connect = useMutation({
    mutationFn: (slug: string) => api.startLinearConnect(slug),
    onSuccess: (result) => {
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
    mutationFn: (input: { project: string; forgetApp: boolean }) =>
      api.disconnectLinear(input.project, input.forgetApp),
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
        Ogun ships no client id — it is self-hosted, so each workspace registers its own.
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
            Paste this into <span className="mono">Redirect callback URLs</span> at{' '}
            <a href={data.registerUrl} target="_blank" rel="noreferrer">
              linear.app/settings/api/applications/new
            </a>
            . Linear matches it exactly — scheme, host, port and trailing slash — and its
            error for a mismatch does not say so.
          </div>
        </dd>

        <dt>Asking for</dt>
        <dd>
          <span className="mono">{data.scopes.join(', ')}</span>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            as <span className="mono">actor={data.actor}</span> — a workspace-level install,
            so Linear needs a workspace admin to approve it. If you are not one, a personal
            key below still works.
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
                <td className="mono muted">{app.scopes.join(' ') || '—'}</td>
                <td>{tokenState(app)}</td>
                <td>
                  {confirming === app.project ? (
                    <span className="row">
                      <span className="muted" style={{ fontSize: 12 }}>
                        the next poll authenticates with nothing — sure?
                      </span>
                      <button
                        className="danger"
                        disabled={disconnect.isPending}
                        onClick={() =>
                          disconnect.mutate({ project: app.project, forgetApp: false })
                        }
                      >
                        Disconnect
                      </button>
                      <button onClick={() => setConfirming(null)}>Cancel</button>
                    </span>
                  ) : app.connected ? (
                    <button className="danger" onClick={() => setConfirming(app.project)}>
                      Disconnect
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={connect.isPending}
                      onClick={() => connect.mutate(app.project)}
                    >
                      Connect
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {connect.error && <p className="error">{String(connect.error)}</p>}
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
              disabled={project === '' || clientId.trim() === '' || clientSecret.trim() === '' || register.isPending}
              onClick={() => register.mutate()}
            >
              {register.isPending ? 'storing…' : 'Register application'}
            </button>
          </div>
          {register.error && <p className="error">{String(register.error)}</p>}
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
          {/* What the command asks for, said here rather than discovered by running it.
              `ogun linear app` reads as complete and is not: it prompts for a Client ID and
              a Client Secret, which is the whole reason an operator is being sent to a
              terminal. --project rather than the directory default, because the control
              plane that refused this write is the one least likely to have the repo on it. */}
          <pre className="md-code" style={{ fontSize: 11, marginBottom: 0 }}>
            ogun linear app --project &lt;slug&gt;
          </pre>
          <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
            It asks for the Client ID and the Client Secret, and prints the callback URL to
            register in Linear first.
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
  if (!app.connected) return <span className="pill yellow">not connected</span>
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
