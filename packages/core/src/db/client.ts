import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDb>['db']

/** A transaction handle. Structurally a Database minus `$client`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Anything you can run a query against. Helpers take this so the same function works
 * inside and outside a transaction — which matters because the run-finalizing write has
 * to be atomic (§5.1) and its parts are shared with non-transactional callers.
 */
export type Db = Database | Transaction

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set')
  // max: 10 — one server process; the runner never opens a database connection (§3).
  const sql = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}

export { schema }
