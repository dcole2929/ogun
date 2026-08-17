import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import {
  expandCycle,
  loadLocalConfig,
  projectConfigSchema,
  workerSchema,
  type CycleDefinition,
  type WorkerConfig,
} from '@ogun/core'

/**
 * Worker definitions live in the repo's `.ogun/config.yaml`, and the control plane edits
 * that file directly. One definition, in git, reviewable in a diff — and still creatable
 * in a few clicks.
 *
 * The rule this has to respect is §4.5: no absolute path in the database, because
 * /home/doug/dev/x and /Users/doug/dev/x are the same project. So the path map is a
 * machine-local file, written by `ogun project sync` and read here. Nothing about a
 * filesystem layout ever crosses the API or lands in postgres.
 *
 * `writable()` is false when the control plane cannot reach a repo — which is the whole
 * remote-control-plane case. Callers degrade to rendering YAML for the human to paste
 * rather than pretending the edit happened.
 */
export type ConfigStore = {
  writable: (slug: string) => Promise<boolean>
  read: (slug: string) => Promise<ConfigFile>
  /**
   * Read-modify-write. `expectedHash` makes it a compare-and-swap: two concurrent edits,
   * or an edit racing your editor, fail loudly instead of silently dropping one.
   */
  mutate: (
    slug: string,
    expectedHash: string | undefined,
    fn: (doc: ReturnType<typeof parseDocument>) => void,
  ) => Promise<ConfigFile>
}

export type ConfigFile = {
  path: string
  text: string
  hash: string
  workers: Record<string, WorkerConfig>
  /**
   * Named cycles, already expanded from sugar into nodes and edges — the same shape
   * `ogun project sync` ships, because both paths feed one `reindexProject`.
   *
   * Carrying these is not optional. `reindexProject` treats the file as the whole truth
   * and deletes any named cycle the file does not mention, so a `ConfigFile` that omits
   * them tells it every cycle is gone. That is not theoretical: editing one worker from
   * the UI used to drop `nightly` and, through `schedules.cycle_id`'s cascade, its 3am
   * schedule — leaving the `cycles:` block sitting in config.yaml looking healthy while
   * nothing ran it.
   */
  cycles: Record<string, CycleDefinition>
}

export class ConfigConflict extends Error {}
export class ConfigUnreachable extends Error {}

const hashOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * `~/.ogun/config.json` — machine-local, shared with the runner. Written by
 * `ogun project add` and `ogun project sync`, the only components that know both a
 * project's slug and where it sits on this disk.
 */
export async function readProjectMap(path?: string): Promise<Record<string, string>> {
  return (await loadLocalConfig(path).catch(() => null))?.projects ?? {}
}

export function createLocalConfigStore(projectMapPath?: string): ConfigStore {
  // Re-read on every call rather than caching: `ogun project sync` rewrites this file,
  // and a server that cached it at boot would need a restart to see a new project.
  const configPathFor = async (slug: string): Promise<string> => {
    const map = await readProjectMap(projectMapPath)
    const root = map[slug]
    if (!root) {
      throw new ConfigUnreachable(
        `this control plane has no local path for "${slug}". Run \`ogun project sync\` on the machine holding the repo.`,
      )
    }
    return join(root, '.ogun', 'config.yaml')
  }

  const load = async (slug: string): Promise<ConfigFile> => {
    const path = await configPathFor(slug)
    const text = await readFile(path, 'utf8').catch(() => {
      throw new ConfigUnreachable(`${path} is not readable`)
    })
    const parsed = projectConfigSchema.parse(parseDocument(text).toJS())
    return { path, text, hash: hashOf(text), workers: parsed.workers, cycles: expand(parsed.cycles) }
  }

  return {
    writable: async (slug) => {
      try {
        await load(slug)
        return true
      } catch {
        return false
      }
    },

    read: load,

    mutate: async (slug, expectedHash, fn) => {
      const current = await load(slug)
      if (expectedHash !== undefined && expectedHash !== current.hash) {
        throw new ConfigConflict(
          'config.yaml changed since this page loaded — reload and reapply the edit',
        )
      }

      // The Document API rather than parse-and-restringify: comments, key order, and
      // blank lines all survive. A UI that silently reformats a file you hand-wrote is
      // a UI you stop trusting with the file.
      const doc = parseDocument(current.text)
      fn(doc)
      /**
       * `flowCollectionPadding` defaults to true, which rewrites every inline list in
       * the file — `[a, b]` becomes `[ a, b ]` — including lists on lines the edit never
       * touched. Small, but it is exactly the silent reformatting this store exists to
       * avoid, and it shows up as noise in the diff a person is meant to review.
       */
      const next = doc.toString({ flowCollectionPadding: false })

      // Validate the *result*, not the input. The UI must not be able to leave a
      // config.yaml on disk that the next `ogun project sync` refuses to load.
      const parsed = projectConfigSchema.safeParse(parseDocument(next).toJS())
      if (!parsed.success) {
        throw new Error(
          `refusing to write an invalid config.yaml: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        )
      }

      // Write-then-rename so a crash mid-write cannot leave a truncated config.yaml —
      // this is the file that defines everything the factory runs.
      const tmp = `${current.path}.ogun-tmp`
      await writeFile(tmp, next, 'utf8')
      await rename(tmp, current.path)

      return {
        path: current.path,
        text: next,
        hash: hashOf(next),
        workers: parsed.data.workers,
        cycles: expand(parsed.data.cycles),
      }
    },
  }
}

/**
 * Sugar → nodes and edges, matching what the CLI does before it POSTs a sync. Expanding
 * on the way out of the store means the control plane and the UI only ever handle one
 * shape, whichever path the edit arrived by (§4.12).
 */
const expand = (
  cycles: Record<string, Parameters<typeof expandCycle>[0]>,
): Record<string, CycleDefinition> =>
  Object.fromEntries(Object.entries(cycles).map(([name, c]) => [name, expandCycle(c)]))

/** Drops undefined and anything equal to the schema default, so the file stays readable
 *  rather than accumulating every field at its default value. */
export function workerToYamlNode(input: WorkerConfig): Record<string, unknown> {
  const full = workerSchema.parse(input)
  const defaults = workerSchema.parse({ skill: full.skill })
  const out: Record<string, unknown> = { skill: full.skill }
  for (const [key, value] of Object.entries(full)) {
    if (key === 'skill' || value === undefined) continue
    if (JSON.stringify(value) === JSON.stringify((defaults as Record<string, unknown>)[key])) {
      continue
    }
    out[key] = value
  }
  return out
}

/** Rendered for the human to paste when the control plane cannot reach the repo. */
export function workerToYamlBlock(name: string, input: WorkerConfig): string {
  // Built as a whole document and then unwrapped: setIn cannot create a nested map under
  // an empty `workers:` key, which is what a hand-rolled stub gives you.
  const doc = new Document({ workers: { [name]: workerToYamlNode(input) } })
  return doc
    .toString()
    .split('\n')
    .slice(1)
    .filter((l: string) => l.trim() !== '')
    .join('\n')
}
