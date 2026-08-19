import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import {
  containedTarget,
  MAX_READBACK_BYTES,
  readContained,
  safeJoin,
  UnsafeReadback,
} from '../src/sandbox/paths.ts'

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

/**
 * Writes *into* a workspace, which had no containment at all until now.
 *
 * The asymmetry with reads is not symmetric in risk. `.ogun-in/` is laid out on the host
 * *before the sandbox exists*, inside a checkout of a repository the runner does not
 * trust — so a repo that ships `.ogun-in` as a symlink names a host file for the runner
 * to overwrite with the runner's own privileges.
 */
describe('containedTarget', () => {
  let root = ''
  let outside = ''

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogun-write-'))
    outside = join(root, 'outside')
    await mkdir(join(root, 'ws'), { recursive: true })
    await mkdir(outside, { recursive: true })
  })

  const ws = () => join(root, 'ws')

  test('an ordinary path is created and returned inside the workspace', async () => {
    const target = await containedTarget(ws(), '.ogun-in/history.json')
    assert.equal(target, join(await realpath(ws()), '.ogun-in', 'history.json'))
    await writeFile(target, 'ok')
    assert.equal(await readFile(target, 'utf8'), 'ok')
  })

  /**
   * The case `writeSecretFile` alone does not cover: it unlinks and creates the leaf, so
   * a symlinked *file* is replaced rather than followed — but a symlinked *directory*
   * moves the whole parent, and the leaf write then happens safely in the wrong place.
   */
  test('a symlinked parent directory does not redirect the write', async () => {
    const link = join(ws(), '.ogun-redirected')
    await symlink(outside, link)
    await writeFile(join(outside, 'target.txt'), 'HOST SECRET')

    await assert.rejects(
      () => containedTarget(ws(), '.ogun-redirected/target.txt'),
      /outside the workspace/,
    )
    assert.equal(
      await readFile(join(outside, 'target.txt'), 'utf8'),
      'HOST SECRET',
      'the host file was overwritten',
    )
  })

  /** Checked before `mkdir`, or a link to a missing directory is used to create one. */
  test('a link pointing at a directory that does not exist creates nothing', async () => {
    const missing = join(root, 'not-yet')
    await symlink(missing, join(ws(), '.ogun-missing'))
    await assert.rejects(() => containedTarget(ws(), '.ogun-missing/x.json'))
    assert.equal(existsSync(missing), false, 'mkdir -p walked through the link')
  })

  test('absolute and traversing paths are refused before anything is touched', async () => {
    await assert.rejects(() => containedTarget(ws(), '/etc/passwd'), /absolute/)
    await assert.rejects(() => containedTarget(ws(), '../escape.json'), /traversal/)
  })
})
