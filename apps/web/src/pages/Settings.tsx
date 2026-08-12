import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '../api.ts'
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

  const { controlPlane, host, checkouts } = data
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
