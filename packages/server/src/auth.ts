import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { MiddlewareHandler } from 'hono'
import type { Env } from './context.ts'

const { runners } = schema

/**
 * The control plane can define workers and trigger them, so an unauthenticated instance
 * reachable from the network is remote code execution on this machine — not merely a
 * data-exposure problem. The posture is: **localhost with no token, or a wider bind
 * with one.** Never wide and open.
 *
 * There are two scopes, and the split matters:
 *
 *   admin  — the shared OGUN_TOKEN. Can do everything, including define a worker.
 *   runner — a per-machine enrollment token. Can claim jobs and report on them, and
 *            nothing else. A compromised runner cannot rewrite config.yaml and hand
 *            itself a new prompt to execute.
 */
export const LOCAL_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])

export type Scope = 'admin' | 'runner'

export type AuthConfig = { bind: string; token: string | undefined }

export function resolveAuth(env = process.env): AuthConfig {
  return {
    // Localhost by default. Reaching this from another machine should be a decision you
    // made, not something that happened because a framework defaults to all interfaces.
    bind: env.OGUN_BIND ?? '127.0.0.1',
    token: env.OGUN_TOKEN?.trim() || undefined,
  }
}

export class InsecureBind extends Error {}

/** Called at boot. Refuses rather than warns: a warning in a systemd log is not read. */
export function assertBindIsSafe(config: AuthConfig): void {
  if (LOCAL_BINDS.has(config.bind) || config.token) return
  throw new InsecureBind(
    [
      `refusing to listen on ${config.bind} without OGUN_TOKEN.`,
      '',
      'This API can create workers and trigger runs, so an open one on a shared network',
      'is remote code execution on this machine.',
      '',
      'Either bind to localhost (unset OGUN_BIND), or set a shared secret:',
      '',
      '  ogun token new            # prints a token and the export line',
      '',
      'Runners are enrolled separately and get their own tokens — see `ogun runner invite`',
      'or the Runners page.',
    ].join('\n'),
  )
}

/** Prefixed so one is recognisable in a shell history or a config file. */
export const mintToken = (prefix: 'ogun' | 'ogr' = 'ogun'): string =>
  `${prefix}_${randomBytes(32).toString('hex')}`

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const presentedToken = (header: string | undefined, fallback: string | undefined): string | undefined =>
  header?.startsWith('Bearer ') ? header.slice(7) : fallback

/**
 * Routes a runner token may reach. Everything else is admin.
 *
 * Expressed as one predicate over the path rather than as a runner-scoped middleware
 * layered under an admin-scoped one: with two registrations both match `/api/jobs/claim`,
 * so the admin check runs after the runner check passes and rejects it anyway. One
 * decision point cannot disagree with itself.
 */
const RUNNER_ROUTES = [
  /^\/api\/jobs\/claim$/,
  /^\/api\/runs\/[^/]+\/(started|events|report)$/,
]

export const scopeForPath = (path: string): Scope =>
  RUNNER_ROUTES.some((r) => r.test(path)) ? 'runner' : 'admin'

/**
 * `required` is the *minimum* scope, given as a value or derived from the path. An admin
 * token satisfies a runner-scoped route; a runner token does not satisfy an admin one.
 */
export function requireScope(
  adminToken: string | undefined,
  required: Scope | ((path: string) => Scope),
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const scope = typeof required === 'function' ? required(c.req.path) : required
    // No admin token configured means localhost-only, where everything is trusted.
    if (!adminToken) return next()
    if (c.req.path === '/api/health') return next()

    const presented = presentedToken(c.req.header('authorization'), c.req.header('x-ogun-token'))
    if (!presented) return c.json({ error: 'unauthorized' }, 401)

    if (constantTimeEqual(presented, adminToken)) return next()
    if (scope === 'admin') {
      // Distinguish "not you" from "not allowed": a runner presenting a valid token to an
      // admin route has a configuration problem, not an authentication one.
      const runner = await findRunnerByToken(c.var.ctx.db, presented)
      if (runner) {
        return c.json(
          { error: 'a runner token cannot administer the control plane' },
          403,
        )
      }
      return c.json({ error: 'unauthorized' }, 401)
    }

    const runner = await findRunnerByToken(c.var.ctx.db, presented)
    if (!runner) return c.json({ error: 'unauthorized' }, 401)
    return next()
  }
}

export async function findRunnerByToken(
  db: Env['Variables']['ctx']['db'],
  token: string,
): Promise<typeof runners.$inferSelect | undefined> {
  // Looked up by hash, so the database never holds anything usable as a credential.
  return db.query.runners.findFirst({
    where: and(eq(runners.tokenHash, hashToken(token)), isNull(runners.revokedAt)),
  })
}
