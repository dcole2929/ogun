import { useState, type ReactNode } from 'react'
import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { startSession, Unauthorized } from './api.ts'

/**
 * A control plane bound beyond localhost needs a token, and a browser cannot attach an
 * Authorization header to its own navigation. So the page loads, every request 401s, and
 * without this the whole UI is a blank screen with errors in the console.
 *
 * Presenting the token once exchanges it for an httpOnly cookie.
 */
export function TokenGate({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(false)

  if (locked) return <TokenPrompt onDone={() => setLocked(false)} />

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorWatcher
          onUnauthorized={() => {
            reset()
            setLocked(true)
          }}
        >
          {children}
        </ErrorWatcher>
      )}
    </QueryErrorResetBoundary>
  )
}

/**
 * TanStack Query surfaces failures per-hook rather than throwing globally, so rather
 * than wrapping every page in a boundary this listens for the rejection the client
 * raises. Coarse, but it catches the one case that matters and adds nothing to the
 * happy path.
 */
function ErrorWatcher({
  children,
  onUnauthorized,
}: {
  children: ReactNode
  onUnauthorized: () => void
}) {
  useOnUnhandled(onUnauthorized)
  return <>{children}</>
}

function useOnUnhandled(onUnauthorized: () => void) {
  if (typeof window !== 'undefined' && !(window as never as { __ogunAuthHook?: boolean }).__ogunAuthHook) {
    ;(window as never as { __ogunAuthHook?: boolean }).__ogunAuthHook = true
    window.addEventListener('unhandledrejection', (e) => {
      if (e.reason instanceof Unauthorized) onUnauthorized()
    })
  }
}

function TokenPrompt({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await startSession(token.trim())
      onDone()
      // A full reload rather than a re-render: every query in flight failed, and
      // refetching them individually is more moving parts than starting clean.
      window.location.reload()
    } catch {
      setError('That token was not accepted.')
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <div className="card" style={{ maxWidth: 460 }}>
        <h1 style={{ marginTop: 0 }}>Ogun</h1>
        <p className="muted" style={{ fontSize: 13 }}>
          This control plane is reachable from the network, so it needs its admin token.
          It is stored on the machine running the server:
        </p>
        <pre className="md-code" style={{ fontSize: 11 }}>
          ogun token show
        </pre>
        <input
          type="password"
          value={token}
          placeholder="ogun_…"
          autoFocus
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token.trim() && submit()}
        />
        {error && <p className="error" style={{ fontSize: 13 }}>{error}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!token.trim() || busy} onClick={submit}>
            {busy ? 'checking…' : 'Unlock'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          Stored as an httpOnly cookie for 30 days. This is the admin secret — it can
          define workers, which is to say define what runs on that machine.
        </p>
      </div>
    </div>
  )
}
