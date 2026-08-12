import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { loadLocalConfig, updateLocalConfig } from '@ogun/core'
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
 *   admin  — OGUN_ADMIN_TOKEN, or generated and stored. Can do everything.
 *   runner — a per-machine enrollment token. Can claim jobs and report on them, and
 *            nothing else. A compromised runner cannot rewrite config.yaml and hand
 *            itself a new prompt to execute.
 */
export const LOCAL_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])

export type Scope = 'admin' | 'runner'

export type AuthConfig = {
  bind: string
  token: string | undefined
  /** True when this run created it, so the caller can say where it went. */
  generated: boolean
}

/**
 * Localhost by default. Reaching this from another machine should be a decision you
 * made, not something that happened because a framework defaults to all interfaces.
 *
 * The admin token is *generated and stored*, not typed. Requiring `ogun token new` and
 * then pasting the result into an environment variable made the operator responsible for
 * moving a secret around by hand, for no benefit: the CLI on this machine can read the
 * same file the server writes, so neither of them needs it in the environment.
 */
export async function resolveAuth(env = process.env): Promise<AuthConfig> {
  const bind = env.OGUN_BIND ?? '127.0.0.1'
  // OGUN_ADMIN_TOKEN, not OGUN_TOKEN. The runner reads its own credential from the
  // environment too, and one name meaning two different secrets depending on which
  // process happens to read it is how a runner ends up holding the admin token.
  const fromEnv = env.OGUN_ADMIN_TOKEN?.trim() || undefined
  if (fromEnv) return { bind, token: fromEnv, generated: false }

  // A localhost control plane needs no token: nothing off this machine can reach it.
  if (LOCAL_BINDS.has(bind)) return { bind, token: undefined, generated: false }

  const local = await loadLocalConfig()
  if (local.server.token) return { bind, token: local.server.token, generated: false }

  const token = mintToken('ogun')
  await updateLocalConfig((c) => ({ ...c, server: { ...c.server, token } }))
  return { bind, token, generated: true }
}

export class InsecureBind extends Error {}

/**
 * Called at boot. With `resolveAuth` generating a token for any non-local bind this is
 * now unreachable in practice — it stays as the invariant it always was, so a future
 * caller constructing an AuthConfig by hand cannot produce an open one by accident.
 */
export function assertBindIsSafe(config: AuthConfig): void {
  if (LOCAL_BINDS.has(config.bind) || config.token) return
  throw new InsecureBind(
    `refusing to listen on ${config.bind} with no admin token. This API can define ` +
      'workers and trigger runs, so an open one on a shared network is remote code ' +
      'execution on this machine.',
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

export const SESSION_COOKIE = 'ogun_session'

/**
 * The browser cannot set an Authorization header on its own first request, and the UI is
 * served from this same origin — so a token-protected control plane needs a cookie or the
 * whole web interface 401s. It holds the admin token itself rather than a session id:
 * httpOnly so scripts cannot read it, and there is no session table to expire, which for
 * a single-operator tool is the right amount of machinery.
 */
const presentedToken = (
  header: string | undefined,
  fallback: string | undefined,
  cookie: string | undefined,
): string | undefined => {
  if (header?.startsWith('Bearer ')) return header.slice(7)
  if (fallback) return fallback
  const match = cookie?.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`))
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

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

/**
 * Reachable while holding only an invite. `/join` is how a machine turns an invite into
 * a runner credential, so requiring a runner credential to reach it would be circular.
 * It validates the invite itself, and refuses a used or revoked one.
 */
const ENROLLMENT_ROUTES = [/^\/api\/runners\/join$/, /^\/api\/session$/]

export const scopeForPath = (path: string): Scope | 'enrollment' =>
  ENROLLMENT_ROUTES.some((r) => r.test(path))
    ? 'enrollment'
    : RUNNER_ROUTES.some((r) => r.test(path))
      ? 'runner'
      : 'admin'

/**
 * `required` is the *minimum* scope, given as a value or derived from the path. An admin
 * token satisfies a runner-scoped route; a runner token does not satisfy an admin one.
 */
export function requireScope(
  adminToken: string | undefined,
  required: Scope | ((path: string) => Scope | 'enrollment'),
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const scope = typeof required === 'function' ? required(c.req.path) : required
    // No admin token configured means localhost-only, where everything is trusted.
    if (!adminToken) return next()
    if (c.req.path === '/api/health') return next()
    // The route checks the invite itself; it cannot require a credential it issues.
    if (scope === 'enrollment') return next()

    const presented = presentedToken(
      c.req.header('authorization'),
      c.req.header('x-ogun-token'),
      c.req.header('cookie'),
    )
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
