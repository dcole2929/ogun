import { serve } from '@hono/node-server'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import { createDb, type Database } from '@ogun/core/db'
import { createApp } from '../src/app.ts'
import { createContext } from '../src/context.ts'
import type { ConfigStore } from '../src/config-store.ts'

/**
 * An isolated control plane for tests: its own database, its own server, on its own port.
 *
 * Tests used to run against whatever was on :7777 — which is the real one — and wrote
 * into the working database. Fixtures leaked three runner rows on every `pnpm test`, and
 * a stale delete route meant the cleanup silently 404'd, so the Runners page filled with
 * `dup-…` machines that never existed. Any test that can pollute the data you are
 * looking at will eventually do it; the fix is to make it impossible rather than to be
 * careful.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://ogun:ogun@localhost:5433/ogun'

const PREFIX = 'ogun_test_'

/**
 * One database per *run*, named after the process that owns the run.
 *
 * The database used to be called `ogun_test`, flat — which made it a machine-global
 * fixture shared by every suite running on the box. Two runs at once (two worktrees, a
 * sandbox job and the developer who started it, a container and a shell) each truncated
 * the other's rows mid-test, and `drop database … with (force)` below would cut the
 * other's connections. The failures land in whichever process loses the race, move around
 * between runs, and read as flaky application code rather than as one shared fixture, so
 * the cost is not the failed run — it is the hour spent looking in the wrong place.
 *
 * That is not hypothetical for Ogun specifically: `pnpm -s test` is the gate a modifier's
 * patch has to pass before it can be published (ADR-0009), so two modifiers verifying
 * themselves at once would each fail the other's gate and each be recorded as having
 * written a bad patch. The factory would blame the agent for a fixture collision, and
 * nondeterministically, which is the hardest possible shape to diagnose.
 *
 * `OGUN_TEST_DB` already existed as an escape hatch and nothing set it. A safety property
 * that depends on remembering an environment variable is not a safety property; it is a
 * convention. So the default is now per-run and the variable stays as an override for
 * someone who wants to keep a database around and inspect it.
 *
 * The run is identified by `process.ppid`, and the choice carries the whole design:
 *
 *  - It is *unique*. `node --test` runs each test file in its own child process, so a pid
 *    of our own would give a database per file — a dozen creates and a dozen migrations
 *    per run. The parent is the `node --test` process itself, and a live pid is unique on
 *    the machine, so two runs cannot pick the same name.
 *  - It is *stable* across the files of one run, which is what lets the truncate-once-per
 *    -process rule below keep meaning what it meant.
 *  - It is *checkable by anybody*, which is what makes the sweep possible: any later run
 *    can ask whether pid N is still alive and therefore whether `ogun_test_N` is still
 *    wanted. A random suffix would be just as unique and completely unsweepable.
 *
 * Rejected: a schema per run on one shared database. Drizzle's migrator writes to a fixed
 * `drizzle.__drizzle_migrations` and the generated SQL is unqualified, so isolation would
 * rest on every connection remembering to set `search_path` — one that forgets writes
 * into `public` silently, which is the bug this change exists to remove, wearing a
 * disguise. Rejected too: a per-run table prefix, which means teaching the schema about
 * tests; and a pre-migrated template database — `create database … template` was timed at
 * 30ms against 230ms for create-then-migrate, so it would save ~180ms of a 22-second run
 * in exchange for a second artefact that can be stale and its own creation race.
 *
 * Note that a `pnpm -s test` at the top of a run and a bare `node --test some.test.ts`
 * started from the same shell share that shell as their parent, and so share a database.
 * Two suites started from *one* shell in the background is not a case worth a worse name.
 */
const TEST_DB = process.env.OGUN_TEST_DB ?? `${PREFIX}${process.ppid}`

export type Harness = {
  /** Where the test control plane is listening, e.g. http://127.0.0.1:41235 */
  url: string
  db: Database
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  stop: () => Promise<void>
}

/**
 * Create the test database if it is not there, and bring its schema up to date.
 *
 * `migrate` only ever moves forward, and the database outlives any one branch — so
 * checking out a branch whose schema is *behind* what the database already has leaves
 * every test failing on a constraint the code has never heard of. That reads as a broken
 * branch rather than a stale database, and it cost real time twice in one afternoon:
 * `null value in column "cycle_name" violates not-null constraint` says nothing about
 * the actual cause.
 *
 * So: if the database has applied migrations this checkout does not contain, it is
 * ahead, and it is dropped and rebuilt. Nothing of value is in it — it is fixtures.
 *
 * A per-run database is usually born empty, so that check usually has nothing to do. It
 * is kept because the two cases where a database *is* inherited are exactly the two where
 * the branch may have moved: `OGUN_TEST_DB` pointing at one somebody keeps, and a name
 * whose pid the sweep below could not prove dead.
 *
 * Memoised per process because every `startHarness` used to pay for it, and a suite file
 * starts several. The database cannot change underneath a process — the only thing that
 * would rebuild it is this function.
 */
let ensured: Promise<string> | undefined
const ensureTestDatabase = (): Promise<string> => (ensured ??= createTestDatabase())

async function createTestDatabase(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const migrations = join(here, '../../core/drizzle')
  const journal = JSON.parse(
    await readFile(join(migrations, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number }> }
  const known = journal.entries.length

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  try {
    await sweepAbandoned(admin)
    const [row] = await admin`select 1 from pg_database where datname = ${TEST_DB}`
    // Not parameterised because an identifier cannot be; TEST_DB is ours, not input.
    if (!row) await admin.unsafe(`create database "${TEST_DB}"`)
    else if (await isAhead(known)) {
      // `with (force)` so a connection left by a killed test run cannot block this.
      // Safe to force now in a way it was not when the name was shared: the only run
      // that can be connected to `ogun_test_<our ppid>` is this one.
      await admin.unsafe(`drop database "${TEST_DB}" with (force)`)
      await admin.unsafe(`create database "${TEST_DB}"`)
      console.warn(
        `[harness] ${TEST_DB} had migrations this checkout does not — rebuilt it`,
      )
    }
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = testDbUrl()
  const { db, close } = createDb(url)
  await migrate(db, { migrationsFolder: migrations })
  await close()
  return url
}

/**
 * Drop the per-run databases whose run is over, before creating this one.
 *
 * A database per run has to be given back, and the obvious place is teardown — which is
 * exactly the place that does not run when it matters. Ctrl-C during a suite, a test
 * process that segfaults, a container the runner kills on a timeout, an `only` that
 * leaves the run half-finished: every case where a database is left behind is a case
 * where the teardown did not happen. Cleanup that only runs on the happy path leaks
 * precisely as fast as the failures it was written for.
 *
 * So there is no teardown drop at all, and the sweep is the whole mechanism. It is a
 * *forward* cleanup: a run does not tidy up after itself, it tidies up after everyone
 * who has finished. That makes a killed run and a clean one identical to handle, which
 * means the rare path and the common path are the same path — the only kind of recovery
 * code that can be trusted, because it is exercised on every run.
 *
 * "Finished" is decided by asking the operating system whether the owning pid is still
 * alive, which is why the pid is in the name. The alternatives were worse: age is a guess
 * (a long suite looks abandoned), and "no active connections" is wrong outright, since a
 * live run sits with none between test files.
 *
 * The remaining hole is honest and small: after a reboot, or after enough pid churn, a
 * dead run's pid can be alive again as something unrelated, and its database is kept and
 * eventually adopted by whichever run draws that pid. Adopting is harmless — the schema
 * is brought forward or rebuilt above, and the rows are truncated at the start of every
 * file below — which is to say it is exactly the situation every run was in before this
 * change, and it now takes a coincidence rather than a certainty.
 *
 * A flat `ogun_test` from before this change is deliberately not swept: it does not match
 * the prefix, and someone may have `OGUN_TEST_DB=ogun_test` set on purpose. Deleting a
 * database a person named is a worse mistake than leaving one behind.
 */
async function sweepAbandoned(admin: postgres.Sql): Promise<void> {
  // The escaping is not decoration: `_` is a single-character wildcard in LIKE, so the
  // unescaped prefix also matches `ogun9test9`, and this is a statement that drops things.
  const rows = await admin<Array<{ datname: string }>>`
    select datname from pg_database where datname like ${`${PREFIX.replaceAll('_', '\\_')}%`}
  `
  for (const { datname } of rows) {
    if (datname === TEST_DB) continue
    // Digits and nothing else. The development postgres this was written against already
    // holds an `ogun_test_policies`, an `ogun_test_wiring` and seven more that somebody
    // named by hand through `OGUN_TEST_DB`; a sweep that took the whole prefix would
    // delete a colleague's kept fixtures the next time anyone ran the suite. Only a name
    // this harness could have generated is a name this harness may remove.
    const owner = /^\d+$/.test(datname.slice(PREFIX.length))
      ? Number(datname.slice(PREFIX.length))
      : 0
    if (owner <= 0 || !Number.isSafeInteger(owner)) continue
    if (isRunning(owner)) continue
    try {
      // `with (force)` because the dead run's connections may outlive it briefly, and a
      // sweep that can be blocked by the wreckage of a crash is a sweep that never runs.
      await admin.unsafe(`drop database "${datname}" with (force)`)
    } catch {
      // Two runs starting together sweep the same corpse and one loses; or the database
      // is genuinely busy. Neither is this run's problem — the next run tries again, and
      // a suite that fails because it could not tidy up would be a worse bargain than a
      // database left lying around.
    }
  }
}

/**
 * Is that pid still running? `signal 0` is the ask-don't-send form of `kill`.
 *
 * `EPERM` counts as running: the process exists, it just is not ours to signal. Treating
 * it as dead would drop a database out from under another user's suite.
 */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const testDbUrl = (): string => ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`)

/**
 * Has the database applied more migrations than this checkout has files for? Counting
 * rather than comparing hashes: a *renamed* migration is the same schema and should not
 * force a rebuild, but a migration that only exists on another branch is one this code
 * cannot satisfy.
 */
async function isAhead(known: number): Promise<boolean> {
  const sql = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql`
      select count(*)::int as applied from drizzle.__drizzle_migrations
    `
    return (row?.applied ?? 0) > known
  } catch {
    // No drizzle schema yet, or the database is unreadable — migrate will deal with it.
    return false
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * `config` defaults to a store that can reach nothing, since a test that edits a real
 * `.ogun/config.yaml` is the same class of mistake as one that writes to the real
 * database. Pass a fake when the test is about config editing.
 */
let cleaned = false

export async function startHarness(
  config?: ConfigStore,
  /** True exercises the protected paths — invites, name uniqueness, bearer auth. */
  adminTokenConfigured = false,
): Promise<Harness> {
  const url = await ensureTestDatabase()
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = url

  const ctx = createContext(config ?? unreachableConfigStore(), adminTokenConfigured)

  /**
   * Start from empty — but only once per process.
   *
   * Several checks count rows globally (remaining capacity is the whole machine's, not
   * one project's), so data left by a previous *file* makes a passing test fail for
   * reasons of its own. Cleaning on start rather than on stop means a crashed run cannot
   * poison the next one.
   *
   * Truncating on *every* start was wrong: a file with more than one suite starts more
   * than one harness, and the second one's cleanup deleted the first suite's project
   * while its tests were still running. The next `startCycleRun` then inserted a
   * `cycle_runs` row pointing at a cycle that had just been cascade-deleted — an FK
   * violation that surfaced as a rare, unreproducible failure in whichever test happened
   * to be mid-flight. Files already run one at a time, and each is its own process, so
   * once per process is exactly the isolation that was intended.
   *
   * That argument was only ever about the processes of *one* run, and it quietly assumed
   * there was only one. A second run's truncate landed in the middle of this one's suite
   * and no amount of care here could have stopped it; the database name above is what
   * makes the assumption true.
   */
  if (!cleaned) {
    await truncate(ctx.db)
    cleaned = true
  }
  // Port 0: the OS picks a free one, so parallel test files never collide and none of
  // them can accidentally be the real control plane. Awaited, because binding is
  // asynchronous — reading `address()` immediately gives a port nothing is listening on.
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolveListening) => {
      const s = serve({ fetch: createApp(ctx).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolveListening({ server: s, port: info.port }),
      )
    },
  )
  const base = `http://127.0.0.1:${port}`

  return {
    url: base,
    db: ctx.db,
    fetch: (path, init) => fetch(`${base}${path}`, init),
    stop: async () => {
      server.close()
      await ctx.close()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    },
  }
}

const unreachableConfigStore = (): ConfigStore => ({
  root: async () => undefined,
  writable: async () => false,
  read: async () => {
    throw new Error('no config store in this test')
  },
  mutate: async () => {
    throw new Error('no config store in this test')
  },
})

/** Remove everything a test created. Cascades handle jobs, runs, coverage, findings. */
export async function truncate(db: Database): Promise<void> {
  const { schema } = await import('@ogun/core/db')
  await db.delete(schema.runners)
  await db.delete(schema.invites)
  await db.delete(schema.projects)
}
