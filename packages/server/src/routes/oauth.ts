import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  clearOAuthApp,
  clearOAuthGrant,
  InvalidSecret,
  listOAuthApps,
  normalizeSecretInput,
  readOAuthApp,
  sealSecret,
  setOAuthApp,
  storeOAuthGrant,
  type Secret,
} from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { secretWriteTransport } from '../auth.ts'
import {
  authorizationUrl,
  exchangeCode,
  identify,
  LinearOAuthError,
  LINEAR_ACTOR,
  LINEAR_SCOPES,
  revokeToken,
  type LinearIdentity,
} from '../integrations/linear-oauth.ts'

const { projects } = schema

/**
 * Connecting a project to Linear as an application (ADR-0014).
 *
 * Four surfaces, and each one exists because of a specific way this flow goes wrong:
 *
 *  - `PUT  /api/oauth/linear/app/:project` — register the client id and secret the
 *    operator created at `linear.app/settings/api/applications/new`, and answer with the
 *    **exact redirect URI** to paste back into that form. A mismatch there is the classic
 *    failure of OAuth and Linear's error for it is unhelpful, so the string is generated
 *    by the server that will receive the callback rather than typed by a person.
 *  - `POST /api/oauth/linear/start` — mint a `state` and hand back an authorization URL.
 *  - `GET  /api/oauth/linear/callback` — where Linear sends the browser back.
 *  - `POST /api/oauth/linear/exchange` — the same thing for a headless control plane,
 *    where the operator pastes the URL they landed on into the CLI.
 *
 * ### The authorization code in the callback URL
 *
 * Decided explicitly rather than by accident, because the brief for the secrets route made
 * the same call about a request body and got a different answer.
 *
 * **`hono/logger` logs the query string.** This was checked in its source rather than
 * assumed, and it contradicts the shorthand in ADR-0012's amendment ("method, path and
 * status"): the middleware computes `url.slice(url.indexOf('/', 8))`, which is everything
 * after the host — path *and* query — and writes it twice, once on the way in and once on
 * the way out. So an authorization code arriving as `?code=…` lands in Ogun's own journal,
 * which is the one log this process definitely writes.
 *
 * Three responses were available and all three are taken, because they cover different
 * halves of the exposure:
 *
 *  1. **The route is exempt from the logger** (`app.ts`), which substitutes a line naming
 *     the method, the path and the status with the query elided. Silence was rejected: a
 *     callback that arrived and failed has to leave evidence, and a missing line is
 *     indistinguishable from a callback Linear never sent.
 *  2. **It redirects immediately to a clean URL.** The code is out of the address bar, out
 *     of the browser's history, and out of any `Referer` the single-page app would send —
 *     and the operator lands on Settings, which is where the result belongs anyway.
 *  3. **No response and no error message ever contains the code.** The failure redirect
 *     carries a short reason *code* from a closed set, not a message: an upstream error
 *     string is a string somebody else formatted out of the parameters we sent them.
 *
 * What is deliberately *not* done is refusing the callback on a non-loopback bind, which
 * is what `secretWriteTransport` does for the secrets route. The asymmetry is the point.
 * That gate exists because a personal API key is a long-lived credential in a third
 * party's workspace crossing a LAN in cleartext. An authorization code is single-use,
 * expires in minutes, and cannot be redeemed without the client secret — which travels
 * only from this machine to Linear, never across the operator's network. The client
 * secret *is* gated, by the same function, on the route that accepts it.
 */
export const oauthRoutes = new Hono<Env>()

/** The path Linear redirects to. One constant, because three places have to agree. */
export const LINEAR_CALLBACK_PATH = '/api/oauth/linear/callback'

/**
 * How long an unfinished authorization stays valid.
 *
 * Ten minutes. It bounds the window in which a stolen or guessed `state` is worth
 * anything, and it is far longer than the flow takes — the operator is already in a
 * browser, clicking approve. An expired state is a clean "start again", which is what the
 * failure of a ten-minute-old tab should be.
 */
const STATE_TTL_MS = 10 * 60 * 1000

/**
 * The `state` parameter, which is the only thing standing between this flow and an
 * attacker's authorization code being planted in the operator's session.
 *
 * ### What it defends against
 *
 * Without it, `GET /api/oauth/linear/callback?code=<attacker's code>` is a URL anyone can
 * make the operator's browser visit — an image tag on any page, a link in a ticket. The
 * control plane would exchange that code, store the resulting grant, and Ogun would be
 * polling *the attacker's* Linear workspace while the operator believes it is polling
 * theirs. Nothing later in the flow can detect it: the code is valid, the exchange
 * succeeds, and the tokens work.
 *
 * ### Generated, stored, verified, expired — and single-use
 *
 * 32 random bytes from `randomBytes`, which is the same source and the same width as the
 * admin token. Stored **server-side** in this map rather than encoded into the parameter
 * itself, because the entry has to carry facts the callback cannot be told by the caller:
 * *which project* this authorization is for, and *which redirect URI* was sent — a
 * `state=<slug>:<nonce>` encoding would let a crafted callback file a grant under a
 * different project than the one the operator started from.
 *
 * In memory, not in config.json. The flow begins and ends in one process within seconds; a
 * restart mid-flow makes the callback fail with "start again", which is correct and rare.
 * Persisting it would put a short-lived nonce into a 0600 credential file and add a second
 * writer to it for no benefit.
 *
 * **Single-use**: `consumeState` deletes before it returns, so a replayed callback — the
 * back button, a duplicated tab, a code the attacker captured from a proxy log — finds
 * nothing. And **expiring**: entries older than the TTL are swept on every use, so a map
 * on a long-lived server cannot grow from abandoned flows.
 *
 * A callback whose state does not match is refused **before the token exchange**, with
 * nothing stored and the code never spent. That ordering is the whole value: an
 * unrecognised state means the code is not ours, and exchanging it first and asking
 * afterwards would already have created the grant the check exists to prevent.
 */
type PendingAuthorization = {
  project: string
  redirectUri: string
  createdAt: number
}

const pending = new Map<string, PendingAuthorization>()

export function beginAuthorization(
  entry: Omit<PendingAuthorization, 'createdAt'>,
  now = Date.now(),
): string {
  sweep(now)
  const state = randomBytes(32).toString('hex')
  pending.set(state, { ...entry, createdAt: now })
  return state
}

export function consumeState(state: string, now = Date.now()): PendingAuthorization | undefined {
  sweep(now)
  const entry = pending.get(state)
  // Deleted whether or not it is still fresh: a state that has been presented once is
  // finished, and leaving an expired entry in place would let a second attempt distinguish
  // "wrong" from "too late", which is a distinction worth nothing and a lookup worth
  // making harder.
  pending.delete(state)
  if (!entry) return undefined
  return now - entry.createdAt <= STATE_TTL_MS ? entry : undefined
}

const sweep = (now: number): void => {
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > STATE_TTL_MS) pending.delete(state)
  }
}

/** Only for tests, which must not inherit a previous test's pending flows. */
export const clearPendingAuthorizations = (): void => pending.clear()

/**
 * Why the last connect attempt failed, for the one operator who is looking at it.
 *
 * In memory, per project, cleared by a success. It exists because the alternative is what
 * this flow is notorious for: a redirect to `?linear=error`, a reason code, and no way to
 * see what Linear actually said. The redirect carries a code because a URL is a place
 * messages get copied out of; the detail stays here, where it is fetched by an
 * authenticated request from the person who just clicked connect.
 *
 * Every string in it has been through `scrubSecrets` already — that happens in
 * `linear-oauth.ts`, at the point the message is constructed, rather than here where it
 * would be one more thing to remember.
 */
type ConnectFailure = { reason: string; detail: string; at: number }
const lastFailure = new Map<string, ConnectFailure>()

/**
 * The origin to build a redirect URI from — what the operator actually types to reach
 * this control plane.
 *
 * Derived from the request rather than from `OGUN_BIND`, because the bind is `0.0.0.0` on
 * exactly the deployments where the answer matters and `0.0.0.0` is not a URL anybody can
 * open. The `Host` header is what the browser used, which is by definition a URL that
 * reaches this server.
 *
 * `OGUN_PUBLIC_URL` overrides it, for a reverse proxy that terminates TLS: the browser
 * spoke `https://ogun.example.com` to the proxy and the proxy spoke plain HTTP to us, so
 * the request we see says the wrong scheme and Linear would reject the mismatch.
 *
 * That the header is attacker-controlled is worth a sentence rather than a shrug. It is
 * used for two things: displaying a string for the operator to paste into Linear, and
 * sending `redirect_uri`. Neither is exploitable — the start route is behind the admin
 * token, and a `redirect_uri` Linear has not been told about is refused by Linear. The
 * value is also *stored* when the application is registered, so the exchange echoes the
 * same string the authorization used rather than re-deriving it from a later request.
 */
export const PUBLIC_URL_ENV = 'OGUN_PUBLIC_URL'

export function callbackUri(requestUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const declared = (env[PUBLIC_URL_ENV] ?? '').trim()
  if (declared !== '') return new URL(LINEAR_CALLBACK_PATH, declared).toString()
  return new URL(LINEAR_CALLBACK_PATH, new URL(requestUrl).origin).toString()
}

// ── registering the application ────────────────────────────────────────────

/**
 * `PUT /api/oauth/linear/app/:project` — the client id and secret from Linear's form.
 *
 * Gated by `secretWriteTransport`, exactly like `PUT /api/system/secrets/:project/:name`
 * and through the same function, because it carries the same kind of value: a credential
 * belonging to a third party's workspace, typed by a person, crossing a network in
 * cleartext unless the operator has TLS in front. One rule, one implementation, one
 * refusal sentence that names the CLI.
 *
 * The body is parsed by hand for the reason the secrets route documents at length: V8
 * builds `JSON.parse`'s message out of a window of the source it choked on, `app.onError`
 * returns and `console.error`s that message, and the source here is a client secret.
 */
oauthRoutes.put('/linear/app/:project', async (c) => {
  const transport = secretWriteTransport()
  if (!transport.allowed) return c.json({ error: transport.reason }, 403)

  const project = c.req.param('project')
  const known = await c.var.ctx.db.query.projects.findFirst({
    where: eq(projects.slug, project),
    columns: { id: true },
  })
  if (!known) {
    return c.json(
      {
        error:
          'no project with that slug. Nothing was stored — an application filed under a ' +
          'slug nothing polls is one that reports as configured and is read by nothing.',
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
    // and the source contains a client secret.
    return c.json({ error: 'the request body was not valid JSON. Nothing was stored.' }, 400)
  }
  const fields = body as { clientId?: unknown; clientSecret?: unknown } | null
  if (typeof fields?.clientId !== 'string' || typeof fields.clientSecret !== 'string') {
    return c.json(
      { error: 'expected a JSON body of {"clientId": "…", "clientSecret": "…"}.' },
      400,
    )
  }

  let clientId: string
  let clientSecret: Secret
  try {
    // The same validator the CLI and the secrets route use, so a trailing newline from a
    // paste is caught here rather than as an `ERR_INVALID_CHAR` inside undici at connect
    // time, hours away from anything that names the application.
    clientId = normalizeSecretInput(fields.clientId)
    clientSecret = sealSecret(normalizeSecretInput(fields.clientSecret))
  } catch (err) {
    if (!(err instanceof InvalidSecret)) throw err
    // Safe to forward: it names the rule that was broken and never the input that broke it.
    return c.json({ error: err.message }, 400)
  }

  const redirectUri = callbackUri(c.req.url)
  const { grantKept } = await setOAuthApp(project, 'linear', {
    clientId,
    clientSecret: clientSecret.expose(),
    redirectUri,
  })

  /**
   * The redirect URI comes back in the response because it is the thing the operator has
   * to paste into Linear, and a value they retype from memory is a value that differs by a
   * trailing slash. `grantKept` says whether an existing connection survived — it does when
   * only the secret was rotated, and does not when the application changed — because
   * "connected" quietly becoming "not connected" is the kind of state change that is only
   * noticed by a poll failing at 3am.
   */
  return c.json({
    project,
    clientId,
    redirectUri,
    grantKept,
    scopes: [...LINEAR_SCOPES],
    actor: LINEAR_ACTOR,
  })
})

// ── starting the flow ──────────────────────────────────────────────────────

oauthRoutes.post('/linear/start/:project', async (c) => {
  const project = c.req.param('project')
  const app = await readOAuthApp(project, 'linear')
  if (app.state !== 'present') {
    return c.json(
      {
        error:
          app.state === 'absent'
            ? 'no linear application is registered for this project on this machine. ' +
              'Create one at https://linear.app/settings/api/applications/new and store ' +
              'its client id and secret first.'
            : `this project's linear application could not be read (${app.state}).`,
      },
      409,
    )
  }

  /**
   * The redirect URI is taken from the **stored application**, not rebuilt from this
   * request. They are normally the same string, and the case where they differ is the case
   * that matters: an operator who registered the application while reaching the control
   * plane on `localhost` and is now on `192.168.1.10` would otherwise silently authorize
   * against a URI Linear has never been told about, and Linear's refusal names nothing
   * useful. Reported instead, with both strings, so the mismatch is a sentence rather than
   * a mystery.
   */
  const current = callbackUri(c.req.url)
  if (current !== app.app.redirectUri) {
    return c.json(
      {
        error:
          `this project's linear application was registered with the callback URL ` +
          `${app.app.redirectUri}, and you are reaching this control plane at ${current}. ` +
          'Linear matches the redirect URI exactly, so authorizing now would fail with an ' +
          'error that does not say why. Either open the control plane at the registered ' +
          'address, or register the application again from this one.',
      },
      409,
    )
  }

  const state = beginAuthorization({ project, redirectUri: app.app.redirectUri })
  return c.json({
    authorizeUrl: authorizationUrl({
      clientId: app.app.clientId,
      redirectUri: app.app.redirectUri,
      state,
    }),
    redirectUri: app.app.redirectUri,
    scopes: [...LINEAR_SCOPES],
    actor: LINEAR_ACTOR,
    expiresInMs: STATE_TTL_MS,
  })
})

// ── the callback ───────────────────────────────────────────────────────────

/**
 * `GET /api/oauth/linear/callback` — where Linear sends the browser back.
 *
 * **Not behind the admin token, and that is a decision rather than an oversight.** The
 * session cookie is `SameSite=Strict`, and a redirect from `linear.app` to this origin is
 * a cross-site navigation — so the browser does not send it. Requiring the admin token
 * here would make the flow impossible on every control plane that has one, which is every
 * control plane bound beyond localhost, which is exactly the deployment this feature is
 * for. `scopeForPath` therefore classifies this path the way it classifies `/runners/join`:
 * a route that authenticates its own request. The credential it checks is the `state`
 * nonce — server-minted, 256 bits, single-use, project-bound and expiring — which is a
 * stronger claim about *this* request than a long-lived admin token would be.
 *
 * Everything it can answer with is a redirect. There is no JSON body a person would ever
 * see: this response is rendered by a browser that arrived from Linear, and a page of JSON
 * is a dead end where a redirect to Settings is the place the answer belongs.
 */
oauthRoutes.get('/linear/callback', async (c) => {
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const denied = c.req.query('error')

  const entry = consumeState(state)
  if (!entry) {
    /**
     * The code is **not** exchanged. An unrecognised state means the code did not come
     * from an authorization this control plane started, so spending it would be doing the
     * attacker's work for them — and it is the whole reason the check runs before the
     * network call rather than after it.
     *
     * No project is named in the redirect, because without a valid state there is nothing
     * that says which project this was ever about.
     */
    return c.redirect(settingsUrl('state'), 302)
  }

  if (denied) {
    /**
     * The person said no, or could not say yes. Under `actor=app` this is a workspace-level
     * install and Linear requires an admin to approve it, so "denied" is frequently "you
     * are not an admin here" rather than a refusal — which is why the sentence the UI shows
     * for this code says both.
     */
    remember(entry.project, 'denied', 'linear reported that the authorization was not granted')
    return c.redirect(settingsUrl('denied', entry.project), 302)
  }

  if (code === '') {
    remember(entry.project, 'no-code', 'linear redirected back with neither a code nor an error')
    return c.redirect(settingsUrl('no-code', entry.project), 302)
  }

  const outcome = await completeAuthorization({ project: entry.project, code, redirectUri: entry.redirectUri })
  if (outcome.ok) return c.redirect(settingsUrl('connected', entry.project), 302)
  return c.redirect(settingsUrl(outcome.reason, entry.project), 302)
})

/**
 * `POST /api/oauth/linear/exchange` — the same completion, for a control plane with no
 * browser on it.
 *
 * A headless control plane can still run this flow: the operator opens the authorization
 * URL on their own machine and Linear redirects them to the callback, which only works if
 * their browser can reach the control plane. When it cannot — a VPS on a private network,
 * a machine behind a bastion — the browser fails on the redirect and the code is sitting in
 * the address bar. This takes the whole URL they landed on and finishes the job.
 *
 * The URL goes in a **body**, never in argv. That is the same rule `ogun project secret
 * set` refuses a positional value for: `/proc/<pid>/cmdline` is world-readable while the
 * command runs, and a shell writes its history to a file nobody audits. The code is
 * single-use and worthless without the client secret, so this is belt rather than braces —
 * but the belt costs nothing and the CLI already has the hidden-prompt machinery.
 */
oauthRoutes.post('/linear/exchange', async (c) => {
  const raw = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // The parser quotes its source, and the source is an authorization code.
    return c.json({ error: 'the request body was not valid JSON.' }, 400)
  }
  const redirectUrl = (body as { redirectUrl?: unknown } | null)?.redirectUrl
  if (typeof redirectUrl !== 'string') {
    return c.json({ error: 'expected a JSON body of {"redirectUrl": "<the URL you landed on>"}.' }, 400)
  }

  let parsed: URL
  try {
    parsed = new URL(redirectUrl)
  } catch {
    return c.json({ error: 'that is not a URL. Paste the whole address you were sent to.' }, 400)
  }

  const entry = consumeState(parsed.searchParams.get('state') ?? '')
  if (!entry) {
    return c.json(
      {
        error:
          'that authorization is not one this control plane started, or it has expired. ' +
          'Nothing was exchanged — start the connection again.',
      },
      400,
    )
  }
  const code = parsed.searchParams.get('code') ?? ''
  if (code === '') {
    const reported = parsed.searchParams.get('error')
    return c.json(
      {
        error: reported
          ? 'linear reported that the authorization was not granted. Under actor=app this ' +
            'is a workspace install, so it also happens when the account approving it is ' +
            'not a workspace admin.'
          : 'that URL has no authorization code in it.',
      },
      400,
    )
  }

  const outcome = await completeAuthorization({
    project: entry.project,
    code,
    redirectUri: entry.redirectUri,
  })
  if (!outcome.ok) return c.json({ error: outcome.detail, reason: outcome.reason }, 400)
  return c.json({ connected: outcome.summary })
})

// ── status and disconnect ──────────────────────────────────────────────────

/**
 * What every surface reads: which projects have an application, and what state each
 * connection is in. Never a token — `ProjectGrantPresence` has no field one fits in.
 */
oauthRoutes.get('/linear', async (c) => {
  const apps = await listOAuthApps().catch(() => [])
  return c.json({
    apps: apps.filter((a) => a.provider === 'linear'),
    /**
     * The callback URL as it would be right now, which is what the operator pastes into
     * Linear's registration form. Rendered even for a project with no application yet,
     * because it is the first thing they need and the form is on a different website.
     */
    redirectUri: callbackUri(c.req.url),
    registerUrl: 'https://linear.app/settings/api/applications/new',
    scopes: [...LINEAR_SCOPES],
    actor: LINEAR_ACTOR,
    writesAllowed: secretWriteTransport().allowed,
    failures: Object.fromEntries(lastFailure),
  })
})

/**
 * `DELETE /api/oauth/linear/:project` — disconnect, keeping the application registered.
 *
 * **No transport check**, for the reason the secrets route's delete gives: the guard on a
 * write is about what a request *carries*, and this one carries nothing towards the
 * network. Gating it would refuse a remote operator the single action that makes a leaked
 * token harmless.
 *
 * The revoke is attempted first and its failure is not fatal. A disconnect that depended on
 * Linear being reachable would leave an operator unable to remove a credential from their
 * own machine during an outage — which is precisely when they most want to.
 */
oauthRoutes.delete('/linear/:project', async (c) => {
  const project = c.req.param('project')
  const forgetApp = c.req.query('app') === 'true'

  const app = await readOAuthApp(project, 'linear')
  let revoked = false
  if (app.state === 'present' && app.app.grant) {
    revoked = (await revokeToken({ token: app.app.grant.access.expose() })).revoked
  }

  const removed = forgetApp
    ? await clearOAuthApp(project, 'linear')
    : await clearOAuthGrant(project, 'linear')
  lastFailure.delete(project)

  // "removed" and "there was nothing here" are different answers all the way out to the
  // browser, and `revoked` is a third fact: the local credential is gone either way, and
  // whether Linear was told is something the operator may want to follow up on.
  return c.json({ removed, revoked, appForgotten: forgetApp && removed })
})

// ── the shared completion ──────────────────────────────────────────────────

type Completion =
  | { ok: true; summary: { project: string; workspace?: string; scopes: string[]; actor: string } }
  | { ok: false; reason: string; detail: string }

/**
 * Code → tokens → identity → store, with every failure named by a code from a closed set.
 *
 * The reason codes exist so that the browser redirect can carry an answer without carrying
 * a message. A message in a URL is a message in a history entry, a bookmark, and whatever
 * the operator screenshots — and this particular message is built partly from what an
 * upstream server said, which is the category of string this repository has leaked
 * credentials through four times. The detail is kept server-side in `lastFailure` and
 * fetched by an authenticated request.
 */
async function completeAuthorization(input: {
  project: string
  code: string
  redirectUri: string
}): Promise<Completion> {
  const app = await readOAuthApp(input.project, 'linear')
  if (app.state !== 'present') {
    return fail(input.project, 'no-app', "this project's linear application is no longer registered")
  }

  let tokens
  try {
    tokens = await exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      clientId: app.app.clientId,
      clientSecret: app.app.clientSecret.expose(),
    })
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    // `err.message` has already been through `scrubSecrets` where it was built, so it
    // cannot contain the client secret or the code even if Linear echoed one back.
    return fail(input.project, err.kind, err.message)
  }

  /**
   * Who the token belongs to, asked once, while it is fresh.
   *
   * A failure here does **not** fail the connection. The tokens are valid — Linear just
   * issued them — and refusing to store a working grant because a cosmetic query timed out
   * would turn a display problem into a broken connect, with the added insult that the
   * authorization code is now spent and the operator has to start over.
   */
  const identity: LinearIdentity = await identify({ accessToken: tokens.accessToken }).catch(
    () => ({ actorIsApp: false }),
  )

  const now = Date.now()
  await storeOAuthGrant(input.project, 'linear', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    obtainedAt: now,
    scopes: tokens.scopes,
    /**
     * What Linear says it is, not what was asked for. `actor` is a request parameter and
     * the response does not echo it, so `viewer.app` is the only evidence that the grant
     * actually came back as an application rather than as the person who approved it — and
     * the difference is invisible until something writes under the wrong name.
     */
    actor: identity.actorIsApp ? LINEAR_ACTOR : 'user',
    ...(identity.workspace ? { workspace: identity.workspace } : {}),
    ...(identity.appUserId ? { appUserId: identity.appUserId } : {}),
  })
  lastFailure.delete(input.project)

  return {
    ok: true,
    summary: {
      project: input.project,
      ...(identity.workspace ? { workspace: identity.workspace.name } : {}),
      scopes: tokens.scopes,
      actor: identity.actorIsApp ? LINEAR_ACTOR : 'user',
    },
  }
}

function fail(project: string, reason: string, detail: string): Completion {
  remember(project, reason, detail)
  return { ok: false, reason, detail }
}

const remember = (project: string, reason: string, detail: string): void => {
  lastFailure.set(project, { reason, detail, at: Date.now() })
}

/**
 * Where the browser lands, with a reason code and never a message.
 *
 * `/settings` rather than a page of this route's own: the operator started on Settings, the
 * connection is shown on Settings, and a dedicated result page would be a screen whose only
 * content is a link back to the one they came from.
 */
const settingsUrl = (result: string, project?: string): string => {
  const params = new URLSearchParams({ linear: result })
  if (project) params.set('project', project)
  return `/settings?${params.toString()}`
}
