import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sealSecret, type OAuthGrant, type ProjectOAuth } from '@ogun/core'
import { usableGrant } from '../src/foreman/linear-grant.ts'
import { LinearOAuthError } from '../src/integrations/linear-oauth.ts'

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
  expiresAt: Date.now() + inMs,
  obtainedAt: Date.now() - 23 * HOUR,
  scopes: ['read'],
  actor: 'app',
  workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
})

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
    expiresAt: Date.now() + 24 * HOUR,
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
  assert.match(result.detail, /ogun linear connect --project ogun/)
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
