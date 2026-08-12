import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import type { AppContext, Env } from './context.ts'
import { jobsRoutes } from './routes/jobs.ts'
import { runsRoutes } from './routes/runs.ts'
import { projectsRoutes } from './routes/projects.ts'
import { findingsRoutes } from './routes/findings.ts'
import { skillsRoutes } from './routes/skills.ts'
import { workersRoutes } from './routes/workers.ts'
import { triggerRoutes } from './routes/trigger.ts'

export function createApp(ctx: AppContext) {
  const app = new Hono<Env>()

  app.use('*', logger())
  // The UI is served from this same origin in production; cors is for `pnpm web` dev.
  app.use('/api/*', cors())
  app.use('*', async (c, next) => {
    c.set('ctx', ctx)
    await next()
  })

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/jobs', jobsRoutes)
  app.route('/api/runs', runsRoutes)
  app.route('/api/projects', projectsRoutes)
  app.route('/api/findings', findingsRoutes)
  app.route('/api/skills', skillsRoutes)
  app.route('/api/workers', workersRoutes)
  app.route('/api/trigger', triggerRoutes)

  app.onError((err, c) => {
    console.error('[api]', err)
    const status = err instanceof SyntaxError ? 400 : 500
    return c.json({ error: err.message }, status)
  })

  const webDist = new URL('../../../apps/web/dist/', import.meta.url).pathname
  if (existsSync(webDist)) {
    app.use('/assets/*', serveStatic({ root: relativeToCwd(webDist) }))
    app.get('*', serveStatic({ path: `${relativeToCwd(webDist)}/index.html` }))
  }

  return app
}

// serveStatic resolves against process.cwd(), so an absolute path has to be relativised.
const relativeToCwd = (abs: string): string => {
  const cwd = process.cwd().replace(/\/$/, '')
  return abs.startsWith(cwd) ? `.${abs.slice(cwd.length)}`.replace(/\/$/, '') : abs
}
