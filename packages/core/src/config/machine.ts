import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/**
 * `~/.ogun/config.json` — everything this *machine* knows, in one file.
 *
 * There were two: `projects.json` for the server's path map and `runner.json` for the
 * runner's, both answering "where is project X on this disk" and both able to disagree.
 * The server and the runner are usually the same box, and even when they are not, a
 * machine has one filesystem — so it has one map.
 *
 * Never synced, never sent over the API, never in the database. `/home/doug/dev/x` and
 * `/Users/doug/dev/x` are the same project (§4.5), so a path is a fact about a machine
 * and belongs here.
 */
export const localConfigSchema = z.object({
  /** Where projects live on this disk. Optional — a runner clones from the remote
   *  otherwise; a path just makes it faster and lets the control plane edit config.yaml. */
  projects: z.record(z.string(), z.string()).default({}),

  /** Present once this machine runs a control plane. */
  server: z
    .object({
      /** Admin secret. Generated on first bind beyond localhost, never by hand. */
      token: z.string().nullish().transform((v) => v ?? undefined),
    })
    .default({ token: undefined }),

  /** Present once this machine has joined a control plane as a runner. */
  runner: z
    .object({
      /**
       * What this machine is called. Unique across the control plane — registering
       * refuses a name another live runner already holds, because two machines sharing
       * one would share a claim identity and a run history.
       */
      name: z.string(),
      /**
       * What this machine can do, as a set of capability tags. A worker's requirements
       * are derived from its config — a `codex` runtime requires `codex`, a `container`
       * sandbox requires `docker` — and a job is only offered to a runner advertising
       * every tag it needs. That is how a Mac without Docker never picks up a container
       * job and leaves it queued for a machine that can run it.
       *
       * Detected at registration by checking which binaries are present. Extra tags can
       * be added by hand for capabilities Ogun cannot detect, and matched by a worker's
       * `requires:` — "gpu", "vpn", "staging-db".
       */
      labels: z.array(z.string()).default([]),
      serverUrl: z.string(),
      token: z.string().nullish().transform((v) => v ?? undefined),
      maxConcurrentJobs: z.number().int().positive().default(2),
      pollIntervalMs: z.number().int().positive().default(3000),
      scratch: z.string().default('~/.ogun/work'),
    })
    .optional(),
})

export type LocalConfig = z.infer<typeof localConfigSchema>

export class LocalConfigError extends Error {}

export const localConfigPath = (): string =>
  expandHome(process.env.OGUN_CONFIG ?? '~/.ogun/config.json')

/**
 * Paths in this file are hand-edited, so `~` has to work. Expanded on read rather than on
 * write, so the stored file stays portable between machines with different home
 * directories — and because an unexpanded one reaches Docker as a literal `~`, which it
 * rejects as an invalid volume name after the container has already been built.
 */
const expandPaths = (config: LocalConfig): LocalConfig => ({
  ...config,
  projects: Object.fromEntries(
    Object.entries(config.projects).map(([slug, path]) => [slug, expandHome(path)]),
  ),
  ...(config.runner ? { runner: { ...config.runner, scratch: expandHome(config.runner.scratch) } } : {}),
})

export async function loadLocalConfig(path = localConfigPath()): Promise<LocalConfig> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return localConfigSchema.parse({})

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new LocalConfigError(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  const parsed = localConfigSchema.safeParse(raw)
  if (!parsed.success) {
    // This file is hand-edited — you add repository paths to it — so name the field
    // rather than showing a parser's stack.
    throw new LocalConfigError(
      `${path} is not valid:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'),
    )
  }
  return expandPaths(parsed.data)
}

/** It holds the admin secret and this machine's runner credential (§4.5). */
const CONFIG_MODE = 0o600

/**
 * Write into a fresh 0600 file and rename it over the old one, so the mode is a property
 * of every write rather than of the first one.
 *
 * `writeFile`'s `mode` is applied only when it *creates* the file. A `config.json` that
 * already existed at 0644 — restored from a backup, copied off another machine, or
 * written before this mode was set — therefore stayed 0644 while `ogun runner join` or
 * the server's first bind wrote an admin token into it, and every later write left it
 * that way too.
 *
 * Rename rather than write-then-chmod because the two are not equivalent under failure:
 * a crash between the write and the chmod leaves the token sitting in a world-readable
 * file permanently, which is the state this is meant to prevent.
 */
async function writeConfigFile(path: string, body: string): Promise<void> {
  // Follow a symlinked config.json instead of replacing the link with a regular file —
  // `writeFile` honoured the link, and rename() would silently break that setup.
  const target = await realpath(path).catch(() => path)
  const tmp = `${target}.tmp-${process.pid}`
  try {
    await writeFile(tmp, body, { mode: CONFIG_MODE })
    // The same create-only rule applies to the temp file: one left behind by a killed
    // process, with a recycled pid, is reused with whatever mode it already carried.
    await chmod(tmp, CONFIG_MODE).catch((err: Error) => {
      // Filesystems without POSIX modes — Windows, exFAT, some network mounts — reject
      // or ignore this. Say so rather than swallow it, but do not lose the credential
      // over a permission bit we cannot set.
      console.error(`ogun: could not set mode 0600 on ${target}: ${err.message}`)
    })
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Read-modify-write, preserving anything this version does not know about. */
export async function updateLocalConfig(
  fn: (config: LocalConfig) => LocalConfig,
  path = localConfigPath(),
): Promise<LocalConfig> {
  const next = fn(await loadLocalConfig(path))
  await mkdir(dirname(path), { recursive: true })
  await writeConfigFile(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export const resolveProjectPath = (config: LocalConfig, slug: string): string | undefined =>
  config.projects[slug] ? expandHome(config.projects[slug]!) : undefined

export { expandHome as expandLocalHome }
