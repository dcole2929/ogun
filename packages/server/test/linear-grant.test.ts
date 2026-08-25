import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { LinearOAuthError, sealSecret, type OAuthGrant, type ProjectOAuth } from '@ogun/core'
import { usableGrant } from '../src/foreman/linear-grant.ts'

/**
 * When a 24-hour token gets renewed, for a poller that wakes at 3am (ADR-0014).
 *
 * Every test here is about a decision rather than a request: the token endpoint is a stub,
 * because what is being protected is *when* it is called, *what happens to the stored
 * refresh token when it fails*, and *whether the new pair is written before it is used*.
 * The wire itself is `linear-oauth-client.test.ts`.
 */

const HOUR = 60 * 60 * 1000

const grantExpiring = (inMs: number): OAuthGrant => ({
  clientId: 'client-1',
  access: sealSecret('access-old'),
  refresh: sealSecret('refresh-old'),
  grantType: 'authorization_code',
  expiresAt: Date.now() + inMs,
  obtainedAt: Date.now() - 23 * HOUR,
  scopes: ['read'],
  actor: 'app',
  workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
})

/** The default grant: no refresh token, because renewal is asking again. */
const appGrantExpiring = (inMs: number): OAuthGrant => {
  const { refresh: _none, ...rest } = grantExpiring(inMs)
  return { ...rest, grantType: 'client_credentials' }
}

const registered: ProjectOAuth = {
  state: 'present',
  app: {
    clientId: 'client-1',
    clientSecret: sealSecret('lin_secret_abcdefgh'),
    redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
    grant: undefined,
  },
}

const deps = (over: Parameters<typeof usableGrant>[3] = {}) => ({
  readApp: async () => registered,
  store: async () => {},
  refresh: async () => ({
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
    grantType: 'authorization_code' as const,
    expiresAt: Date.now() + 24 * HOUR,
    scopes: ['read'],
  }),
  reissue: async () => ({
    accessToken: 'access-reissued',
    grantType: 'client_credentials' as const,
    expiresAt: Date.now() + 30 * 24 * HOUR,
    scopes: ['read'],
  }),
  ...over,
})

/**
 * The property: a healthy token is used as it stands, with no round trip.
 *
 * Worth fixing because the obvious "just refresh before every poll" is *nearly* free and
 * is not: Linear rotates the refresh token on every use, so refreshing every five minutes
 * means 288 rotations a day, each one a chance for a lost response to leave the stored
 * token behind the real one. The whole design rests on renewing about once a day.
 */
test('a token with most of its life left is used without a refresh', async () => {
  let refreshes = 0
  const result = await usableGrant(
    'ogun',
    'linear',
    grantExpiring(20 * HOUR),
    deps({
      refresh: async () => {
        refreshes++
        throw new Error('should not have been called')
      },
    }),
  )

  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(refreshes, 0)
  assert.equal(result.refreshed, false)
  assert.deepEqual(result.credential, { kind: 'oauth', token: 'access-old', workspace: 'Acme' })
})

/**
 * The property: a token that is alive *right now* but will not outlive the poll is renewed
 * before the poll, not during it.
 *
 * This is the credential preflight's argument applied one layer down. "Is it valid?" is
 * the wrong question for something about to make up to four paged requests: a token with
 * four minutes left passes that test and dies between page two and page three, which
 * surfaces as a half-read list and an `AUTHENTICATION_ERROR` indistinguishable from a
 * revoked grant. A naive implementation checks `expiresAt <= now`.
 */
test('a token still alive but inside the horizon is renewed before the poll runs', async () => {
  const result = await usableGrant('ogun', 'linear', grantExpiring(4 * 60 * 1000), deps())
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(result.refreshed, true)
  assert.equal(result.credential.token, 'access-new')
})

/**
 * The property: the ordinary case is an **already expired** token, and it renews rather
 * than refusing.
 *
 * A timer-based design fails exactly here. A workstation asleep since yesterday evening
 * has run no timer, so the token is dead before the first tick would have fired — and this
 * is the normal state of the machine at 3am rather than an edge case. The refresh token
 * outlives the access token, so there is nothing to stop.
 */
test('a token that expired hours ago is renewed, not refused', async () => {
  const result = await usableGrant('ogun', 'linear', grantExpiring(-9 * HOUR), deps())
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') return
  assert.equal(result.credential.token, 'access-new')
})

/**
 * The property: **a transport failure does not destroy the stored refresh token.**
 *
 * The most expensive mistake available in this file. A refresh token is single-use and
 * rotated, so a client that clears its stored token when a refresh fails has thrown away a
 * connection because the network blipped — and reconnecting under `actor=app` needs a
 * workspace admin, so the recovery is not one click.
 *
 * Linear's 30-minute replay window for a consumed refresh token exists precisely for the
 * case where the response never arrived, and it is only usable by a client that still has
 * the token. So the failure is reported as `failed` (try again next poll), never `refused`
 * (go and reconnect), and nothing here writes to the store at all.
 */
test('a transport failure keeps the refresh token and says the next poll will retry', async () => {
  let wrote = 0
  const result = await usableGrant(
    'ogun',
    'linear',
    grantExpiring(-1 * HOUR),
    deps({
      store: async () => {
        wrote++
      },
      refresh: async () => {
        throw new LinearOAuthError('transport', 'could not reach the token endpoint')
      },
    }),
  )

  assert.equal(result.state, 'failed')
  if (result.state !== 'failed') return
  assert.equal(wrote, 0, 'a failed refresh must not write to the store')
  assert.match(result.detail, /refresh token was kept/)
})

/**
 * The property: a permanently refused grant is a `refused` — with the remedy — and still
 * does not delete anything.
 *
 * Two halves. The outcome has to differ from a transport failure, because `source_polls`
 * is the only evidence a source leaves and "look again tomorrow" is the wrong advice for a
 * revoked grant. And the deletion still does not happen: an operator disconnects
 * deliberately, from a surface that says what it is doing, and a poller quietly erasing a
 * credential at 3am is the destructive write ADR-0012 keeps `empty` separate from `absent`
 * to make visible.
 */
test('a revoked grant refuses the poll, names the fix, and deletes nothing', async () => {
  let wrote = 0
  const result = await usableGrant(
    'ogun',
    'linear',
    grantExpiring(-1 * HOUR),
    deps({
      store: async () => {
        wrote++
      },
      refresh: async () => {
        throw new LinearOAuthError('invalid-grant', 'linear refused the grant')
      },
    }),
  )

  assert.equal(result.state, 'refused')
  if (result.state !== 'refused') return
  assert.equal(wrote, 0)
  assert.match(result.detail, /Nothing was deleted/)
  assert.match(result.detail, /ogun connect linear --project ogun/)
})

/**
 * The property: **the new pair is written before it is used**, and a failed write stops
 * the poll.
 *
 * The tempting alternative is to poll with the token in hand and hope the next write
 * lands. It is wrong because the rotation has already happened at Linear: the refresh
 * token on disk is spent, so the next poll would replay a consumed token. Stopping keeps
 * that inside Linear's 30-minute replay window, where the retry recovers the same pair —
 * which is exactly what the window is documented for. Proceeding would spend the window on
 * a poll and lose the connection.
 */
test('a grant that could not be written stops the poll rather than being used unrecorded', async () => {
  const result = await usableGrant(
    'ogun',
    'linear',
    grantExpiring(-1 * HOUR),
    deps({
      store: async () => {
        throw new Error('EACCES: config.json')
      },
    }),
  )

  assert.equal(result.state, 'failed')
  if (result.state !== 'failed') return
  assert.match(result.detail, /replayed for 30 minutes/)
})

/**
 * The property: two concurrent polls of one project spend **one** refresh token.
 *
 * The window is not theoretical. `main.ts` drives `pollSources` from an interval that does
 * not await its callback, so two ticks overlap whenever a poll runs longer than the
 * interval — and two sources in one project would then both find the same expiring grant.
 * Without single-flight, both refresh; the second spends a token the first has already
 * rotated. Linear's grace window means even that recovers, which is why this is a
 * legibility fix rather than a correctness one — but "recovers by accident" is not a
 * property worth relying on, and one rotation per day is the design.
 */
test('two polls arriving together produce one refresh, not two', async () => {
  let refreshes = 0
  const slow = deps({
    refresh: async () => {
      refreshes++
      await new Promise((done) => setTimeout(done, 20))
      return {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        grantType: 'authorization_code' as const,
        expiresAt: Date.now() + 24 * HOUR,
        scopes: ['read'],
      }
    },
  })

  const grant = grantExpiring(-1 * HOUR)
  const [a, b] = await Promise.all([
    usableGrant('single-flight', 'linear', grant, slow),
    usableGrant('single-flight', 'linear', grant, slow),
  ])

  assert.equal(refreshes, 1)
  assert.equal(a.state, 'ready')
  assert.equal(b.state, 'ready')
})

/**
 * The property: a grant with no application behind it says so, rather than reporting an
 * expired token.
 *
 * Only reachable by hand-editing config.json, which §4.5 says happens — the write paths
 * refuse to create it. The fix is to register the application, and reporting it as an
 * expiry problem sends somebody to reconnect an application that is not there.
 */
test('a grant whose application has been hand-removed names that, not the expiry', async () => {
  const result = await usableGrant(
    'ogun',
    'linear',
    grantExpiring(-1 * HOUR),
    deps({ readApp: async () => ({ state: 'absent' }) }),
  )
  assert.equal(result.state, 'refused')
  if (result.state !== 'refused') return
  assert.match(result.detail, /no application behind it/)
})

/**
 * The property: **which renewal runs is decided by the recorded `grantType`, not by whether
 * a refresh token happens to be sitting there.**
 *
 * Inference is the tempting implementation and it is wrong in the direction that costs a
 * connection. A grant missing its refresh token through a truncated write, an older build
 * or a hand-edit would be *silently* renewed a different way — so the recovery for a
 * damaged entry becomes a change to how the credential is maintained, with nothing said.
 * Reading the recorded intent means a damaged entry stops at the parser, as `malformed`,
 * where it names itself.
 *
 * The two directions are asserted together because each one is a live failure. A
 * client-credentials grant sent down the refresh path spends a `refresh_token` that does
 * not exist and reports the refusal as a dead connection; an authorization-code grant sent
 * down the reissue path asks Linear for a workspace token where a user-scoped one was
 * approved, and quietly narrows what Ogun can see.
 */
test('the grant type decides the renewal, rather than the presence of a refresh token', async () => {
  const called: string[] = []
  const trace = {
    refresh: async () => {
      called.push('refresh')
      return {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        grantType: 'authorization_code' as const,
        expiresAt: Date.now() + 24 * HOUR,
        scopes: ['read'],
      }
    },
    reissue: async () => {
      called.push('reissue')
      return {
        accessToken: 'access-reissued',
        grantType: 'client_credentials' as const,
        expiresAt: Date.now() + 30 * 24 * HOUR,
        scopes: ['read'],
      }
    },
  }

  const app = await usableGrant('cc', 'linear', appGrantExpiring(-9 * HOUR), deps(trace))
  assert.equal(app.state, 'ready')
  if (app.state !== 'ready') return
  assert.equal(app.refreshed, true)
  assert.equal(app.credential.kind, 'oauth')

  const code = await usableGrant('ac', 'linear', grantExpiring(-9 * HOUR), deps(trace))
  assert.equal(code.state, 'ready')

  assert.deepEqual(called, ['reissue', 'refresh'])
})

/**
 * The property: what gets **written** after a client-credentials renewal has no refresh
 * token in it, and still says which grant it came from.
 *
 * `storeOAuthGrant` is where a renewal turns into the thing the next process reads, and the
 * shape it writes is the shape `parseOAuthApp` will judge. Writing a `grantType` of
 * `authorization_code` here — by carrying the old value forward instead of taking the new
 * one — would produce an entry that is `malformed` on the next read, because it would claim
 * to be a rotating grant with nothing to rotate. A connection that works until the process
 * restarts is the hardest kind of wrong to find.
 */
test('a renewed app token is written with no refresh token and its own grant type', async () => {
  let written: Record<string, unknown> | undefined
  const result = await usableGrant(
    'ogun',
    'linear',
    appGrantExpiring(-9 * HOUR),
    deps({
      store: async (_slug, _provider, grant) => {
        written = grant as unknown as Record<string, unknown>
      },
    }),
  )

  assert.equal(result.state, 'ready')
  assert.equal(written?.grantType, 'client_credentials')
  assert.equal(written?.refreshToken, undefined)
  assert.equal(written?.accessToken, 'access-reissued')
  // Carried forward rather than re-fetched: a renewal cannot change which workspace the
  // grant is in, and re-running `identify` would be a GraphQL request a poll does not need.
  assert.deepEqual(written?.workspace, { id: 'org-1', name: 'Acme', urlKey: 'acme' })
})

/**
 * The property: a transport failure renewing an app token says **nothing was spent**.
 *
 * The same branch under the rotating grant says the refresh token was kept, and the
 * difference is the whole point of the two sentences existing. There, a lost response is a
 * consumed credential inside a 30-minute replay window, and an operator reading the line
 * needs to know their connection is intact. Here nothing has been consumed at all, and
 * telling somebody their refresh token survived — when there is no refresh token — is a
 * sentence that sends them looking for a thing that does not exist.
 */
test('a failed app-token renewal reports that nothing was spent', async () => {
  const result = await usableGrant(
    'ogun',
    'linear',
    appGrantExpiring(-9 * HOUR),
    deps({
      reissue: async () => {
        throw new LinearOAuthError('transport', 'could not reach linear')
      },
    }),
  )

  assert.equal(result.state, 'failed')
  if (result.state !== 'failed') return
  assert.match(result.detail, /nothing was spent/i)
  assert.ok(!/refresh token was kept/.test(result.detail))
})
