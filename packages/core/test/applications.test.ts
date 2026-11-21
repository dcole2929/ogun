import { strict as assert } from 'node:assert'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApplicationInUse,
  clearApplication,
  clearGrant,
  deriveApplicationName,
  listApplications,
  listGrants,
  migrateLegacyOAuth,
  NoApplication,
  readApplication,
  readGrant,
  readProjectSecret,
  setApplication,
  setProjectSecret,
  storeGrant,
} from '../src/config/secrets.ts'
import { loadLocalConfig, parseLocalConfig, updateLocalConfig } from '../src/config/machine.ts'

/**
 * Applications and grants, after `oauth` was split in two.
 *
 * The claim under test is that **an application is shared and a grant is not**. The old
 * map keyed both by project, so a second project reaching the same provider meant a second
 * copy of the same client secret or private key — two values that must agree, with nothing
 * that makes them, and no way to tell which one a poll actually used. Everything below is
 * about the seams where that duplication used to live.
 */

let dir = ''
let store = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ogun-apps-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  store = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
})

const read = async (): Promise<Record<string, unknown>> =>
  parseLocalConfig(await readFile(store, 'utf8'), store) as unknown as Record<string, unknown>

test('a name is derived from the provider and the account, not from a project', async () => {
  /**
   * The whole reason the name is not the project slug: the application is shared. Naming
   * it after whichever project connected first means every other project links to a name
   * that describes none of them.
   */
  assert.equal(deriveApplicationName('github', 'Heirchive'), 'github:heirchive')
  assert.equal(deriveApplicationName('linear', ' Heirchive '), 'linear:heirchive')
})

test('two projects share one application and keep their own grants', async () => {
  await setApplication(
    {
      name: 'github:heirchive',
      provider: 'github',
      method: 'private_key_jwt',
      appId: '1234567',
      installationId: '98765432',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    },
    store,
  )
  for (const slug of ['heirchive-api', 'heirchive-web']) {
    await storeGrant(
      slug,
      'github',
      {
        app: 'github:heirchive',
        accessToken: `ghs_${slug}`,
        grantType: 'installation',
        expiresAt: Date.now() + 3_600_000,
        obtainedAt: Date.now(),
        scopes: [],
        actor: 'app',
      },
      store,
    )
  }

  const config = await read()
  assert.deepEqual(Object.keys(config.applications as object), ['github:heirchive'])
  assert.deepEqual(
    Object.keys(config.grants as object).sort(),
    ['heirchive-api', 'heirchive-web'],
  )

  // The private key exists once, which is the entire point.
  assert.equal(JSON.stringify(config).split('BEGIN RSA PRIVATE KEY').length - 1, 1)

  const api = await readGrant('heirchive-api', 'github', store)
  assert.equal(api.state, 'present')
  assert.equal(api.state === 'present' ? api.grant.access.expose() : '', 'ghs_heirchive-api')
  assert.equal(api.state === 'present' ? api.grant.app : '', 'github:heirchive')
})

test('an application cannot be deleted while a project still holds a grant from it', async () => {
  /**
   * Refusing rather than cascading. The private key is the only copy, and a cascade would
   * take five projects offline to satisfy one `disconnect` typed in the wrong directory.
   */
  await setApplication(
    {
      name: 'github:heirchive',
      provider: 'github',
      method: 'private_key_jwt',
      appId: '1',
      installationId: '2',
      privateKey: 'k',
    },
    store,
  )
  await storeGrant(
    'heirchive-api',
    'github',
    {
      app: 'github:heirchive',
      accessToken: 'ghs_x',
      grantType: 'installation',
      expiresAt: Date.now() + 1000,
      obtainedAt: Date.now(),
      scopes: [],
      actor: 'app',
    },
    store,
  )

  const err = await clearApplication('github:heirchive', store).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof ApplicationInUse)
  assert.deepEqual(err.usedBy, ['heirchive-api'], 'and it names who, which is what you need')

  // Dropping the last grant releases it.
  assert.equal(await clearGrant('heirchive-api', 'github', store), true)
  assert.equal(await clearApplication('github:heirchive', store), true)
})

test('clearing one project’s grant leaves the application and the other projects alone', async () => {
  await setApplication(
    { name: 'linear:heirchive', provider: 'linear', method: 'client_credentials',
      clientId: 'abc', clientSecret: 'shh', redirectUri: '' },
    store,
  )
  const grant = {
    app: 'linear:heirchive',
    accessToken: 'lin_x',
    grantType: 'client_credentials' as const,
    expiresAt: Date.now() + 1000,
    obtainedAt: Date.now(),
    scopes: ['read'],
    actor: 'app',
  }
  await storeGrant('a', 'linear', grant, store)
  await storeGrant('b', 'linear', grant, store)

  await clearGrant('a', 'linear', store)

  assert.equal((await readGrant('a', 'linear', store)).state, 'absent')
  assert.equal((await readGrant('b', 'linear', store)).state, 'present')
  assert.equal((await readApplication('linear:heirchive', store)).state, 'present')
})

test('the listing says who uses each application, and does not hide a broken one', async () => {
  await setApplication(
    { name: 'linear:heirchive', provider: 'linear', method: 'client_credentials',
      clientId: 'abc', clientSecret: 'shh', redirectUri: '' },
    store,
  )
  await storeGrant(
    'ogun',
    'linear',
    { app: 'linear:heirchive', accessToken: 't', grantType: 'client_credentials',
      expiresAt: 1, obtainedAt: 1, scopes: [], actor: 'app' },
    store,
  )
  // An entry this build cannot read is exactly the one somebody needs to see.
  const raw = JSON.parse(await readFile(store, 'utf8')) as Record<string, Record<string, unknown>>
  raw.applications!['github:broken'] = { provider: 'github', appId: '1' }
  await writeFile(store, JSON.stringify(raw))

  const listed = await listApplications(store)
  assert.deepEqual(listed.map((l) => l.name), ['github:broken', 'linear:heirchive'])
  assert.equal(listed[0]!.state, 'malformed')
  assert.deepEqual(listed[1]!.usedBy, ['ogun'])
})

test('an application written in the old shape is moved, once, without losing a grant', async () => {
  /**
   * The migration, against the shape a real machine has: the same Linear application
   * stored under two projects, each with its own live token. The duplication is the bug;
   * losing a token while fixing it would be worse than the bug.
   */
  const legacy = {
    projects: {},
    oauth: {
      ogun: {
        linear: {
          clientId: 'client-1',
          clientSecret: 'secret-1',
          redirectUri: '',
          grant: {
            accessToken: 'lin_oauth_ogun',
            grantType: 'client_credentials',
            expiresAt: 4_000_000_000_000,
            obtainedAt: 1,
            scopes: ['read'],
            actor: 'app',
            workspace: { id: 'w1', name: 'Heirchive', urlKey: 'heirchive' },
          },
        },
      },
      'heirchive-api': {
        linear: {
          clientId: 'client-1',
          clientSecret: 'secret-1',
          redirectUri: '',
          grant: {
            accessToken: 'lin_oauth_api',
            grantType: 'client_credentials',
            expiresAt: 4_000_000_001_000,
            obtainedAt: 1,
            scopes: ['read'],
            actor: 'app',
            workspace: { id: 'w1', name: 'Heirchive', urlKey: 'heirchive' },
          },
        },
      },
    },
  }
  await writeFile(store, JSON.stringify(legacy))

  // Readable before anything is written, so an upgraded build works on an unconverted file.
  const beforeWrite = await readGrant('ogun', 'linear', store)
  assert.equal(beforeWrite.state, 'present')
  assert.equal(beforeWrite.state === 'present' ? beforeWrite.grant.app : '', 'linear:heirchive')

  const config = parseLocalConfig(await readFile(store, 'utf8'), store)
  const moved = migrateLegacyOAuth(config)
  assert.deepEqual(Object.keys(moved.applications), ['linear:heirchive'])
  assert.deepEqual(Object.keys(moved.grants).sort(), ['heirchive-api', 'ogun'])
  assert.deepEqual(moved.oauth, {}, 'and the old map is emptied of what moved')

  assert.deepEqual(
    migrateLegacyOAuth(moved),
    moved,
    'idempotent — a second pass finds nothing, so a half-converted file converges',
  )
})

test('the migration never overwrites something already in the new shape', async () => {
  const mixed = {
    projects: {},
    applications: { 'linear:heirchive': { provider: 'linear', method: 'client_credentials',
                                          clientId: 'new', clientSecret: 'new', redirectUri: '' } },
    oauth: {
      ogun: { linear: { clientId: 'old', clientSecret: 'old', redirectUri: '',
                        grant: { accessToken: 't', grantType: 'client_credentials',
                                 expiresAt: 1, obtainedAt: 1, scopes: [], actor: 'app',
                                 workspace: { id: 'w', name: 'H', urlKey: 'heirchive' } } } },
    },
  }
  await writeFile(store, JSON.stringify(mixed))
  const moved = migrateLegacyOAuth(parseLocalConfig(await readFile(store, 'utf8'), store))
  assert.equal(
    (moved.applications['linear:heirchive'] as { clientId: string }).clientId,
    'new',
    'the converted entry wins, so a partly-migrated file does not flap',
  )
})

// ── what `project-oauth.test.ts` used to assert ─────────────────────────────

/**
 * Everything below was in `test/project-oauth.test.ts`, which is deleted rather than kept
 * beside this file.
 *
 * Two test files for one store is how two builds of the same rule end up asserted in two
 * places and only one of them updated — and most of that file was about `oauth[project]`,
 * a map that no longer exists. What survives is the part that was never about the *shape*:
 * the grant parser's rules, the precedence between a grant and a personal key, the seams a
 * parallel store would have shown up at, and the listing that structurally cannot carry a
 * credential. Each one is restated here against the new API, with its original reasoning,
 * because the reasoning is what made the test worth having.
 */

const linearApp = (over: Record<string, string> = {}) =>
  ({
    name: 'linear:acme',
    provider: 'linear' as const,
    method: 'client_credentials' as const,
    clientId: 'client-1',
    clientSecret: 'lin_secret_abcdefghijklmnop',
    redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
    ...over,
  })

const rotating = (over: Record<string, unknown> = {}) => ({
  app: 'linear:acme',
  accessToken: 'access-abcdefghijklmnop',
  refreshToken: 'refresh-abcdefghijklmnop',
  grantType: 'authorization_code' as const,
  expiresAt: Date.now() + 86_399_000,
  obtainedAt: Date.now(),
  scopes: ['read'],
  actor: 'app',
  account: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  ...over,
})

/** The default grant: a 30-day app-actor token with nothing to refresh it from. */
const appToken = (over: Record<string, unknown> = {}) =>
  rotating({
    grantType: 'client_credentials' as const,
    refreshToken: undefined,
    expiresAt: Date.now() + 2_591_999_000,
    ...over,
  })

/**
 * The property: a `client_credentials` grant **round-trips with no refresh token**, and an
 * `authorization_code` grant without one is still `malformed`.
 *
 * The check used to be unconditional and its reasoning is worth carrying rather than
 * deleting: *"a grant that cannot be refreshed is a connection with a 24-hour life and no
 * symptom until it ends."* The prediction was right. The premise — that a refresh token is
 * the only renewal Ogun has — is what stopped being true.
 *
 * Both halves are asserted because they fail in opposite directions. A build that kept the
 * old blanket rule makes the default mechanism impossible; a build that dropped it entirely
 * stores a rotating grant with nothing to rotate, which reports as healthy for a day.
 */
test('a client-credentials grant needs no refresh token, and the other still does', async () => {
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', appToken(), store)

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.grantType, 'client_credentials')
  assert.equal(read.grant.refresh, undefined)

  // The rotating grant with its refresh token hand-edited out — which is how this shape
  // actually arrives, since the write path will not create it.
  const raw = JSON.parse(await readFile(store, 'utf8')) as {
    grants: Record<string, Record<string, unknown>>
  }
  raw.grants.ogun!.linear = {
    app: 'linear:acme',
    accessToken: 'access-abcdefghijklmnop',
    grantType: 'authorization_code',
    expiresAt: Date.now() + 86_399_000,
  }
  await writeFile(store, JSON.stringify(raw))
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'malformed')
})

/**
 * The property: a `grantType` this build does not know is `malformed`, not defaulted.
 *
 * A future build's fourth grant would have renewal rules this one has never heard of.
 * Quietly treating it as something else means spending the wrong credential at 3am and
 * reporting the result as a dead connection. Every *other* unknown field in the entry is
 * ignored on purpose, and this one is not, because this is the field that decides what
 * happens to the credential.
 */
test('a grant type this build does not know is malformed rather than assumed', async () => {
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', rotating(), store)

  const raw = JSON.parse(await readFile(store, 'utf8')) as {
    grants: Record<string, Record<string, Record<string, unknown>>>
  }
  const entry = raw.grants.ogun!.linear!
  entry.grantType = 'device_code'
  entry.somethingNewer = { ignored: true }
  await writeFile(store, JSON.stringify(raw))

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'malformed')
  if (read.state !== 'malformed') return
  assert.match(read.reason, /grantType/)
})

/**
 * The property: an application registered with **no callback URL** is readable.
 *
 * `redirectUri` is required to be a string and allowed to be empty, which is right because
 * the default grant has no browser in it: a CLI on a machine with no control plane running
 * has no address to record, and inventing a plausible one would put a string in the store
 * that Linear was never told about. That is the mismatch the field exists to make visible,
 * manufactured.
 */
test('an application connected without a browser has no redirect uri, and reads fine', async () => {
  await setApplication(linearApp({ redirectUri: '' }), store)
  await storeGrant('ogun', 'linear', appToken(), store)

  const stored = await readApplication('linear:acme', store)
  assert.equal(stored.state, 'present')
  assert.equal(stored.state === 'present' && stored.app.provider === 'linear'
    ? stored.app.redirectUri : 'x', '')
  const [row] = await listGrants(store)
  assert.equal(row?.grantType, 'client_credentials')
})

/**
 * The property: **a grant wins over a personal API key**, and the shadowed key is reported
 * rather than silently ignored.
 *
 * The naive implementation reads the two blocks in whichever order the code was written in,
 * or prefers the key because that branch already existed. Both produce a project that has
 * just been connected and is still authenticating as a person — so the connection appears
 * to have done nothing, and once write-back lands, every comment Ogun posts still carries
 * the operator's name on a shared board. That is the entire failure this feature exists to
 * fix, reintroduced by a two-line ordering mistake.
 *
 * `apiKeyIgnored` is the second half. A project keeping both is normal, and an operator
 * debugging a poll failure by rotating that key is changing something nothing reads.
 */
test('a grant wins over a personal api key, and says the key is being ignored', async () => {
  await setProjectSecret('ogun', 'linear', 'lin_api_the_old_way', store)
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', rotating(), store)

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.access.expose(), 'access-abcdefghijklmnop')
  assert.equal(read.apiKeyIgnored, true)
  assert.deepEqual(read.grant.account, { id: 'org-1', name: 'Acme', urlKey: 'acme' })
})

/**
 * The property: an application nobody has taken a token from does not shadow a working key.
 *
 * A build that treated "an application exists" as "this project authenticates with it"
 * would stop a working poll at the moment somebody started improving it — and under a
 * *shared* application that is far easier to reach than it was, because the application
 * may have been registered for an entirely different project.
 */
test('an application with no grant does not shadow a working api key', async () => {
  await setProjectSecret('ogun', 'linear', 'lin_api_still_working', store)
  await setApplication(linearApp({ name: 'linear:ogun' }), store)

  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'present')
})

/**
 * The property: with no key behind it, an application this project has not connected is its
 * own state.
 *
 * Reported as `absent`, the remedy printed to the operator is "run `ogun connect`" — which
 * sends somebody who has done most of the work back to the credential they were migrating
 * away from. Principle 6: one state per remedy.
 *
 * `linear:ogun` is the name deliberately, because that is the name
 * `migrateLegacyOAuth` gives an old registered-and-never-authorized entry, and it is the
 * only name `readProjectSecret` recognises as *this project's* unconnected application —
 * see the note there on why it is not inferred from the whole set.
 */
test('an application this project has not connected is its own state, not absent', async () => {
  await setApplication(linearApp({ name: 'linear:ogun' }), store)
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'unconnected')
  assert.equal(read.state === 'unconnected' ? read.clientId : '', 'client-1')

  // And an application named after a *different* account is not this project's business.
  const other = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
  await setApplication(linearApp({ name: 'linear:someone-else' }), other)
  assert.equal((await readProjectSecret('ogun', 'linear', other)).state, 'absent')
})

/**
 * The property: an entry this build cannot read is `malformed`, which is about **one
 * project**, and not `unreadable`, which is about the whole machine.
 *
 * The fixes are unrelated and only one of them is destructive. `malformed` means reconnect
 * this project; `unreadable` means a config.json that is currently failing to parse for
 * everything on the box, where telling somebody to reconnect sends them to overwrite a file
 * that is already broken.
 */
test('an entry this build cannot read is malformed, not unreadable and not absent', async () => {
  await updateLocalConfig(
    (config) => ({ ...config, grants: { ogun: { linear: { accessToken: 'a' } } } }),
    store,
  )
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'malformed')
  if (read.state !== 'malformed') return
  // The reason names the field and never a value — every string in that object is a
  // credential or sits beside one.
  assert.match(read.reason, /app/)
})

/**
 * The property: a grant with no refresh token where one is required, or with an unreadable
 * expiry, is refused at the parser rather than accepted and used.
 *
 * Both are connections that look healthy and are not. A rotating grant with no refresh
 * token works for 24 hours and then stops. A grant whose `expiresAt` is not a number falls
 * through every comparison as `NaN`, so the poll either refreshes on every poll or never
 * refreshes at all depending on which way the comparison was written, and neither says
 * anything.
 */
test('a grant with no refresh token or no readable expiry is refused by the parser', async () => {
  for (const [name, broken] of [
    ['no refresh token', { ...rotating(), refreshToken: undefined }],
    ['expiry as a string', { ...rotating(), expiresAt: 'tomorrow' }],
    ['no expiry at all', { ...rotating(), expiresAt: undefined }],
    ['no application named', { ...rotating(), app: '' }],
  ] as const) {
    await updateLocalConfig(
      (config) => ({ ...config, grants: { ogun: { linear: broken } } }),
      store,
    )
    assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'malformed', name)
  }
})

/**
 * The property: rotating a secret keeps every grant; replacing the application under a name
 * with a **different** application drops them, and says which.
 *
 * This is `setOAuthApp`'s old rule, which the move to a name-keyed map nearly lost. A grant
 * points at a name now, so a replaced entry would otherwise re-point live tokens at
 * credentials that never minted them: a connection that reports as healthy and 401s on the
 * next poll.
 *
 * Both directions fail if they are wrong and they fail in opposite ways. Dropping on a
 * secret rotation forces a reconnect nobody asked for, which under `actor=app` needs a
 * workspace admin. Keeping on an identity change strands a dead token in a store every
 * surface reports as connected.
 */
test('rotating the secret keeps grants; replacing the application drops them, and says so', async () => {
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', appToken(), store)
  await storeGrant('other', 'linear', appToken(), store)

  const rotated = await setApplication(linearApp({ clientSecret: 'lin_secret_new' }), store)
  assert.equal(rotated.replaced, true)
  assert.deepEqual(rotated.droppedGrants, [])
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'granted')

  const moved = await setApplication(linearApp({ clientId: 'client-2' }), store)
  assert.equal(moved.replaced, true)
  assert.deepEqual(moved.droppedGrants, ['ogun', 'other'], 'and it names who it disconnected')
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'absent')
})

/**
 * The property: a grant cannot be stored without an application behind it.
 *
 * A grant whose application is missing can never be renewed — a `client_credentials` token
 * *is* the pair asked again, an `installation` token is a fresh JWT — so writing one would
 * create a connection with no way to renew it. The refusal is inside the lock, so it also
 * cannot be raced into existence by two writers.
 */
test('a grant with no application behind it is refused rather than stored', async () => {
  const err = await storeGrant('ogun', 'linear', rotating(), store).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof NoApplication)
  assert.equal((await loadLocalConfig(store)).grants.ogun, undefined)
})

/**
 * The property: **one writer.** Every write goes through `updateLocalConfig`, so nothing
 * these two blocks do can lose an unrelated edit, and nothing an unrelated edit does can
 * lose them.
 *
 * This is the seam a parallel store would have shown up at, and the second half is the one
 * with no symptom at the time: `updateLocalConfig` is a read-modify-write through
 * `localConfigSchema` and zod strips what a schema does not name, so an undeclared block is
 * silently deleted by the next `ogun project add` — which prints success, exits 0, and the
 * connection is gone.
 */
test('writing a grant preserves everything beside it, and survives an unrelated write', async () => {
  await writeFile(
    store,
    JSON.stringify({
      projects: { ogun: '/srv/ogun' },
      server: { token: 'ogun_keep_me' },
      secrets: { other: { linear: 'lin_api_other_project' } },
    }),
  )

  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', rotating(), store)

  const config = await loadLocalConfig(store)
  assert.equal(config.server.token, 'ogun_keep_me')
  assert.equal(config.projects.ogun, '/srv/ogun')
  assert.equal(config.secrets.other?.linear, 'lin_api_other_project')

  // Exactly what `ogun project add` does.
  await updateLocalConfig(
    (c) => ({ ...c, projects: { ...c.projects, other: '/srv/other' } }),
    store,
  )
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'granted')
  assert.equal((await readApplication('linear:acme', store)).state, 'present')
})

/**
 * The property: neither listing can report a credential.
 *
 * A list endpoint is where secrets leak, so this is structural rather than remembered —
 * `GrantPresence` has room for an application name, an account, scopes and an expiry, and
 * `ApplicationListing` for a provider, a method and identifiers that are not secrets. The
 * assertion is against the serialised rows rather than against named fields, because the
 * failure this guards against is somebody *adding* a field, which a field-by-field check
 * would not notice.
 */
test('the listings carry no token, no client secret and no private key', async () => {
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', rotating(), store)
  await setApplication(
    {
      name: 'github:acme',
      provider: 'github',
      method: 'private_key_jwt',
      appId: '1234567',
      installationId: '98765432',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYBYTES\n-----END RSA PRIVATE KEY-----',
    },
    store,
  )

  const serialised = JSON.stringify({
    grants: await listGrants(store),
    applications: await listApplications(store),
  })
  for (const secret of [
    'access-abcdefghijklmnop',
    'refresh-abcdefghijklmnop',
    'lin_secret_',
    'SECRETKEYBYTES',
  ]) {
    assert.doesNotMatch(serialised, new RegExp(secret), `a listing carried ${secret}`)
  }
})

/**
 * The property: a hand-edited grant the parser rejects still appears in the listing.
 *
 * §4.5 says this file gets hand-edited. A row that is invisible because it is broken is a
 * row nobody can remove, and the credential stays in the file — the closed set protecting a
 * value from its owner. `listApplications` already has this test for applications; this is
 * the same rule for the other map.
 */
test('an unreadable grant is listed as malformed rather than hidden', async () => {
  await updateLocalConfig(
    (config) => ({ ...config, grants: { ogun: { linear: { nonsense: true } } } }),
    store,
  )
  const [row] = await listGrants(store)
  assert.ok(row?.malformed)
  assert.equal(row.app, '')
})

/**
 * The property: a stored credential never arrives as a bare string.
 *
 * `Secret` survives `console.log`, `JSON.stringify` and interpolation as `[redacted]`, and
 * that is what makes it safe for a poller to write `console.error('poll failed', { key })`
 * without thinking about it. The grant has two of them and the easiest to forget is the
 * refresh token, which is the longest-lived; the application has the one that matters most,
 * because a GitHub private key cannot be re-displayed by its provider at all.
 */
test('the tokens on a grant and the secrets on an application are sealed, not strings', async () => {
  await setApplication(linearApp(), store)
  await storeGrant('ogun', 'linear', rotating(), store)
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return

  assert.equal(String(read.grant.access), '[redacted]')
  assert.equal(String(read.grant.refresh), '[redacted]')
  assert.match(JSON.stringify(read.grant), /"access":"\[redacted\]"/)
  assert.match(JSON.stringify(read.grant), /"refresh":"\[redacted\]"/)
  assert.doesNotMatch(JSON.stringify(read.grant), /abcdefghijklmnop/)

  const stored = await readApplication('linear:acme', store)
  assert.equal(stored.state, 'present')
  if (stored.state !== 'present' || stored.app.provider !== 'linear') return
  assert.equal(String(stored.app.clientSecret), '[redacted]')
})
