import { strict as assert } from 'node:assert'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearOAuthApp,
  clearOAuthGrant,
  listOAuthApps,
  NoOAuthApp,
  readOAuthApp,
  readProjectSecret,
  setOAuthApp,
  setProjectSecret,
  storeOAuthGrant,
} from '../src/config/secrets.ts'
import { loadLocalConfig, updateLocalConfig } from '../src/config/machine.ts'

/**
 * The OAuth half of the project credential store (ADR-0014).
 *
 * Everything here is about one claim: an OAuth grant is a **second shape inside the
 * existing store**, not a second store. So the tests are mostly about the seams where a
 * parallel store would have shown up — one writer, one lock, one retrieval function that
 * decides precedence, and one listing type that cannot carry a value.
 */

let dir = ''
let store = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ogun-oauth-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  store = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
})

const app = (over: Record<string, string> = {}) => ({
  clientId: 'client-1',
  clientSecret: 'lin_secret_abcdefghijklmnop',
  redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
  ...over,
})

const grant = (over: Record<string, unknown> = {}) => ({
  accessToken: 'access-abcdefghijklmnop',
  refreshToken: 'refresh-abcdefghijklmnop',
  grantType: 'authorization_code' as const,
  expiresAt: Date.now() + 86_399_000,
  obtainedAt: Date.now(),
  scopes: ['read'],
  actor: 'app',
  workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  ...over,
})

/** The default grant: a 30-day app-actor token with nothing to refresh it from. */
const appGrant = (over: Record<string, unknown> = {}) =>
  grant({
    grantType: 'client_credentials' as const,
    refreshToken: undefined,
    expiresAt: Date.now() + 2_591_999_000,
    ...over,
  })

// ── the two grants ─────────────────────────────────────────────────────────

/**
 * The property: a `client_credentials` grant **round-trips with no refresh token**, and an
 * `authorization_code` grant without one is still `malformed`.
 *
 * The check used to be unconditional and its reasoning is worth carrying rather than
 * deleting: *"a grant that cannot be refreshed is a connection with a 24-hour life and no
 * symptom until it ends — and Linear's client-credentials flow does return a token with no
 * refresh token beside it, so this is the shape a plausible future edit would write."* The
 * prediction was right. The premise — that a refresh token is the only renewal Ogun has —
 * is what stopped being true, because a client-credentials token is renewed from the client
 * id and secret two fields up.
 *
 * Both halves are asserted because they fail in opposite directions. A build that kept the
 * old blanket rule makes the default mechanism impossible; a build that dropped it entirely
 * stores a rotating grant with nothing to rotate, which reports as healthy for a day.
 */
test('a client-credentials grant needs no refresh token, and the other still does', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', appGrant(), store)

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.grantType, 'client_credentials')
  assert.equal(read.grant.refresh, undefined)

  // The rotating grant, with its refresh token hand-edited out of the file — which is how
  // this shape actually arrives, since the write path will not create it.
  const config = JSON.parse(await readFile(store, 'utf8'))
  config.oauth.ogun.linear.grant = {
    accessToken: 'access-abcdefghijklmnop',
    grantType: 'authorization_code',
    expiresAt: Date.now() + 86_399_000,
  }
  await writeFile(store, JSON.stringify(config))
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'malformed')
})

/**
 * The property: **a grant written before `grantType` existed is read as
 * `authorization_code`**, and keeps working.
 *
 * Not a guess dressed as a default. The build that wrote those entries refused a token with
 * no refresh token in two places, so an authorization-code grant is the only thing it could
 * have produced — which is what makes the absence readable rather than ambiguous.
 *
 * The cost of getting it wrong is a live connection: defaulting the other way would send a
 * `client_credentials` request for a grant whose renewal is a refresh token, at 3am, and
 * report the failure as a connection that is over. There is no migration for this file, so
 * this default *is* the migration.
 */
test('a grant stored before grantType existed still reads, as authorization_code', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const config = JSON.parse(await readFile(store, 'utf8'))
  delete config.oauth.ogun.linear.grant.grantType
  await writeFile(store, JSON.stringify(config))

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.grantType, 'authorization_code')
  assert.equal(read.grant.refresh?.expose(), 'refresh-abcdefghijklmnop')
})

/**
 * The property: a `grantType` this build does not know is `malformed`, not defaulted.
 *
 * A future build's third grant would have renewal rules this one has never heard of.
 * Quietly treating it as an authorization-code grant means spending a refresh token that is
 * not there and reporting the result as a dead connection — a newer build's working
 * credential broken by an older one that assumed. Every *other* unknown field in the entry
 * is ignored on purpose, and this one is not, because this is the field that decides what
 * happens to the credential.
 */
test('a grant type this build does not know is malformed rather than assumed', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const config = JSON.parse(await readFile(store, 'utf8'))
  config.oauth.ogun.linear.grant.grantType = 'device_code'
  config.oauth.ogun.linear.grant.somethingNewer = { ignored: true }
  await writeFile(store, JSON.stringify(config))

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'malformed')
  if (read.state !== 'malformed') return
  assert.match(read.reason, /grantType/)
})

/**
 * The property: an application registered with **no callback URL** is readable.
 *
 * `redirectUri` used to be required to be non-empty, which was right while every connection
 * had a browser in it. The default grant has none — so a CLI on a machine with no control
 * plane running has no address to record, and inventing a plausible one would put a string
 * in the store that Linear was never told about. That is the mismatch the field exists to
 * make visible, manufactured, and it would surface as an authorization Linear refuses
 * without saying why.
 */
test('an application connected without a browser has no redirect uri, and reads fine', async () => {
  await setOAuthApp('ogun', 'linear', app({ redirectUri: '' }), store)
  await storeOAuthGrant('ogun', 'linear', appGrant(), store)

  const [row] = await listOAuthApps(store)
  assert.equal(row?.redirectUri, '')
  assert.equal(row?.connected, true)
  assert.equal(row?.grantType, 'client_credentials')
})

// ── precedence ─────────────────────────────────────────────────────────────

/**
 * The property: **an OAuth grant wins over a personal API key**, and the shadowed key is
 * reported rather than silently ignored.
 *
 * The naive implementation reads the two blocks in whichever order the code was written
 * in, or prefers the key because that branch already existed. Both produce a project that
 * has just been connected and is still authenticating as a person — so the connection
 * appears to have done nothing, and once write-back lands, every comment Ogun posts still
 * carries the operator's name on a shared board. That is the entire failure this feature
 * exists to fix, reintroduced by a two-line ordering mistake.
 *
 * `apiKeyIgnored` is the second half. A project keeping both is normal — the key is the
 * documented fallback, and connecting does not delete it — but an operator debugging a
 * poll failure by rotating that key is changing something nothing reads, and nothing else
 * in the system is in a position to tell them.
 */
test('an oauth grant wins over a personal api key, and says the key is being ignored', async () => {
  await setProjectSecret('ogun', 'linear', 'lin_api_the_old_way', store)
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.access.expose(), 'access-abcdefghijklmnop')
  assert.equal(read.apiKeyIgnored, true)
  assert.deepEqual(read.grant.workspace, { id: 'org-1', name: 'Acme', urlKey: 'acme' })
})

/**
 * The property: an application that has been *registered* and never *connected* does not
 * shadow a working key.
 *
 * This is the ordinary state of a project halfway through the migration — the operator has
 * pasted the client id and secret and has not yet clicked through Linear's consent screen —
 * and it is a state that lasts as long as it takes to find a workspace admin. A build that
 * treated "has an oauth entry" as "authenticates with oauth" would stop a working poll at
 * the moment somebody started improving it.
 */
test('an application with no grant does not shadow a working api key', async () => {
  await setProjectSecret('ogun', 'linear', 'lin_api_still_working', store)
  await setOAuthApp('ogun', 'linear', app(), store)

  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'present')
})

/**
 * The property: with no key behind it, an unconnected application is its own state.
 *
 * Reported as `absent`, the remedy printed to the operator is "run `ogun connect`" —
 * which sends somebody who has done most of the work of connecting an application
 * back to the credential they were migrating away from. Principle 6: one state per remedy,
 * and this remedy is a browser rather than a terminal.
 */
test('an unconnected application with no key is its own state, not absent', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'unconnected')
  if (read.state !== 'unconnected') return
  assert.equal(read.clientId, 'client-1')
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
    (config) => ({ ...config, oauth: { ogun: { linear: { clientId: 'client-1' } } } }),
    store,
  )
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'malformed')
  if (read.state !== 'malformed') return
  // The reason names the field and never a value — every string in that object is a
  // credential or sits beside one.
  assert.match(read.reason, /clientSecret/)
})

/**
 * The property: a grant with no refresh token, or with an unreadable expiry, is refused at
 * the parser rather than accepted and used.
 *
 * Both are connections that look healthy and are not. A grant with no refresh token cannot
 * be renewed, so it works for 24 hours — or 30 days, if it came from Linear's
 * client-credentials flow — and then stops. A grant whose `expiresAt` is not a number
 * falls through every comparison as `NaN`, so the poll either refreshes on every single
 * poll or never refreshes at all, depending on which way the comparison was written, and
 * neither says anything.
 */
test('a grant with no refresh token or no readable expiry is refused by the parser', async () => {
  for (const [name, broken] of [
    ['no refresh token', { ...grant(), refreshToken: '' }],
    ['expiry as a string', { ...grant(), expiresAt: 'tomorrow' }],
    ['no expiry at all', { ...grant(), expiresAt: undefined }],
  ] as const) {
    await updateLocalConfig(
      (config) => ({ ...config, oauth: { ogun: { linear: { ...app(), grant: broken } } } }),
      store,
    )
    const read = await readProjectSecret('ogun', 'linear', store)
    assert.equal(read.state, 'malformed', name)
  }
})

// ── writing ────────────────────────────────────────────────────────────────

/**
 * The property: re-registering the **same** application keeps the connection; pointing the
 * project at a **different** one drops it.
 *
 * Both directions are failures if they are wrong, and they fail in opposite ways. Dropping
 * on a secret rotation forces a reconnect nobody asked for — and a reconnect under
 * `actor=app` needs a workspace admin, who may not be the person rotating the secret.
 * Keeping on a client-id change leaves tokens minted by an application this project no
 * longer uses: a connection that reports as healthy and 401s on the next poll, which is
 * exactly the "set but does not work" state ADR-0012 keeps `empty` separate from `absent`
 * to make visible.
 */
test('rotating the client secret keeps the grant; changing the client id drops it', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const rotated = await setOAuthApp('ogun', 'linear', app({ clientSecret: 'lin_secret_new' }), store)
  assert.equal(rotated.grantKept, true)
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'granted')

  const moved = await setOAuthApp('ogun', 'linear', app({ clientId: 'client-2' }), store)
  assert.equal(moved.grantKept, false)
  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'unconnected')
})

/**
 * The property: a grant cannot be stored without an application behind it.
 *
 * A grant with no client id and secret beside it can never be refreshed, so writing one
 * would create a connection with a 24-hour lifetime and no way to renew it. The refusal is
 * inside the lock, so it also cannot be raced into existence by two writers.
 */
test('a grant with no application behind it is refused rather than stored', async () => {
  const err = await storeOAuthGrant('ogun', 'linear', grant(), store).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof NoOAuthApp)
  assert.equal((await loadLocalConfig(store)).oauth.ogun, undefined)
})

/**
 * The property: **one writer.** Every write goes through `updateLocalConfig`, so nothing
 * the OAuth block does can lose an unrelated edit.
 *
 * This is the seam a parallel store would have shown up at. A second file, or a direct
 * `writeFile` here, would re-inherit both bugs `updateLocalConfig` has already had fixed:
 * `writeFile`'s `mode` applies only on create, so a restored 0644 config.json stays
 * world-readable while credentials are written into it; and concurrent read-modify-write
 * silently drops whichever edit lost the race. The symptom of the second one is a Linear
 * connection that stops working on the day somebody registered an unrelated repository.
 */
test('writing a grant preserves the admin token and the projects map beside it', async () => {
  await writeFile(
    store,
    JSON.stringify({
      projects: { ogun: '/srv/ogun' },
      server: { token: 'ogun_keep_me' },
      secrets: { other: { linear: 'lin_api_other_project' } },
    }),
  )

  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const config = await loadLocalConfig(store)
  assert.equal(config.server.token, 'ogun_keep_me')
  assert.equal(config.projects.ogun, '/srv/ogun')
  assert.equal(config.secrets.other?.linear, 'lin_api_other_project')
})

/**
 * The property: the `oauth` block survives an unrelated write.
 *
 * `updateLocalConfig` is a read-modify-write through `localConfigSchema` and zod strips
 * what a schema does not name — so a block that is not declared there is silently deleted
 * by the next `ogun project add`. `secrets` already has this test, and it exists because
 * the failure has no symptom at the time: the command prints success, exits 0, and the
 * connection is gone.
 */
test('the oauth block is not stripped by an unrelated config write', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  // Exactly what `ogun project add` does.
  await updateLocalConfig(
    (config) => ({ ...config, projects: { ...config.projects, other: '/srv/other' } }),
    store,
  )

  assert.equal((await readProjectSecret('ogun', 'linear', store)).state, 'granted')
})

// ── listing, and what it cannot say ────────────────────────────────────────

/**
 * The property: the listing reports a connection and cannot report a credential.
 *
 * A list endpoint is where secrets leak, so this is structural rather than remembered —
 * `ProjectGrantPresence` has room for a client id, a workspace, scopes and an expiry, and
 * no field any of the three secrets fits in. The assertion is against the serialised row
 * rather than against named fields, because the failure this guards against is somebody
 * *adding* a field, which a field-by-field check would not notice.
 */
test('the listing carries no token, and no client secret', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  const [row] = await listOAuthApps(store)
  assert.ok(row)
  assert.equal(row.connected, true)
  assert.equal(row.clientSecretSet, true)

  const serialised = JSON.stringify(row)
  for (const secret of ['access-abcdefghijklmnop', 'refresh-abcdefghijklmnop', 'lin_secret_']) {
    assert.doesNotMatch(serialised, new RegExp(secret), `the listing carried ${secret}`)
  }
})

/**
 * The property: a hand-edited entry the parser rejects still appears in the listing.
 *
 * §4.5 says this file gets hand-edited. A row that is invisible because it is broken is a
 * row nobody can remove, and the credential stays in the file — which is the closed set
 * protecting a value from its owner. It is reported as `malformed` so the UI can say what
 * it is rather than rendering an empty connected row.
 */
test('an unreadable entry is listed as malformed rather than hidden', async () => {
  await updateLocalConfig(
    (config) => ({ ...config, oauth: { ogun: { linear: { nonsense: true } } } }),
    store,
  )
  const [row] = await listOAuthApps(store)
  assert.ok(row?.malformed)
  assert.equal(row.connected, false)
})

// ── forgetting ─────────────────────────────────────────────────────────────

/**
 * The property: disconnecting and forgetting the application are different acts, and both
 * distinguish "removed" from "there was nothing here".
 *
 * A command that prints "disconnected" for both teaches its user that it worked after they
 * disconnected the wrong project. And a disconnect that took the application with it would
 * make every reconnect require the client secret again, from a workspace settings page the
 * operator may not be an admin of.
 */
test('disconnect keeps the application; forgetting it takes the grant too', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)

  assert.equal(await clearOAuthGrant('ogun', 'linear', store), true)
  assert.equal(await clearOAuthGrant('ogun', 'linear', store), false)
  assert.equal((await readOAuthApp('ogun', 'linear', store)).state, 'present')

  assert.equal(await clearOAuthApp('ogun', 'linear', store), true)
  assert.equal(await clearOAuthApp('ogun', 'linear', store), false)
  assert.equal((await readOAuthApp('ogun', 'linear', store)).state, 'absent')

  // An emptied project drops out entirely rather than being left as `{}`, so a later read
  // is "nobody set one" rather than "a project that exists holding nothing".
  const raw = JSON.parse(await readFile(store, 'utf8')) as { oauth: Record<string, unknown> }
  assert.equal(raw.oauth.ogun, undefined)
})

/**
 * The property: a stored token never arrives as a bare string.
 *
 * `Secret` survives `console.log`, `JSON.stringify` and interpolation as `[redacted]`, and
 * that is what makes it safe for a poller to write `console.error('poll failed', { key })`
 * without thinking about it. The grant has three of them, and the one that is easiest to
 * forget is the refresh token, which is the longest-lived of the three.
 */
test('the tokens on a grant are sealed, not strings', async () => {
  await setOAuthApp('ogun', 'linear', app(), store)
  await storeOAuthGrant('ogun', 'linear', grant(), store)
  const read = await readProjectSecret('ogun', 'linear', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return

  assert.equal(String(read.grant.access), '[redacted]')
  assert.equal(String(read.grant.refresh), '[redacted]')
  assert.equal(JSON.stringify(read.grant), JSON.stringify({
    clientId: 'client-1',
    access: '[redacted]',
    refresh: '[redacted]',
    grantType: 'authorization_code',
    expiresAt: read.grant.expiresAt,
    obtainedAt: read.grant.obtainedAt,
    scopes: ['read'],
    actor: 'app',
    workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
  }))

  const appRead = await readOAuthApp('ogun', 'linear', store)
  assert.equal(appRead.state, 'present')
  if (appRead.state !== 'present') return
  assert.equal(String(appRead.app.clientSecret), '[redacted]')
})
