import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { credentialStatuses } from '@ogun/gateway'
import type { CredentialSet } from '@ogun/gateway'
import { configPermissions, gatewayCredentials } from '../src/commands/doctor.ts'

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
