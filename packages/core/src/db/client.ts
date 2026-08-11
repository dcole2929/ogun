import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDb>['db']

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set')
  // max: 10 — one server process; the runner never opens a database connection (§3).
  const sql = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}

export { schema }
