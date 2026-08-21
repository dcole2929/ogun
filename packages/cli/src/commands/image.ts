import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pinnedNodeVersion, sandboxStamp, STAMP_LABEL } from '@ogun/core'
import { bold, dim, fail, green } from '../output.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

/**
 * `ogun image build` — build at project-add time, not at 2am (§4.6). A nightly run that
 * has to build an image first is a nightly run that fails on a bad network.
 */
export async function imageBuild(args: string[]): Promise<void> {
  const project = args[0]
  const context = project ? resolve(project) : join(repoRoot, 'images', 'base')
  const dockerfile = project ? join(context, '.ogun', 'Dockerfile') : join(context, 'Dockerfile')
  const tag = project ? `ogun/project-${basenameOf(context)}:latest` : 'ogun/base:latest'

  if (!existsSync(dockerfile)) {
    fail(
      project
        ? `${dockerfile} not found. A project image is ${bold('FROM ogun/base')} plus its toolchain.`
        : `${dockerfile} not found`,
    )
  }

  if (!project) await bundleCli()

  console.log(dim(`building ${tag} from ${dockerfile}`))
  /**
   * Stamp the base image with a hash of what went into it, so a later check can tell
   * whether the installed image still matches the source. §7 claims the bundled CLI
   * "cannot drift from the validator on the way in"; it drifted for a week here, and hid
   * both a `findings schema` fix that never reached a reviewer and a bundle that would
   * not load at all. Project images are unstamped — they are `FROM ogun/base` plus a
   * toolchain, and the base is where the CLI lives.
   */
  const stamp = project ? undefined : await sandboxStamp()
  /**
   * The base image's Node comes from `.tool-versions`, passed in rather than written into
   * the Dockerfile, so the container runs the version the suite is tested against. A
   * project image inherits it by being `FROM ogun/base` and neither needs nor accepts the
   * arg — docker warns about build args a Dockerfile never declares.
   */
  const node = project ? undefined : await pinnedNodeVersion()
  const code = await runDocker([
    'build',
    '-t',
    tag,
    ...(stamp ? ['--label', `${STAMP_LABEL}=${stamp}`] : []),
    ...(node ? ['--build-arg', `NODE_VERSION=${node}`] : []),
    '-f',
    dockerfile,
    context,
  ])
  if (code !== 0) fail(`docker build exited ${code}`)
  console.log(green(`built ${tag}`))
}

/**
 * The in-sandbox CLI is bundled to a single file rather than installed from a registry.
 * It has to match the control plane that will read its output, and a bundle means the
 * image needs no node_modules and cannot drift from the validator on the way in.
 */
async function bundleCli(): Promise<void> {
  const out = join(repoRoot, 'images', 'base', 'cli', 'ogun.mjs')
  await mkdir(dirname(out), { recursive: true })
  const { build } = await import('esbuild')
  await build({
    entryPoints: [join(repoRoot, 'packages', 'cli', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    // The runtime the bundle will actually meet, which is the image's Node, which is the
    // pin. Hardcoding a target here was the other half of the same drift.
    target: `node${(await pinnedNodeVersion()).split('.')[0]}`,
    format: 'esm',
    outfile: out,
    /**
     * Only what the agent-facing subcommands need travels into the sandbox. Anything
     * that talks to postgres is server-side and must not be reachable from in here.
     *
     * `@ogun/core/db` is external for a reason that is easy to miss: marking only
     * `drizzle-orm` and `postgres` external stops them being *bundled*, but does not stop
     * them being *imported*. `ogun db …` reaches the client through `await import()`, and
     * esbuild inlines a dynamically-imported internal module into the same file — at
     * which point that module's own top-level `import 'drizzle-orm/pg-core'` is hoisted
     * to the top of the bundle. Every command then failed to load:
     *
     *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'drizzle-orm'
     *         imported from /opt/ogun/ogun.mjs
     *
     * Externalising the boundary module keeps the import lazy, so it is reached only by
     * the `db` subcommands, which are host-side and never run in a sandbox.
     */
    external: ['drizzle-orm', 'postgres', '@ogun/core/db'],
    // yaml is CJS and calls require() at module scope. Bundling CJS into ESM needs a
    // createRequire shim or it dies on the first dynamic require at startup.
    banner: {
      js: [
        "import { createRequire as __ogunCreateRequire } from 'node:module'",
        'const require = __ogunCreateRequire(import.meta.url)',
      ].join('\n'),
    },
    logLevel: 'warning',
  })
  console.log(dim(`bundled ogun cli -> ${out}`))
}

const basenameOf = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? 'project'

const runDocker = (args: string[]): Promise<number> =>
  new Promise((res) => {
    const child = spawn('docker', args, { stdio: 'inherit' })
    child.on('close', (code) => res(code ?? 1))
    child.on('error', () => res(1))
  })
