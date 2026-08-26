import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The label the base image carries so a later check can tell what went into it. */
export const STAMP_LABEL = 'dev.ogun.sandbox-stamp'

/**
 * The name of a project's image, keyed on the **project slug** and nothing else.
 *
 * There were two answers to this and they disagreed. `ogun image build <dir>` tagged
 * `ogun/project-<basename of dir>`; the runner asked for `ogun/project-<job.projectSlug>`.
 * Those are the same string exactly when the checkout directory happens to be named after
 * the project, which is a coincidence and not a rule — a git worktree
 * (`.claude/worktrees/agent-aecf30`), a second clone kept as `ogun-review`, `ogun project
 * add --name`, or any repository whose `project.name` is not its directory name all break
 * it. The build reported success, the image existed, and the modifier job then failed with
 * docker's "Unable to find image `ogun/project-ogun:latest`" — an error about a thing
 * nobody built rather than about the thing that was.
 *
 * The slug wins because it is the only one of the two that both sides can see. The runner
 * has a `ClaimedJob` and no filesystem opinion about where the project lives; the control
 * plane keys everything on the slug; the machine-local path map is `slug → path` (§4.5).
 * The directory name is a fact about one machine, which is the same reason no absolute
 * path is allowed in the database.
 *
 * One function rather than two format strings, so this cannot drift apart again: both the
 * builder and the runner call it, and a change to the naming scheme has one site.
 *
 * A slug that is not a legal docker reference component — uppercase, a space — produces a
 * tag docker rejects. That is left as docker's error rather than validated here, because
 * the failure is loud and at build time; what mattered was that both ends produce the
 * *same* wrong string rather than two different plausible ones.
 */
export const projectImage = (slug: string): string => `ogun/project-${slug}:latest`

/**
 * What the `project-image` lens tags the image it builds out of a patch (ADR-0016).
 *
 * **Not `projectImage(slug)`, and the difference is the whole point.** That tag is what
 * every modifier job on this machine runs in, and this image was built from a Dockerfile
 * an agent wrote minutes ago in a branch nobody has read. Writing it to `:latest` would
 * mean a rejected patch's image quietly becoming the one the next night's modifier is
 * verified in — a change to the machine made by a run that was refused. §4.6's rule that
 * images are built at `ogun project add` and never at 2am is the same rule from the other
 * side: the operator builds the image once the patch has been *merged*, and the pull
 * request says so.
 *
 * Keyed on the run rather than only on the project so two gates cannot collide. A fixed
 * `:candidate` would be one tag two concurrent jobs both build and both delete, and the
 * loser's failure — an image that vanished between `build` and `run` — reads as a broken
 * daemon rather than as a race.
 */
export const candidateImage = (slug: string, runId: string): string =>
  `ogun/project-${slug}:candidate-${runId.slice(0, 12)}`

/**
 * The one name for the substrate image, so that the string is written down once. Every
 * project's `.ogun/Dockerfile` is `FROM` this by hand, which is why it is a constant and
 * not a parameter — see `baseImage` below.
 */
export const BASE_IMAGE = 'ogun/base:latest'

/**
 * The image a job gets when its project has none of its own: `ogun/base`, which is enough
 * for a reviewer and not enough for a modifier (§5.1).
 *
 * `OGUN_BASE_IMAGE` is an override for tests and for anyone running a runner against an
 * image built elsewhere.
 *
 * ### Why this is still `:latest`, and not §4.6's content-hash tag
 *
 * §4.6 says "tag by content hash of Dockerfile + lockfile", and `sandboxStamp` below
 * deliberately did not implement it. Two concurrent builds retagging `:latest` out from
 * under each other, and `imageState` then calling a perfectly good checkout stale, is the
 * strongest argument yet for reversing that — and it still loses, for a reason that has
 * nothing to do with effort:
 *
 *  - A project's own image is `FROM ogun/base:latest`, written by hand in a
 *    `.ogun/Dockerfile` that lives in *somebody else's repository*. Content-hash tagging
 *    the base means either that line stops resolving, or every project Dockerfile has to
 *    take a build arg it does not have today. Ogun cannot edit those files, and a change
 *    that breaks a project's image the next time it rebuilds is worse than the warning it
 *    would remove.
 *  - `:latest` is also what actually runs. A stamp-keyed tag would let `ogun runner
 *    doctor` say "an image matching this checkout exists" while jobs kept running the
 *    image `:latest` points at — reporting healthy about an image nothing uses. Checking
 *    the tag that runs is the only honest check, so `imageState` keeps checking it.
 *
 * Which means "stale" is not a wrong answer when a second checkout has rebuilt: it is the
 * right answer, because the image a job would run really is not this checkout's. What was
 * missing was that the message named only the passage of time, so the message now names
 * the other cause. The unaddressed part is real and stated plainly: one machine has one
 * `ogun/base`, so two checkouts of Ogun at different commits cannot both have their own
 * sandbox image, and the last one to build wins. Per-checkout base images are the fix if
 * that ever costs more than the rebuild does.
 */
export const baseImage = (): string => process.env.OGUN_BASE_IMAGE ?? BASE_IMAGE

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
 * what the source says — which is the one that actually went wrong. That decision was
 * re-examined when it turned out two checkouts on one machine make each other's image
 * look stale, and it stood: `baseImage` above records why, and what it costs.
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
 *
 * `stale` has two causes and the report cannot tell them apart, because from here they are
 * the same fact: this checkout's sources do not hash to what the installed image was built
 * from. Either you edited something since the last build, or *another checkout on this
 * machine* built `ogun/base` more recently — one machine has one `ogun/base` and the last
 * build wins (see `baseImage`). Both mean a job started now runs an image that is not this
 * checkout, so both deserve the same warning; the callers just have to name both causes,
 * or the second one reads as a bug in the check.
 */
export async function imageState(): Promise<ImageState> {
  const { stdout, code } = await dockerOutput([
    'image',
    'inspect',
    // The canonical name, deliberately not `baseImage()`. `OGUN_BASE_IMAGE` points a
    // runner at somebody else's image; the stamp answers whether the image *this
    // checkout builds* is current, and inspecting a substituted one would report
    // `unstamped` and tell you to rebuild something you are not using.
    BASE_IMAGE,
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
