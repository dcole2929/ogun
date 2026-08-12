import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_READBACK_BYTES, readContained, safeJoin, UnsafeReadback } from '../src/sandbox/paths.ts'

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

/**
 * The escape these guard against: a symlink inside the workspace is just a string, and
 * the *runner* resolves it on the *host*. The container never escapes anything — it
 * arranges for the host to read a file and hand the contents back through the API.
 *
 * Found by ogun's own adversarial reviewer, rated critical, against pipeline.ts:226.
 */
test('a symlinked output file is refused, not followed onto the host', async () => {
  const { root, workspace } = await fixture()
  await mkdir(join(workspace, '.ogun-out'))
  await symlink(join(root, 'secret.txt'), join(workspace, '.ogun-out', 'findings.json'))

  await assert.rejects(
    () => readContained(workspace, '.ogun-out/findings.json'),
    UnsafeReadback,
    'the host followed a symlink the sandbox planted',
  )
})

test('a symlink to a file inside the workspace is refused too', async () => {
  // No exception for "it happens to point somewhere harmless" — the check is on the
  // shape, because the target can be swapped between the check and the read.
  const { workspace } = await fixture()
  await symlink(join(workspace, 'sub', 'ok.json'), join(workspace, 'link.json'))
  await assert.rejects(() => readContained(workspace, 'link.json'), UnsafeReadback)
})

test('an ordinary file still reads', async () => {
  const { workspace } = await fixture()
  assert.equal(await readContained(workspace, 'sub/ok.json'), '{}')
})

test('a missing file is null, which is an ordinary outcome', async () => {
  const { workspace } = await fixture()
  assert.equal(await readContained(workspace, 'sub/nothing.json'), null)
})

test('a directory is not a readback', async () => {
  const { workspace } = await fixture()
  await assert.rejects(() => readContained(workspace, 'sub'), UnsafeReadback)
})

test('an oversized file is refused rather than held in memory', async () => {
  const { workspace } = await fixture()
  const big = join(workspace, 'big.json')
  await writeFile(big, 'x'.repeat(MAX_READBACK_BYTES + 1))
  await assert.rejects(() => readContained(workspace, 'big.json'), UnsafeReadback)
})

test('traversal and absolute paths are still refused at the read boundary', async () => {
  const { workspace } = await fixture()
  await assert.rejects(() => readContained(workspace, '../secret.txt'), /parent traversal/)
  await assert.rejects(() => readContained(workspace, '/etc/passwd'), /absolute/)
})
