import { Hono } from 'hono'
import { desc } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'

const { runners } = schema

/**
 * One control plane, N runners — the split has always supported this (§4.5), but the
 * registry was written on every claim and never read back, so there was no way to see
 * which machines were actually connected or what each could do.
 */
export const runnersRoutes = new Hono<Env>()

/** A runner polls every few seconds, so silence for a minute means it is gone. */
const STALE_MS = 60_000

runnersRoutes.get('/', async (c) => {
  const rows = await c.var.ctx.db.select().from(runners).orderBy(desc(runners.lastSeenAt))
  const now = Date.now()
  return c.json({
    runners: rows.map((r) => ({
      ...r,
      online: now - r.lastSeenAt.getTime() < STALE_MS,
    })),
  })
})
