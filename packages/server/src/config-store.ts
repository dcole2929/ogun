import { createHash, randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  /**
   * Where this project's repo is on this machine, or undefined when there is no local
   * copy. Exposed because publishing a config needs more of the repo than the config
   * file — the skills beside it — and a second component resolving the path its own way
   * is how the two end up disagreeing about which checkout they mean.
   */
  root: (slug: string) => Promise<string | undefined>
  read: (slug: string) => Promise<ConfigFile>
  /**
   * Read-modify-write. `expectedHash` makes it a compare-and-swap: two concurrent edits,
   * or an edit racing your editor, fail loudly instead of silently dropping one.
   *
   * The compare-and-swap only ever guarded the *content*, and a compare-and-swap whose
   * compare and whose swap are separated by an `await` is not one. Two requests arriving
   * together both loaded hash H, both passed the check, and both went on to write — so
   * the loser's edit vanished without the conflict this parameter exists to raise. Every
   * write into one file therefore runs behind `serialize()` below, which makes the whole
   * load-modify-write indivisible within this process and gives the second request a
   * `ConfigConflict` instead of silence.
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

  const loadFrom = async (path: string): Promise<ConfigFile> => {
    const text = await readFile(path, 'utf8').catch(() => {
      throw new ConfigUnreachable(`${path} is not readable`)
    })
    const parsed = projectConfigSchema.parse(parseDocument(text).toJS())
    return { path, text, hash: hashOf(text), workers: parsed.workers, cycles: expand(parsed.cycles) }
  }

  const load = async (slug: string): Promise<ConfigFile> => loadFrom(await configPathFor(slug))

  return {
    root: async (slug) => (await readProjectMap(projectMapPath))[slug],

    writable: async (slug) => {
      try {
        await load(slug)
        return true
      } catch {
        return false
      }
    },

    read: load,

    mutate: async (slug, expectedHash, fn) =>
      // Resolved before the queue rather than inside it, because the path is what the
      // queue is keyed on. Two slugs pointing at one repo is a misconfiguration, but it
      // would be one that quietly bypassed the lock if the key were the slug.
      serialize(await configPathFor(slug), async (path) => {
        const current = await loadFrom(path)
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

        await stage(current.path, next)

        return {
          path: current.path,
          text: next,
          hash: hashOf(next),
          workers: parsed.data.workers,
          cycles: expand(parsed.data.cycles),
        }
      }),
  }
}

/**
 * Write-then-rename so a crash mid-write cannot leave a truncated config.yaml — this is
 * the file that defines everything the factory runs.
 *
 * The staging path used to be a constant, `<path>.ogun-tmp`, and that is a shared mutable
 * global wearing a filename. Two writers interleave their `write(2)`s into one file and
 * then each rename it over the real config: what lands is neither edit but a splice of
 * both, byte-for-byte plausible and syntactically broken in the middle. The
 * compare-and-swap above cannot see it, because it compares content and the collision is
 * on the path.
 *
 * A pid suffix — what `machine.ts` does — is not enough, and is not enough there either:
 * it distinguishes two *processes* and not two concurrent calls inside one. That matters
 * most here, because this runs inside a server handling concurrent requests, so both
 * writers always share a pid. The random suffix is what makes the name unique; the pid is
 * kept because it names the owner of anything left behind.
 *
 * `wx` rather than a plain create, so that the guarantee does not rest on the suffix being
 * unique. If two writers ever did choose one name, the second fails to open instead of
 * writing into the first's file, and the edit is refused rather than mangled.
 */
async function stage(path: string, body: string): Promise<void> {
  const tmp = `${path}.ogun-tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, path)
  } catch (err) {
    // A staging file left in the repo's `.ogun/` would show up in `git status` as
    // something the control plane put there and never took away.
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * One read-modify-write per file at a time, within this process.
 *
 * `mutate` is documented as a compare-and-swap, and it was not one: the hash check and the
 * rename that acts on it are separated by parsing, a callback and re-validation, all of
 * which yield. Two edits submitted together — two tabs, a person and the `fix-a-finding`
 * modifier, two requests from one impatient click — both read hash H, both find it
 * current, and both write. The second silently erases the first, which is precisely the
 * outcome `expectedHash` exists to turn into a visible `ConfigConflict`. Serialising the
 * whole operation makes the second one observe the first's hash and refuse.
 *
 * In-process only, and that is the honest bound. The other writer of a project's
 * config.yaml is a human with an editor, and no in-process lock reaches them — but they
 * are covered, because the hash they raced is now genuinely the hash on disk when the
 * write happens. What is *not* covered is two control planes sharing one checkout, which
 * nothing in Ogun's design produces: the path map that makes a repo reachable is
 * machine-local (§4.5), so a second control plane on the same machine is the only way to
 * get there, and it would be sharing a database as well.
 *
 * The queue entry is dropped once it is the tail again, so an idle server holds nothing.
 */
const writes = new Map<string, Promise<unknown>>()

function serialize<T>(path: string, fn: (path: string) => Promise<T>): Promise<T> {
  // `.then(run, run)` and not `.finally`: a rejected predecessor must not cancel the
  // queue behind it. One bad edit failing validation cannot be allowed to wedge every
  // later edit to that file for the lifetime of the process.
  const run = (): Promise<T> => fn(path)
  const result = (writes.get(path) ?? Promise.resolve()).then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  writes.set(path, tail)
  void tail.then(() => {
    if (writes.get(path) === tail) writes.delete(path)
  })
  return result
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
