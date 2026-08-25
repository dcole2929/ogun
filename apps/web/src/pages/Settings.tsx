import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, type SystemInfo } from '../api.ts'
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
          <pre className="md-code" style={{ fontSize: 11, marginBottom: 0 }}>
            ogun project secret set &lt;project&gt; {writes.names[0] ?? 'linear'}
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
