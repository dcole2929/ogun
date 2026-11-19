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
  migrateLegacyOAuth,
  readApplication,
  readGrant,
  setApplication,
  storeGrant,
} from '../src/config/secrets.ts'
import { parseLocalConfig } from '../src/config/machine.ts'

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
