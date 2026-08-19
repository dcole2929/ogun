import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The label the base image carries so a later check can tell what went into it. */
export const STAMP_LABEL = 'dev.ogun.sandbox-stamp'

/**
 * What the sandbox image is *supposed* to contain, as one hash.
 *
 * §7 claims the bundled CLI "cannot drift from the validator on the way in". It can, and
 * did: the image on the machine that runs this was seven days old, so a fix to
 * `ogun findings schema` never reached a reviewer, and a bundle that failed to load at
 * all sat undetected for a week because nobody had rebuilt.
 *
 * Hashes the sources that decide what lands in the image rather than the built artefact —
 * the bundle is a derived file and hashing it would require running esbuild to answer a
 * question asked on every runner start. 35 files, tens of milliseconds.
 *
 * Not the content-hash *tag* §4.6 specifies. Retagging changes which image a run pulls
 * and is a larger change; this answers the narrower question — is what is installed still
 * what the source says — which is the one that actually went wrong.
 */
export async function sandboxStamp(): Promise<string> {
  const root = await ogunRoot()
  const base = join(root, 'images', 'base')
  const sources = [
    join(base, 'Dockerfile'),
    join(base, 'entrypoint.sh'),
    ...(await tsFilesUnder(join(root, 'packages', 'cli', 'src'))),
    ...(await tsFilesUnder(join(root, 'packages', 'core', 'src'))),
  ].sort()

  const hash = createHash('sha256')
  for (const file of sources) {
    // The path as well as the body: a file moved without being edited still changes what
    // the bundle resolves.
    hash.update(file.slice(root.length))
    hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
  }
  return hash.digest('hex').slice(0, 16)
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

export type ImageState =
  | { state: 'current' }
  | { state: 'stale'; built: string }
  /** Built before stamping existed, so it cannot be compared — not the same as stale. */
  | { state: 'unstamped' }
  | { state: 'missing' }

/**
 * Whether `ogun/base` still matches the source it was built from.
 *
 * A warning, never a rebuild: §4.6 is explicit that images are built at project-add time
 * and not at 2am, because a nightly that has to build first is a nightly that fails on a
 * bad network. Saying so is the whole fix — the week this went unnoticed, every command
 * reported success.
 */
export async function imageState(): Promise<ImageState> {
  const { stdout, code } = await dockerOutput([
    'image',
    'inspect',
    'ogun/base:latest',
    '--format',
    `{{index .Config.Labels "${STAMP_LABEL}"}}|{{.Created}}`,
  ])
  if (code !== 0) return { state: 'missing' }

  const [stamp = '', built = ''] = stdout.trim().split('|')
  if (!stamp || stamp === '<no value>') return { state: 'unstamped' }
  return stamp === (await sandboxStamp()) ? { state: 'current' } : { state: 'stale', built }
}

async function dockerOutput(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => void (stdout += d.toString()))
    child.on('error', () => resolvePromise({ stdout: '', code: 1 }))
    child.on('close', (code) => resolvePromise({ stdout, code: code ?? 1 }))
  })
}

/**
 * The checkout this build of Ogun came from, resolved lazily.
 *
 * Lazily because this module is reachable from the CLI, which is bundled into the sandbox
 * image — where `import.meta.url` is `/opt/ogun/ogun.mjs` and there is no checkout at all.
 * Nothing in a sandbox asks these questions, but a module-level constant would be
 * computed on import and get the wrong answer for free.
 */
async function ogunRoot(): Promise<string> {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}
