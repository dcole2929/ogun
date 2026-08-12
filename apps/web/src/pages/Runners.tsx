import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api.ts'
import { Empty, Page, when } from '../ui.tsx'

/**
 * One control plane, N machines.
 *
 * **Runners connect outward; the control plane never dials a runner.** That is what
 * lets a laptop be one — a machine that sleeps, changes networks, and sits behind NAT
 * can still ask for work whenever it is awake, with no inbound port and no fixed
 * address. So "add a runner" here means: mint a credential, and carry it there.
 */
export function RunnersPage() {
  const [adding, setAdding] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['runners'],
    queryFn: api.runners,
    refetchInterval: 10_000,
  })
  const runners = data?.runners.filter((r) => !r.revokedAt) ?? []
  const live = runners.filter((r) => r.online)

  return (
    <Page
      title="Runners"
      subtitle="Machines that execute jobs. Runs happen on-device, wherever the control plane lives."
      actions={
        !adding && (
          <button className="primary" onClick={() => setAdding(true)}>
            Add a runner
          </button>
        )
      }
    >
      {adding && (
        <EnrollForm
          addresses={data?.addresses ?? []}
          tokenRequired={data?.tokenRequired ?? false}
          onDone={() => setAdding(false)}
        />
      )}

      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && runners.length === 0 && !adding && (
        <Empty>
          no runners
          <br />
          <span className="muted">
            This machine can be one — <span className="mono">pnpm runner</span>
          </span>
        </Empty>
      )}

      {runners.length > 0 && <RunnerTable runners={runners} />}

      {runners.length > 0 && live.length === 0 && (
        <p className="error" style={{ fontSize: 13 }}>
          Nothing is online. Queued jobs will wait — they are not lost, but nothing will
          pick them up.
        </p>
      )}
    </Page>
  )
}

function RunnerTable({ runners }: { runners: NonNullable<Awaited<ReturnType<typeof api.runners>>>['runners'] }) {
  const qc = useQueryClient()
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeRunner(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
  })
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <table>
      <thead>
        <tr>
          <th />
          <th>Runner</th>
          <th>Can run</th>
          <th>Capacity</th>
          <th>Last seen</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {runners.map((r) => (
          <tr key={r.id} style={{ opacity: r.online ? 1 : 0.6 }}>
            <td>
              {r.pending ? (
                <span className="pill yellow">waiting</span>
              ) : r.online ? (
                <span className="live" />
              ) : (
                <span className="pill">off</span>
              )}
            </td>
            <td className="mono">{r.id}</td>
            <td>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {r.labels.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  r.labels.map((l) => (
                    <span key={l} className="pill">
                      {l}
                    </span>
                  ))
                )}
              </div>
            </td>
            <td className="muted">{r.maxConcurrency}</td>
            <td className="muted">
              {r.pending ? <span className="muted">never connected</span> : when(r.lastSeenAt)}
            </td>
            <td style={{ textAlign: 'right' }}>
              {r.enrolled &&
                (confirming === r.id ? (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      revoke its token?
                    </span>
                    <button className="danger" onClick={() => revoke.mutate(r.id)}>
                      Revoke
                    </button>
                    <button onClick={() => setConfirming(null)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirming(r.id)}>Revoke</button>
                ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function EnrollForm({
  addresses,
  tokenRequired,
  onDone,
}: {
  addresses: string[]
  tokenRequired: boolean
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [id, setId] = useState('')
  const [url, setUrl] = useState(addresses[0] ?? '')
  const [labels, setLabels] = useState(['claude', 'codex', 'docker'])
  const [issued, setIssued] = useState<{ command: string } | null>(null)

  const enroll = useMutation({
    mutationFn: () => api.enrollRunner({ id, labels, serverUrl: url }),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ['runners'] })
      setIssued({ command: result.command })
    },
  })

  const idValid = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(id)
  const toggle = (l: string) =>
    setLabels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))

  if (issued) {
    return (
      <div className="card" style={{ marginBottom: 22 }}>
        <h2 style={{ marginTop: 0 }}>Run this on {id}</h2>
        <pre className="md-code">{issued.command}</pre>
        <p className="muted" style={{ fontSize: 12 }}>
          The token is shown once — only its hash is stored here, so a lost one is
          re-issued rather than recovered. It can claim work and report on it; it cannot
          define a worker, so a compromised runner cannot hand itself a new prompt to run.
        </p>
        <button onClick={onDone}>Done</button>
      </div>
    )
  }

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <h2 style={{ marginTop: 0 }}>Add a runner</h2>
      <div className="form">
        <label>
          <span>Name</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="macbook" />
          <small className={id && !idValid ? 'error' : 'muted'}>
            {id && !idValid ? 'lowercase, dashes and dots only' : 'how this machine appears here'}
          </small>
        </label>

        <label>
          <span>This control plane, as that machine will see it</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://…" />
          <small className="muted">
            {addresses.length > 1 && (
              <>
                also detected:{' '}
                {addresses.slice(1).map((a) => (
                  <button
                    key={a}
                    style={{ padding: '0 5px', marginRight: 4, fontSize: 11 }}
                    onClick={() => setUrl(a)}
                  >
                    {a}
                  </button>
                ))}
                <br />
              </>
            )}
            {/* localhost is the default bind and is exactly what will not work here. */}
            {url.includes('localhost') || url.includes('127.0.0.1')
              ? 'another machine cannot reach this — bind the server wider, or use a VPN address'
              : 'must be reachable from that machine; a Tailscale address travels between networks'}
          </small>
        </label>

        <label className="wide">
          <span>What it can run</span>
          <div className="row">
            {['claude', 'codex', 'docker'].map((l) => (
              <label key={l} className="inline">
                <input type="checkbox" checked={labels.includes(l)} onChange={() => toggle(l)} />
                <span>{l}</span>
              </label>
            ))}
          </div>
          <small className="muted">
            A job only goes to a runner advertising everything it needs. The runner
            corrects this from what it actually finds on first connect.
          </small>
        </label>
      </div>

      {!tokenRequired && (
        <p className="muted" style={{ fontSize: 12 }}>
          This control plane is on localhost with no admin token, so nothing outside this
          machine can reach it yet. Run <span className="mono">ogun token new</span>, then
          start the server with <span className="mono">OGUN_BIND=0.0.0.0</span>.
        </p>
      )}
      {enroll.error && <p className="error">{errorText(enroll.error)}</p>}

      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="primary"
          disabled={!idValid || !url || enroll.isPending}
          onClick={() => enroll.mutate()}
        >
          {enroll.isPending ? 'issuing…' : 'Issue token'}
        </button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

const errorText = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  const match = /"error":"((?:[^"\\]|\\.)*)"/.exec(raw)
  return match?.[1]?.replace(/\\"/g, '"') ?? raw
}
