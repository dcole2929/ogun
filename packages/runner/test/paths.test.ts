import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { safeJoin } from '../src/sandbox/paths.ts'

/**
 * Anything read back from a sandbox goes through this. A container that can write a
 * symlink can otherwise name any file on the host (§5.3).
 */
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-paths-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'sub', 'ok.json'), '{}')
  await writeFile(join(root, 'secret.txt'), 'host secret')
  return { root, workspace }
}

test('a normal relative path resolves inside the workspace', async () => {
  const { workspace } = await fixture()
  assert.match(await safeJoin(workspace, 'sub/ok.json'), /workspace\/sub\/ok\.json$/)
})

test('absolute paths and parent traversal are rejected', async () => {
  const { workspace } = await fixture()
  await assert.rejects(() => safeJoin(workspace, '/etc/passwd'), /absolute/)
  await assert.rejects(() => safeJoin(workspace, '../secret.txt'), /parent traversal/)
  await assert.rejects(() => safeJoin(workspace, 'sub/../../secret.txt'), /parent traversal/)
})

test('a symlink pointing out of the workspace does not escape', async () => {
  const { root, workspace } = await fixture()
  await symlink(root, join(workspace, 'escape'))
  await assert.rejects(() => safeJoin(workspace, 'escape/secret.txt'), /escapes the workspace/)
})

test('a not-yet-created file in a real directory is allowed', async () => {
  const { workspace } = await fixture()
  // The reviewer writes its findings file; the leaf must not have to exist already.
  assert.match(await safeJoin(workspace, 'sub/findings.json'), /sub\/findings\.json$/)
})
