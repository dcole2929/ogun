import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { count, eq, sql } from 'drizzle-orm'
import {
  clearProjectSecret,
  InvalidSecret,
  isSecretName,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
  normalizeSecretInput,
  sealSecret,
  SECRET_NAMES,
  setProjectSecret,
  type Secret,
} from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { mintToken, secretWriteTransport } from '../auth.ts'
import { updateLocalConfig } from '@ogun/core'
import { reachableAddresses, reachabilityWarning } from './runners.ts'
import { driftAcross } from '../drift.ts'

const run = promisify(execFile)
const { breakers, findings, jobs, projects, runners, runs, workers } = schema

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

/**
 * The three things that silently stop work, cheap enough for the UI to ask constantly.
 *
 * Deliberately not part of `GET /api/system`, which shells out to `git`, `docker`,
 * `claude` and `codex` with ten-second timeouts — fine for a page you open, ruinous for
 * something the chrome polls every few seconds. This is four queries and one file hash.
 *
 * All three fail the same way: everything reports success and nothing runs. No runner
 * online and jobs queue forever; a drifted config runs last week's definition; an open
 * breaker refuses a worker at admission. Each is visible today only on the page that owns
 * it, which is no use when you are looking at something else.
 */
systemRoutes.get('/status', async (c) => {
  const { db, config } = c.var.ctx

  const [online] = await db
    .select({ n: count() })
    .from(runners)
    .where(
      sql`${runners.revokedAt} is null and ${runners.pending} = false
          and ${runners.lastSeenAt} > now() - interval '60 seconds'`,
    )

  const tripped = await db
    .select({ worker: workers.name, project: projects.slug, failures: breakers.consecutiveFailures })
    .from(breakers)
    .innerJoin(workers, eq(workers.id, breakers.workerId))
    .innerJoin(projects, eq(projects.id, workers.projectId))
    .where(sql`${breakers.openedAt} is not null`)

  const drift = await driftAcross(db, config)

  return c.json({
    runnersOnline: online?.n ?? 0,
    // Only `drifted` is actionable. `unreachable` is a hosted control plane working as
    // designed, and `unknown` is a project indexed before the hash was recorded.
    drifted: Object.entries(drift)
      .filter(([, d]) => d.state === 'drifted')
      .map(([slug]) => slug),
    breakers: tripped,
  })
})

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
    /**
     * Which projects have an API key on this machine — the name and nothing else.
     *
     * The value is not here and cannot be: `listProjectSecrets` returns
     * `ProjectSecretPresence`, which has no field one would fit in (ADR-0012). That is the
     * whole design of this line. A list endpoint is where secrets leak, and the way to
     * make that impossible is for the listing type to be unable to carry one, rather than
     * for every future editor of this route to remember not to add it.
     *
     * There *is* now a route that sets one — `PUT /secrets/:project/:name` below — and it
     * is conditional on the transport rather than on the shape of the request. The line
     * this comment used to carry said there was deliberately no such route, because "a
     * secret in a request body is a secret in a reverse proxy's access log and in a
     * browser's network panel". Only part of that was ever load-bearing: this server's own
     * log (`hono/logger`) records method, path and status and never a body, a proxy's log
     * is the operator's configuration rather than ours, and the network panel shows the
     * value to the person who just typed it, which is not a disclosure. What is real is a
     * key crossing a network in cleartext, and that is a property of the bind — so the
     * refusal now lives where the condition is, in `secretWriteTransport`.
     *
     * A config.json too broken to read shows as none here. `ogun runner doctor` is the
     * surface that tells those two apart, and the `host` block above already degrades the
     * same way on the same file.
     */
    projectSecrets: await listProjectSecrets().catch(() => []),

    /**
     * Whether this control plane will accept a key typed into the browser, and if not,
     * the sentence to show instead — which names the CLI, because that path always works.
     *
     * The UI asks rather than deciding for itself. It already has `controlPlane.bind` and
     * could apply the rule client-side, and then there would be two implementations of a
     * security condition, one of them in a bundle that anybody can edit. The server is the
     * one that refuses; this field only decides whether a form is worth rendering.
     *
     * `names` is `SECRET_NAMES`, so the form offers exactly the set the server accepts. A
     * hard-coded `['linear']` in the page would drift from the store the day a second name
     * lands, in the direction that stores a key nothing reads.
     */
    projectSecretWrites: (() => {
      const transport = secretWriteTransport()
      return {
        allowed: transport.allowed,
        reason: transport.allowed ? null : transport.reason,
        names: [...SECRET_NAMES],
      }
    })(),

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

// ── a project's API key, from the browser ──────────────────────────────────

/**
 * `PUT /api/system/secrets/:project/:name` — store a project's API key (ADR-0012).
 *
 * Everything that makes this safe is a refusal, so they are listed in the order they run
 * and each one says what it is protecting:
 *
 *  1. **The admin token**, already applied. `scopeForPath` puts every `/api/system` route
 *     in the admin scope, so a runner credential cannot reach this and an unauthenticated
 *     caller on a wider bind never arrives.
 *  2. **The transport.** `secretWriteTransport` — loopback, or an operator who has
 *     declared a TLS terminator in front. Refused *before the body is read*, so a key sent
 *     to a control plane that will not take it is never parsed, never normalised and never
 *     held in a variable here at all.
 *  3. **The name**, against `SECRET_NAMES`. A name Ogun does not read stores a key that
 *     reports as set and authenticates nothing, which is the failure that closed set
 *     exists for — the symptom arrives hours later as an unauthenticated poller.
 *  4. **The project**, against the database. The CLI cannot do this and does not try: it
 *     writes the file with no control plane running and no database up. This route has a
 *     handle, and the same argument as the name applies — a secret under a slug nothing
 *     polls is a secret nothing reads.
 *  5. **The value**, through `normalizeSecretInput`, which is the CLI's validator and not
 *     a second one. One writer, one set of rules: a trailing newline from a paste becomes
 *     `ERR_INVALID_CHAR` inside undici at poll time, hours away from anything that names
 *     the key.
 *
 * ### Nothing in here quotes the value, including the failures
 *
 * The body is parsed by hand rather than with `c.req.json()`, and that is not style. V8
 * builds `JSON.parse`'s message from a window of the source it choked on — a real one,
 * measured on this Node: `Unexpected token 'l', ..."{"value": lin_api_SU"... is not valid
 * JSON`. `c.req.json()` throws that verbatim, `app.onError` returns `err.message` to the
 * caller *and* `console.error`s it, and that console line is the journal. So a mis-typed
 * body would put ten characters of a live key into the one log Ogun does write. That is
 * the same leak `parseLocalConfig` was hardened against for `~/.ogun/config.json`, and
 * the third of its kind in this repository.
 *
 * There is no zod schema here for a related reason. `zod@4` does not put the received
 * value in an issue for any code this would produce — that was checked, not assumed — but
 * `zod@3` did exactly that for `invalid_enum_value` ("received 'linaer'"), and the
 * distance between a validator that echoes its input and a leak is one dependency bump.
 * The value is never handed to a schema.
 *
 * The *rejected* name is not echoed either, which is where the CLI does echo it. A name is
 * a path segment, so `hono/logger` has already written it to the journal — and if somebody
 * curls this with the arguments swapped, that segment is the key. Repeating it into a
 * response and an error string spreads a mistake that has already happened rather than
 * containing it. The success response does name the secret, and may: by then `isSecretName`
 * has proved it is one of a closed set of literals compiled into this binary.
 *
 * The value is sealed the moment it is valid, so the only unsealed form is the argument to
 * `normalizeSecretInput`. After that line everything in this handler holds a `Secret`,
 * which survives a spread, a `console.log` and a thrown cause chain as `[redacted]`, and
 * `expose()` appears once, at the write.
 */
systemRoutes.put('/secrets/:project/:name', async (c) => {
  const transport = secretWriteTransport()
  if (!transport.allowed) return c.json({ error: transport.reason }, 403)

  const project = c.req.param('project')
  const name = c.req.param('name')
  if (!isSecretName(name)) {
    return c.json(
      {
        error:
          `that is not a secret Ogun reads. Known: ${SECRET_NAMES.join(', ')}. Nothing ` +
          'was stored — a secret nothing reads looks exactly like one that works, right ' +
          'up until the night it mattered.',
      },
      400,
    )
  }

  const known = await c.var.ctx.db.query.projects.findFirst({
    where: eq(projects.slug, project),
    columns: { id: true },
  })
  if (!known) {
    return c.json(
      {
        error:
          'no project with that slug. Nothing was stored — a key filed under a slug ' +
          'nothing polls is a key that reports as set and is read by nothing.',
      },
      404,
    )
  }

  const raw = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // The parser's own message is discarded rather than forwarded: it quotes the source,
    // and the source is the key. The location it also carries is no use to a program that
    // built this body, so unlike `parseLocalConfig` there is nothing worth keeping.
    return c.json({ error: 'the request body was not valid JSON. Nothing was stored.' }, 400)
  }
  const value = (body as { value?: unknown } | null)?.value
  if (typeof value !== 'string') {
    return c.json({ error: 'expected a JSON body of {"value": "<the key>"}.' }, 400)
  }

  let secret: Secret
  let characters: number
  try {
    const normalized = normalizeSecretInput(value)
    characters = normalized.length
    secret = sealSecret(normalized)
  } catch (err) {
    if (!(err instanceof InvalidSecret)) throw err
    // Safe to forward: `normalizeSecretInput` states the rule that was broken and never
    // the input that broke it — not even the offending character, because the whole input
    // is the secret and naming a byte at an offset has narrowed it.
    return c.json({ error: err.message }, 400)
  }

  // Through the same function the CLI calls, which writes through `updateLocalConfig`'s
  // lock. A second writer here would re-open the lost-update this repo already paid for:
  // read-modify-write races between `ogun project add`, a runner joining, and this.
  await setProjectSecret(project, name, secret.expose())

  /**
   * The confirmation says the length and nothing else — the same answer `ogun project
   * secret set` gives, for the same reason. Not the last four characters: a suffix is the
   * standard reassurance and it is a disclosure. The length catches the two mistakes a set
   * can make, a truncated paste and a value that picked something up, and narrows a random
   * key by nothing. It is also strictly less than what this route has already accepted:
   * the transport that carried the value can carry its length.
   */
  return c.json({ stored: { project, name }, characters })
})

/**
 * `DELETE /api/system/secrets/:project/:name` — forget one.
 *
 * **No transport check.** The guard on the write is about what a request *carries*, and
 * this one carries nothing: the value goes only towards the file, never back out, and a
 * removal on a plain-HTTP LAN discloses nothing that `GET /api/system` did not already
 * say. It is behind the admin token like everything else here, which is the check that
 * matches the actual risk — a destructive action, not a leaking one.
 *
 * **Any name, not just `SECRET_NAMES`.** `listProjectSecrets` returns whatever the store
 * holds, and §4.5 says that file gets hand-edited — so a `linaer` typed into config.json
 * by hand appears in the table on the Settings page. A row you can see has to be a row you
 * can remove; refusing here would leave a live credential in the file with the UI showing
 * it and offering no way out, which is the opposite of what a closed set is for. The
 * closed set guards *writes*, where an unknown name creates a key nothing reads.
 */
systemRoutes.delete('/secrets/:project/:name', async (c) => {
  const project = c.req.param('project')
  const name = c.req.param('name')
  // "removed" and "there was nothing here" are different answers, all the way out to the
  // browser. Collapsing them is how you learn it worked after removing it from the wrong
  // project.
  //
  // The answer is the boolean and not the row: unlike the write above, `name` here has not
  // been proved to be one of a closed set, and no route in this file echoes an unvalidated
  // path segment back. The caller knows which row it clicked.
  const removed = await clearProjectSecret(project, name)
  return c.json({ removed })
})
