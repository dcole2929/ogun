import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  authorizationUrl,
  exchangeCode,
  identify,
  LinearOAuthError,
  refreshGrant,
  revokeToken,
  scrubSecrets,
} from '../src/integrations/linear-oauth.ts'
import {
  identityResponse,
  refreshedResponse,
  tokenErrorResponse,
  tokenResponse,
} from './linear-oauth-fixtures.ts'

/**
 * The OAuth client, against recorded responses (ADR-0014).
 *
 * A stubbed `fetch` rather than a local socket, unlike `linear-client.test.ts`. The
 * difference is what is being protected: that suite asserts header *bytes*, which only a
 * real request can show, while everything here is about the request Ogun *composes* — the
 * form encoding, the delimiter on `scope`, the unit on `expires_in` — and about what a
 * failure is allowed to say. A stub is what lets a test assert the exact body that went
 * out and then feed back a body nobody could produce on purpose.
 *
 * `linear-oauth-fixtures.ts` records where every response shape came from and, more
 * importantly, that none of it was captured live.
 */

const CLIENT_SECRET = 'lin_secret_QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'
const CODE = 'code_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

type Call = { url: string; body: string; contentType: string | null }

/** A `fetch` that records what it was asked to send and answers with a fixture. */
const stub = (status: number, body: string) => {
  const calls: Call[] = []
  const fn = (async (url: unknown, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as Record<string, string>)
    calls.push({
      url: String(url),
      body: init.body === undefined ? '' : String(init.body),
      contentType: headers.get('content-type'),
    })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

// ── the authorization request ──────────────────────────────────────────────

/**
 * The property: `scope` is comma-separated on the way out and space-separated on the way
 * back, and this build has to get both right in the two different places.
 *
 * What a naive implementation does is pick one delimiter and use it everywhere, because
 * every other OAuth provider uses spaces on the request. `scope=read%20write` is then a
 * request for a single scope literally named `read write`, which Linear answers by
 * granting nothing useful — and the token response's `scope` field, being space-delimited,
 * looks correct in the debugger the whole time.
 *
 * `actor=app` is asserted for a different reason: it is the entire justification for this
 * feature existing rather than the personal API key, and it is a parameter whose absence
 * is invisible. A grant made without it works perfectly and attributes every future write
 * to a person.
 */
test('the authorization url uses comma-separated scopes, and asks for the app actor', () => {
  const url = new URL(
    authorizationUrl({
      clientId: 'client-1',
      redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
      state: 'nonce-1',
      scopes: ['read', 'comments:create'],
    }),
  )

  assert.equal(url.origin + url.pathname, 'https://linear.app/oauth/authorize')
  assert.equal(url.searchParams.get('scope'), 'read,comments:create')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('actor'), 'app')
  assert.equal(url.searchParams.get('state'), 'nonce-1')
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://localhost:7777/api/oauth/linear/callback',
  )
})

// ── the exchange ───────────────────────────────────────────────────────────

/**
 * The property: the exchange is a form submission, and `expires_in` seconds become an
 * absolute instant at the moment the response arrives.
 *
 * Two things a naive implementation gets wrong, and both are quiet. Sending JSON is the
 * default reflex and Linear's token endpoint requires `x-www-form-urlencoded`; the
 * rejection names a parse failure rather than a content type. And storing `expires_in`
 * as-is means a config.json read back after a restart reports 24 hours remaining forever —
 * so the token is never renewed, and the first symptom is a 401 at 3am on a poll that
 * "should" have had a full day left.
 */
test('the exchange posts a form, and turns expires_in seconds into an absolute expiry', async () => {
  const { fn, calls } = stub(200, tokenResponse())
  const before = Date.now()
  const tokens = await exchangeCode({
    code: CODE,
    redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  })

  assert.equal(calls[0]?.url, 'https://api.linear.app/oauth/token')
  assert.equal(calls[0]?.contentType, 'application/x-www-form-urlencoded')
  const sent = new URLSearchParams(calls[0]!.body)
  assert.equal(sent.get('grant_type'), 'authorization_code')
  assert.equal(sent.get('code'), CODE)
  assert.equal(sent.get('client_secret'), CLIENT_SECRET)
  // Linear requires the redirect uri to match the authorization's, byte for byte.
  assert.equal(sent.get('redirect_uri'), 'http://localhost:7777/api/oauth/linear/callback')

  assert.deepEqual(tokens.scopes, ['read'])
  // 86399 seconds from now, give or take the time this test took.
  assert.ok(tokens.expiresAt >= before + 86_398_000)
  assert.ok(tokens.expiresAt <= Date.now() + 86_399_000)
})

/**
 * The property: a token with no refresh token beside it is refused rather than stored.
 *
 * This is exactly what Linear's `client_credentials` grant returns — a 30-day token their
 * own documentation says to replace by reacting to a 401. Accepting one would produce a
 * connection that reports as healthy, polls happily for a month, and then stops with an
 * authentication error that looks like a revoked grant. The naive implementation treats
 * `refresh_token` as optional because the type it lands in has it optional.
 */
test('an access token with no refresh token is refused, not stored', async () => {
  const { fn } = stub(200, tokenResponse({ refresh_token: undefined, expires_in: 2_591_999 }))
  const err = await exchangeCode({
    code: CODE,
    redirectUri: 'http://x/cb',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.equal(err.kind, 'config')
  assert.match(err.message, /no way to renew/)
})

// ── nothing leaks ──────────────────────────────────────────────────────────

/**
 * The property this file exists for: **a failed token exchange never quotes the client
 * secret or the authorization code**, whatever the far end sends back.
 *
 * This repository has leaked a credential into a string four separate times —
 * `redactUrlCredentials`, the gateway on a plaintext socket, V8 quoting a window of
 * config.json, and `c.req.json()` quoting a request body. In all four the leak came from a
 * string *somebody else* formatted, and a token endpoint's `error_description` is a string
 * somebody else formatted out of the parameters we just handed them. So the hostile
 * fixture here is one that echoes the request back — which no server should do and which
 * costs nothing to survive.
 *
 * The naive implementation is `throw new Error(\`token exchange failed: \${await
 * response.text()}\`)`, which is what almost every OAuth client written in an afternoon
 * does. That message then reaches `app.onError`, which returns it to the caller *and*
 * `console.error`s it into the journal — putting a live client secret in two places at
 * once, permanently.
 */
test('a token failure that echoes the request back does not echo the secret', async () => {
  const { fn } = stub(
    400,
    tokenErrorResponse(`invalid client_secret=${CLIENT_SECRET} for code=${CODE}`),
  )
  const err = await exchangeCode({
    code: CODE,
    redirectUri: 'http://x/cb',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.doesNotMatch(err.message, /lin_secret_/)
  assert.doesNotMatch(err.message, /code_Z/)
  assert.match(err.message, /\[redacted\]/)
})

/**
 * The same property for a body that is not JSON at all — a proxy's HTML error page, which
 * is the realistic case.
 *
 * The order matters and is the part a rewrite gets wrong: the body is **scrubbed and then
 * truncated**, never the other way round. Truncating first can cut a secret across the
 * boundary and leave a prefix the scrubber no longer recognises, so the message ends up
 * containing the first forty characters of a live client secret.
 */
test('a non-json body is scrubbed before it is truncated', async () => {
  const filler = 'x'.repeat(190)
  const { fn } = stub(502, `<html>${filler}${CLIENT_SECRET}</html>`)
  const err = await refreshGrant({
    refreshToken: 'refresh-abcdefgh',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.equal(err.kind, 'transport')
  assert.doesNotMatch(err.message, /lin_secret_/)
})

/**
 * The scrubber itself, fixed rather than left as an implementation detail.
 *
 * A regex-based version is the tempting one and it is wrong twice: a credential is
 * arbitrary bytes, so building a pattern out of one either throws on a stray `(` or
 * silently matches something else. And a scrubber with no minimum length turns every
 * message into confetti the first time a short value is passed to it, which is how people
 * learn to route around the scrubber.
 */
test('the scrubber replaces every occurrence and ignores values too short to be secrets', () => {
  assert.equal(scrubSecrets('a SECRETVALUE b SECRETVALUE', ['SECRETVALUE']), 'a [redacted] b [redacted]')
  // Regex metacharacters are data here, not syntax.
  assert.equal(scrubSecrets('x a(b[c]d+e x', ['a(b[c]d+e']), 'x [redacted] x')
  // Below the minimum length: left alone, so ordinary words survive.
  assert.equal(scrubSecrets('the value is ok', ['ok']), 'the value is ok')
})

// ── classifying a failure ──────────────────────────────────────────────────

/**
 * The property: an **unrecognised** failure is transient, not permanent.
 *
 * Linear documents no error table for the grants Ogun uses, so this classification is text
 * matching and will eventually meet a message it does not know. The direction it falls in
 * then is the whole design. `transport` keeps the stored refresh token and tries again;
 * `invalid-grant` tells the operator to reconnect. A build that guessed the other way
 * would destroy a working connection the day Linear reworded a sentence — and, because a
 * refresh token is single-use and rotated, "destroy" is literal rather than dramatic.
 */
test('an unrecognised token failure is transient, so the refresh token survives it', async () => {
  const { fn } = stub(500, tokenErrorResponse('something nobody has seen before'))
  const err = await refreshGrant({
    refreshToken: 'refresh-abcdefgh',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.equal(err.kind, 'transport')
})

/**
 * The property: a redirect-URI mismatch is named as one, because it is the classic failure
 * of this flow and Linear's own message for it is not actionable.
 *
 * Reported as a generic "the exchange failed", an operator has no reason to suspect the
 * one string they typed by hand into somebody else's form — and the mismatch is usually a
 * trailing slash or a port, which is invisible when you read it back.
 */
test('a redirect uri mismatch says so, and says what has to match', async () => {
  const { fn } = stub(400, tokenErrorResponse('redirect_uri does not match'))
  const err = await exchangeCode({
    code: CODE,
    redirectUri: 'http://x/cb',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.equal(err.kind, 'config')
  assert.match(err.message, /match one of the callback URLs/)
})

test('an expired or revoked grant is permanent, and says reconnecting is the fix', async () => {
  const { fn } = stub(400, tokenErrorResponse('refresh token has been revoked'))
  const err = await refreshGrant({
    refreshToken: 'refresh-abcdefgh',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  }).then(() => null, (e: unknown) => e)

  assert.ok(err instanceof LinearOAuthError)
  assert.equal(err.kind, 'invalid-grant')
  assert.match(err.message, /Reconnecting is the fix/)
})

// ── refresh and identity ───────────────────────────────────────────────────

/**
 * The property: a refresh sends `grant_type=refresh_token` and takes back **both** tokens.
 *
 * Linear rotates the refresh token, so a client that keeps the old one has a connection
 * that works for 24 hours and then cannot be renewed. The naive implementation reads
 * `access_token` and ignores the rest of the body, because the access token is the one it
 * came for.
 */
test('a refresh takes the new refresh token as well as the new access token', async () => {
  const { fn, calls } = stub(200, refreshedResponse())
  const tokens = await refreshGrant({
    refreshToken: 'old-refresh-token',
    clientId: 'client-1',
    clientSecret: CLIENT_SECRET,
    fetch: fn,
  })

  assert.equal(new URLSearchParams(calls[0]!.body).get('grant_type'), 'refresh_token')
  assert.notEqual(tokens.refreshToken, 'old-refresh-token')
  assert.match(tokens.refreshToken, /^rrrr/)
})

/**
 * The property: `viewer.app` is read as evidence, because `actor=app` is a request
 * parameter and the token response does not echo it back.
 *
 * Nothing else in the flow can tell an app-actor grant from a user-actor one, and the
 * difference is invisible until the first write appears under somebody's name. Linear's
 * own agent documentation asks integrations to store `viewer.id` alongside the token for
 * exactly this reason.
 */
test('identity reads the workspace and whether the token really is an app actor', async () => {
  const asApp = stub(200, identityResponse())
  const app = await identify({ accessToken: 'token', fetch: asApp.fn })
  assert.deepEqual(app.workspace, { id: 'org-1', name: 'Acme', urlKey: 'acme' })
  assert.equal(app.appUserId, 'app-user-1')
  assert.equal(app.actorIsApp, true)

  const asUser = stub(200, identityResponse({ app: false }))
  assert.equal((await identify({ accessToken: 'token', fetch: asUser.fn })).actorIsApp, false)
})

/**
 * The property: a revoke that fails is a `false`, never a throw.
 *
 * Disconnecting forgets the local credential either way. A revoke that threw would leave
 * an operator unable to remove a token from their own machine while Linear was down —
 * which is precisely the moment they most want to.
 */
test('a revoke that cannot reach linear reports false rather than throwing', async () => {
  const dead = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch
  assert.deepEqual(await revokeToken({ token: 'token', fetch: dead }), { revoked: false })

  // 400 is what Linear answers for a token that was already revoked, which is a success
  // from where the caller sits — but it is reported honestly rather than rewritten.
  const { fn } = stub(400, '{}')
  assert.deepEqual(await revokeToken({ token: 'token', fetch: fn }), { revoked: false })
})
