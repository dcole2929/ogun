import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/**
 * `~/.ogun/local.json` — everything this *machine* knows, in one file.
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
      id: z.string(),
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
  expandHome(process.env.OGUN_LOCAL_CONFIG ?? '~/.ogun/local.json')

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
  return parsed.data
}

/** Read-modify-write, preserving anything this version does not know about. */
export async function updateLocalConfig(
  fn: (config: LocalConfig) => LocalConfig,
  path = localConfigPath(),
): Promise<LocalConfig> {
  const next = fn(await loadLocalConfig(path))
  await mkdir(dirname(path), { recursive: true })
  // 0600: it holds the admin secret and this machine's runner credential.
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export const resolveProjectPath = (config: LocalConfig, slug: string): string | undefined =>
  config.projects[slug] ? expandHome(config.projects[slug]!) : undefined

export { expandHome as expandLocalHome }
