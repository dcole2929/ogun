import { Hono } from 'hono'
import { networkInterfaces } from 'node:os'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { hashToken, mintToken } from '../auth.ts'

const { runners } = schema

/**
 * One control plane, N machines.
 *
 * **Runners connect outward; the control plane never dials a runner.** That is not an
 * implementation detail to be relaxed — it is what makes a laptop a viable runner. A
 * machine that sleeps, moves between networks, and sits behind NAT can still ask for
 * work whenever it is awake, and needs no inbound port, no forwarding, and no static
 * address. Reversing the direction would mean every runner has to be reachable, which
 * is the one thing a laptop cannot promise.
 *
 * So "add a runner from the UI" is: mint an enrollment token here, and paste one command
 * over there. The connection still travels runner → control plane. This is the same
 * shape as a CI agent or a mesh VPN node, for the same reason.
 */
export const runnersRoutes = new Hono<Env>()

/** A runner polls every few seconds, so silence for a minute means it is gone. */
const STALE_MS = 60_000

runnersRoutes.get('/', async (c) => {
  const rows = await c.var.ctx.db.select().from(runners).orderBy(desc(runners.lastSeenAt))
  const now = Date.now()
  return c.json({
    runners: rows.map((r) => ({
      id: r.id,
      labels: r.labels,
      maxConcurrency: r.maxConcurrency,
      lastSeenAt: r.lastSeenAt,
      enrolledAt: r.enrolledAt,
      revokedAt: r.revokedAt,
      pending: r.pending,
      // Never the hash, and certainly never the token — this is a browser-facing route.
      enrolled: r.tokenHash !== null,
      online: !r.pending && !r.revokedAt && now - r.lastSeenAt.getTime() < STALE_MS,
    })),
    /** Addresses this control plane believes it is reachable at, for the paste command. */
    addresses: reachableAddresses(),
    tokenRequired: Boolean(process.env.OGUN_TOKEN?.trim()),
  })
})

const enrollSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'must be a lowercase slug, e.g. macbook or dev-box'),
  /** What the operator says this machine can do; the runner overwrites it on first claim. */
  labels: z.array(z.string()).default([]),
  serverUrl: z.string().optional(),
})

/**
 * Mints a token and returns it **once**. Only the hash is stored, so a lost token is
 * re-issued rather than recovered — which is the property that makes storing it safe.
 */
runnersRoutes.post('/', async (c) => {
  const { db } = c.var.ctx
  const body = enrollSchema.parse(await c.req.json())

  const existing = await db.query.runners.findFirst({ where: eq(runners.id, body.id) })
  if (existing && !existing.revokedAt) {
    return c.json(
      { error: `a runner named "${body.id}" is already enrolled — revoke it first to re-issue` },
      409,
    )
  }

  const token = mintToken('ogr')
  const values = {
    id: body.id,
    labels: body.labels,
    tokenHash: hashToken(token),
    enrolledAt: new Date(),
    revokedAt: null,
    pending: true,
  }
  await db
    .insert(runners)
    .values(values)
    .onConflictDoUpdate({ target: runners.id, set: values })

  const url = body.serverUrl ?? reachableAddresses()[0] ?? 'http://localhost:7777'
  return c.json(
    {
      runner: { id: body.id },
      // Shown once. The UI has to make that clear, because there is no second chance.
      token,
      command: enrollCommand(body.id, url, token),
    },
    201,
  )
})

/** Revoked, not deleted, so this machine's runs keep a name to point at. */
runnersRoutes.delete('/:id', async (c) => {
  const { db } = c.var.ctx
  const [row] = await db
    .update(runners)
    .set({ revokedAt: new Date(), pending: false })
    .where(eq(runners.id, c.req.param('id')))
    .returning()
  if (!row) return c.json({ error: 'no such runner' }, 404)
  return c.json({ revoked: row.id })
})

const enrollCommand = (id: string, url: string, token: string): string =>
  [
    `ogun runner join ${url} \\`,
    `  --token ${token} \\`,
    `  --name ${id}`,
  ].join('\n')

/**
 * A runner on another machine cannot reach `localhost`, so the paste command needs a
 * real address. These are candidates rather than a decision — the operator knows which
 * network the other machine is on, and may be using a VPN address that is not listed.
 */
export function reachableAddresses(port = Number(process.env.OGUN_PORT ?? 7777)): string[] {
  const bind = process.env.OGUN_BIND ?? '127.0.0.1'
  if (bind !== '0.0.0.0' && bind !== '::') return [`http://${bind}:${port}`]

  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== 'IPv4') continue
      out.push(`http://${addr.address}:${port}`)
    }
  }
  // Tailscale and other overlays hand out 100.64/10; that is usually the address that
  // works across networks, so surface it first.
  return out.sort((a, b) => Number(b.includes('://100.')) - Number(a.includes('://100.')))
}
