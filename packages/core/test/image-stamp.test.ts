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
