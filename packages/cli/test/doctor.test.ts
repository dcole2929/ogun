import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configPermissions } from '../src/commands/doctor.ts'

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
