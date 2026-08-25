import { credentialHealth, readProjectSecret, type ProjectSecret } from '@ogun/core'
import type {
  ConnectedApp,
  ConnectionCredential,
  ConnectionCredentials,
  SessionConnections,
} from '@ogun/gateway'

/**
 * Where a connected application's credential comes from, on the runner's side of the
 * gateway.
 *
 * ### Why this is here and not in `@ogun/gateway`
 *
 * The gateway knows how a credential goes on a *wire*: which header, which prefix, which
 * paths a connection may carry. It deliberately does not know where credentials live —
 * `credentials.ts` there reads two files it owns the format of, and the top of it explains
 * that it imports `@ogun/core/credentials` rather than `@ogun/core` because it sits in the
 * request path of every job and will not drag a yaml parser and a zod runtime in behind
 * it. A project's Linear grant lives in `~/.ogun/config.json` behind `readProjectSecret`,
 * which is zod all the way down (ADR-0012, ADR-0014).
 *
 * So the layering is: the runner knows *where*, the gateway knows *how*, and the seam
 * between them is `SessionConnections` — a list of granted applications and a function
 * that returns their current credentials. The gateway calls that function per request and
 * never learns what it read.
 *
 * ### The seam is `readProjectSecret`, consumed whole
 *
 * Not `readStore`, not `localConfigPath()` plus a `JSON.parse`. One function decides which
 * credential a project authenticates with (ADR-0014 decision 5) — a grant wins over a key,
 * a dead grant refuses rather than falling back — and a second reader here would be a
 * second opinion about that, reachable only from a sandbox, which is the worst place for
 * one to live. `linearConnection` below therefore takes the union whole and answers every
 * variant of it by name, with an exhaustiveness check, so that the next variant somebody
 * adds is a compile error in this file rather than a silent `undefined`.
 */

/**
 * The `SecretName` an application's credential is stored under.
 *
 * Written out rather than passing `app` straight through, even though the two vocabularies
 * happen to spell Linear the same way today. They are different sets owned by different
 * decisions — `SECRET_NAMES` is "values used verbatim as credentials" and is deliberately
 * closed (ADR-0014 decision 4), `CONNECTED_APPS` is "things a sandbox can call" — and the
 * day they diverge, an implicit identity between them is a lookup that silently finds
 * nothing.
 */
const SECRET_NAME_FOR: Readonly<Record<ConnectedApp, 'linear'>> = { linear: 'linear' }

/**
 * A credential for one application, or the reason there is none.
 *
 * A reason and not a `undefined`, because these reasons are not interchangeable and the
 * runner logs one of them beside the job. "You have not connected an application",
 * "you connected one and it expired", and "this machine is not the one holding the store"
 * send an operator to three different places, and `readProjectSecret` grew seven states
 * precisely so they would not collapse (principle 6).
 */
export type ConnectionLookup =
  | { ok: true; credential: ConnectionCredential }
  | { ok: false; reason: string }

/**
 * Which lookup an application uses, as a switch rather than as one function that happens
 * to serve everything.
 *
 * There is one application and one lookup, so this reads like ceremony. It is not: the
 * refusals `linearConnection` writes are *about Linear* — a personal key is refused
 * because Linear attributes writes by name, an expired token is refused because the
 * control plane renews before a poll. None of that is true of the next application by
 * construction, and a shared function would quietly apply Linear's reasoning to it. The
 * `never` makes adding one a compile error here, in the file that decides what a sandbox
 * may be handed.
 */
export function connectionFor(
  app: ConnectedApp,
  secret: ProjectSecret,
  now = Date.now(),
): ConnectionLookup {
  if (app === 'linear') return linearConnection(secret, now)
  const exhaustive: never = app
  return exhaustive
}

/**
 * File a credential under its own application.
 *
 * `credentials[app] = credential` would compile today and would be the bug the day a
 * second application exists: nothing in that expression checks that the credential the
 * lookup returned is the one the key names, so a lookup wired to the wrong app would put
 * a Linear token where the other application's belongs — and the gateway would inject it,
 * because by then it is just a value under a key. Written as a switch on the credential's
 * own tag, so the key comes from the value rather than from the loop variable.
 */
function place(into: ConnectionCredentials, credential: ConnectionCredential): void {
  // The tag is copied into a local of the *app* type rather than switched on in place.
  // With one application `ConnectionCredential` is not a union, so TypeScript narrows
  // nothing in the else branch and an exhaustiveness check written against the value
  // itself does not compile. Against the app type it does — and when the second
  // application arrives, `into.linear = credential` stops compiling because `credential`
  // is then genuinely a union that this branch has not narrowed. Either way the compiler
  // stops, which is the property being bought.
  const app: ConnectedApp = credential.app
  if (app === 'linear') {
    into.linear = credential
    return
  }
  const exhaustive: never = app
  void exhaustive
}

function forget(from: ConnectionCredentials, app: ConnectedApp): void {
  if (app === 'linear') {
    delete from.linear
    return
  }
  const exhaustive: never = app
  void exhaustive
}

/**
 * `ProjectSecret` → what the gateway can put on a wire, answering every state by name.
 *
 * ### A personal API key is refused, and that is the decision in this function
 *
 * `readProjectSecret` returns `present` for a personal Linear API key, and it is a
 * perfectly good credential for the *host* — it is what §4.13's poll authenticates with
 * when a project has not connected an application. It is not one for a sandbox, and the
 * asymmetry is deliberate:
 *
 *  - A personal key is **everything that person can do** in that workspace, forever
 *    (ADR-0014). Not `read`: delete an issue, read a private team, change a workflow. An
 *    OAuth grant is what a workspace admin approved on a consent screen, at a scope they
 *    saw.
 *  - Linear attributes every write to the key's owner **by name**. The whole reason
 *    ADR-0014 exists is that a machine posting under a person's name on a shared board is
 *    a person's name on text they did not write. Lending that to an unattended agent
 *    aimed at untrusted repository content is the same mistake with a worse blast radius.
 *
 * So the refusal is not "we have not built it yet". It says so, and it names the fix.
 *
 * ### Expiry
 *
 * An expired access token is refused rather than injected. Injecting one produces a
 * `401 AUTHENTICATION_ERROR` from Linear, which reads as "this connection is revoked" and
 * sends an operator to reconnect an application that is fine — the exact misnaming
 * `LinearUnavailable`'s three kinds exist to prevent. `expiring` is *not* refused: the
 * token is valid right now, the control plane renews on demand before its next poll, and
 * `read()` re-reads the store often enough to pick the new one up mid-job. Refusing on a
 * horizon here would refuse work for a credential that is about to be fine.
 */
export function linearConnection(secret: ProjectSecret, now = Date.now()): ConnectionLookup {
  switch (secret.state) {
    case 'granted': {
      const health = credentialHealth({ kind: 'at', expiresAt: secret.grant.expiresAt }, { now })
      if (health.state === 'expired') {
        return {
          ok: false,
          reason:
            'the linear oauth access token expired and has not been renewed — the control ' +
            'plane renews on demand before a poll (ADR-0014), so either nothing has polled ' +
            'since it lapsed or the refresh is failing. `ogun linear status` says which',
        }
      }
      return {
        ok: true,
        credential: {
          app: 'linear',
          // The one `expose()` on this path, at the point the value becomes a header.
          // ADR-0012's rule is one per consumer, and this is the sandbox's one.
          accessToken: secret.grant.access.expose(),
          scopes: secret.grant.scopes,
        },
      }
    }
    case 'present':
      return {
        ok: false,
        reason:
          'this project authenticates to linear with a personal api key, and a personal key ' +
          'is not injectable into a sandbox: it is everything its owner can do in that ' +
          'workspace, and linear attributes every write to them by name (ADR-0014). Connect ' +
          'an application for this project — the poll keeps working with the key either way',
      }
    case 'unconnected':
      return {
        ok: false,
        reason:
          `an oauth application (client ${secret.clientId}) is registered for this project ` +
          'and the authorization was never completed, so there is no token to inject',
      }
    case 'absent':
      return {
        ok: false,
        reason:
          'no linear connection is stored for this project on this machine. A connection is ' +
          'read from `~/.ogun/config.json` (ADR-0012), which lives on the machine that runs ' +
          'the control plane — if that is a different box from this runner, a sandbox on ' +
          'this one cannot reach linear',
      }
    case 'empty':
      return {
        ok: false,
        reason:
          'this project has a linear entry holding nothing — something wrote a blank over ' +
          'what was set, which is a different problem from never having set one',
      }
    case 'malformed':
      return {
        ok: false,
        reason: `this project's linear entry is not a shape this build can read: ${secret.reason}`,
      }
    case 'unreadable':
      return {
        ok: false,
        reason:
          `the local config store could not be read, so nothing on this machine can say ` +
          `whether a linear connection exists: ${secret.reason}`,
      }
    default: {
      /**
       * The point of taking the union whole.
       *
       * `ProjectSecret` is going to gain variants — a `client_credentials` grant with no
       * refresh token is the one currently being built — and the failure this guards
       * against is not a crash. It is a new state falling through to a `return undefined`
       * and a sandbox quietly losing a connection it was granted, reported as "linear is
       * unreachable" at 3am. A `never` here means the next variant cannot be added without
       * somebody writing the sentence for what a sandbox should do with it.
       */
      const exhaustive: never = secret
      return { ok: false, reason: `unhandled credential state: ${JSON.stringify(exhaustive)}` }
    }
  }
}

/**
 * How stale a connection credential may be before it is read again.
 *
 * Five seconds, the same number and the same reasoning as the gateway's model-credential
 * memo: the point of re-reading at all is that a renewal performed by the control plane
 * reaches a job that is already running, and a window longer than a retry backoff defeats
 * that. Not zero, because this is on a per-request path and `readProjectSecret` parses a
 * whole config file with zod.
 */
export const CONNECTION_TTL_MS = 5_000

export type ConnectionReaderOptions = {
  /** Injected by the tests, which have no `~/.ogun/config.json`. */
  read?: (projectSlug: string, name: 'linear') => Promise<ProjectSecret>
  ttlMs?: number
  now?: () => number
  /** Where a lookup failure is reported. One line on the host, at the moment it happens. */
  onUnavailable?: (app: ConnectedApp, reason: string) => void
}

/**
 * A `SessionConnections` for one job: primed once, then re-read in the background.
 *
 * ### Why priming is awaited and refreshing is not
 *
 * `readProjectSecret` is async and the gateway's `prepare()` is not, and making it async
 * was rejected. `prepare()` is called from four doors, one of which is an HTTP `'upgrade'`
 * handler holding a raw socket that `node:http` has already detached from its parser —
 * awaiting there means bytes can arrive with nothing reading them, for a lookup that is
 * a small file read. So the shape is the other way round: the value is a snapshot, and
 * keeping it fresh is this function's job rather than the caller's.
 *
 * The first read is **awaited**, in `provision()`, which is already async and already runs
 * once per job. That matters: without it the agent's first Linear call — the one a skill
 * makes immediately — would race a cold cache and get a 502 for a credential that was
 * there all along, which is a flake that only shows up under load.
 *
 * Afterwards, a `read()` past the TTL returns what it has *and* starts a refresh. The cost
 * is that one request per five seconds may use a value up to a few milliseconds staler
 * than a blocking read would have — against a 24-hour token renewed ten minutes before it
 * lapses, that is not a window anything can fall into.
 *
 * ### What it does when the lookup fails
 *
 * It keeps the *last good* credential rather than dropping it, and reports. A control
 * plane rewriting `config.json` is a write-and-rename, so a read that lands mid-rename
 * sees no file and returns `absent`; dropping the credential on that would turn an
 * ordinary renewal into a job that lost its connection for a reason nothing records. What
 * it must not do is hold one *forever* — so a failure is reported every time it changes,
 * and an expired grant is a lookup failure, so a genuinely dead connection stops working
 * as soon as the token it last held goes stale.
 */
export async function connectionReader(
  projectSlug: string,
  granted: readonly ConnectedApp[],
  options: ConnectionReaderOptions = {},
): Promise<SessionConnections> {
  const read = options.read ?? ((slug, name) => readProjectSecret(slug, name))
  const ttlMs = options.ttlMs ?? CONNECTION_TTL_MS
  const now = options.now ?? Date.now
  const report =
    options.onUnavailable ??
    ((app: ConnectedApp, reason: string) =>
      console.warn(`[runner] ${projectSlug}: no \`${app}\` connection — ${reason}`))

  const credentials: ConnectionCredentials = {}
  const lastReason = new Map<ConnectedApp, string>()
  let at = 0
  let refreshing = false

  const refresh = async (): Promise<void> => {
    // Stamped before the reads rather than after, so a read that throws does not leave the
    // memo permanently stale and turn every subsequent request into a fresh attempt.
    at = now()
    for (const app of granted) {
      const lookup = connectionFor(app, await read(projectSlug, SECRET_NAME_FOR[app]), now())
      if (lookup.ok) {
        place(credentials, lookup.credential)
        lastReason.delete(app)
        continue
      }
      // Reported once per distinct reason, not once per read: at a five-second TTL an
      // unconnected project would otherwise print twelve identical lines a minute for the
      // whole of a thirty-minute job, and a log nobody reads is a log that reports nothing.
      if (lastReason.get(app) !== lookup.reason) {
        lastReason.set(app, lookup.reason)
        report(app, lookup.reason)
      }
      /**
       * The last good credential is kept, *unless* it is the one that just failed to
       * verify. Only an expired grant can do that — every other refusal means the store
       * says something different from what it said before, which a rename race can
       * produce — and an expired token must stop being injected the moment we know it is
       * expired, or the gateway spends the rest of the job answering 401s from Linear.
       */
      if (lookup.reason.includes('expired')) forget(credentials, app)
    }
    refreshing = false
  }

  await refresh()

  return {
    granted,
    read: () => {
      if (now() - at >= ttlMs && !refreshing) {
        refreshing = true
        // Not awaited, and its rejection is swallowed rather than left unhandled: this is
        // called from a request handler, and an unhandled rejection out of the credential
        // path would take the runner process — and every other job on it — down.
        void refresh().catch(() => {
          refreshing = false
        })
      }
      return credentials
    },
  }
}
