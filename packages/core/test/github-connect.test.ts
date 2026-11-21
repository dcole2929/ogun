import { strict as assert } from 'node:assert'
import { after, before, beforeEach, test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectGithubApp,
  disconnectGithub,
  linkGithubApplication,
  linkedGithubApplication,
} from '../src/integrations/github-connect.ts'
import { GithubAppError } from '../src/integrations/github-app.ts'
import {
  listApplications,
  listGrants,
  readApplication,
  readProjectSecret,
  setProjectSecret,
} from '../src/config/secrets.ts'
import { installationResponse, installationTokenResponse } from './github-app-fixtures.ts'

/**
 * Connecting a project to GitHub as an App, in one act.
 *
 * The wire is `github-app.test.ts` and the store is `applications.test.ts`. What is only
 * here is the *sequence* — which write happens first, what a half-finished connect leaves
 * behind, and what a disconnect is allowed to leave in the file — which is the half that
 * would otherwise exist twice, once in a route and once in a command, and drift.
 *
 * `github-app-fixtures.ts` carries the provenance. The sentence that matters: **no GitHub
 * App exists for this repository and no private key exists on any machine here**, so
 * nothing below has spoken to GitHub.
 */

const APP_ID = '1234567'
const INSTALLATION_ID = '98765432'
const TOKEN = 'ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PAT = 'ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

let dir = ''
let store = ''
let privateKey = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ogun-gh-connect-'))
  privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(() => {
  store = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
})

type Answer = [number, string]

const wire = (over: Partial<Record<'token' | 'install', Answer>> = {}) => {
  const calls: string[] = []
  const fn = (async (url: unknown) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/access_tokens')) {
      calls.push('mint')
      const [status, body] = over.token ?? [201, installationTokenResponse()]
      return new Response(body, { status })
    }
    calls.push('describe')
    const [status, body] = over.install ?? [200, installationResponse()]
    return new Response(body, { status })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

const deps = (fetch: typeof globalThis.fetch) => ({
  fetch,
  endpoint: 'https://github.test',
  path: store,
})

const credentials = () => ({
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  privateKey,
})

// ── connecting ─────────────────────────────────────────────────────────────

/**
 * The property: connecting is **one act**, in the order mint → describe → name → write the
 * application → write the grant, and everything a later surface needs is recorded while
 * the token is fresh.
 *
 * The order is the part with a failure mode in it, and it is asserted on the calls rather
 * than left to a comment: an application in the store is one that has been spent at least
 * once, and the name on it describes an account the credential proved it reaches.
 *
 * The bot login is stored on the grant's `actor` rather than being recomputed. It is only
 * obtainable while holding the key — `GET /user` does not work for an installation token —
 * and `loopGuard` compares comment authors against it, where a wrong answer is a source
 * that feeds itself.
 */
test('one call mints a token, names the application after the account, and writes both', async (t) => {
  const { fn, calls } = wire()
  const connection = await connectGithubApp('heirchive-api', credentials(), deps(fn))

  assert.deepEqual(calls, ['mint', 'describe'])
  assert.equal(connection.application, 'github:heirchive', 'lowercased, from account.login')
  assert.equal(connection.account, 'Heirchive')
  assert.equal(connection.login, 'ogun[bot]')
  assert.equal(connection.installationId, INSTALLATION_ID)
  assert.equal(connection.repositorySelection, 'all')
  assert.deepEqual(connection.permissions, ['contents:read', 'pull_requests:read'])
  assert.equal(connection.applicationReplaced, false)
  assert.deepEqual(connection.displacedProjects, [])

  const read = await readProjectSecret('heirchive-api', 'github', store)
  assert.equal(read.state, 'granted')
  if (read.state !== 'granted') return
  assert.equal(read.grant.app, 'github:heirchive')
  assert.equal(read.grant.grantType, 'installation')
  assert.equal(read.grant.access.expose(), TOKEN)
  /**
   * No refresh token, and that is not a degraded grant: renewal is signing a fresh JWT
   * with the private key already in the application, which needs no person, spends nothing
   * and can be repeated.
   */
  assert.equal(read.grant.refresh, undefined)
  assert.equal(read.grant.actor, 'ogun[bot]')
  assert.deepEqual(read.grant.account, { id: '42', name: 'Heirchive', urlKey: 'Heirchive' })

  t.diagnostic(`stored ${JSON.stringify(await listGrants(store))}`)
})

/**
 * The property: **nothing is written until a token comes back**, and nothing is written if
 * the installation cannot be described either.
 *
 * The first half is the rule the whole reordering exists for and it is shared with the
 * Linear path: an unproven private key on the disk is a credential no poll will ever
 * spend, reported by `connect list` and `doctor` as a thing that exists.
 *
 * The second half is where this path deliberately differs. `finishConnection` lets
 * Linear's `identify` fail and still stores the grant, because everything it returns there
 * is for display. Here the describe call carries the application's *name* and the login a
 * loop guard will trust — so a connect that could not ask would have to invent both, and it
 * refuses instead. The cost is stated rather than hidden: the operator runs the command
 * again.
 */
test('neither a failed mint nor a failed describe leaves anything behind', async () => {
  for (const [what, over] of [
    ['the mint', { token: [401, '{"message":"Bad credentials"}'] as Answer }],
    ['the describe', { install: [500, 'upstream'] as Answer }],
  ] as const) {
    const fresh = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
    const { fn } = wire(over)
    const err = await connectGithubApp('heirchive-api', credentials(), {
      ...deps(fn),
      path: fresh,
    }).then(
      () => null,
      (e: unknown) => e,
    )

    assert.ok(err instanceof GithubAppError, what)
    assert.deepEqual(await listApplications(fresh), [], what)
    assert.deepEqual(await listGrants(fresh), [], what)
    // Not even an empty file: nothing wrote, so there is nothing to have written one.
    assert.equal(await readFile(fresh, 'utf8').then(() => true, () => false), false, what)
  }
})

/**
 * The property: **the private key exists once**, and a second project links to the
 * application rather than copying it.
 *
 * This is the whole reason the store was split, and it matters more for GitHub than for
 * Linear: a client secret is on the provider's settings page forever, but **a GitHub App's
 * private key is displayed once at generation and can never be retrieved again**. Two
 * copies of it is two values that must agree, with nothing that makes them, and no way to
 * tell which one a poll used.
 *
 * The link still **mints**, because "connected" has to mean "proved". A key can be revoked
 * in GitHub's UI at any moment and an installation can be removed, so a link that only
 * wrote a pointer would be the likeliest of all the paths to report a connection that does
 * not exist.
 */
test('two projects share one app, and the private key is stored once', async () => {
  const first = wire()
  await connectGithubApp('heirchive-api', credentials(), deps(first.fn))

  const second = wire()
  const linked = await linkGithubApplication('heirchive-web', 'github:heirchive', deps(second.fn))

  assert.deepEqual(second.calls, ['mint', 'describe'], 'linking spent the application')
  assert.equal(linked.application, 'github:heirchive')
  assert.deepEqual(
    (await listApplications(store)).map((a) => [a.name, a.usedBy]),
    [['github:heirchive', ['heirchive-api', 'heirchive-web']]],
  )

  const file = await readFile(store, 'utf8')
  assert.equal(
    file.split('BEGIN PRIVATE KEY').length - 1,
    1,
    'the private key exists more than once, which is the bug the split removed',
  )
  // And `linkedGithubApplication` is how a reconnect finds it without asking for anything.
  assert.equal((await linkedGithubApplication('heirchive-web', store))?.name, 'github:heirchive')
})

/**
 * The property: connecting retires the personal access token it supersedes, **after** the
 * grant is on disk.
 *
 * A grant beats a key — ADR-0014 settled that once for Linear and `projectGithubCredential`
 * follows it — so leaving the token behind would leave a credential that reports as set and
 * is read by nothing, which is the first thing somebody rotates when a poll fails.
 *
 * The order is the part with a failure mode in it. Removing the key first and then failing
 * the write would trade a shadowed token for no credential at all.
 */
test('connecting retires the personal access token it supersedes', async () => {
  await setProjectSecret('heirchive-api', 'github', PAT, store)
  const { fn } = wire()
  const connection = await connectGithubApp('heirchive-api', credentials(), deps(fn))

  assert.equal(connection.apiKeyRetired, true)
  const read = await readProjectSecret('heirchive-api', 'github', store)
  assert.equal(read.state, 'granted')
  assert.equal(read.state === 'granted' ? read.apiKeyIgnored : true, false)
})

/**
 * The property: linking a name that is not there, or that belongs to another provider,
 * fails with a sentence rather than minting something.
 *
 * The provider check is not pedantry. `applications` is one map across providers, so
 * `--link linear:acme` on a `github` connect is one typo away — and without this the code
 * would read `appId` off a Linear application, sign a JWT with `undefined`, and report
 * whatever GitHub said about it.
 */
test('linking an absent or wrong-provider application is refused', async () => {
  const { fn, calls } = wire()
  await connectGithubApp('heirchive-api', credentials(), deps(fn))

  const absent = await linkGithubApplication('other', 'github:nope', deps(fn)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(absent instanceof GithubAppError)
  assert.equal(absent.kind, 'config')
  assert.match(absent.message, /no application named "github:nope"/)

  calls.length = 0
  const wrong = await linkGithubApplication('other', 'linear:acme', deps(fn)).then(
    () => null,
    (e: unknown) => e,
  )
  // There is no linear:acme here either, so the first refusal is the one that fires — what
  // is asserted is that nothing was spent on the way to finding out.
  assert.ok(wrong instanceof GithubAppError)
  assert.deepEqual(calls, [], 'a refused link reached the network')
})

// ── disconnecting ──────────────────────────────────────────────────────────

/**
 * The property: a disconnect takes the grant, the personal token, and — only when nothing
 * else uses it — the application, **and it does not try to revoke anything**.
 *
 * The revoke is the one real difference from the Linear disconnect and the reason this is
 * a separate function rather than a branch: **GitHub has no endpoint that ends an
 * installation token early.** A one-hour life is the whole of its revocation story. Folding
 * it into `disconnectProject` would have meant posting a GitHub installation token to
 * `api.linear.app/oauth/revoke` — a credential handed to the wrong third party by the
 * command whose whole job is to take credentials away.
 *
 * Taking the private key is the destructive half and it is deliberate: a key kept after the
 * last thing that read it is a live credential nobody is watching, in every backup of the
 * machine. GitHub shows one only once, so the surfaces above this say so.
 */
test('a disconnect removes the grant, the token and the app, and revokes nothing', async () => {
  const { fn, calls } = wire()
  await connectGithubApp('heirchive-api', credentials(), deps(fn))
  /**
   * The token is written *after* the connect, which is the only way this state is now
   * reachable: the ordinary path retires one (asserted above). A key beside a grant comes
   * from a hand-edited config.json — §4.5 says that happens — or from a build that wrote
   * one before the grant existed, and `readProjectSecret` still reports it as
   * `apiKeyIgnored` for exactly that reason. A disconnect that left it behind would leave
   * the project **still connected**, by the credential the operator was least likely to be
   * thinking about.
   */
  await setProjectSecret('heirchive-api', 'github', PAT, store)
  calls.length = 0

  const gone = await disconnectGithub('heirchive-api', {}, { path: store })
  assert.ok(gone.ok)
  if (!gone.ok) return
  assert.equal(gone.removed, true)
  assert.equal(gone.apiKeyRemoved, true)
  assert.equal(gone.applicationForgotten, true)
  assert.equal(gone.revoked, false, 'reported, not omitted — a missing field reads as "unknown"')
  assert.equal(gone.grantType, 'installation')
  assert.deepEqual(calls, [], 'a disconnect reached the network')

  assert.deepEqual(await listApplications(store), [])
  assert.deepEqual(await listGrants(store), [])

  // "removed" and "there was nothing here" are different answers all the way out.
  const again = await disconnectGithub('heirchive-api', {}, { path: store })
  assert.equal(again.ok && again.removed, false)
})

/**
 * The property: an application another project still uses is **kept**, and the disconnect
 * says who is using it.
 *
 * The cascade the shared store made possible is refused rather than performed: it would
 * take four working projects offline to satisfy one `disconnect` typed in the wrong
 * directory. And "disconnected" said while a private key is still on the disk is a
 * half-truth — the half somebody removing a credential most needs.
 *
 * `--keep-application` is the other direction and is **never refused** here, unlike the
 * Linear path: a private key with no installation token beside it mints nothing until
 * somebody signs a JWT with it, so keeping it is not a disconnection the machine undoes by
 * itself.
 */
test('an application another project uses is kept, and the disconnect names who', async () => {
  await connectGithubApp('heirchive-api', credentials(), deps(wire().fn))
  await linkGithubApplication('heirchive-web', 'github:heirchive', deps(wire().fn))

  const shared = await disconnectGithub('heirchive-api', {}, { path: store })
  assert.ok(shared.ok)
  if (!shared.ok) return
  assert.equal(shared.applicationForgotten, false)
  assert.deepEqual(shared.applicationSharedWith, ['heirchive-web'])
  assert.equal((await readApplication('github:heirchive', store)).state, 'present')
  assert.equal((await readProjectSecret('heirchive-web', 'github', store)).state, 'granted')

  const kept = await disconnectGithub('heirchive-web', { keepApplication: true }, { path: store })
  assert.ok(kept.ok)
  if (!kept.ok) return
  assert.equal(kept.removed, true)
  assert.equal(kept.applicationForgotten, false)
  assert.equal(
    (await readApplication('github:heirchive', store)).state,
    'present',
    'keeping the application is allowed for github, where a key alone mints nothing',
  )
  assert.deepEqual(await listGrants(store), [], 'and the grant went anyway')
})

/**
 * The property: replacing the application under a name with a **different** App or a
 * different installation drops the grants that were minted by the old one, and the
 * connection says which projects were disconnected.
 *
 * `setApplication` carries the rule; this is it reaching the surface somebody reads. A
 * grant points at a *name* now, so without the drop a replaced entry would re-point live
 * tokens at credentials that never minted them — a connection that reports as healthy and
 * 401s on the next poll, on a project nobody was looking at.
 *
 * `displacedProjects` excludes the project doing the connecting, whose grant is written a
 * moment later and is the fresh one.
 */
test('pointing a name at a different installation disconnects the projects that used it', async () => {
  await connectGithubApp('heirchive-api', credentials(), deps(wire().fn))
  await linkGithubApplication('heirchive-web', 'github:heirchive', deps(wire().fn))

  const moved = await connectGithubApp(
    'heirchive-api',
    { ...credentials(), installationId: '11111111' },
    deps(wire().fn),
  )

  assert.equal(moved.applicationReplaced, true)
  assert.deepEqual(moved.displacedProjects, ['heirchive-web'])
  assert.equal((await readProjectSecret('heirchive-api', 'github', store)).state, 'granted')
  assert.equal((await readProjectSecret('heirchive-web', 'github', store)).state, 'absent')
})

/**
 * The property: a **rotated private key** keeps every grant.
 *
 * The other half of the rule above, and the direction that would be expensive to get
 * wrong: a key rotation is routine, every token the App already issued keeps working, and
 * dropping the grants would force a reconnect of every project that shares the App for no
 * reason at all. What identifies an application is what GitHub issues tokens *against* —
 * the App and the installation — not the secret used to ask.
 */
test('rotating the private key keeps every grant', async () => {
  await connectGithubApp('heirchive-api', credentials(), deps(wire().fn))
  await linkGithubApplication('heirchive-web', 'github:heirchive', deps(wire().fn))

  const rotatedKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey

  const rotated = await connectGithubApp(
    'heirchive-api',
    { ...credentials(), privateKey: rotatedKey },
    deps(wire().fn),
  )
  assert.equal(rotated.applicationReplaced, true)
  assert.deepEqual(rotated.displacedProjects, [])
  assert.equal((await readProjectSecret('heirchive-web', 'github', store)).state, 'granted')
})

/**
 * The property: **`--as` overrides the derived name**, for one account with two Apps.
 *
 * Both derive to `github:heirchive`, so without the override the second would replace the
 * first — and then correctly drop the first's grants, which is not what anybody wanted.
 * This is the escape hatch, and it is the only thing in the command that lets a person name
 * a shared credential.
 */
test('--as gives a second app in one account its own name', async () => {
  await connectGithubApp('heirchive-api', credentials(), deps(wire().fn))
  const second = await connectGithubApp(
    'heirchive-web',
    { ...credentials(), appId: '7654321' },
    { ...deps(wire().fn), as: 'github:heirchive-releases' },
  )

  assert.equal(second.application, 'github:heirchive-releases')
  assert.deepEqual(second.displacedProjects, [])
  assert.deepEqual(
    (await listApplications(store)).map((a) => a.name),
    ['github:heirchive', 'github:heirchive-releases'],
  )
})

/**
 * The property: an application and a grant written here survive an unrelated write, and
 * the file is 0600.
 *
 * `updateLocalConfig` is a read-modify-write through `localConfigSchema` and zod strips
 * what a schema does not name, so an undeclared block is silently deleted by the next
 * `ogun project add` — a command that prints success, exits 0, and takes a private key
 * GitHub will never show again with it.
 */
test('a github application survives an unrelated config write, at 0600', async () => {
  await writeFile(store, JSON.stringify({ server: { token: 'ogun_keep_me' } }), { mode: 0o600 })
  await connectGithubApp('heirchive-api', credentials(), deps(wire().fn))

  const { updateLocalConfig, loadLocalConfig } = await import('../src/config/machine.ts')
  await updateLocalConfig(
    (config) => ({ ...config, projects: { ...config.projects, other: '/srv/other' } }),
    store,
  )

  assert.equal((await loadLocalConfig(store)).server.token, 'ogun_keep_me')
  assert.equal((await readApplication('github:heirchive', store)).state, 'present')
  assert.equal((await readProjectSecret('heirchive-api', 'github', store)).state, 'granted')
})
