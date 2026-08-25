import { strict as assert } from 'node:assert'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectWithAppToken,
  disconnectProject,
  finishConnection,
  registeredApplication,
} from '../src/integrations/linear-connect.ts'
import { LinearOAuthError } from '../src/integrations/linear-oauth.ts'
import {
  listOAuthApps,
  listProjectSecrets,
  readOAuthApp,
  readProjectSecret,
  setOAuthApp,
  setProjectSecret,
} from '../src/config/secrets.ts'
import { appTokenResponse, identityResponse, teamsResponse } from './linear-oauth-fixtures.ts'

/**
 * Connecting and disconnecting as one operation, shared by the CLI and the Settings page.
 *
 * The wire itself is `linear-oauth-client.test.ts` and the store is `project-oauth.test.ts`.
 * What is only here is the *sequence*: which write happens first, what a half-finished
 * connection leaves behind, and what a disconnection is allowed to leave in the file. Those
 * are the parts that would otherwise exist twice — once in a route and once in a command —
 * and drift.
 */

const TOKEN_URL = 'https://token.test/oauth/token'
const GRAPHQL_URL = 'https://graphql.test/graphql'
const REVOKE_URL = 'https://token.test/oauth/revoke'
const SECRET = 'lin_secret_QQQQQQQQQQQQQQQQQQQQQQQQ'
const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

let dir = ''
let store = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ogun-connect-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  store = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
})

type Answer = [number, string]

/** A `fetch` that routes by URL, so one stub covers the token call and both queries. */
const wire = (over: Partial<Record<'token' | 'identity' | 'teams' | 'revoke', Answer>> = {}) => {
  const calls: string[] = []
  const fn = (async (url: unknown, init: RequestInit = {}) => {
    const href = String(url)
    if (href === TOKEN_URL) {
      calls.push('token')
      const [status, body] = over.token ?? [200, appTokenResponse()]
      return new Response(body, { status })
    }
    if (href === REVOKE_URL) {
      calls.push('revoke')
      const [status, body] = over.revoke ?? [200, '{}']
      return new Response(body, { status })
    }
    const query = String((JSON.parse(String(init.body)) as { query: string }).query)
    if (query.includes('teams')) {
      calls.push('teams')
      const [status, body] = over.teams ?? [200, teamsResponse()]
      return new Response(body, { status })
    }
    calls.push('identity')
    const [status, body] = over.identity ?? [200, identityResponse()]
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

const deps = (fetch: typeof globalThis.fetch) => ({
  fetch,
  tokenUrl: TOKEN_URL,
  graphqlEndpoint: GRAPHQL_URL,
  path: store,
})

const credentials = { clientId: 'client-1', clientSecret: SECRET, redirectUri: '' }

// ── connecting ─────────────────────────────────────────────────────────────

test('one call registers the application, takes a token, and records who it is', async (t) => {
  /**
   * The property: connecting is **one act**, and everything a later surface needs is
   * recorded while the token is fresh.
   *
   * It used to be two commands because the authorization step needed a browser and a
   * person, so there had to be a place to stop between "here are the credentials" and "go
   * and approve this". `client_credentials` has nothing for a person to do, so there is
   * nothing to stop for.
   *
   * The identity and the teams are asked for **now** because now is the only time they can
   * be. Linear has no token introspection — no RFC 7662 endpoint and nothing in the schema
   * reporting a token's own scopes — so the moment a grant is made is the only moment its
   * workspace and actor are obtainable.
   */
  const { fn, calls } = wire()
  const connection = await connectWithAppToken('ogun', 'linear', credentials, deps(fn))

  assert.deepEqual(calls, ['token', 'identity', 'teams'])
  assert.equal(connection.grantType, 'client_credentials')
  assert.equal(connection.workspace, 'Acme')
  assert.equal(connection.actor, 'app')
  assert.deepEqual(connection.teams.map((team) => team.key), ['ENG', 'HEI'])

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.grantType, 'client_credentials')
  assert.equal(read.grant.refresh, undefined)
  assert.deepEqual(read.grant.workspace, { id: 'org-1', name: 'Acme', urlKey: 'acme' })
  t.diagnostic(`stored ${JSON.stringify(await listOAuthApps(store))}`)
})

test('a token request that fails leaves the application registered, so a retry asks for nothing', async () => {
  /**
   * The property: the client id and secret are written **before** the token is asked for.
   *
   * That looks backwards — it stores a client secret for a connection that may not work —
   * and it is the right way round. A failed token request leaves the project `unconnected`,
   * which is a state ADR-0014 already defines, already reports and already has a remedy
   * for; the operator retries and is **not asked to paste anything**, because the
   * application is there. Writing the application last would make a network blip cost a
   * second trip to Linear's settings page for a value this machine could have kept.
   *
   * The failure has to surface as a `LinearOAuthError` rather than as a stored half-state
   * reported as success, which is the other way to get this wrong.
   */
  const { fn } = wire({ token: [500, '{"error":"Error","error_description":"upstream"}'] })
  const err = await connectWithAppToken('ogun', 'linear', credentials, deps(fn)).then(
    () => null,
    (e: unknown) => e,
  )

  assert.ok(err instanceof LinearOAuthError)
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'unconnected')

  const stored = await registeredApplication('ogun', 'linear', store)
  assert.equal(stored?.clientId, 'client-1')
  assert.equal(stored?.clientSecret, SECRET)
})

test('connecting retires the personal api key it supersedes, and says so', async () => {
  /**
   * The property: a project that connects as an application does not keep a personal key
   * behind the grant.
   *
   * ADR-0014 left it in place and reported it as shadowed in four surfaces, which was right
   * while the key was written by a *different command*: an operator could have had one
   * without ever having asked for it in the same breath as a grant. Under one `connect`
   * there is one place to give Ogun access to Linear, and leaving a second credential in
   * the store leaves exactly the ambiguity that vocabulary exists to end — a credential
   * that reports as set, is read by nothing, and is the first thing somebody rotates when a
   * poll fails.
   *
   * The **order** is the part with a failure mode in it. The key is removed *after* the
   * grant is on disk: removing it first and then failing the write would trade a shadowed
   * key for no credential at all.
   */
  await setProjectSecret('ogun', 'linear', KEY, store)
  const { fn } = wire()
  const connection = await connectWithAppToken('ogun', 'linear', credentials, deps(fn))

  assert.equal(connection.apiKeyRetired, true)
  assert.deepEqual(await listProjectSecrets(store), [])
  // And the grant is what a poll now reads, with nothing sitting behind it.
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.apiKeyIgnored, false)
})

test('a token that can read nothing is reported as such, not as a probe that failed', async () => {
  /**
   * The property: "the teams query failed" and "this token sees no teams" are different
   * answers, and the connection carries both facts.
   *
   * This is the trapdoor under the default grant. A `client_credentials` token has access
   * to the workspace's **public** teams and no others, so a workspace whose teams are
   * private hands back a token that authenticates perfectly, answers every query, and
   * returns nothing — a source that polls every five minutes, records `ok`, sees zero
   * tickets and emits no jobs, forever, while every surface says the connection is healthy.
   *
   * Collapsing the two into an empty list would make the one moment a person is watching
   * say nothing at all. `teamsProbed` is what lets the caller print a warning in one case
   * and stay quiet in the other.
   */
  const empty = wire({ teams: [200, JSON.stringify({ data: { teams: { nodes: [] } } })] })
  const seesNothing = await connectWithAppToken('ogun', 'linear', credentials, deps(empty.fn))
  assert.deepEqual(seesNothing.teams, [])
  assert.equal(seesNothing.teamsProbed, false)

  const broken = wire({ teams: [500, '<html>gateway timeout</html>'] })
  const probeFailed = await connectWithAppToken('other', 'linear', credentials, deps(broken.fn))
  // The connection still succeeded: refusing to store a working grant because a
  // reassurance query failed would turn a display problem into a broken connect.
  assert.equal(probeFailed.grantType, 'client_credentials')
  assert.equal((await readProjectSecret('other', 'linear', store)).state, 'granted')
})

test('an identity query that fails does not fail the connection', async () => {
  /**
   * The property: the tokens are valid — Linear issued them a moment ago — so a cosmetic
   * query timing out must not throw them away.
   *
   * Under the consent flow the insult is doubled: the authorization code is spent by then,
   * so a refusal here means starting the whole flow again, admin approval included, because
   * a GraphQL request for a workspace *name* did not come back.
   *
   * What is *not* claimed is that the actor was verified. `viewer.app` is the only evidence
   * a grant really came back as an application, and with no answer the honest record is
   * `user` — a state the listing shows in yellow — rather than an assumption printed in
   * green.
   */
  const { fn } = wire({ identity: [500, 'not json'] })
  const connection = await connectWithAppToken('ogun', 'linear', credentials, deps(fn))

  assert.equal(connection.workspace, undefined)
  assert.equal(connection.actor, 'user')
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'granted')
})

// ── disconnecting ──────────────────────────────────────────────────────────

test('a disconnect takes the client id and secret with it, and the api key too', async () => {
  /**
   * The property: **everything** goes, because under this grant the client id and secret
   * *are* the credential.
   *
   * ADR-0014's disconnect kept them, and was right to while every connection had a browser
   * in it: a client secret alone authenticated nothing without a consent screen and a
   * workspace admin behind it, so keeping it cost nothing and saved a reconnect that a
   * non-admin operator could not perform for themselves.
   *
   * That is no longer true. Anyone holding the pair can mint a live token and the next poll
   * would, so a disconnect that left them behind is a disconnect the machine undoes by
   * itself. ADR-0012 wrote this rule for keys already — "one that is still accepted is a
   * live credential nobody is watching, and it would be in every backup of the machine" —
   * and this is that rule reaching a value that only just became one.
   */
  await setProjectSecret('ogun', 'linear', KEY, store)
  const { fn, calls } = wire()
  await connectWithAppToken('ogun', 'linear', credentials, deps(fn))
  calls.length = 0

  const gone = await disconnectProject('ogun', 'linear', {}, { ...deps(fn), revokeUrl: REVOKE_URL })

  assert.ok(gone.ok)
  if (!gone.ok) return
  assert.equal(gone.removed, true)
  assert.equal(gone.revoked, true)
  assert.equal(gone.applicationForgotten, true)
  assert.deepEqual(calls, ['revoke'])

  const file = JSON.parse(await readFile(store, 'utf8'))
  assert.deepEqual(file.oauth ?? {}, {})
  assert.deepEqual(file.secrets?.ogun ?? {}, {})
})

test('keeping the application is refused on a client-credentials connection', async () => {
  /**
   * The property: `--keep-application` fails rather than warning.
   *
   * A warning about a state that reverts itself within one poll interval is a warning
   * nobody can act on. The refusal has to name what makes it different — that the pair
   * mints the token — and offer the thing an operator who wanted "stop trusting what Ogun
   * holds" actually needs, which is a rotation at Linear.
   *
   * Nothing moves on a refusal, which is the second half: a partial disconnect that removed
   * the token and refused the rest would leave a project the next poll silently reconnects.
   */
  const { fn } = wire()
  await connectWithAppToken('ogun', 'linear', credentials, deps(fn))

  const refused = await disconnectProject(
    'ogun',
    'linear',
    { keepApplication: true },
    { ...deps(fn), revokeUrl: REVOKE_URL },
  )

  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.reason, 'keeps-a-live-credential')
  assert.match(refused.detail, /not a disconnection/)
  assert.equal((await readOAuthApp('ogun', 'linear', store)).state, 'present')
})

test('keeping the application is allowed on a consent connection, and drops only the tokens', async () => {
  /**
   * The property: the flag still exists, for the grant it was written for.
   *
   * Under the authorization-code flow the client secret genuinely cannot mint anything
   * alone — it needs a browser, a consent screen and a workspace admin — so keeping it is a
   * real intermediate state and is the difference between reconnecting with one command and
   * going back to Linear's settings page for a value somebody has to be an admin to read.
   */
  await setOAuthApp(
    'ogun',
    'linear',
    { clientId: 'client-1', clientSecret: SECRET, redirectUri: 'http://x/cb' },
    store,
  )
  const { fn } = wire()
  await finishConnection(
    'ogun',
    'linear',
    'client-1',
    {
      accessToken: 'access-abcdefghijkl',
      refreshToken: 'refresh-abcdefghijkl',
      grantType: 'authorization_code',
      expiresAt: Date.now() + 86_399_000,
      scopes: ['read'],
    },
    deps(fn),
  )

  const kept = await disconnectProject(
    'ogun',
    'linear',
    { keepApplication: true },
    { ...deps(fn), revokeUrl: REVOKE_URL },
  )

  assert.ok(kept.ok)
  if (!kept.ok) return
  assert.equal(kept.applicationForgotten, false)
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'unconnected')
})

test('a revoke that cannot reach linear still removes the local credential', async () => {
  /**
   * The property: the store is cleaned whether or not Linear was told, and the two facts
   * are reported separately.
   *
   * A disconnect that depended on Linear being reachable would leave an operator unable to
   * remove a credential from their own machine during an outage, which is precisely when
   * they most want to. And an operator who needs to follow the revocation up by hand can
   * only do that if the line says it did not happen.
   */
  await writeFile(store, JSON.stringify({}), { mode: 0o600 })
  const { fn } = wire({ revoke: [500, 'nope'] })
  await connectWithAppToken('ogun', 'linear', credentials, deps(fn))

  const gone = await disconnectProject('ogun', 'linear', {}, { ...deps(fn), revokeUrl: REVOKE_URL })
  assert.ok(gone.ok)
  if (!gone.ok) return
  assert.equal(gone.removed, true)
  assert.equal(gone.revoked, false)
  assert.equal((await readOAuthApp('ogun', 'linear', store)).state, 'absent')
})
