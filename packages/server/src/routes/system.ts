import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { count, eq, sql } from 'drizzle-orm'
import { loadLocalConfig, localConfigPath } from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { mintToken } from '../auth.ts'
import { updateLocalConfig } from '@ogun/core'
import { reachableAddresses, reachabilityWarning } from './runners.ts'

const run = promisify(execFile)
const { findings, jobs, projects, runs } = schema

/**
 * What `ogun runner doctor` answers, for the machine running the control plane.
 *
 * The UI cannot ask a runner directly — runners connect outward and are not addressable
 * (§4.5) — so this describes *this* host only. A remote runner's health is its own
 * `doctor` output, which is why the Runners page shows what each advertises rather than
 * pretending to probe it.
 */
export const systemRoutes = new Hono<Env>()

const version = async (bin: string, args: string[]): Promise<string | null> =>
  run(bin, args, { timeout: 10_000 }).then(
    ({ stdout }) => stdout.split('\n')[0]?.trim() ?? '',
    () => null,
  )

systemRoutes.get('/', async (c) => {
  const { db, adminTokenConfigured } = c.var.ctx
  const local = await loadLocalConfig().catch(() => null)

  const [git, docker, claude, codex] = await Promise.all([
    version('git', ['--version']),
    version('docker', ['--version']),
    version(process.env.OGUN_CLAUDE_BIN ?? 'claude', ['--version']),
    version('codex', ['--version']),
  ])

  const baseImage = docker
    ? await run('docker', ['image', 'inspect', 'ogun/base:latest'], { timeout: 15_000 }).then(
        () => true,
        () => false,
      )
    : false

  // Cheap counts. The UI uses them to say "nothing here yet" versus "nothing matched
  // your filter", which are different answers to the same empty screen.
  const [[projectCount], [runCount], [openFindings], [queued]] = await Promise.all([
    db.select({ n: count() }).from(projects),
    db.select({ n: count() }).from(runs),
    db.select({ n: count() }).from(findings).where(eq(findings.status, 'open')),
    db.select({ n: count() }).from(jobs).where(eq(jobs.state, 'queued')),
  ])

  return c.json({
    controlPlane: {
      bind: process.env.OGUN_BIND ?? '127.0.0.1',
      port: Number(process.env.OGUN_PORT ?? 7777),
      tokenRequired: adminTokenConfigured,
      addresses: reachableAddresses(),
      reachabilityWarning: reachabilityWarning(),
      configPath: localConfigPath(),
    },
    host: {
      // Present/absent, with the version when we have it. A missing binary is why a job
      // sits queued forever, and that is worth being able to see from the browser.
      git,
      docker,
      claude,
      codex,
      baseImage,
      claudeCredentials: existsSync(join(process.env.HOME ?? '', '.claude')),
      codexCredentials: existsSync(join(process.env.HOME ?? '', '.codex')),
      isRunner: Boolean(local?.runner),
      runnerName: local?.runner?.name ?? null,
    },
    /** Where this machine has repos checked out. Absent ones clone from their remote. */
    checkouts: Object.entries(local?.projects ?? {}).map(([slug, path]) => ({
      slug,
      path,
      present: existsSync(join(path.replace(/^~/, process.env.HOME ?? ''), '.git')),
    })),
    counts: {
      projects: projectCount?.n ?? 0,
      runs: runCount?.n ?? 0,
      openFindings: openFindings?.n ?? 0,
      queuedJobs: queued?.n ?? 0,
    },
  })
})

/**
 * The admin token, for an operator who is already authenticated as one. Behind an
 * explicit request rather than in the payload above, so it is not sitting in every
 * response and in the browser's network log for the whole session.
 */
systemRoutes.get('/token', async (c) => {
  const local = await loadLocalConfig().catch(() => null)
  const token = process.env.OGUN_ADMIN_TOKEN?.trim() || local?.server.token
  if (!token) return c.json({ token: null, reason: 'this control plane is on localhost' })
  return c.json({ token, fromEnvironment: Boolean(process.env.OGUN_ADMIN_TOKEN?.trim()) })
})

systemRoutes.post('/token/rotate', async (c) => {
  if (process.env.OGUN_ADMIN_TOKEN?.trim()) {
    return c.json(
      {
        error:
          'this control plane takes its token from OGUN_ADMIN_TOKEN, so rotating here ' +
          'would be overwritten on restart. Change the environment instead.',
      },
      409,
    )
  }
  const token = mintToken('ogun')
  await updateLocalConfig((cfg) => ({ ...cfg, server: { ...cfg.server, token } }))
  void sql
  // Deliberately not applied to the running process: the operator's own session is
  // authenticated with the old token, and swapping it underneath them would lock them
  // out mid-request with no way to see the new one.
  return c.json({ token, restartRequired: true })
})
