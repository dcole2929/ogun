import { serve } from '@hono/node-server'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
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

/** Create the test database if it is not there, and bring its schema up to date. */
async function ensureTestDatabase(): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  try {
    const [row] = await admin`select 1 from pg_database where datname = ${TEST_DB}`
    // Not parameterised because an identifier cannot be; TEST_DB is ours, not input.
    if (!row) await admin.unsafe(`create database "${TEST_DB}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`)
  const { db, close } = createDb(url)
  const here = dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: join(here, '../../core/drizzle') })
  await close()
  return url
}

/**
 * `config` defaults to a store that can reach nothing, since a test that edits a real
 * `.ogun/config.yaml` is the same class of mistake as one that writes to the real
 * database. Pass a fake when the test is about config editing.
 */
export async function startHarness(config?: ConfigStore): Promise<Harness> {
  const url = await ensureTestDatabase()
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = url

  const ctx = createContext(config ?? unreachableConfigStore(), false)

  /**
   * Start from empty. Several checks count rows globally — remaining capacity is the
   * whole machine's, not one project's — so data left by another file makes a passing
   * test fail for reasons that have nothing to do with it. Cleaning on start rather than
   * on stop means a crashed run cannot poison the next one.
   */
  await truncate(ctx.db)
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
