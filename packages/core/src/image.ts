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
  const hash = createHash('sha256')
  for (const file of await stampSources()) {
    // The path as well as the body: a file moved without being edited still changes what
    // the bundle resolves.
    hash.update(file.slice(root.length))
    hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Every file whose contents decide what ends up in the image.
 *
 * Separate from `sandboxStamp` so the list itself can be asserted on: what is *missing*
 * from it is invisible in the digest, and a file dropped from here silently stops the
 * staleness check noticing that file's changes — which is the failure the stamp exists to
 * prevent, one level up.
 */
export async function stampSources(): Promise<string[]> {
  const root = await ogunRoot()
  const base = join(root, 'images', 'base')
  return [
    join(base, 'Dockerfile'),
    join(base, 'entrypoint.sh'),
    // The egress forwarder is baked in and never rebuilt from source at run time, so an
    // image built before a change to it enforces the old behaviour while the runner
    // assumes the new. Same failure this stamp exists for, one file later (§4.6).
    join(base, 'egress-forwarder.mjs'),
    // The Dockerfile no longer names a Node version — it takes one as a build arg, read
    // from here. Without this the file that decides what Node the image runs would sit
    // outside the hash, and bumping the pin would leave the image looking current while
    // running the version before it.
    join(root, '.tool-versions'),
    ...(await tsFilesUnder(join(root, 'packages', 'cli', 'src'))),
    ...(await tsFilesUnder(join(root, 'packages', 'core', 'src'))),
  ].sort()
}

/**
 * The Node version this checkout pins, as `.tool-versions` states it.
 *
 * The sandbox image used to hardcode `node:24`, inherited from the sandbox it was derived
 * from, while the host ran the pinned 26.4.0. Nothing was broken by it — type stripping
 * works on both — but "the suite passes on the version the agent will actually run" was
 * being asserted about a different Node than the one under test. One source of truth
 * removes the question rather than answering it again each time the pin moves.
 */
export async function pinnedNodeVersion(): Promise<string> {
  const root = await ogunRoot()
  const body = await readFile(join(root, '.tool-versions'), 'utf8').catch(() => '')
  const version = /^nodejs[ \t]+(\S+)/m.exec(body)?.[1]
  if (!version) throw new Error(`no nodejs line in ${join(root, '.tool-versions')}`)
  return version
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
