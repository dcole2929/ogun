import { CONNECTED_APPS, CONNECTION_HOSTS, type ConnectedApp } from '@ogun/core/connections'
import { hostMatches } from './hosts.ts'
import type { Injection } from './inject.ts'

/**
 * A *connected application* reached from inside a sandbox: which session may reach it,
 * what may be sent, and what the container is told instead of the credential.
 *
 * ### Why this is not just another entry in `DEFAULT_ALLOWED_HOSTS`
 *
 * Everything on that list is a host every job needs — a model API, a package registry,
 * a public git host. Adding `api.linear.app` beside them would have been three lines, and
 * it would have handed every worker on the machine a credentialed path to the project's
 * issue tracker. `adversarial-review` is *pointed at* untrusted repository content on
 * purpose; the prompt injection is the job description. A reviewer that could read every
 * ticket in a workspace, on a grant nobody wrote down, is a worse outcome than the one
 * ADR-0010 exists to prevent, because at least a stolen model token is somebody's to
 * revoke.
 *
 * So a connection is granted **per session**, out of a field a worker had to write
 * (`connections:`), and the default for every worker that says nothing is no connection at
 * all. `open(authority, allow, connections)` is where the grant is minted, and the session
 * is the only place it exists — there is no global that a second worker could inherit.
 *
 * ### The three checks, and why each one is separate
 *
 * A door that ran two of these would look correct. They answer different questions and
 * they fail differently:
 *
 *  1. **Is the application granted to this session?** Belt-and-braces beside `open()`,
 *     which only puts the host on the allowlist when the app was granted. It is here
 *     because "the allowlist happens to be right" is how this component has already
 *     shipped the same bug twice: a fourth door, or a caller that composes an allowlist by
 *     hand, would otherwise reach a credentialed host with no grant behind it.
 *  2. **Is this request shape one a connection is for?** `api.linear.app` is not only the
 *     GraphQL API. It also serves `/oauth/token` and `/oauth/revoke`, and a sandbox that
 *     could reach the second one could *end the project's connection* with a single
 *     request carrying a credential the gateway kindly attached for it. That is not a
 *     data-exfiltration risk, it is a destructive one, and no allowlist entry expresses it.
 *  3. **Is there a credential to splice in?** Answered here rather than forwarded, exactly
 *     as `requiresCredential` is for the model providers: a placeholder sent to Linear
 *     comes back as `AUTHENTICATION_ERROR`, which reads as "your workspace credential is
 *     dead" and sends an operator to reconnect an application that was never the problem.
 *
 * ### What a prompt-injected agent can do with this, stated plainly
 *
 * It can issue arbitrary GraphQL **against the whole workspace the grant covers**, with
 * the granted scopes. Today that is `read`, and `read` in Linear is not one ticket: it is
 * every issue, comment, document and attachment in every team the grant can see, plus the
 * member list. There is no per-ticket scope and no per-team scope on an access token, so
 * this layer cannot narrow it and does not pretend to. And because `api.anthropic.com` is
 * on every allowlist, anything the agent can read it can also put in a prompt and send
 * out — ADR-0005 and ADR-0010 both say exfiltration through the model API is a different
 * and harder problem, and it is still open.
 *
 * Two narrowings are real and are the honest limit of what this file buys:
 *
 *  - **Only an OAuth grant, never a personal API key.** A personal key is *everything that
 *    person can do* in that workspace, forever — including deleting issues and reading
 *    private teams — and Linear attributes every write to them by name (ADR-0014). An
 *    application's grant is what a workspace admin approved, at a scope they read on a
 *    consent screen. `linearConnection` refuses the key rather than falling back to it, so
 *    the worst case is a worker that cannot reach Linear until somebody connects an
 *    application, which is a refusal an operator can act on.
 *  - **Only `POST /graphql`.** See check 2.
 */

export type { ConnectedApp }
export { CONNECTED_APPS, CONNECTION_HOSTS }

/**
 * The credential a connected application is reached with, as the *wire* needs it.
 *
 * A discriminated union keyed on `app` rather than a bare token, for the reason ADR-0014
 * gives for `LinearCredential`: the shape of the `Authorization` header is a property of
 * the credential, both spellings produce a well-formed request, and a wrong one comes back
 * as the same 401 a revoked credential does. A `{ token: string }` handed to a generic
 * `Bearer ${token}` would compile, would work for the second application somebody adds,
 * and would be silently wrong for one of them.
 *
 * Only the OAuth shape exists. A personal API key never reaches this type — see the note
 * on `linearConnection` in the runner, which is where a `ProjectSecret` is turned into one
 * of these and where the refusal is written.
 */
export type LinearConnection = {
  app: 'linear'
  accessToken: string
  /** As Linear granted them, for the refusal message when a scope is the reason. */
  scopes: readonly string[]
}

export type ConnectionCredential = LinearConnection

/**
 * What the host currently holds for each granted application.
 *
 * A record rather than an array so a lookup cannot silently match the wrong app, and
 * optional per key because "granted but the host has no credential right now" is a real
 * and distinct state — a control plane on another machine, a grant an operator revoked
 * mid-job — that has to produce a different answer from "not granted".
 */
export type ConnectionCredentials = { linear?: LinearConnection }

/**
 * One session's grant: which applications it may reach, and how to get their current
 * credential.
 *
 * `read` is a function and not a value, for the reason `credentialReader` is: an OAuth
 * access token is refreshed by the control plane in place, and a session that captured the
 * token at `provision()` would go on presenting a dead one for the rest of a
 * half-hour job — 401ing at minute twenty for a credential that was renewed at minute
 * three. The memo lives with the caller (see `connectionReader` in the runner), because
 * only the caller knows what reading costs on its own machine.
 */
export type SessionConnections = {
  granted: readonly ConnectedApp[]
  read: () => ConnectionCredentials
}

/** A session that was granted nothing, which is what every worker gets by default. */
export const NO_CONNECTIONS: SessionConnections = { granted: [], read: () => ({}) }

/**
 * Which application owns a hostname, or `undefined` for a host that is not a connection.
 *
 * Through `hostMatches`, which is the one host matcher in the system. The table is exact
 * names, so a `hostname === pattern` here would behave identically today and would drift
 * the first time a table entry gained a wildcard or a request arrived fully qualified with
 * the DNS root's trailing dot — which is precisely the drift that killed `isHostAllowed`
 * in `@ogun/core` (see the epitaph at the bottom of `config/egress.ts`).
 */
export function connectionForHost(hostname: string): ConnectedApp | undefined {
  for (const app of CONNECTED_APPS) {
    if (CONNECTION_HOSTS[app].some((pattern) => hostMatches(pattern, hostname))) return app
  }
  return undefined
}

/**
 * The one request shape a connection carries, per application.
 *
 * Returns a *reason* rather than a boolean so the refusal can name what it refused.
 *
 * For Linear this is `POST /graphql` and nothing else, and the reason is not tidiness.
 * `api.linear.app` also serves the OAuth endpoints — `/oauth/token`, `/oauth/revoke` —
 * and both are reachable with exactly the credential the gateway is about to attach:
 *
 *  - `/oauth/revoke` would let a prompt-injected agent **end the project's connection**.
 *    Reconnecting needs a workspace admin, so the recovery is not one click, and nothing
 *    in the agent's transcript would look like an attack.
 *  - `/oauth/token` is where a refresh token is spent. The sandbox does not have one and
 *    is not going to get one, but the endpoint's job is to hand out credentials, and a
 *    door whose only defence is "you do not hold the input" is a door.
 *
 * Compared against the *decoded* path and the method together, in the spirit of
 * `isGitPushRequest`: an allowlist of one exact path is easier to get right than a
 * denylist of two, so this is the allowlist. Query strings are tolerated because Linear's
 * own SDK appends them for tracing; anything else is refused.
 *
 * What this deliberately does **not** do is look inside the GraphQL document. A gateway
 * that told a query from a mutation would be parsing attacker-controlled input in the one
 * code path that must not throw, and would be one alias or one `@include` away from being
 * wrong — while claiming a guarantee. The boundary inside `/graphql` is the *granted
 * scope*, enforced by Linear, which is the only party that can enforce it. That is stated
 * as a cost in ADR-0013 rather than hidden behind a check that does not hold.
 */
export function connectionRequestRefusal(
  app: ConnectedApp,
  method: string,
  path: string,
): string | undefined {
  const base = path.split('?', 1)[0] ?? ''
  if (method.toUpperCase() !== 'POST' || decodedPaths(base).every((p) => p !== '/graphql')) {
    return (
      `a ${app} connection carries POST /graphql and nothing else — ${method.toUpperCase()} ` +
      `${base} is refused. api.linear.app also serves /oauth/revoke, and a sandbox that ` +
      'could reach it would end this project\'s connection with the credential the gateway ' +
      'attached for it'
    )
  }
  return undefined
}

/**
 * Every spelling of a path the origin would accept.
 *
 * The same trick `isGitPushRequest` guards against, in the opposite direction: there, a
 * percent-encoded path had to still *match* the refusal; here it has to still match the
 * one permitted path, so `/graph%71l` is accepted rather than being an unexplained 403.
 * Bounded at three passes for the same reason — a path still changing after three rounds
 * is not one anybody legitimately sent, and it simply does not match.
 */
function decodedPaths(path: string): string[] {
  const lower = path.toLowerCase()
  const out = [lower]
  try {
    let decoded = lower
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      out.push(decoded)
    }
  } catch {
    // A malformed escape cannot be reasoned about, so it is not the permitted path.
  }
  return out
}

/**
 * The header edits for a request to a connected application.
 *
 * Removes as well as sets, exactly like `planInjections`: the container was handed a
 * placeholder and sends it, and a request that reached Linear with two authorization-ish
 * headers would be resolved by *Linear's* precedence rule rather than ours. `x-api-key` is
 * removed because it is the header the Anthropic stub teaches an agent to reach for, and a
 * client that copied its own model-API call as a template would send both.
 *
 * The `Bearer` prefix is load-bearing and is the single most common way to get a 401 out of
 * this API. Linear takes a personal key **raw** in `Authorization` and an OAuth token
 * **with** `Bearer`; see `authorizationHeader` in `packages/server/src/integrations/linear.ts`,
 * which is the one other place in the tree that puts a Linear credential on a wire. Only
 * the OAuth shape reaches here, so the prefix is unconditional — and it is unconditional
 * *because* the raw shape was excluded upstream, not because the distinction stopped
 * mattering.
 */
export function connectionInjections(
  app: ConnectedApp,
  credentials: ConnectionCredentials,
): Injection[] {
  if (app === 'linear') {
    const credential = credentials.linear
    if (!credential) return []
    return [
      { kind: 'set', name: 'authorization', value: `Bearer ${credential.accessToken}` },
      { kind: 'remove', name: 'x-api-key' },
    ]
  }
  /**
   * Unreachable while `ConnectedApp` is one name, and it is written as an exhaustiveness
   * check rather than a `default:` so that adding the second application is a *compile*
   * error here — in the function that decides how its credential goes on the wire —
   * instead of a silent `[]` that reaches the upstream with the container's placeholder.
   */
  const exhaustive: never = app
  return exhaustive
}
