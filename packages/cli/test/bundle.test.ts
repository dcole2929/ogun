import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Kept in step with `bundleCli` in `packages/cli/src/commands/image.ts` by hand, which is
 * the weak point of this test — but importing that function would run a docker build.
 * If the two drift, this passes while the image breaks, so change both together.
 */
const EXTERNAL = ['drizzle-orm', 'postgres', '@ogun/core/db']

/**
 * The CLI that ships inside the sandbox image must load with no `node_modules`.
 *
 * §7 says it is bundled "so it carries no node_modules and cannot drift from the
 * validator on the way in", and the image has no dependencies installed. Marking
 * `drizzle-orm` and `postgres` external stopped them being *bundled* but not being
 * *imported*: `ogun db …` reaches the client through `await import()`, esbuild inlines a
 * dynamically-imported internal module, and that module's own top-level
 * `import 'drizzle-orm/pg-core'` was hoisted to the top of the bundle. Every command in
 * the sandbox then died on load with ERR_MODULE_NOT_FOUND before printing anything —
 * including `ogun findings write`, which is how a reviewer reports at all.
 *
 * Asserted on the bundle rather than by running a container, so it fails in the test
 * suite rather than at 3am.
 */
test('the sandbox bundle imports nothing it will not find in the image', async () => {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [resolve(repoRoot, 'packages/cli/src/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    write: false,
    external: EXTERNAL,
    banner: {
      js: [
        "import { createRequire as __ogunCreateRequire } from 'node:module'",
        'const require = __ogunCreateRequire(import.meta.url)',
      ].join('\n'),
    },
    logLevel: 'silent',
  })

  const text = result.outputFiles[0]?.text ?? ''
  const bare = [...text.matchAll(/^import\s[^'"]*from\s*["']([^"']+)["']/gm)]
    .map((m) => m[1]!)
    .filter((spec) => !spec.startsWith('node:'))

  assert.deepEqual(
    bare,
    [],
    `the bundle top-level imports ${bare.join(', ')}, none of which exist in the image`,
  )
})
