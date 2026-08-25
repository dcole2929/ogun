/**
 * Linear's OAuth 2.0 grants, behind one seam (ADR-0014, amended).
 *
 * The same shape as the server's `linear.ts` GraphQL client and for the same reason: there
 * is no Linear application registered to this project and no credential on any machine
 * here, so everything below was built against Linear's published documentation and is
 * exercised by fixtures. `test/linear-oauth-fixtures.ts` records exactly what that proves
 * and what it does not, the way `linear-fixtures.ts` does for the GraphQL client.
 *
 * ### Why this lives in core rather than in the server
 *
 * It used to live in `packages/server/src/integrations/`, because the only grant Ogun had
 * needed a `state` nonce and an HTTP callback, and both of those are things only a running
 * control plane can hold. `client_credentials` needs neither: a client id, a client secret
 * and one POST are the whole of it, and every input is already in
 * `~/.ogun/config.json` on the machine the operator is typing on.
 *
 * That matters because of a promise ADR-0012 made about the *fallback* credential —
 * `ogun secret set` "works before `ogun init`, with the database down, and over SSH". If
 * the preferred way to connect needed a control plane and the discouraged one did not,
 * then every operator whose control plane was down would reach for the personal API key,
 * which is exactly the attribution problem ADR-0014 exists to end. So the code that
 * obtains a grant sits where **both** the CLI and the server can call it, and there is one
 * implementation of it rather than two that can disagree about what gets stored.
 *
 * ### The one rule this file exists to keep
 *
 * **No secret in an error message.** This repository has had four separate instances of a
 * credential escaping inside a string — `redactUrlCredentials`, the gateway putting a real
 * token on a plaintext socket, V8 quoting a window of `config.json` in a `JSON.parse`
 * message, and `c.req.json()` quoting a request body — and a token endpoint is the obvious
 * fifth. It is worse than the others, because the *request* carries the client secret and
 * an authorization code, and there is nothing stopping a server from echoing a parameter
 * back in `error_description`. So:
 *
 *  - Every failure here is built from a fixed sentence plus, at most, a **scrubbed** slice
 *    of the response. `scrubSecrets` replaces every value this call sent — client secret,
 *    code, refresh token — and the token it received, wherever they appear.
 *  - The response is parsed by hand. No zod: a validator that puts the received value in
 *    an issue is one dependency bump away from a leak, and this is the request in the
 *    codebase whose body has the most credentials in it.
 *  - Nothing here logs. The caller decides what to record, and it records a message that
 *    has already been through the scrubber.
 *
 * ### And what it deliberately does not do
 *
 * No retry, no backoff, no scheduling. This module makes one HTTP call per exported
 * function and hands back a value or a typed failure; when to call it is ADR-0014's
 * refresh decision and lives with the poll, which is the only thing that knows how long it
 * needs the token to survive.
 */

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize'
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke'
const GRAPHQL_URL = 'https://api.linear.app/graphql'

/**
 * What Ogun asks for, and it is one scope.
 *
 * `read` only, deliberately, and not because more would be hard. Ogun polls today and
 * writes nothing back (ADR-0004), so `write`, `issues:create` and `comments:create` would
 * be permissions granted against a feature that does not exist — and a scope is granted at
 * authorization time by a workspace admin who is trusting the sentence on the consent
 * screen. Asking for what tonight's code cannot use spends that trust on nothing and makes
 * the *next* request, the one that is real, indistinguishable from this one.
 *
 * When write-back lands it adds `comments:create` here rather than `write`, which is
 * Linear's own advice ("If your application only needs to create comments, use a more
 * targeted scope"), and re-authorization is the honest cost of widening a grant.
 *
 * Linear notes that `read` "will always be present" whether or not it is asked for. It is
 * still sent explicitly: `scope` is a required parameter, and a request that relies on a
 * default is a request that changes meaning when the default does.
 */
export const LINEAR_SCOPES = ['read'] as const

/**
 * `actor=app`, fixed, and this is the decision the whole ADR turns on.
 *
 * Under `actor=user` every write Ogun makes is attributed to the person who authorized it:
 * on a shared board, a comment from the machine is indistinguishable from a comment from
 * them. `actor=app` attributes it to the application instead, which is what Linear's own
 * documentation says the mode is for — "This option should be used for agents and service
 * accounts". A personal API key cannot do this at all, which is the second half of why
 * this exists.
 *
 * Fixed rather than configurable because `actor` is chosen at authorization time and
 * baked into the tokens: a setting would mean two kinds of grant in the store, two
 * attributions in Linear, and a flag whose effect is invisible until months later when
 * something writes. The cost is named rather than hidden: **installing with `actor=app` is
 * a workspace-level install and Linear requires an admin to approve it.** An operator who
 * is not an admin in their workspace cannot complete this flow, and for them the personal
 * API key remains supported and documented. That is the whole reason ADR-0012's key is
 * kept rather than removed.
 *
 * **This constant is now only sent on the authorization-code flow.** `client_credentials`
 * returns an app-actor token *implicitly* — Linear's words are that the token "will be an
 * `app` actor token that has access to all public teams in the workspace" — so there is no
 * `actor` parameter on that request and sending one would be a parameter Linear does not
 * document accepting. The recorded actor is still `app` for both, because it describes the
 * same thing: who Linear attributes a write to. Which is why it goes on the grant as an
 * observed fact rather than being assumed from the request that asked for it.
 */
export const LINEAR_ACTOR = 'app'

/**
 * Where a token exchange can go wrong, kept apart because the remedies are unrelated.
 *
 *  - `denied` — the person said no on Linear's consent screen, or is not allowed to
 *    approve a workspace install. Not a failure of anything here, and it must not read
 *    like one.
 *  - `invalid-grant` — the code or refresh token was rejected. Permanent: the fix is to
 *    reconnect, and retrying makes it worse by spending a code that may still be live.
 *  - `config` — the application itself is wrong. In practice this is a redirect URI that
 *    does not match what was registered, which is *the* classic failure of this flow and
 *    the one Linear's message is least helpful about, so the sentence says so out loud.
 *  - `transport` — the network, or a response this build cannot parse. Nothing is wrong
 *    with the grant; trying again later is the right move, and the stored refresh token
 *    must be left exactly where it is.
 *
 * The distinction between `invalid-grant` and `transport` is the one that costs something
 * to get wrong. Discarding a refresh token because the network blipped is a connection
 * destroyed by a timeout — and Linear's 30-minute replay window for a consumed refresh
 * token exists precisely so that a client which did not receive the response can try
 * again, which a client that deleted its token cannot do.
 */
export type LinearOAuthErrorKind = 'denied' | 'invalid-grant' | 'config' | 'transport'

export class LinearOAuthError extends Error {
  readonly kind: LinearOAuthErrorKind
  constructor(kind: LinearOAuthErrorKind, message: string) {
    super(message)
    this.name = 'LinearOAuthError'
    this.kind = kind
  }
}

/**
 * Which of Linear's two grants a token came from, carried with the token.
 *
 * Not derived from "is there a refresh token beside it", which is the shape the same
 * information happens to take today. A mode inferred from a nullable field is a mode that
 * silently changes when the field does — and the field here is the one Linear omits, so
 * the inference would read a truncated response as a deliberate choice. It is written
 * down instead, in Linear's own vocabulary, so that a reader with their documentation open
 * is looking at the same word.
 *
 * The two differ in every way that matters to renewal, and that is the whole reason this
 * exists:
 *
 *  - `client_credentials` — Ogun's own client id and secret, exchanged for a 30-day
 *    **app-actor** token with **no refresh token**. Renewal is *asking again*, which is
 *    idempotent, needs nobody, and cannot lose anything. Reaches the workspace's **public
 *    teams only**.
 *  - `authorization_code` — a person approved an install in a browser, and the pair that
 *    came back **rotates on use**. Renewal spends a credential, so it has to be written
 *    before it is relied on. Reaches whatever the approver could see, private teams
 *    included.
 */
export type LinearGrantType = 'client_credentials' | 'authorization_code'

/** What a successful token call yields, in Ogun's units rather than Linear's. */
export type LinearTokens = {
  accessToken: string
  /**
   * Absent for `client_credentials`, which Linear documents as returning none: "your
   * server is expected to fetch a new token if it receives a 401 error". Required for
   * `authorization_code`, and `tokenCall` refuses a response that omits it there — a
   * rotating grant with no refresh token is a connection that ends silently in a day.
   */
  refreshToken?: string
  /** Absolute ms. Converted here, once, from Linear's `expires_in` seconds. */
  expiresAt: number
  scopes: string[]
  grantType: LinearGrantType
}

export type Fetch = typeof globalThis.fetch

/**
 * The URL to send the operator's browser to.
 *
 * `scope` is **comma**-separated here and **space**-separated in the token response, which
 * is Linear's asymmetry rather than a mistake in this file — their authorize parameter
 * table says "Comma separated list of scopes" and their example response says
 * `"scope": "read write"`. Both are handled, in the two places, and both are tested,
 * because a client that gets this backwards asks for a scope literally named `read write`
 * and is told nothing useful.
 *
 * `prompt=consent` is deliberately **not** sent. Linear offers it to force the consent
 * screen every time, which is how a user connects several workspaces — and Ogun stores one
 * grant per project, so forcing a re-consent would let an operator pick a second workspace
 * that silently replaces the first.
 *
 * PKCE is deliberately not used either. It exists so that a client which cannot keep a
 * secret — a single-page app, a mobile binary — can still do this flow safely. Ogun is a
 * server that already holds the client secret in a 0600 file on the same machine, so PKCE
 * would add a code verifier to protect a channel whose other end is the same process.
 */
export function authorizationUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  scopes?: readonly string[]
  actor?: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', (input.scopes ?? LINEAR_SCOPES).join(','))
  url.searchParams.set('state', input.state)
  url.searchParams.set('actor', input.actor ?? LINEAR_ACTOR)
  return url.toString()
}

/**
 * Spend an authorization code.
 *
 * `redirect_uri` is required by Linear and has to be byte-identical to the one the
 * authorization used — which is why it is stored on the application and carried through
 * the pending-authorization entry rather than recomputed here from whatever the current
 * request happens to look like.
 */
export function exchangeCode(input: {
  code: string
  redirectUri: string
  clientId: string
  clientSecret: string
  fetch?: Fetch
  tokenUrl?: string
}): Promise<LinearTokens> {
  return tokenCall({
    fetch: input.fetch,
    tokenUrl: input.tokenUrl,
    grantType: 'authorization_code',
    // Order matters to nothing on the wire; it matters here because this array is also
    // the scrub list, and it must name every secret the body contains.
    secrets: [input.clientSecret, input.code],
    body: {
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
    },
  })
}

/**
 * Ask Linear for a token in Ogun's own name, with no browser and nobody's approval.
 *
 * This is the **default** way a project connects, and the reason is that everything the
 * authorization-code flow needs in order to be safe is machinery this grant does not have
 * to defend: no browser step, no redirect URI for Linear to match byte-for-byte, no
 * `state` nonce, no authorization code sitting in a query string that `hono/logger` writes
 * to the journal twice. Those were not incidental costs — they are three quarters of
 * ADR-0014 — and a grant that needs none of them is not a shortcut, it is a smaller
 * attack surface.
 *
 * What comes back, from Linear's own documentation: an `app` actor token — implicitly, so
 * there is no `actor` parameter to send — which "has access to all public teams in the
 * workspace", lasting `2591999` seconds (30 days), with **no refresh token**, because
 * "your server is expected to fetch a new token if it receives a 401 error".
 *
 * ### The two costs, named rather than buried
 *
 *  - **Public teams only.** A workspace whose teams are private gets a token that
 *    authenticates perfectly and reads nothing, which is the worst failure shape there is:
 *    a poll that succeeds and returns zero tickets forever. `visibleTeams` exists to make
 *    that visible at the moment of connecting, and `--consent` is the way out of it.
 *  - **A workspace-wide token.** It reaches every public team, where an approver could
 *    have granted less. Scope still bounds it — `read` and nothing else — but membership
 *    does not.
 *
 * `scope` is required and **comma**-separated, the same delimiter `authorizationUrl` uses
 * and the opposite of the space-separated `scope` that comes back. It is sent explicitly
 * rather than relying on Linear's note that `read` "will always be present": a request
 * that leans on a default is a request whose meaning changes when the default does.
 *
 * The client secret goes in the form body rather than in an HTTP basic header, which
 * Linear also accepts, for the reason `refreshGrant` gives — a header is the part of a
 * request people paste into bug reports.
 */
export function appTokenGrant(input: {
  clientId: string
  clientSecret: string
  scopes?: readonly string[]
  fetch?: Fetch
  tokenUrl?: string
}): Promise<LinearTokens> {
  return tokenCall({
    fetch: input.fetch,
    tokenUrl: input.tokenUrl,
    grantType: 'client_credentials',
    secrets: [input.clientSecret],
    body: {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      scope: (input.scopes ?? LINEAR_SCOPES).join(','),
      grant_type: 'client_credentials',
    },
  })
}

/**
 * Spend a refresh token for a new pair.
 *
 * **Linear rotates the refresh token**: the response carries a new access token *and a new
 * refresh token*, and the old one is consumed. ADR-0010 rejected refreshing an OAuth token
 * inside the gateway for exactly that reason — rotation there would silently log a human
 * out of their own `claude` CLI, because the credential was borrowed from a file the human
 * also uses. None of that applies here. Ogun obtained this grant for itself, nothing else
 * on the machine has a copy, and the only writer of the file it lives in takes a lock.
 *
 * What rotation *does* cost is that a lost response is a lost grant, so the caller must
 * persist the new pair before relying on it — and Linear's 30-minute replay window covers
 * the case where the write happened and the response did not arrive. `refreshGrant` itself
 * has no retry: replaying is a decision about a stored value, which belongs to the caller
 * that owns the store.
 *
 * `client_secret` is sent as a parameter rather than as HTTP basic auth. Linear accepts
 * both. A parameter keeps this call the same shape as the exchange above — one form body,
 * one scrub list — where a basic-auth header would put a base64 of the secret in a
 * *header*, which is the part of a request that gets copied into a bug report.
 */
export function refreshGrant(input: {
  refreshToken: string
  clientId: string
  clientSecret: string
  fetch?: Fetch
  tokenUrl?: string
}): Promise<LinearTokens> {
  return tokenCall({
    fetch: input.fetch,
    tokenUrl: input.tokenUrl,
    grantType: 'authorization_code',
    secrets: [input.clientSecret, input.refreshToken],
    body: {
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
    },
  })
}

/**
 * Tell Linear the token is finished with, on disconnect.
 *
 * Best-effort by contract, not by accident: it returns whether it worked rather than
 * throwing, because the caller forgets the grant locally either way. A disconnect that
 * failed because Linear was unreachable must still remove the credential from this
 * machine — refusing would leave an operator unable to revoke a token they no longer want,
 * which is the opposite of what the button is for. Linear answers 400 for a token that was
 * already revoked, which is a success from where this sits.
 */
export async function revokeToken(input: {
  token: string
  fetch?: Fetch
  revokeUrl?: string
}): Promise<{ revoked: boolean }> {
  const doFetch = input.fetch ?? globalThis.fetch
  try {
    const response = await doFetch(input.revokeUrl ?? LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: input.token, token_type_hint: 'access_token' }),
    })
    return { revoked: response.ok }
  } catch {
    // Nothing from the failure is kept. There is no remedy to report — the grant is being
    // forgotten regardless — and the only thing an error here could carry is the URL and
    // whatever undici says about the socket, neither of which changes what happens next.
    return { revoked: false }
  }
}

/**
 * Who this token is, asked once at the moment the grant is made.
 *
 * Linear has no token introspection — no RFC 7662 endpoint, and nothing in the GraphQL
 * schema that reports the current token's scopes — so the *only* moment the identity
 * behind a grant is obtainable is while holding a fresh token. Asking here and storing the
 * answer is what lets Settings say "connected to Acme as Ogun" instead of "connected",
 * which is the difference between an operator being able to spot that they authorized the
 * wrong workspace and finding out when tickets never arrive.
 *
 * `viewer.app` is Linear's own confirmation that the token is an app-actor token. It is
 * checked rather than assumed: `actor=app` is a request parameter, and a grant that came
 * back as a user actor would write under a person's name later, silently.
 *
 * A failure here is **not** fatal to the connection and the caller treats it that way. The
 * tokens are valid — they were just issued — and refusing to store a working grant because
 * a cosmetic query failed would turn a display problem into a broken connect.
 */
export type LinearIdentity = {
  workspace?: { id: string; name: string; urlKey: string }
  appUserId?: string
  actorIsApp: boolean
}

const IDENTITY_QUERY = `query OgunGrantIdentity {
  viewer { id name app }
  organization { id name urlKey }
}`

export async function identify(input: {
  accessToken: string
  fetch?: Fetch
  endpoint?: string
}): Promise<LinearIdentity> {
  const doFetch = input.fetch ?? globalThis.fetch
  const response = await doFetch(input.endpoint ?? GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify({ query: IDENTITY_QUERY }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The body is discarded rather than sliced into the message. This request carries a
    // live access token in a header, and an upstream that echoes a request — a proxy error
    // page, a debug endpoint — is exactly the case where the body is worth nothing and
    // costs everything.
    throw new LinearOAuthError('transport', `${response.status} from linear's graphql api`)
  }
  const data = asRecord(asRecord(parsed)?.data)
  const viewer = asRecord(data?.viewer)
  const org = asRecord(data?.organization)
  return {
    ...(org && typeof org.id === 'string' && typeof org.name === 'string' && typeof org.urlKey === 'string'
      ? { workspace: { id: org.id, name: org.name, urlKey: org.urlKey } }
      : {}),
    ...(viewer && typeof viewer.id === 'string' ? { appUserId: viewer.id } : {}),
    actorIsApp: viewer?.app === true,
  }
}

/**
 * Which teams this token can actually see — asked once, at connect, and never stored.
 *
 * ### The failure this exists for
 *
 * A `client_credentials` token "has access to all public teams in the workspace", which is
 * Linear's sentence and is also a trapdoor. A workspace whose teams are **private** hands
 * back a token that authenticates perfectly, answers every query, and returns nothing — so
 * the symptom is not an error anywhere. It is a source that polls every five minutes,
 * records `ok`, sees zero tickets, and emits no jobs, forever, while `connections`,
 * `doctor` and the Settings card all say the connection is healthy. Nothing in the
 * credential is wrong. There is simply no overlap between what the operator wanted polled
 * and what the token can reach.
 *
 * ADR-0014 named the adjacent gap honestly — *"whether a `read`-only `actor=app` install
 * can read issues at all, which the documentation implies and nothing here has observed"*
 * — and this is the cheapest possible observation of it: one query, at the one moment a
 * person is watching, whose answer is printed beside the connection they just made. An
 * operator who does not see their team in that list knows immediately, rather than in a
 * fortnight.
 *
 * ### Why it is a second request rather than two fields on `identify`'s query
 *
 * Because GraphQL fails a whole document on a validation error. `teams` takes pagination
 * arguments and its field set is one that could plausibly differ across API versions, so
 * folding it into the identity query would mean a rename at Linear taking the workspace
 * name and the actor check down with it — turning a cosmetic addition into a connect that
 * cannot report who it connected as. Two calls cost one round trip on a command a human is
 * waiting on, and each fails alone.
 *
 * ### Why nothing stores the answer
 *
 * A team list is a fact about a workspace at one instant, and workspaces gain teams. A
 * stored copy would be consulted later by something that believed it, and would be wrong
 * in the direction that matters: reporting a team as unreachable after somebody made it
 * public. It is printed and dropped.
 *
 * Returns an empty list rather than throwing, for the reason `identify` does not throw:
 * the tokens are valid and were just issued, and a connect that failed because a
 * *reassurance* query failed would be a working credential thrown away over a display.
 */
export type LinearTeam = { id: string; key: string; name: string }

const TEAMS_QUERY = `query OgunVisibleTeams {
  teams(first: 50) { nodes { id key name } }
}`

export async function visibleTeams(input: {
  accessToken: string
  fetch?: Fetch
  endpoint?: string
}): Promise<LinearTeam[]> {
  const doFetch = input.fetch ?? globalThis.fetch
  try {
    const response = await doFetch(input.endpoint ?? GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({ query: TEAMS_QUERY }),
    })
    const parsed: unknown = JSON.parse(await response.text())
    const nodes = asRecord(asRecord(asRecord(parsed)?.data)?.teams)?.nodes
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): LinearTeam[] => {
      const team = asRecord(node)
      return team && typeof team.id === 'string' && typeof team.key === 'string' &&
        typeof team.name === 'string'
        ? [{ id: team.id, key: team.key, name: team.name }]
        : []
    })
  } catch {
    // Nothing from the failure is kept, and nothing is logged. The caller cannot act on it
    // and the body would carry a live access token's worth of context for no gain.
    return []
  }
}

// ── the one call all three grants make ─────────────────────────────────────

async function tokenCall(input: {
  body: Record<string, string>
  secrets: string[]
  grantType: LinearGrantType
  fetch?: Fetch
  tokenUrl?: string
}): Promise<LinearTokens> {
  const doFetch = input.fetch ?? globalThis.fetch
  const url = input.tokenUrl ?? LINEAR_TOKEN_URL

  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      // Linear: "Pass parameters in body as URL-encoded form submission, where the
      // Content-Type header must be application/x-www-form-urlencoded." A JSON body is
      // accepted by many token endpoints and not by this one.
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(input.body),
    })
  } catch (err) {
    throw new LinearOAuthError(
      'transport',
      // `err.message` from undici names the host and the syscall and never the body, so
      // it is safe as it stands — and it is scrubbed anyway, because "safe as it stands"
      // is a claim about a dependency's current formatting.
      `could not reach ${url}: ${scrubSecrets(asMessage(err), input.secrets)}`,
    )
  }

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LinearOAuthError(
      'transport',
      `${response.status} from ${url}, and the body was not JSON: ` +
        // Scrubbed *then* sliced, and in that order: slicing first can cut a secret in
        // half and leave the half the scrubber no longer recognises.
        truncate(scrubSecrets(text, input.secrets)),
    )
  }

  const record = asRecord(parsed)
  if (record === undefined) {
    throw new LinearOAuthError('transport', `${response.status} from ${url} with a non-object body`)
  }

  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw classifyTokenError(record, response.status, input.secrets)
  }

  const refreshToken = record.refresh_token
  const gotRefresh = typeof refreshToken === 'string' && refreshToken !== ''

  /**
   * A missing refresh token is a refusal for one grant and the documented answer for the
   * other, and this used to be a flat refusal for both.
   *
   * **What the old rule said, and it is worth quoting because it was right at the time:**
   * *"a token with no way to renew it is a connection that stops working in 30 days with
   * no warning"*. That reasoning assumed the only renewal Ogun had was a refresh token. It
   * is no longer true. A `client_credentials` token is renewed by *asking again* with the
   * client id and secret already in the store — no person, no browser, nothing spent — so
   * the absence of a refresh token there costs nothing at all.
   *
   * It still costs everything for `authorization_code`. That grant rotates: the pair that
   * comes back replaces the pair that went out, and a response with no refresh token in it
   * means the next renewal has nothing to spend. A build that shrugged at that would store
   * a connection that dies in a day and reports as healthy until it does — so the refusal
   * stays exactly where it was, narrowed to the grant it was ever about.
   */
  if (input.grantType === 'authorization_code' && !gotRefresh) {
    throw new LinearOAuthError(
      'config',
      "linear returned an access token with no refresh token beside it, and this is the " +
        'authorization-code grant, which rotates — so there would be nothing to renew it ' +
        'with. Nothing was stored',
    )
  }

  return {
    accessToken,
    ...(gotRefresh ? { refreshToken } : {}),
    expiresAt: expiresAtFrom(record.expires_in, input.grantType),
    scopes: scopesFrom(record.scope),
    grantType: input.grantType,
  }
}

/**
 * Which kind of failure a token endpoint just reported.
 *
 * Linear documents one error body — `{ error, error_description }` — and documents it only
 * for the client-credentials grant, where `error` is the literal string `"Error"` rather
 * than an RFC 6749 code. So this cannot switch on a code table that does not exist, and
 * matching on the *text* is what is left. That is fragile by nature, so the fragility is
 * arranged to fail in the safe direction: an unrecognised failure is `transport`, which
 * keeps the stored refresh token and retries later, rather than `invalid-grant`, which
 * would throw away a working connection because a message was reworded.
 *
 * The description is scrubbed before it is used at all, including in the matching, because
 * the thing being matched is a string an upstream server wrote and may have built out of
 * the parameters this process just sent it.
 */
function classifyTokenError(
  record: Record<string, unknown>,
  status: number,
  secrets: string[],
): LinearOAuthError {
  const code = typeof record.error === 'string' ? scrubSecrets(record.error, secrets) : ''
  const description =
    typeof record.error_description === 'string'
      ? scrubSecrets(record.error_description, secrets)
      : ''
  const said = truncate([code, description].filter((s) => s !== '').join(': '))
  const haystack = said.toLowerCase()

  if (haystack.includes('redirect')) {
    return new LinearOAuthError(
      'config',
      `linear rejected the redirect uri (${said}). It has to match one of the callback ` +
        "URLs registered on the application, exactly — including the scheme, the port " +
        'and any trailing slash',
    )
  }
  if (
    haystack.includes('invalid_grant') ||
    haystack.includes('invalid_client') ||
    haystack.includes('expired') ||
    haystack.includes('revoked')
  ) {
    return new LinearOAuthError(
      'invalid-grant',
      `linear refused the grant (${said}). Reconnecting is the fix; retrying is not`,
    )
  }
  return new LinearOAuthError(
    'transport',
    said === ''
      ? `${status} from linear's token endpoint, with no access token and no error in the body`
      : `${status} from linear's token endpoint: ${said}`,
  )
}

/**
 * `expires_in` seconds → an absolute instant.
 *
 * Converted here, once, at the only place that has both the number and the moment it
 * arrived. A duration stored raw is true for one instant and wrong for every instant
 * after, so a config.json read back after a restart would report 24 hours remaining
 * forever — a token that is never refreshed because it never looks close to expiring.
 *
 * A missing or unusable `expires_in` falls back to the lifetime Linear documents for that
 * grant — 24 hours for `authorization_code`, 30 days (`2591999` seconds) for
 * `client_credentials` — rather than to "no expiry". The fallback is per grant rather than
 * one number because being wrong in either direction has a cost and they are not
 * symmetric: 24 hours applied to a 30-day token spends 29 unnecessary renewals, and 30
 * days applied to a 24-hour token is the 3am 401 this whole path exists to avoid. Sooner
 * is the safe direction, and the safe direction is only cheap when it is roughly right.
 */
const FALLBACK_LIFETIME_MS: Record<LinearGrantType, number> = {
  authorization_code: 24 * 60 * 60 * 1000,
  client_credentials: 2591999 * 1000,
}

function expiresAtFrom(raw: unknown, grantType: LinearGrantType, now = Date.now()): number {
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return now + FALLBACK_LIFETIME_MS[grantType]
  return now + seconds * 1000
}

/**
 * The granted scopes, out of a field that has had two shapes.
 *
 * Space-delimited in the token response today. Linear notes that "OAuth apps created prior
 * to Dec 1, 2023 will instead return scope as an array of strings", and both are accepted
 * — not out of defensiveness, but because the alternative is a grant that records no
 * scopes at all for a workspace whose application predates that change, and there is no
 * introspection endpoint anywhere to recover them from later.
 */
function scopesFrom(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string')
  if (typeof raw !== 'string') return []
  return raw.split(/[\s,]+/).filter((s) => s !== '')
}

/**
 * Remove every value this call sent or received from a string that is about to become an
 * error message.
 *
 * The belt beside the braces. Every message in this file is already built from a fixed
 * sentence plus fields chosen by hand, so in principle nothing needs scrubbing — and that
 * is exactly the reasoning that was true of `execFile`'s message before `bbaa036`, of
 * `JSON.parse`'s before `parseLocalConfig`, and of `c.req.json()`'s before the secrets
 * route. The pattern in all three is that the leak came from a string somebody else
 * formatted, and a token endpoint's `error_description` is a string somebody else
 * formatted out of the parameters we just handed them.
 *
 * Short values are skipped. A one-character "secret" would turn every message into
 * confetti, and a scrubber that mangles unrelated text is a scrubber people work around.
 */
const MIN_SCRUB_LENGTH = 8

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SCRUB_LENGTH) continue
    // `split`/`join` rather than a regex: a credential is arbitrary bytes and building a
    // pattern out of one is how a scrubber throws instead of scrubbing.
    out = out.split(secret).join('[redacted]')
  }
  return out
}

/** Enough to recognise an HTML error page; not enough to be a paste of one. */
const truncate = (text: string): string =>
  text.length <= 200 ? text : `${text.slice(0, 200)}…`

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
