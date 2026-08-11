import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from './client.ts'

const here = dirname(fileURLToPath(import.meta.url))
const { db, close } = createDb()
await migrate(db, { migrationsFolder: join(here, '../../drizzle') })
await close()
console.log('migrations applied')
