import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { ROUTES, SKILLS, WORKERS } from './fixtures.ts'

const DIST = new URL('../dist/', import.meta.url).pathname

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Serves the built bundle — the same files `ogun server` serves — so these tests exercise
 * what ships rather than a dev-mode approximation of it.
 *
 * Unknown paths fall back to index.html, because the app is a client-side router and a
 * reload on /workers has to reach it. That is also what hono does in production.
 */
export async function serveDist(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    // normalize() before joining, so a `..` in a request cannot walk out of dist.
    const file = join(DIST, normalize(path))
    const body = await readFile(file).catch(() => null)
    if (body) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
      return
    }
    const index = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(index)
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((done) => server.close(() => done())),
  }
}

export type Harness = {
  page: Page
  url: string
  stop: () => Promise<void>
}

/**
 * A browser on the built app, with `/api` answered from fixtures.
 *
 * `overrides` replaces one route's body — how a test says "now the status endpoint
 * reports everything is fine" without inventing a second fixture set.
 */
export async function open(
  path = '/',
  overrides: Record<string, unknown> = {},
): Promise<Harness> {
  const site = await serveDist()
  const browser: Browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const project = url.searchParams.get('project')
    let body = overrides[url.pathname] ?? ROUTES[url.pathname]

    // The two endpoints that take `?project=` filter server-side, so a browser test that
    // ignored it would let a scoped page look correct while the real one did not.
    if (project && url.pathname === '/api/skills') {
      body = { skills: SKILLS.skills.filter((s) => s.project.slug === project) }
    }
    if (project && url.pathname === '/api/workers') {
      body = { ...WORKERS, workers: WORKERS.workers.filter((w) => w.project.slug === project) }
    }

    if (body === undefined) return route.fulfill({ status: 404, body: '{}' })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })

  await page.goto(`${site.url}${path}`)
  // Every page's first paint is a loading state; the scope selector is the shell, so its
  // arrival means the app has mounted and the projects query has landed.
  await page.waitForSelector('.scope select, .empty', { timeout: 15_000 })

  return {
    page,
    url: site.url,
    stop: async () => {
      await browser.close()
      await site.stop()
    },
  }
}
