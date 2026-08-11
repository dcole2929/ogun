import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createContext } from './context.ts'
import { sweepStaleClaims } from './foreman/sweep.ts'

const port = Number(process.env.OGUN_PORT ?? 7777)
const staleAfterMs = Number(process.env.OGUN_STALE_CLAIM_MS ?? 45 * 60_000)

const ctx = createContext()
const server = serve({ fetch: createApp(ctx).fetch, port }, (info) => {
  console.log(`ogun-server listening on http://localhost:${info.port}`)
})

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
