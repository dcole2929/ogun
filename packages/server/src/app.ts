import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import type { AppContext, Env } from './context.ts'
import { deleteCookie, setCookie } from 'hono/cookie'
import { requireScope, scopeForPath, SESSION_COOKIE } from './auth.ts'
import { ConfigInvalid } from './reindex.ts'
import { jobsRoutes } from './routes/jobs.ts'
import { runsRoutes } from './routes/runs.ts'
import { projectsRoutes } from './routes/projects.ts'
import { findingsRoutes } from './routes/findings.ts'
import { skillsRoutes } from './routes/skills.ts'
import { runnersRoutes } from './routes/runners.ts'
import { LINEAR_CALLBACK_PATH, oauthRoutes } from './routes/oauth.ts'
import { systemRoutes } from './routes/system.ts'
import { workersRoutes } from './routes/workers.ts'
import { triggerRoutes } from './routes/trigger.ts'

export function createApp(ctx: AppContext, token?: string) {
  const app = new Hono<Env>()

  /**
   * The request log, with one path exempted.
   *
   * `hono/logger` does **not** log "method, path and status" — it logs
   * `url.slice(url.indexOf('/', 8))`, which is the path *and the query string*, twice per
   * request. That is fine for every other route in this process and wrong for exactly one:
   * `GET /api/oauth/linear/callback?code=…&state=…`, where the query is an authorization
   * code and a CSRF nonce, and this journal is the one log Ogun definitely writes.
   *
   * Exempted rather than silenced. A callback that arrived and failed has to leave
   * evidence — a missing line is indistinguishable from a callback Linear never sent — so
   * the substitute below records the method, the path, the status and the fact that the
   * query was elided. `ogun` at the start of the line matches nothing else here on
   * purpose: it is a line a person grepping for the code will find, and it says why the
   * code is not in it.
   *
   * The route also redirects immediately to a clean URL, so this is one of three defences
   * rather than the only one (`routes/oauth.ts` has the argument).
   */
  const requestLog = logger()
  app.use('*', async (c, next) => {
    if (c.req.path !== LINEAR_CALLBACK_PATH) return requestLog(c, next)
    await next()
    console.log(
      `ogun: ${c.req.method} ${LINEAR_CALLBACK_PATH} ${c.res.status} ` +
        '(query withheld — it carries an authorization code)',
    )
  })
  // Before auth, not after: scope checking has to look up an enrolled runner, which
  // needs the database handle.
  app.use('*', async (c, next) => {
    c.set('ctx', ctx)
    await next()
  })
  // The UI is served from this same origin in production; cors is for `pnpm web` dev.
  app.use('/api/*', cors())
  /**
   * One registration, with the required scope derived from the path. A runner token can
   * claim work and report on it; it cannot define a worker, because defining a worker is
   * defining what gets executed on the host.
   */
  app.use('/api/*', requireScope(token, scopeForPath))

  app.get('/api/health', (c) => c.json({ ok: true }))

  /**
   * Exchange the admin token for a session cookie. The UI calls this once, when it gets
   * a 401 — a browser cannot attach an Authorization header to its own navigation, so
   * without this a token-protected control plane serves a page that cannot talk to it.
   */
  app.post('/api/session', async (c) => {
    if (!token) return c.json({ ok: true, required: false })
    const body = (await c.req.json().catch(() => ({}))) as { token?: string }
    if (!body.token || body.token !== token) return c.json({ error: 'wrong token' }, 401)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      // Not `secure`: this is plain HTTP on a LAN or a VPN address. Marking it secure
      // would stop the cookie being sent at all, which is worse than not marking it.
    })
    return c.json({ ok: true, required: true })
  })

  app.delete('/api/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
  app.route('/api/jobs', jobsRoutes)
  app.route('/api/runs', runsRoutes)
  app.route('/api/projects', projectsRoutes)
  app.route('/api/findings', findingsRoutes)
  app.route('/api/skills', skillsRoutes)
  app.route('/api/runners', runnersRoutes)
  app.route('/api/oauth', oauthRoutes)
  app.route('/api/system', systemRoutes)
  app.route('/api/workers', workersRoutes)
  app.route('/api/trigger', triggerRoutes)

  app.onError((err, c) => {
    console.error('[api]', err)
    /**
     * 400 only for an error whose type says a person's input caused it. Deliberately not
     * inferred from a `status` property, and deliberately not from `ZodError`: the same
     * schemas parse rows read back out of the database — `startCycleRun` parses the
     * definition stored on a cycle — and a failure there is this control plane's problem,
     * not the caller's. Calling it a bad request sends someone to go and edit a file that
     * is fine.
     */
    const status = err instanceof SyntaxError || err instanceof ConfigInvalid ? 400 : 500
    return c.json({ error: err.message }, status)
  })

  const webDist = new URL('../../../apps/web/dist/', import.meta.url).pathname
  if (existsSync(webDist)) {
    const root = relativeToCwd(webDist)
    /**
     * Anything that exists on disk, then index.html for everything else.
     *
     * Serving only `/assets/*` meant a root-level file — favicon.svg, and anything else
     * that lives beside index.html — fell through to the SPA fallback and was returned
     * as HTML with a 200. A browser asking for an icon and getting a document does not
     * report an error; it just shows no icon.
     */
    app.use('*', serveStatic({ root }))
    app.get('*', serveStatic({ path: `${root}/index.html` }))
  }

  return app
}

// serveStatic resolves against process.cwd(), so an absolute path has to be relativised.
const relativeToCwd = (abs: string): string => {
  const cwd = process.cwd().replace(/\/$/, '')
  return abs.startsWith(cwd) ? `.${abs.slice(cwd.length)}`.replace(/\/$/, '') : abs
}
