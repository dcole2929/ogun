import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { hashToken, mintToken } from '../auth.ts'

const { invites, runners } = schema

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
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
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
    /** Why an address may not work from another machine, when we can tell in advance. */
    reachabilityWarning: reachabilityWarning(),
    // Answered from what the server is actually enforcing. Reading the environment
    // said "no token" whenever one had been generated and stored rather than exported,
    // which is now the normal case.
    tokenRequired: c.var.ctx.adminTokenConfigured,
  })
})

const inviteSchema = z.object({
  /** Optional note for your own benefit — "the mac", "the NAS". Never a machine name. */
  note: z.string().max(200).optional(),
  serverUrl: z.string().optional(),
})

/**
 * Mints a join token. **No machine name is required or accepted here**, because the
 * machine has not joined yet and it is the thing that knows its own name — asking the
 * control plane to guess it is backwards, and produces a row for a machine that may
 * never appear.
 *
 * The token is returned once; only its hash is stored, which is what makes storing it
 * safe. A lost one is re-issued rather than recovered.
 */
runnersRoutes.post('/invites', async (c) => {
  const { db } = c.var.ctx
  const body = inviteSchema.parse(await c.req.json().catch(() => ({})))

  const token = mintToken('ogr')
  await db.insert(invites).values({
    tokenHash: hashToken(token),
    ...(body.note ? { note: body.note } : {}),
  })

  const url = body.serverUrl ?? reachableAddresses()[0] ?? 'http://localhost:7777'
  return c.json({ token, command: joinCommand(url, token) }, 201)
})

/** Outstanding invites — a token minted but not yet used by any machine. */
runnersRoutes.get('/invites', async (c) => {
  const rows = await c.var.ctx.db.select().from(invites).orderBy(desc(invites.createdAt))
  return c.json({
    invites: rows
      .filter((i) => !i.usedAt && !i.revokedAt)
      .map((i) => ({ id: i.id, note: i.note, createdAt: i.createdAt })),
  })
})

runnersRoutes.delete('/invites/:id', async (c) => {
  const [row] = await c.var.ctx.db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(eq(invites.id, c.req.param('id')))
    .returning()
  if (!row) return c.json({ error: 'no such invite' }, 404)
  return c.json({ revoked: row.id })
})

const joinSchema = z.object({
  /** Chosen by the machine, defaulting to its hostname. It is the thing that knows. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:[-._][a-z0-9]+)*$/i, 'must be a hostname-like slug'),
  labels: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().positive().default(2),
})

/**
 * Redeem a join token. Called by the runner, presenting the invite as its bearer token —
 * this is the one route an unenrolled machine may reach, since by definition it has no
 * runner credential yet.
 *
 * The invite is single use. A token that enrolled one machine and could then enroll ten
 * more is a shared secret wearing an invite's clothes.
 */
runnersRoutes.post('/join', async (c) => {
  const { db, adminTokenConfigured } = c.var.ctx
  const presented = (c.req.header('authorization') ?? '').replace(/^Bearer /, '')
  const body = joinSchema.parse(await c.req.json())

  /**
   * An invite is only required when the control plane is protected. On localhost there
   * is nothing to protect against and no credential to carry, so `ogun runner init`
   * registers through this same endpoint with no token.
   *
   * One registration path rather than two: it is the only place that can enforce name
   * uniqueness, and a second path that skipped it would be the hole.
   */
  const invite = adminTokenConfigured
    ? await db.query.invites.findFirst({
        where: and(eq(invites.tokenHash, hashToken(presented)), isNull(invites.revokedAt)),
      })
    : undefined

  if (adminTokenConfigured) {
    if (!invite) return c.json({ error: 'that join token is not valid' }, 401)
    if (invite.usedAt) {
      return c.json(
        { error: `that join token was already used by "${invite.usedBy}" — mint a new one` },
        409,
      )
    }
  }

  /**
   * Names are unique. Two machines answering to one name would share a claim identity
   * and a run history, and neither would be attributable — so the second one is refused
   * rather than quietly taking over the first one's row.
   *
   * Except on an unprotected control plane, where there is nothing to protect against:
   * it is only reachable from this machine, so a collision cannot mean "another machine"
   * and always means "me again" — re-running `ogun runner init`, or reconnecting after
   * the local config was lost. Refusing there would strand the one-box case with an
   * error whose only remedy is revoking a machine that is not gone.
   */
  const taken = await db.query.runners.findFirst({
    where: and(eq(runners.name, body.name), isNull(runners.revokedAt)),
  })
  if (taken && !taken.revokedAt && adminTokenConfigured) {
    const age = Date.now() - taken.lastSeenAt.getTime()
    const seen = taken.pending
      ? 'has never connected'
      : `was last seen ${Math.round(age / 60_000)} minutes ago`
    return c.json(
      {
        error:
          `a runner called "${body.name}" is already registered and ${seen}. ` +
          'Choose another name with --name, or revoke that one from the Runners page ' +
          'if it is the same machine being re-registered.',
      },
      409,
    )
  }

  // The invite becomes this machine's credential. One token, one machine, revocable on
  // its own — which is the property that makes a lost laptop a revocation rather than a
  // rotation across every machine.
  const values = {
    name: body.name,
    labels: body.labels,
    maxConcurrency: body.maxConcurrency,
    // Null on a localhost control plane: there is no credential because none is needed.
    tokenHash: invite?.tokenHash ?? null,
    enrolledAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    pending: true,
  }
  // `taken` is the live row with this name, when one exists — re-registering the same
  // machine updates it in place rather than minting a second identity for it.
  if (taken && !taken.revokedAt) {
    await db.update(runners).set(values).where(eq(runners.id, taken.id))
  } else {
    await db.insert(runners).values(values)
  }

  if (invite) {
    await db
      .update(invites)
      .set({ usedAt: new Date(), usedBy: body.name })
      .where(eq(invites.id, invite.id))
  }

  return c.json({ runner: { name: body.name, labels: body.labels } }, 201)
})

/**
 * A runner is addressed by its id, which is a uuid. Anything else — most likely a name,
 * from a caller written before runners had a real identity — would reach postgres as a
 * failed cast and surface as a 500 with a driver error in it. It is a 404: there is no
 * runner with that id, and saying so is both true and actionable.
 */
const runnerIdOf = (raw: string): string | null =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw : null

/**
 * Revoke: the token stops working and the machine can no longer claim, but the row
 * stays. That is the right default for a machine you are decommissioning — you may want
 * to see it in the list, and it stops the name being silently reused by something else.
 */
runnersRoutes.delete('/:id', async (c) => {
  const { db } = c.var.ctx
  const id = runnerIdOf(c.req.param('id'))
  if (!id) return c.json({ error: 'no such runner' }, 404)
  const [row] = await db
    .update(runners)
    .set({ revokedAt: new Date(), pending: false })
    .where(eq(runners.id, id))
    .returning()
  if (!row) return c.json({ error: 'no such runner' }, 404)
  return c.json({ revoked: row.name })
})

/**
 * Forget: remove the row entirely. Safe because `runs.runner_id` is text with no foreign
 * key — history keeps the name whether or not the runner still exists — so this loses
 * nothing but the entry in the list.
 *
 * Only for an already-revoked runner. Forgetting a live one would let it silently
 * re-register on its next claim, which looks like the delete did not work.
 */
runnersRoutes.delete('/:id/forget', async (c) => {
  const { db } = c.var.ctx
  const id = runnerIdOf(c.req.param('id'))
  if (!id) return c.json({ error: 'no such runner' }, 404)
  const existing = await db.query.runners.findFirst({ where: eq(runners.id, id) })
  if (!existing) return c.json({ error: 'no such runner' }, 404)
  if (!existing.revokedAt) {
    return c.json({ error: 'revoke it first — a live runner would just re-register' }, 409)
  }
  await db.delete(runners).where(eq(runners.id, existing.id))
  return c.json({ forgotten: existing.name })
})

/**
 * WSL2 sits behind a NAT'd virtual switch. Windows can reach the distro, but nothing
 * else on the LAN can, so the eth0 address is exactly the wrong thing to paste into
 * another machine's config — and it looks plausible, which is worse than looking wrong.
 *
 * Detected rather than assumed, because the answer differs per Windows version and per
 * .wslconfig.
 */
export function reachabilityWarning(): string | null {
  if (!isWsl()) return null
  // Only relevant when you are trying to reach this from elsewhere. On a localhost bind
  // nothing is supposed to, so the warning would just be noise on the Settings page.
  const bind = process.env.OGUN_BIND ?? '127.0.0.1'
  if (bind !== '0.0.0.0' && bind !== '::') return null
  const addrs = reachableAddresses()
  const hasOverlay = addrs.some((a) => a.includes('://100.'))
  if (hasOverlay) return null
  return [
    'This control plane is on WSL2, whose address is private to Windows — another',
    'machine on your network cannot reach it as-is. Three ways out, cheapest first:',
    '',
    '  1. Mirrored networking (Windows 11 22H2+): add to %USERPROFILE%\\.wslconfig',
    '       [wsl2]',
    '       networkingMode=mirrored',
    '     then `wsl --shutdown`. WSL then shares the Windows LAN address.',
    '',
    '  2. A mesh VPN such as Tailscale, installed inside WSL2. Gives a stable 100.x',
    '     address that works from any network, not just this one — the right answer if',
    '     a runner is ever off your LAN.',
    '',
    '  3. Port forwarding, from an elevated PowerShell:',
    '       netsh interface portproxy add v4tov4 listenport=7777 \\',
    '         connectaddress=<wsl-ip> connectport=7777',
    '     Brittle: the WSL address changes on reboot.',
  ].join('\n')
}

const isWsl = (): boolean => {
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

/**
 * `--name` is deliberately absent: the runner defaults to its own hostname, and can pass
 * `--name` itself if the operator over there wants something else.
 */
const joinCommand = (url: string, token: string): string =>
  `ogun runner join ${url} --token ${token}`

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
