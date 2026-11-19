import { strict as assert } from 'node:assert'
import { before, test } from 'node:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  appJwt,
  botLogin,
  GithubAppError,
  installationIdentity,
  installationToken,
} from '../src/integrations/github-app.ts'
import { installationResponse, installationTokenResponse } from './github-app-fixtures.ts'

/**
 * A GitHub App authenticating as itself — the JWT and the two calls it signs.
 *
 * `github-app-fixtures.ts` records what these fixtures are recordings *of*, and the short
 * version is the part that matters: **no GitHub App exists for this repository and no
 * private key exists on any machine here**, so nothing below has spoken to GitHub. What is
 * proved is the half that is ours — the signature, the claims, the units, the
 * classification of failures, and that no credential reaches an error message. What is not
 * proved is that GitHub accepts any of it.
 *
 * The JWT half is better than a fixture, and deliberately: a real 2048-bit RSA key is
 * generated here and the signature is verified with `node:crypto` against its public half.
 * That is the one thing in this file that would still be true if GitHub changed everything
 * else — RS256 over `<header>.<payload>` is a specification, not a vendor's behaviour.
 */

const APP_ID = '1234567'
const INSTALLATION_ID = '98765432'

let privateKey = ''
let publicKey = ''

before(() => {
  // 2048 rather than 4096: this runs on every `node --test` and the key is thrown away.
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKey = pair.privateKey
  publicKey = pair.publicKey
})

const decode = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>

type Answer = [number, string]

/** A `fetch` that routes by path, so one stub covers the mint and the description. */
const wire = (over: Partial<Record<'token' | 'install', Answer>> = {}) => {
  const calls: Array<{ method: string; path: string; authorization: string }> = []
  const fn = (async (url: unknown, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      method: init.method ?? 'GET',
      path,
      authorization: headers.authorization ?? '',
    })
    if (path.endsWith('/access_tokens')) {
      const [status, body] = over.token ?? [201, installationTokenResponse()]
      return new Response(body, { status })
    }
    const [status, body] = over.install ?? [200, installationResponse()]
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

const deps = (fetch: typeof globalThis.fetch) => ({
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  privateKey,
  fetch,
  endpoint: 'https://github.test',
})

// ── the JWT ────────────────────────────────────────────────────────────────

/**
 * The property: the JWT is a **verifiable** RS256 signature over the header and payload,
 * with the three claims GitHub documents.
 *
 * Verified rather than merely shaped, because every other way to test this proves only
 * that the author and the parser agree. A JWT with the right fields and a signature over
 * the wrong bytes — `header + payload` without the dot, or the decoded JSON rather than
 * the base64url — is accepted by every assertion about its structure and rejected by
 * GitHub with a 401 that reads like a bad key.
 *
 * `node:crypto` signs this rather than a library, which is a decision about dependencies:
 * the CLI is bundled into the sandbox image (§7), so a package here is a package in a
 * container, and there are three claims and one algorithm.
 */
test('the jwt is a real RS256 signature over the header and payload', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0)
  const token = appJwt({ appId: APP_ID, privateKey, now })
  const [header, payload, signature] = token.split('.')
  assert.ok(header && payload && signature)

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  assert.equal(
    verifier.verify(publicKey, signature, 'base64url'),
    true,
    'the signature does not cover `<header>.<payload>`, which is what GitHub verifies',
  )

  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' })
  const claims = decode(payload)
  assert.equal(claims.iss, APP_ID, 'iss is the App id')

  const nowS = Math.floor(now / 1000)
  /**
   * `iat` is backdated by a minute, which is GitHub's own guidance: a clock slightly slow
   * here produces an `iat` in GitHub's future, and their answer to that is a 401 saying
   * *"'Issued at' claim ('iat') must be an Integer representing the time that the assertion
   * was issued"* — which reads like a bad key rather than like a clock.
   */
  assert.equal(claims.iat, nowS - 60)
  /**
   * And `exp` is inside GitHub's ten-minute ceiling, which they **reject** above rather
   * than clamp. The margin is for a clock slightly *fast* here, which is the mirror image
   * of the same failure.
   */
  const life = (claims.exp as number) - nowS
  assert.ok(life > 0 && life <= 10 * 60, `exp is ${life}s out, and GitHub's ceiling is 600`)
  assert.ok(life <= 9 * 60, 'no margin left for a fast clock')
})

/**
 * The property: a private key `node:crypto` cannot read is a `config` failure that
 * **quotes nothing**.
 *
 * `config` because the remedy is in GitHub's UI rather than here, and waiting fixes
 * nothing. The silence is the half worth a test: OpenSSL's errors for a malformed PEM are
 * terse and have at times carried a window of the input, and the input here is the entire
 * credential. The remedy does not depend on *which way* it was malformed, so none of the
 * underlying message is kept.
 */
test('an unreadable private key fails as config, quoting nothing of the key', () => {
  const nonsense = '-----BEGIN RSA PRIVATE KEY-----\nTHISISNOTAKEY\n-----END RSA PRIVATE KEY-----'
  const err = (() => {
    try {
      appJwt({ appId: APP_ID, privateKey: nonsense })
      return null
    } catch (e: unknown) {
      return e
    }
  })()

  assert.ok(err instanceof GithubAppError)
  assert.equal(err.kind, 'config')
  assert.ok(!err.message.includes('THISISNOTAKEY'), 'the message quoted the key')
  assert.match(err.message, /BEGIN RSA PRIVATE KEY/, 'and it says what a key looks like')
})

// ── the mint ───────────────────────────────────────────────────────────────

/**
 * The property: the mint is a **POST** carrying the JWT as a bearer, and what comes back is
 * converted into Ogun's units.
 *
 * Three things here are the easiest to get wrong and each would pass a test that only
 * looked at the happy path's return value:
 *
 *  - GitHub answers **201**. A check written as `status === 200` rejects every success.
 *  - The field is `token`, not `access_token` — the OAuth name a reader coming from
 *    `linear-oauth.ts` would reach for.
 *  - `expires_at` is an **instant**, where Linear's `expires_in` is a duration. Treated as
 *    a duration it would be a token that expired in 1970.
 */
test('the mint posts the jwt and converts the response into absolute units', async () => {
  const { fn, calls } = wire()
  const token = await installationToken(deps(fn))

  assert.deepEqual(calls.map((c) => [c.method, c.path]), [
    ['POST', `/app/installations/${INSTALLATION_ID}/access_tokens`],
  ])
  assert.match(calls[0]!.authorization, /^Bearer eyJ/, 'the JWT goes in the authorization header')

  assert.equal(token.accessToken, 'ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(token.expiresAt, Date.UTC(2026, 10, 19, 12, 0, 0))
  /**
   * The permissions are flattened to `name:level` strings and **sorted**, because they go
   * into the same `scopes` field every other grant uses. Sorted so that two mints of one
   * installation produce the same list and a stored grant does not appear to have changed
   * because an object's keys arrived in a different order.
   */
  assert.deepEqual(token.permissions, ['contents:read', 'pull_requests:read'])
  assert.equal(token.repositorySelection, 'all')
})

/**
 * The property: an `expires_at` this build cannot read falls back to the **documented
 * lifetime**, not to "no expiry".
 *
 * A `Date.parse` of a format GitHub changed is `NaN`, and a `NaN` expiry falls through
 * every comparison — so the token is either renewed on every poll or never renewed at all
 * depending on which way the comparison happens to be written, and both are silent. One
 * hour is the safe direction: too short spends an extra mint, too long is the 3am 401 the
 * refresh-before-use path exists to avoid.
 */
test('an unreadable expiry falls back to the documented hour', async () => {
  const at = Date.UTC(2026, 10, 19, 9, 0, 0)
  const { fn } = wire({ token: [201, installationTokenResponse({ expires_at: 'soon' })] })
  const token = await installationToken({ ...deps(fn), now: () => at })
  assert.equal(token.expiresAt, at + 60 * 60 * 1000)
})

/**
 * The property: 401 and 404 are **permanent** (`config`), and a 5xx is not.
 *
 * The classification is the whole value of the error type and getting it backwards costs
 * something real in both directions. A 401 reported as `transport` is a revoked private
 * key that a poller retries every five minutes forever, with the ledger saying "look again
 * tomorrow"; a 5xx reported as `config` is a connection declared dead because GitHub had a
 * bad minute.
 *
 * 404 sits with 401 because GitHub answers it for an installation the App cannot see —
 * rather than 403, so that an App cannot enumerate installations it has no business
 * knowing about. In practice it is an App somebody uninstalled, and no amount of waiting
 * reinstalls it.
 */
test('a refused credential is permanent and a server error is not', async () => {
  for (const status of [401, 404]) {
    const { fn } = wire({ token: [status, '{"message":"Bad credentials"}'] })
    const err = await installationToken(deps(fn)).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof GithubAppError, String(status))
    assert.equal(err.kind, 'config', String(status))
    assert.match(err.message, /Check the App id, the installation id/)
  }

  const { fn } = wire({ token: [503, 'upstream is having a moment'] })
  const transient = await installationToken(deps(fn)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(transient instanceof GithubAppError)
  assert.equal(transient.kind, 'transport')
})

/**
 * The property: **no failure message carries the JWT, and none carries the token.**
 *
 * The fifth instance of the rule this repository has had four of —
 * `redactUrlCredentials`, a real token on a plaintext socket, V8 quoting a window of
 * `config.json`, and `c.req.json()` quoting a request body. A token endpoint is the obvious
 * next one, because the *request* carries a bearer credential and there is nothing stopping
 * a server from echoing a header or a parameter back in a body.
 *
 * The body-echo case is the one that needs a fixture rather than an argument: a proxy error
 * page that reflects the request is exactly where a naive `text.slice(0, 200)` puts a live
 * credential into an error string.
 */
test('no failure message carries the jwt, even when the response echoes it', async () => {
  // A stub that reflects whatever it was sent, which is what a debug endpoint or a
  // misconfigured proxy does.
  let jwt = ''
  const reflecting = (async (url: unknown, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    jwt = (headers.authorization ?? '').replace('Bearer ', '')
    return new Response(`<html>rejected request: ${jwt}</html>`, { status: 502 })
  }) as unknown as typeof globalThis.fetch

  const err = await installationToken(deps(reflecting)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof GithubAppError)
  assert.ok(jwt.length > 100, 'the stub did not see a JWT, so this proves nothing')
  assert.ok(!err.message.includes(jwt), `the error carried the JWT: ${err.message}`)
  assert.match(err.message, /redacted/)

  // A body that is not JSON at all takes a different branch, and it is scrubbed too —
  // scrubbed *then* truncated, because truncating first can cut a credential in half and
  // leave the half the scrubber no longer recognises.
  const notJson = wire({ token: [201, 'this is not json'] })
  const parse = await installationToken(deps(notJson.fn)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(parse instanceof GithubAppError)
  assert.equal(parse.kind, 'transport')
})

/**
 * The property: a 201 with no token in it is a **transport** failure rather than a success
 * carrying an empty credential.
 *
 * The naive implementation reads `record.token` and hands back `undefined`, which becomes
 * the string `"undefined"` in an `authorization` header three layers away — a 401 naming
 * nothing. `linear-oauth.ts` refuses the same shape for the same reason.
 */
test('a success with no token in it is refused rather than returned', async () => {
  const { fn } = wire({ token: [201, '{"expires_at":"2026-11-19T12:00:00Z"}'] })
  const err = await installationToken(deps(fn)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof GithubAppError)
  assert.match(err.message, /without a token in it/)
})

// ── who the installation is ────────────────────────────────────────────────

/**
 * The property: **one call** yields both the account the application is named after and
 * the login its writes are attributed to.
 *
 * Both are obtainable only while holding the key, and both are load-bearing rather than
 * cosmetic. The account is what makes a *shared* application nameable —
 * `github:heirchive`, derived from what GitHub reported rather than from whichever project
 * connected first. The bot login is what `loopGuard` compares comment authors against, and
 * a source that gets that wrong feeds itself.
 *
 * `GET /user` is not how this is asked and it is worth a sentence rather than a comment: an
 * installation token is not a user and that endpoint answers 403 for one. The server's
 * `githubLogin` does ask `/user`, correctly, because the credential it identifies is a
 * personal access token.
 */
test('one call gives the account to name the application after and the bot login', async () => {
  const { fn, calls } = wire()
  const identity = await installationIdentity(deps(fn))

  assert.deepEqual(calls.map((c) => [c.method, c.path]), [
    ['GET', `/app/installations/${INSTALLATION_ID}`],
  ])
  assert.equal(identity.account, 'Heirchive')
  assert.equal(identity.accountId, '42')
  assert.equal(identity.accountType, 'Organization')
  assert.equal(identity.appSlug, 'ogun')
  assert.equal(botLogin(identity.appSlug), 'ogun[bot]')
})

/**
 * The property: an installation GitHub describes without a login or without an `app_slug`
 * is a **failure**, not a connection with a guessed name.
 *
 * This is where the GitHub path deliberately differs from the Linear one.
 * `finishConnection` lets Linear's `identify` fail and still stores the grant, because
 * everything it returns there is for display. Here the two fields *are* the application's
 * name and the login a loop guard will trust — so inventing either would produce a
 * connection that works and is wrong in a way nothing downstream can detect.
 */
test('an installation with no login or no app slug fails rather than being guessed at', async () => {
  for (const [what, body] of [
    ['no login', installationResponse({ account: { id: 42 } })],
    ['no account at all', installationResponse({ account: null })],
    ['no app slug', installationResponse({ app_slug: '' })],
  ] as const) {
    const { fn } = wire({ install: [200, body] })
    const err = await installationIdentity(deps(fn)).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof GithubAppError, what)
    assert.equal(err.kind, 'transport', what)
  }
})
