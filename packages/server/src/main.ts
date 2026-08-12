import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createContext } from './context.ts'
import { localConfigPath } from '@ogun/core'
import { assertBindIsSafe, InsecureBind, LOCAL_BINDS, resolveAuth } from './auth.ts'
import { sweepStaleClaims } from './foreman/sweep.ts'

const port = Number(process.env.OGUN_PORT ?? 7777)
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

const ctx = createContext()
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

const sweep = setInterval(() => {
  sweepStaleClaims(ctx.db, staleAfterMs)
    .then((n) => n > 0 && console.log(`[foreman] swept ${n} stale claim(s)`))
    .catch((err) => console.error('[foreman] sweep failed', err))
}, 60_000)
sweep.unref()

const shutdown = async () => {
  clearInterval(sweep)
  server.close()
  await ctx.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
