import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialStatuses } from '@ogun/gateway'
import type { CredentialSet } from '@ogun/gateway'
import { configPermissions, gatewayCredentials, linearGrants } from '../src/commands/doctor.ts'

const configAt = async (mode: number): Promise<string> => {
  const path = join(await mkdtemp(join(tmpdir(), 'ogun-doctor-')), 'config.json')
  await writeFile(path, '{"projects":{}}\n')
  await chmod(path, mode)
  return path
}

/**
 * Tightening on write does nothing for a file that is never written again. This is the
 * only thing that looks at the mode a config.json is sitting at right now.
 */
test('a world-readable config.json is reported', async () => {
  const check = await configPermissions(await configAt(0o644))
  assert.equal(check?.ok, false)
  assert.match(check!.detail, /0644/)
  // It says what to type. A check that only names the problem gets ignored.
  assert.match(check!.detail, /chmod 600/)
})

test('a group-readable config.json is reported too', async () => {
  // 0640 leaks the admin token to everyone in the group, which on a shared box is the
  // more likely mistake than 0644.
  assert.equal((await configPermissions(await configAt(0o640)))?.ok, false)
})

test('an owner-only config.json passes', async () => {
  const check = await configPermissions(await configAt(0o600))
  assert.equal(check?.ok, true)
})

test('a machine with no config.json is not a failing check', async () => {
  // Never set up is an ordinary state, and doctor already has a check that says so.
  assert.equal(await configPermissions('/nonexistent/ogun/config.json'), undefined)
})

// ── the credential preflight ───────────────────────────────────────────────

const now = Date.UTC(2026, 7, 20, 18, 0, 0)
const anthropic = (set: CredentialSet) => gatewayCredentials(credentialStatuses(set, now))[0]!
const withOauth = (expiresAt: number): CredentialSet => ({
  anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'sk-ant-oat01-x', expiresAt },
})

/**
 * `present` is not the question, and this is the check that says so.
 *
 * An expired token is on disk, parses, and has an access token in it — every test a
 * presence check runs, it passes. So the machine this whole preflight exists for, an
 * unattended runner whose token lapsed weeks ago, got a green `ok` line from `doctor`
 * while every job it ran failed on auth at 3am. The check has to degrade on the
 * classification, never on whether a file was found.
 */
test('a token that is present and dead is not an ok line', () => {
  const check = anthropic(withOauth(now - 6 * 36e5))
  assert.equal(check.ok, false)
  assert.match(check.detail, /EXPIRED 6h ago/)
  assert.match(check.detail, /run `claude` on this host/)
})

test('a token with 42 minutes left is a warning, because doctor is run before the night', () => {
  /**
   * The naive version asks "is it valid right now" and answers yes. It is right, and
   * useless: the job this machine is about to be handed runs for half an hour, so the
   * token dies partway and the 401 arrives with the container already started.
   */
  const check = anthropic(withOauth(now + 42 * 60_000))
  assert.equal(check.ok, false)
  assert.match(check.detail, /42m left/)
})

test('a token with hours left is an ok line, or the warning stops meaning anything', () => {
  const check = anthropic(withOauth(now + 6 * 36e5))
  assert.equal(check.ok, true)
  assert.match(check.detail, /6h left/)
})

test('an API key is ok forever, and is never warned about', () => {
  // The one configuration that is actually correct for a runner nobody logs into: it
  // cannot lapse, so a check that nagged about it would be teaching a bad habit.
  const check = anthropic({
    anthropic: { provider: 'anthropic', mode: 'api-key', apiKey: 'sk-ant-api03-x' },
  })
  assert.equal(check.ok, true)
  assert.match(check.detail, /does not expire/)
})

test('a missing credential is still a warning and still not fatal', () => {
  /**
   * Not fatal on purpose. `doctor` exits 1 on a fatal check with "this runner cannot
   * claim jobs", and a box with no Anthropic credential can still run every codex worker
   * it has — so making this fatal would be a false statement about the machine.
   */
  const check = anthropic({})
  assert.equal(check.ok, false)
  assert.equal(check.fatal, false)
  assert.match(check.detail, /cannot authenticate/)
})

test('an absent github token stays the intended default rather than a credential warning', () => {
  // The gateway's GitHub token is opt-in (ADR-0005). Nothing about the expiry work above
  // may start treating its absence as a lapse.
  const github = gatewayCredentials(credentialStatuses({}, now))[2]!
  assert.equal(github.fatal, false)
  assert.match(github.detail, /intended default/)
})

// ── the linear connection ──────────────────────────────────────────────────

const storeWith = async (config: unknown): Promise<string> => {
  const path = join(await mkdtemp(join(tmpdir(), 'ogun-doctor-oauth-')), 'config.json')
  await writeFile(path, JSON.stringify(config))
  return path
}

const anApp = (grant?: unknown) => ({
  clientId: 'client-1',
  clientSecret: 'lin_secret_abcdefghij',
  redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
  ...(grant === undefined ? {} : { grant }),
})

const aGrant = (expiresAt: number) => ({
  accessToken: 'access-abcdefghij',
  refreshToken: 'refresh-abcdefghij',
  expiresAt,
  obtainedAt: expiresAt - 24 * 36e5,
  scopes: ['read'],
  actor: 'app',
  workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
})

/**
 * The property: `doctor` says which workspace Ogun is acting in and as whom, not merely
 * that something is connected.
 *
 * A green "linear: connected" answers the wrong question. The entire reason for an OAuth
 * application rather than a personal key is *who Linear attributes activity to*, so a
 * status line that omits the workspace and the actor has removed the evidence the feature
 * exists to produce — and the case it hides is the expensive one: an operator who
 * authorized the wrong workspace, whose tickets simply never arrive.
 */
test('a connected project reports its workspace, actor, scopes and remaining life', async () => {
  const store = await storeWith({ oauth: { ogun: { linear: anApp(aGrant(now + 7 * 36e5)) } } })
  const [check] = await linearGrants(store, now)

  assert.equal(check?.ok, true)
  assert.match(check!.detail, /7h left/)
  assert.match(check!.detail, /in Acme/)
  assert.match(check!.detail, /as the app/)
  assert.match(check!.detail, /scopes: read/)
  // Never a token. There is no branch of that function that could print one: the listing
  // type it reads has no field a credential fits in.
  assert.ok(!check!.detail.includes('access-'))
  assert.ok(!check!.detail.includes('refresh-'))
})

/**
 * The property: **an expired access token is not a warning.**
 *
 * This is the one place `doctor`'s Linear line deliberately disagrees with its Anthropic
 * line, and the difference is a fact about the system rather than a matter of tone.
 * Nothing renews the Anthropic token — the gateway re-reads a file a human's own CLI
 * refreshes — so an expired one needs a person, and the line is red. A Linear grant is
 * renewed by the next poll from a refresh token Ogun owns. Warning about it would train an
 * operator to act on the one state that needs no action, and then to ignore the line on
 * the night it means something.
 */
test('an expired access token is reported as renewable, not as a problem', async () => {
  const store = await storeWith({ oauth: { ogun: { linear: anApp(aGrant(now - 9 * 36e5)) } } })
  const [check] = await linearGrants(store, now)

  assert.equal(check?.ok, true)
  assert.match(check!.detail, /the next poll renews it/)
})

/**
 * The property: **a personal key that a grant is shadowing is called out.**
 *
 * The line that earns this check. A project with both authenticates with the grant —
 * `readProjectSecret` decides, once — so an operator debugging a poll failure by rotating
 * the key is changing something nothing reads, and every observation afterwards confirms
 * the wrong theory. Nothing else in the system is in a position to say it: the poll's
 * error names a credential, and `ogun secret list` only knows about keys.
 */
test('an api key behind a live grant is reported as not being used', async () => {
  const store = await storeWith({
    secrets: { ogun: { linear: 'lin_api_the_old_way' } },
    oauth: { ogun: { linear: anApp(aGrant(now + 7 * 36e5)) } },
  })
  const [check] = await linearGrants(store, now)
  assert.match(check!.detail, /api key is also stored/)
  assert.match(check!.detail, /NOT being used/)
})

/**
 * The property: an application registered and never connected is a warning with the
 * command that finishes it.
 *
 * It is the one genuinely actionable state here, and it is invisible from every other
 * surface — the poll refuses, quietly, into a `source_polls` row. `doctor` is where a
 * person looks when nothing is happening.
 */
test('an application nobody connected warns, and names the command that finishes it', async () => {
  const store = await storeWith({ oauth: { ogun: { linear: anApp() } } })
  const [check] = await linearGrants(store, now)
  assert.equal(check?.ok, false)
  assert.match(check!.detail, /never connected/)
  assert.match(check!.detail, /ogun linear connect --project ogun/)
})

/**
 * The property: a machine with no applications produces **no line at all**, rather than a
 * green one.
 *
 * A check that said "linear: none" would read as coverage it does not have. `doctor` reads
 * no repositories, so it cannot know which projects declare a `sources:` block and need a
 * connection — and the absence-of-evidence mistake is the one the credential preflight was
 * built to avoid.
 */
test('a machine with no linear applications adds no line', async () => {
  assert.deepEqual(await linearGrants(await storeWith({ projects: {} }), now), [])
})
