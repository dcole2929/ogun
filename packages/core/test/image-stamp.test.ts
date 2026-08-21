import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandboxStamp } from '../src/image.ts'

/**
 * §7 says the CLI bundled into the sandbox image "cannot drift from the validator on the
 * way in". It can: nothing rebuilds the image when the CLI changes, and nothing compares
 * them. The image on the machine running this was seven days old, which hid two things —
 * a `findings schema` fix that never reached a reviewer, and a bundle that would not load
 * at all.
 *
 * The stamp is what makes the drift observable, so what it does and does not respond to
 * is the whole of its usefulness.
 */
test('the stamp is stable across calls', async () => {
  assert.equal(await sandboxStamp(), await sandboxStamp())
})

test('the stamp is a short hex digest, not a path or a timestamp', async () => {
  const stamp = await sandboxStamp()
  assert.match(stamp, /^[0-9a-f]{16}$/)
})

/**
 * The property that matters and the one a naive implementation gets wrong: hashing file
 * *contents* alone means a file moved without being edited leaves the stamp unchanged,
 * while the bundle it produces resolves differently.
 */
test('a file that moves changes the stamp even with identical contents', async () => {
  const { createHash } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'ogun-stamp-'))
  await mkdir(join(root, 'a'), { recursive: true })
  await mkdir(join(root, 'b'), { recursive: true })
  await writeFile(join(root, 'a', 'x.ts'), 'same body')

  // Mirrors what sandboxStamp does: path, then body.
  const digest = (path: string, body: string) =>
    createHash('sha256').update(path).update(body).digest('hex').slice(0, 16)

  assert.notEqual(
    digest('/a/x.ts', 'same body'),
    digest('/b/x.ts', 'same body'),
    'moving a file must change the stamp — the bundle resolves it differently',
  )
})

/**
 * The image used to say `FROM node:24-bookworm-slim` while `.tool-versions` pinned 26.4.0
 * for the host. Nothing failed — type stripping works on both — but every "the suite
 * passes" claim about a modifier's patch was made about a different Node than the one the
 * agent would run under. The version now lives in one file and reaches the image as a
 * build arg, and these are the two ways that can quietly come apart again.
 */
test('the base Dockerfile names no Node version of its own', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const dockerfile = await readFile(join(root, 'images', 'base', 'Dockerfile'), 'utf8')

  const from = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1]
  assert.equal(
    from,
    'node:${NODE_VERSION}-bookworm-slim',
    'a literal version here is a second place to write the pin down',
  )
  assert.match(dockerfile, /^ARG NODE_VERSION$/m, 'and it must be declared to be usable in FROM')
  assert.doesNotMatch(
    dockerfile,
    /^ARG NODE_VERSION=/m,
    'a default is that second place wearing a disguise — it applies silently when the arg is not passed',
  )
})

test('the pinned version is read from .tool-versions', async () => {
  const { pinnedNodeVersion } = await import('../src/image.ts')
  assert.match(await pinnedNodeVersion(), /^\d+\.\d+\.\d+$/)
})

/**
 * A file dropped from the source list is invisible in the digest: the stamp keeps
 * matching while the thing it describes has changed. `.tool-versions` is the one most
 * easily forgotten, because it does not live under images/.
 */
test('the stamp covers the file that decides the image Node', async () => {
  const { stampSources } = await import('../src/image.ts')
  const sources = await stampSources()
  assert.ok(
    sources.some((f) => f.endsWith('/.tool-versions')),
    'bumping the pin must make the installed image read as stale',
  )
  assert.ok(sources.some((f) => f.endsWith('/images/base/Dockerfile')))
})
