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
const TEST_DB = process.env.OGUN_TEST_DB ?? 'ogun_test'

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
 */
async function ensureTestDatabase(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const migrations = join(here, '../../core/drizzle')
  const journal = JSON.parse(
    await readFile(join(migrations, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number }> }
  const known = journal.entries.length

  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  try {
    const [row] = await admin`select 1 from pg_database where datname = ${TEST_DB}`
    // Not parameterised because an identifier cannot be; TEST_DB is ours, not input.
    if (!row) await admin.unsafe(`create database "${TEST_DB}"`)
    else if (await isAhead(known)) {
      // `with (force)` so a connection left by a killed test run cannot block this.
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
