import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { bold, cyan, dim, fail, green, red } from '../output.ts'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

/**
 * `ogun db` — the database, without needing to know it is postgres in a compose file.
 *
 * These were `pnpm db:up` and `pnpm db:migrate`, which leaks the fact that Ogun happens
 * to be a pnpm workspace into the instructions for running it. Someone setting this up on
 * a second machine should need `ogun` and nothing else.
 */
export const DEFAULT_DATABASE_URL = 'postgres://ogun:ogun@localhost:5433/ogun'

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
}

const compose = (args: string[]): Promise<number> =>
  new Promise((res) => {
    const child = spawn('docker', ['compose', ...args], { stdio: 'inherit', cwd: repoRoot })
    child.on('close', (code) => res(code ?? 1))
    child.on('error', () => res(127))
  })

/** True once postgres answers, rather than once the container exists. */
export async function isReady(url = databaseUrl()): Promise<boolean> {
  const { createDb } = await import('@ogun/core/db')
  try {
    const { sql, close } = createDb(url)
    await sql`select 1`
    await close()
    return true
  } catch {
    return false
  }
}

/** Compose reports the container as started well before postgres accepts connections. */
export async function waitForDatabase(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isReady()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

export async function dbUp(): Promise<void> {
  const code = await compose(['up', '-d'])
  if (code === 127) fail('docker is not installed, or not on PATH')
  if (code !== 0) fail(`docker compose exited ${code}`)

  process.stdout.write(dim('  waiting for postgres…'))
  const ready = await waitForDatabase()
  process.stdout.write('\r')
  if (!ready) fail('postgres did not accept connections within 30s')
  console.log(green(`postgres is up — ${databaseUrl()}`))
}

export async function dbDown(args: string[]): Promise<void> {
  // `--volumes` is destructive and never implied: it discards every run, finding, and
  // coverage record, which is the entire history of what the factory has done.
  const wipe = args.includes('--volumes')
  const code = await compose(wipe ? ['down', '--volumes'] : ['down'])
  if (code !== 0) fail(`docker compose exited ${code}`)
  console.log(green(wipe ? 'postgres stopped and its data deleted' : 'postgres stopped'))
}

export async function dbMigrate(): Promise<void> {
  if (!(await isReady())) {
    fail(`cannot reach ${databaseUrl()} — run \`ogun db up\` first`)
  }
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  const { createDb } = await import('@ogun/core/db')
  const { db, close } = createDb(databaseUrl())
  await migrate(db, { migrationsFolder: resolve(repoRoot, 'packages/core/drizzle') })
  await close()
  console.log(green('schema is up to date'))
}

export async function dbStatus(): Promise<void> {
  const url = databaseUrl()
  const up = await isReady(url)
  console.log(`  ${up ? green('ok  ') : red('down')}  ${dim(url)}`)
  if (!up) {
    console.log(dim(`\n  ${cyan('ogun db up')} to start it`))
    return
  }

  const { createDb } = await import('@ogun/core/db')
  const { sql, close } = createDb(url)
  try {
    const applied = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public'`
    const pending = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`
    console.log(`  ${bold(String(applied[0]?.n ?? 0))} tables`)
    if ((pending[0]?.n ?? 0) === 0) {
      console.log(dim(`  no migrations recorded — ${cyan('ogun db migrate')}`))
    }
  } finally {
    await close()
  }
}
