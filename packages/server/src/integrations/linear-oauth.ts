/**
 * Linear's OAuth 2.0 flow, behind one seam (ADR-0014).
 *
 * The same shape as `linear.ts` beside it and for the same reason: there is no Linear
 * application registered to this project and no credential on any machine here, so
 * everything below was built against Linear's published documentation and is exercised by
 * fixtures. `test/linear-oauth-fixtures.ts` records exactly what that proves and what it
 * does not, the way `linear-fixtures.ts` does for the GraphQL client.
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

/** What a successful token call yields, in Ogun's units rather than Linear's. */
export type LinearTokens = {
  accessToken: string
  refreshToken: string
  /** Absolute ms. Converted here, once, from Linear's `expires_in` seconds. */
  expiresAt: number
  scopes: string[]
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

// ── the one call both grants make ──────────────────────────────────────────

async function tokenCall(input: {
  body: Record<string, string>
  secrets: string[]
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
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    /**
     * A token with no refresh token beside it. Linear's `client_credentials` grant returns
     * exactly this — a 30-day token their docs say to replace by reacting to a 401 — and
     * accepting one here would store a connection this build has no way to renew, which
     * looks healthy for a month and then stops. Refused at the door instead, because the
     * store refuses it too (`parseOAuthApp` requires the field) and a value rejected in two
     * places with two different messages is worse than one rejected here with a reason.
     */
    throw new LinearOAuthError(
      'config',
      'linear returned an access token with no refresh token. That is what the ' +
        'client-credentials grant does, and Ogun cannot use it: a token with no way to ' +
        'renew it is a connection that stops working in 30 days with no warning',
    )
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtFrom(record.expires_in),
    scopes: scopesFrom(record.scope),
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
 * A missing or unusable `expires_in` falls back to Linear's documented 24 hours rather
 * than to "no expiry". Being wrong towards *sooner* costs one unnecessary refresh; being
 * wrong towards later is the 3am 401 this whole path exists to avoid.
 */
const FALLBACK_LIFETIME_MS = 24 * 60 * 60 * 1000

function expiresAtFrom(raw: unknown, now = Date.now()): number {
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return now + FALLBACK_LIFETIME_MS
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
