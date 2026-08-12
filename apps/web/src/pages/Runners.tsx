import { useQuery } from '@tanstack/react-query'
import { api } from '../api.ts'
import { Empty, Page, when } from '../ui.tsx'

/**
 * One control plane, N machines. A runner claims jobs over HTTP and advertises what it
 * can do; a job declares what it needs, and the claim query only matches a runner whose
 * labels are a superset (§4.5).
 *
 * The registry existed from the first commit but was write-only, so "is my laptop
 * connected?" had no answer short of reading postgres.
 */
export function RunnersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['runners'],
    queryFn: api.runners,
    refetchInterval: 10_000,
  })
  const runners = data?.runners ?? []
  const online = runners.filter((r) => r.online)

  return (
    <Page
      title="Runners"
      subtitle="Machines that execute jobs. Runs happen on-device, wherever the control plane lives."
    >
      {isLoading && <Empty>loading…</Empty>}
      {!isLoading && runners.length === 0 && (
        <Empty>
          no runner has ever connected
          <br />
          <span className="muted mono">pnpm runner</span>
        </Empty>
      )}

      {runners.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th />
                <th>Runner</th>
                <th>Can run</th>
                <th>Capacity</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {runners.map((r) => (
                <tr key={r.id} style={{ opacity: r.online ? 1 : 0.55 }}>
                  <td>{r.online ? <span className="live" /> : <span className="pill">off</span>}</td>
                  <td className="mono">{r.id}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      {r.labels.length === 0 ? (
                        <span className="muted">nothing advertised</span>
                      ) : (
                        r.labels.map((l) => (
                          <span key={l} className="pill">
                            {l}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="muted">{r.maxConcurrency} concurrent</td>
                  <td className="muted">{when(r.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {online.length === 0 && (
            <p className="error" style={{ fontSize: 13 }}>
              Nothing is online. Queued jobs will sit until a runner connects — they are not
              lost, but nothing will pick them up.
            </p>
          )}
        </>
      )}

      <h2>Adding a machine</h2>
      <div className="card">
        <p style={{ marginTop: 0, fontSize: 13 }}>
          A runner needs to reach this control plane over HTTP and hold its own Claude or
          Codex credentials. It keeps its own map of where repositories live, because{' '}
          <span className="mono">/home/doug/dev/x</span> and{' '}
          <span className="mono">/Users/doug/dev/x</span> are the same project at different
          paths — so no absolute path is ever stored centrally.
        </p>
        <pre className="md-code">{SETUP}</pre>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          A control plane reachable beyond localhost requires{' '}
          <span className="mono">OGUN_TOKEN</span> on both ends — it can define workers and
          trigger runs, so an open one is remote code execution on the host.
        </p>
      </div>
    </Page>
  )
}

const SETUP = `# on the control-plane machine, to accept connections
OGUN_TOKEN=$(openssl rand -hex 32) OGUN_BIND=0.0.0.0 pnpm server

# on the other machine
ogun runner init                    # writes ~/.ogun/runner.json
#   → add this machine's repo paths under "projects"
#   → set "serverUrl" to the control plane

OGUN_TOKEN=<same secret> pnpm runner
ogun runner doctor                  # what this machine can actually run`
