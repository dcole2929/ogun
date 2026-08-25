import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createContext } from './context.ts'
import { localConfigPath } from '@ogun/core'
import { assertBindIsSafe, InsecureBind, LOCAL_BINDS, resolveAuth } from './auth.ts'
import { reconcileCoverage, sweepStaleClaims } from './foreman/sweep.ts'
import { tick } from './foreman/scheduler.ts'
import { pollSources } from './foreman/sources.ts'

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
 *
 * One tick at a time, though. `setInterval` does not wait for its callback, so a tick
 * that outlives 30 seconds — `startCycleRun` writes a CycleRun and a job per node —
 * overlaps the next one, and a database under load turns one overlap into a pile-up.
 *
 * Belt to the scheduler's braces rather than the correctness boundary: this guard is a
 * variable in one process, and the occurrence is claimed in the database precisely
 * because a second server, a manual trigger, or a restart mid-tick walks straight past
 * it. What it buys is that the ordinary case never attempts the race at all.
 */
let ticking = false
const scheduler = setInterval(() => {
  if (ticking) return
  ticking = true
  tick(ctx.db)
    .then((r) => {
      for (const name of r.started) console.log(`[foreman] cron started ${name}`)
      for (const name of r.skipped) {
        console.log(`[foreman] cron skipped ${name} — missed while this machine was down`)
      }
    })
    .catch((err) => console.error('[foreman] scheduler failed', err))
    .finally(() => {
      ticking = false
    })
}, 30_000)
scheduler.unref()

/**
 * Sources, on their own interval and deliberately not folded into the scheduler's.
 *
 * The two triggers answer different questions and fail differently. Cron asks "was an
 * occurrence due", finishes in milliseconds, and is entirely local; a poll asks an
 * external API over the network and can sit there for as long as Linear takes. Sharing one
 * tick would mean a slow or hanging Linear delaying tonight's 3am review, which is a
 * failure the review has no part in.
 *
 * A minute rather than five, because the cadence lives on each source (`pollMinutes`) and
 * is enforced by the claim on `lastPolledAt`. This interval only decides the granularity
 * at which a due source is noticed, so the query it runs on a machine with no sources —
 * one `select` returning nothing — is the common case and costs nothing.
 *
 * No arguments: the defaults are the real ones. The key comes from `readProjectSecret`
 * (ADR-0012) and the client from `linearHttp`; both are parameters of `pollSources` only
 * so that the tests around them need neither a `~/.ogun/config.json` nor a socket. A
 * project with no key set polls, refuses, and writes a row naming the command that fixes
 * it — which is the same shape as every other missing-credential path here.
 */
let polling = false
const sourcePoll = setInterval(() => {
  if (polling) return
  polling = true
  pollSources(ctx.db)
    .then((results) => {
      for (const r of results) {
        if (r.emitted.length > 0) {
          console.log(`[foreman] source ${r.source} emitted ${r.emitted.join(', ')}`)
        } else if (r.outcome !== 'ok') {
          console.log(`[foreman] source ${r.source} ${r.outcome}: ${r.detail ?? ''}`)
        }
      }
    })
    .catch((err) => console.error('[foreman] source poll failed', err))
    .finally(() => {
      polling = false
    })
}, 60_000)
sourcePoll.unref()

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
  clearInterval(sourcePoll)
  clearInterval(sweep)
  server.close()
  await ctx.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
