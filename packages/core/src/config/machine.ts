import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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

  /**
   * A project's own API keys, keyed by project slug and then by secret name (ADR-0012).
   *
   * The one thing in this file that is *not* a fact about this machine, and it is here
   * because the machine that runs the control plane is the machine that polls (§4.13) —
   * so a per-project polling secret and a per-machine admin token have the same lifetime,
   * the same 0600 file, and the same "never leaves this box" rule. `secrets.ts` is the
   * only module that reads or writes it; nothing here should be reached through
   * `loadLocalConfig` directly.
   *
   * **It has to be declared here even though nothing else in this file uses it.** Zod
   * strips what a schema does not name, and `updateLocalConfig` is a read-modify-write
   * through this schema — so an undeclared `secrets` block would be silently deleted by
   * the next `ogun project add`, `ogun runner join` or admin-token rotation. The failure
   * would be a Linear key that stopped working on the day someone registered an unrelated
   * repository, with nothing connecting the two.
   */
  secrets: z.record(z.string(), z.record(z.string(), z.string())).default({}),

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
  return parseLocalConfig(text, path)
}

/**
 * The parsing half of `loadLocalConfig`, separated so a caller that needs to tell "no
 * file" apart from "I could not read the file" can do its own read.
 *
 * `loadLocalConfig` deliberately cannot: it swallows every read error and returns an empty
 * config, which is right for the projects map and wrong for a credential (`secrets.ts`
 * explains which). One parser either way, so the two agree about what the file means.
 */
export function parseLocalConfig(text: string, path = localConfigPath()): LocalConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new LocalConfigError(
      `${path} is not valid JSON ${faultLocation((err as Error).message)}`,
    )
  }
  const parsed = localConfigSchema.safeParse(raw)
  if (!parsed.success) {
    // This file is hand-edited — you add repository paths to it — so name the field
    // rather than showing a parser's stack. The path is a key name (`secrets.ogun.linear`)
    // and zod's message states the expected and received *types*, so neither half of this
    // can carry a value.
    throw new LocalConfigError(
      `${path} is not valid:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n'),
    )
  }
  return expandPaths(parsed.data)
}

/**
 * Keep where the JSON went wrong; throw the parser's own words away.
 *
 * V8 builds `JSON.parse`'s message out of the source it choked on — `Unexpected token 'x',
 * ..."token": "ogun_liv...` — quoting a window of characters around the fault. This file
 * now holds an admin token, a runner credential, and a project's API keys (ADR-0012), and
 * this message is printed by `ogun runner start` on a bad config and forwarded by `fail()`
 * from every CLI command. That is the same leak `redactUrlCredentials` was merged for: a
 * secret ending up inside an error string, which then spreads into consoles, transcripts
 * and whatever someone pastes when asking why a command failed.
 *
 * The location is the half that helps and the only half that is safe, so it is the half
 * that is kept. A message with no location at all is not a mystery worth creating — the
 * file is small and `python -m json.tool` names the line — but "line 4 column 12" is what
 * turns this from a puzzle into an edit.
 */
const faultLocation = (message: string): string => {
  const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  return at
    ? `— ${at[0]}. The parser's own message is withheld because it quotes the surrounding ` +
        'source, and this file holds credentials'
    : '— the parser could not say where, and its message is withheld because it quotes ' +
        'the surrounding source, and this file holds credentials'
}

/**
 * Owner only. `config.json` holds the admin secret and this machine's runner credential
 * (§4.5); the files `writeSecretFile` writes hold findings nobody has fixed yet.
 */
const SECRET_MODE = 0o600

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
    await writeFile(tmp, body, { mode: SECRET_MODE })
    // The same create-only rule applies to the temp file: one left behind by a killed
    // process, with a recycled pid, is reused with whatever mode it already carried.
    await chmod(tmp, SECRET_MODE).catch((err: Error) => {
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

/**
 * The same rule, for the files a *run* writes: a fresh 0600 file, replacing whatever the
 * path held.
 *
 * `writeFile`'s `mode` reaches `open(2)` and is applied only on create, so passing it and
 * calling the file protected was wrong everywhere the path could already exist. It could:
 * the runner lays `.ogun-in/` out inside a clone of a repository that may itself track
 * those paths, and an agent that hand-writes `.ogun-out/findings.json` before calling
 * `ogun findings write` — which the prompt forbids, which is why it happens — leaves it
 * at its own umask. What stayed world-readable is a list of vulnerabilities nobody has
 * fixed yet, on a box with other users on it.
 *
 * Unlink and create, rather than the temp-file-and-rename `writeConfigFile` uses. The two
 * want opposite things and that is the point of them being separate:
 *
 *  - Nothing may be written *through* a symlink here. These paths sit in a workspace, and
 *    a path in a workspace is resolved by the runner on the host — the reason reads back
 *    out of one already refuse to follow a link (§5.3). A tracked symlink at
 *    `.ogun-in/history.json` redirected a host-side write, before the sandbox existed.
 *    `config.json` wants the reverse: someone who put a link there meant it.
 *  - Atomicity buys nothing. One writer, one reader, and the tree is deleted when the run
 *    ends, so there is no concurrent reader to hand a half-written file to, and no
 *    long-lived secret to strand at 0644 if the process dies mid-write.
 *
 * `wx` so that a path recreated between the unlink and the open — by whatever planted the
 * link the unlink just removed — fails the run instead of being written through.
 */
export async function writeSecretFile(path: string, body: string): Promise<void> {
  await rm(path, { force: true })
  await writeFile(path, body, { mode: SECRET_MODE, flag: 'wx' })
}

/**
 * How long a writer waits for the lock, and how old an abandoned lock has to be before it
 * is broken regardless of what it says.
 *
 * The critical section is a read, a callback and a rename — a millisecond or two. Two
 * seconds is not a budget, it is "the holder is not coming back", and the pid check below
 * usually decides long before the timeout is reached. Long enough is what matters here
 * rather than exact: an `ogun init` that chains several of these must never trip it, and a
 * person whose command has genuinely stuck wants an error naming the lock, not a hang.
 */
const CONFIG_LOCK_WAIT_MS = 2_000
const CONFIG_LOCK_STALE_MS = 30_000

/**
 * Read-modify-write, preserving anything this version does not know about — and doing it
 * under an exclusive lock, because there is more than one writer.
 *
 * ### What was lost without one
 *
 * Every caller reads the whole file, changes one branch of it, and writes the whole file
 * back. With two of them in flight the second read happens before the first write, so the
 * second write is built on a config that is already out of date and silently drops
 * whatever the first one added. The three things that can go missing are each of the three
 * things this file exists to hold:
 *
 *  - `projects`, written by `ogun project add` and by every `ogun project sync`. Losing an
 *    entry means the control plane reports the project unreachable and the runner clones
 *    from the remote instead of from disk — degraded, not broken, and therefore not
 *    noticed.
 *  - `server.token`, generated once, on the first bind beyond localhost. Losing it means
 *    the admin secret in memory is not the one on disk, and the next process to start
 *    cannot authenticate.
 *  - `runner`, written by `ogun runner join`. Losing it un-joins the machine.
 *
 * None of these produce an error at the time. `ogun project sync` prints `synced`, exits
 * 0, and the entry is not there.
 *
 * This is not a two-people-typing-fast scenario. `runner join` and `project sync` are both
 * things a setup script runs, `ogun init` chains several of them, and a `fix-a-finding`
 * modifier verifying a patch runs Ogun's own suite while a runner on the same box is live.
 *
 * ### The lock
 *
 * `<config>.lock`, created with `wx` — the one cross-process atomic primitive available on
 * every filesystem this could sit on. Two things make it safe to leave behind:
 *
 *  - It contains the holder's pid, and a lock naming a pid that no longer exists is broken
 *    immediately. This is the same reasoning the test harness uses to reclaim abandoned
 *    databases: a live pid is unique on the machine, and any later process can ask the
 *    kernel about it. A crashed `ogun runner join` therefore costs the next command
 *    nothing, where a plain lockfile would have wedged `~/.ogun/config.json` until someone
 *    found it and deleted it by hand.
 *  - It is broken on age as a second line, for the pid the OS has recycled into something
 *    unrelated. Thirty seconds against a critical section of a millisecond or two.
 *
 * The lock also fixes something `writeConfigFile` could not. Its staging path is
 * `<path>.tmp-<pid>`, which distinguishes two *processes* and not two concurrent calls
 * inside one — the second `rename` then failed with ENOENT because the first had already
 * moved the file out from under it, so an in-process collision surfaced as a spurious
 * error rather than as the silent loss it caused between processes. Serialised, there is
 * only ever one writer of that path at a time.
 *
 * Rejected: a rename-based compare-and-swap on a content hash, which needs no lock and no
 * timeout. It gives the loser a conflict to *handle*, and there is nothing sensible for
 * `ogun runner join` to do with one but retry — so it would be a retry loop around a
 * function whose callers all want "just make this edit", with the added property that a
 * caller who forgot to retry loses the edit again. A lock puts the waiting in one place.
 *
 * The residual hole, stated rather than hidden: two processes can decide a lock is stale at
 * the same instant and both proceed. That requires a previous holder to have crashed and
 * two writers to arrive within the same tick afterwards, and its consequence is the lost
 * update that happened unconditionally before — so the worst case is what today's best
 * case is.
 */
export async function updateLocalConfig(
  fn: (config: LocalConfig) => LocalConfig,
  path = localConfigPath(),
): Promise<LocalConfig> {
  await mkdir(dirname(path), { recursive: true })
  // The lock belongs beside the file that is actually written, which for a symlinked
  // config.json is the link's target — otherwise two machines' worth of tooling could
  // take two different locks over one file.
  const target = await realpath(path).catch(() => path)
  return withLock(`${target}.lock`, async () => {
    const next = fn(await loadLocalConfig(path))
    await writeConfigFile(path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS
  for (;;) {
    if (await claimLock(lockPath)) {
      try {
        return await fn()
      } finally {
        await rm(lockPath, { force: true })
      }
    }
    if (!(await breakAbandonedLock(lockPath)) && Date.now() > deadline) {
      throw new LocalConfigError(
        `${lockPath} is still held after ${CONFIG_LOCK_WAIT_MS}ms, by a process that is ` +
          'alive and has not released it. Delete it if nothing is writing the config.',
      )
    }
    // Jittered, so two waiters that arrived together do not keep colliding in lockstep.
    await new Promise((done) => setTimeout(done, 10 + Math.random() * 20))
  }
}

const claimLock = (lockPath: string): Promise<boolean> =>
  writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: SECRET_MODE }).then(
    () => true,
    () => false,
  )

/** True if the lock was removed because nothing could still be holding it. */
async function breakAbandonedLock(lockPath: string): Promise<boolean> {
  const [owner, age] = await Promise.all([
    readFile(lockPath, 'utf8').then(
      (t) => Number.parseInt(t.trim(), 10),
      () => NaN,
    ),
    stat(lockPath).then(
      (s) => Date.now() - s.mtimeMs,
      () => -1,
    ),
  ])
  // Gone underneath us: the holder finished, so there is nothing to break and retrying is
  // the whole answer.
  if (age < 0) return false
  /**
   * An owner we cannot read is a lock being *written*, not one abandoned.
   *
   * `claimLock` creates the file and writes the pid in one `writeFile`, but a reader that
   * arrives between those two things sees an empty file. `Number.parseInt('')` is `NaN`,
   * `alive(NaN)` is false, and without this the next two lines delete a lock whose holder
   * is very much alive — both writers then proceed and one silently loses its edit, which
   * is the exact failure this lock exists to prevent, reachable only while it is being
   * taken.
   *
   * It cost a test that failed roughly one run in eight with `edits dropped: p1` and
   * passed in isolation every time. Age is the tiebreak rather than a retry: a file that
   * has been unreadable for longer than the stale window is a crash between `open` and
   * `write`, and that one really is abandoned.
   */
  if (!Number.isInteger(owner) && age < CONFIG_LOCK_STALE_MS) return false
  if (alive(owner) && age < CONFIG_LOCK_STALE_MS) return false
  await rm(lockPath, { force: true })
  return true
}

/** `kill(pid, 0)` asks whether a pid exists without touching it; EPERM is still a yes. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const resolveProjectPath = (config: LocalConfig, slug: string): string | undefined =>
  config.projects[slug] ? expandHome(config.projects[slug]!) : undefined

export { expandHome as expandLocalHome }
