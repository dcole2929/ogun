import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createContext } from './context.ts'
import { localConfigPath } from '@ogun/core'
import { assertBindIsSafe, InsecureBind, LOCAL_BINDS, resolveAuth } from './auth.ts'
import { reconcileCoverage, sweepStaleClaims } from './foreman/sweep.ts'
import { tick } from './foreman/scheduler.ts'

/**
 * `--port` beats `OGUN_PORT` beats 7777.
 *
 * `ogun server` forwards its arguments here, and this used to parse none of them — so
 * `ogun server --port 8080` started on 7777 and said so in a line nobody reads twice.
 * Unknown arguments are refused for the same reason: an accepted-and-ignored flag is
 * worse than a rejected one.
 */
const cli = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: { port: { type: 'string' } },
      allowPositionals: false,
    }).values
  } catch (err) {
    console.error(
      `\nogun-server: ${(err as Error).message}\n` +
        '  usage: ogun server [--port <n>]\n' +
        '  Everything else is configured by environment — see `ogun server --help`.\n',
    )
    process.exit(1)
  }
})()
if (cli.port !== undefined && !/^\d+$/.test(cli.port)) {
  console.error(`\nogun-server: --port must be a number, got "${cli.port}"\n`)
  process.exit(1)
}
const port = Number(cli.port ?? process.env.OGUN_PORT ?? 7777)
const staleAfterMs = Number(process.env.OGUN_STALE_CLAIM_MS ?? 45 * 60_000)
const auth = await resolveAuth()

try {
  assertBindIsSafe(auth)
} catch (err) {
  if (err instanceof InsecureBind) {
    console.error(`\nogun-server: ${err.message}\n`)
    process.exit(1)
  }
  throw err
}

const ctx = createContext(undefined, Boolean(auth.token))
const server = serve(
  { fetch: createApp(ctx, auth.token).fetch, port, hostname: auth.bind },
  (info) => {
    console.log(`ogun-server listening on http://${auth.bind}:${info.port}`)
    if (auth.generated) {
      console.log(`  generated an admin token — stored in ${localConfigPath()}`)
    }
    if (!LOCAL_BINDS.has(auth.bind)) {
      console.log('  reachable from the network; the UI will ask for the token once')
    }
  },
)

/**
 * Every 30 seconds. Fine-grained enough that a minute-level schedule fires within its
 * own minute, and coarse enough that the query is nothing — and since due-ness is
 * derived from the last run rather than from a timer, a tick that is late or missed
 * entirely changes nothing except when the work starts.
 */
const scheduler = setInterval(() => {
  tick(ctx.db)
    .then((r) => {
      for (const name of r.started) console.log(`[foreman] cron started ${name}`)
      for (const name of r.skipped) {
        console.log(`[foreman] cron skipped ${name} — missed while this machine was down`)
      }
    })
    .catch((err) => console.error('[foreman] scheduler failed', err))
}, 30_000)
scheduler.unref()

const sweep = setInterval(() => {
  sweepStaleClaims(ctx.db, staleAfterMs)
    .then((n) => n > 0 && console.log(`[foreman] swept ${n} stale claim(s)`))
    .catch((err) => console.error('[foreman] sweep failed', err))
  reconcileCoverage(ctx.db)
    .then((n) => n > 0 && console.log(`[foreman] reconciled ${n} stale coverage row(s)`))
    .catch((err) => console.error('[foreman] coverage reconcile failed', err))
}, 60_000)
sweep.unref()

const shutdown = async () => {
  clearInterval(scheduler)
  clearInterval(sweep)
  server.close()
  await ctx.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
