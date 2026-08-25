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

/**
 * The one environment variable that says "something in front of me terminates TLS".
 *
 * An *assertion by the operator*, not a fact Ogun can check — and a variable rather than a
 * header for that reason. `secretWriteTransport` has the argument.
 */
export const TLS_PROXY_ENV = 'OGUN_BEHIND_TLS_PROXY'

/**
 * Whether this control plane may accept a project's API key in a request body (ADR-0012),
 * and when it may not, what to tell the person who tried.
 *
 * ### The condition is the transport, not the existence of a route
 *
 * The rule this replaces was "no route accepts a secret, ever", on the grounds that a
 * value in a request body is a value in a reverse proxy's access log and in a browser's
 * network panel. Both halves were re-checked against what this process actually does, and
 * only one thing survives:
 *
 *  - **Ogun's own log is not the leak.** Nothing here logs a request body — which is also
 *    why the value goes in the body and never in the path: the request line is the part of
 *    a request this server does write to its journal.
 *
 *    [corrected] That line used to say `hono/logger` "writes method, path and status". It
 *    writes `url.slice(url.indexOf('/', 8))`, which is the path **and the query string**.
 *    Nothing about this route changes — its value is in the body either way — but the
 *    imprecision mattered the moment a route arrived whose *query* carries a credential,
 *    and ADR-0014's callback is exempted from the logger because of it. Recorded rather
 *    than quietly fixed: a paraphrase that was load-bearing somewhere else is worth
 *    marking where it was first written down.
 *  - **A proxy's access log is the operator's configuration, not ours.** A real hazard,
 *    and one they chose and can see. Not having the feature does not remove their proxy;
 *    it only sends them to a terminal.
 *  - **The browser's network panel shows the value to the person who just typed it.** That
 *    is not a disclosure. It is the same screen the key was pasted into.
 *
 * What is left is the irreducible one: **a secret crossing a network in cleartext**. Ogun
 * serves plain HTTP — there is no TLS listener anywhere in this process — so on a wider
 * bind the key is readable by anything on the path.
 *
 * ### So the rule is about what the transport can carry
 *
 *  - **Loopback.** Allowed. The request never reaches a network interface, and the only
 *    attacker who can see it is one already running as this user on this machine — who can
 *    read `~/.ogun/config.json` at 0600 directly. ADR-0012 draws its boundary in exactly
 *    that place, for exactly that reason.
 *  - **A wider bind.** Refused, unless the operator has declared a TLS terminator in front
 *    by setting `OGUN_BEHIND_TLS_PROXY`. Ogun cannot see past its own socket, so that is
 *    the operator asserting something only they know.
 *
 * ### Why an environment variable and not `x-forwarded-proto: https`
 *
 * Because that header is written by whoever is speaking to us, and on the exact bind this
 * guard exists for — plain HTTP straight off a LAN — that is the client. A guard a request
 * can switch off by asserting it is safe is not a guard, it is a comment. The environment
 * is the one input to this decision that something on the wire cannot supply, and it is
 * set once, by the person who built the deployment.
 *
 * ### Considered and rejected: allow it on any bind, since the token is already there
 *
 * The strongest objection, and it is nearly right. A token-protected control plane on
 * plain HTTP already puts an admin token — which can define a worker, which is to say
 * execute code on this host — on the wire with every request. An eavesdropper who could
 * take the Linear key already owns the machine. So what does refusing protect?
 *
 * *Somebody else's* system. The admin token's blast radius is this host and the work it
 * runs; a project's Linear key is a credential in a third party's workspace, and revoking
 * it is not this operator's call. Adding a new class of victim to a channel that is
 * already compromised is a fresh loss rather than a rounding error on an existing one —
 * and the alternative costs one `ssh` and a command that already exists.
 *
 * Note what this is *not*: authentication. A wider bind already requires the admin token
 * for every `/api/system` route (`scopeForPath`), and this runs after that check. The
 * question here is not who is asking; it is what the wire does with the answer.
 */
export type SecretWriteTransport =
  | { allowed: true; because: 'loopback' | 'declared-tls' }
  | { allowed: false; reason: string }

export function secretWriteTransport(
  env: NodeJS.ProcessEnv = process.env,
): SecretWriteTransport {
  const bind = env.OGUN_BIND ?? '127.0.0.1'
  if (LOCAL_BINDS.has(bind)) return { allowed: true, because: 'loopback' }
  // Any non-blank value. A variable whose meaning turned on `1` versus `true` is one
  // somebody sets to `yes` and then believes they have set.
  if ((env[TLS_PROXY_ENV] ?? '').trim() !== '') return { allowed: true, because: 'declared-tls' }
  return {
    allowed: false,
    reason:
      `this control plane is bound to ${bind} and serves plain HTTP, so a key typed into ` +
      'a browser would cross the network in cleartext — and Ogun cannot tell from inside ' +
      'whether anything in front of it terminates TLS. Set it with `ogun secret set ' +
      '<name>` on the control-plane machine — in the project\'s directory, or with ' +
      '`--project <slug>` — which writes the file directly and sends nothing anywhere. If ' +
      'TLS is terminated in front of this process, say so ' +
      `by starting the server with ${TLS_PROXY_ENV}=1.`,
  }
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
  // A triage node's input is the upstream nodes' staged findings (§4.12). The runner
  // has to fetch it to write it into the workspace, holding only a runner token.
  /^\/api\/jobs\/[^/]+\/inputs$/,
  /^\/api\/runs\/[^/]+\/(started|events|report)$/,
]

/**
 * Routes that carry their own credential, so requiring one of ours would be circular.
 *
 * `/runners/join` is how a machine turns an invite into a runner credential; it validates
 * the invite itself and refuses a used or revoked one.
 *
 * `/oauth/linear/callback` is the same shape for a different reason, and it is worth
 * spelling out because it looks like a hole. The session cookie is `SameSite=Strict`, and
 * a redirect from `linear.app` back to this origin is a cross-site navigation — so the
 * browser does not send it. Requiring the admin token here would make the OAuth flow
 * impossible on every control plane that has one, which is every control plane bound
 * beyond localhost, which is the deployment the feature exists for. What authenticates the
 * request instead is the `state` nonce: 256 bits from `randomBytes`, minted by this
 * process, bound to one project, single-use, and expiring in ten minutes. A callback that
 * does not present a matching one is refused before the authorization code is spent.
 */
const ENROLLMENT_ROUTES = [
  /^\/api\/runners\/join$/,
  /^\/api\/session$/,
  /^\/api\/oauth\/linear\/callback$/,
]

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

/**
 * The runner a request is *speaking as*: the machine its credential resolves to, rather
 * than whatever the body says about itself.
 *
 * Undefined means nothing in the request names a machine — an unprotected control plane,
 * which carries no credential at all, or the admin token, which is an operator and not a
 * machine. Both are legitimate, so a caller that has to attribute work decides for itself
 * what undefined means rather than being handed a guess (§4.5).
 */
export async function runnerForRequest(
  db: Env['Variables']['ctx']['db'],
  authorization: string | undefined,
): Promise<typeof runners.$inferSelect | undefined> {
  // Same tolerance as `/join`, which reads the header the same way: the runner sends
  // `Bearer <token>`, and a bare token from a hand-run curl still resolves.
  const presented = (authorization ?? '').replace(/^Bearer /, '').trim()
  if (!presented) return undefined
  return findRunnerByToken(db, presented)
}
