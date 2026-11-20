import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  authorizationUrl,
  connectWithAppToken,
  disconnectProject,
  exchangeCode,
  finishConnection,
  InvalidSecret,
  LinearOAuthError,
  LINEAR_ACTOR,
  LINEAR_SCOPES,
  linkedApplication,
  applicationIdentifier,
  listApplications,
  listGrants,
  normalizeSecretInput,
  sealSecret,
  type LinearConnection,
  type Secret,
} from '@ogun/core'
import { schema } from '@ogun/core/db'
import type { Env } from '../context.ts'
import { secretWriteTransport } from '../auth.ts'

const { projects } = schema

/**
 * Connecting a project to Linear as an application (ADR-0014, amended).
 *
 * Five surfaces, and each one exists because of a specific way this goes wrong:
 *
 *  - `POST /api/oauth/linear/connect/:project` — **the default.** Register the client id
 *    and secret and immediately exchange them for an app-actor token, in one request,
 *    because `client_credentials` needs no browser and therefore no second step. Everything
 *    below this line exists for the other grant.
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
 * ### Why the default path is four fewer surfaces
 *
 * The `state` nonce, the redirect-URI matching, the callback exemption from the admin
 * token and the authorization-code-in-a-query-string problem are, between them, most of
 * this file — and every one of them is a defence the browser step makes necessary. A grant
 * that needs no browser needs none of them. They stay because private teams and
 * user-scoped access still need the consent flow (ADR-0014's amendment), not because the
 * ordinary connect touches them.
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
 *
 * ### It now carries the client id and secret, and that is what lets nothing be written
 *   before the authorization is proved
 *
 * This flow used to register the application **first**, because the browser round trip had
 * to find one in the store when it came back. The connect path no longer works that way —
 * see `connectWithAppToken` for why nothing unproven reaches the store — and the consent
 * flow has to match it, or an abandoned browser tab would leave behind the one thing the
 * reordering exists to prevent: a client secret on disk that no poll will ever spend,
 * named after a workspace nobody confirmed.
 *
 * So the credentials travel in the entry. **Every reason the comment above gives for this
 * map being in memory rather than in config.json is the reason it is the right place for
 * them**, and none of it is weakened by what is now inside:
 *
 *  - *"The flow begins and ends in one process within seconds"* — so the credentials are
 *    held for seconds, bounded by the same ten minutes, and a restart mid-flow loses them
 *    along with the nonce. The operator is told to start again, which is correct and rare,
 *    and nothing partial is left on the disk.
 *  - *"Persisting it would put a short-lived nonce into a 0600 credential file and add a
 *    second writer to it for no benefit"* — the client secret is not short-lived, but the
 *    *registration* of it is: it belongs in that file only once there is a grant to put
 *    beside it. Writing it earlier is exactly the second writer and exactly the no-benefit.
 *  - Single-use still holds and matters more: `consumeState` deletes before it returns, so
 *    the secret is in the map for one callback and gone, rather than readable by a second
 *    attempt.
 *
 * What it does cost is stated plainly: a client secret is in this process's heap for up to
 * ten minutes. It already was — it arrives in a request body and goes out in a token
 * request — and the alternative is not "no copy" but "a copy on the disk, forever, whether
 * or not the flow finished".
 */
type PendingAuthorization = {
  project: string
  redirectUri: string
  clientId: string
  clientSecret: string
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

// ── connecting, the way that needs no browser ──────────────────────────────

/**
 * The one sentence for a slug the control plane does not know, used by every route here
 * that writes. One string because the refusal is one fact, and three near-identical
 * paraphrases of it is how a reader learns that the differences must mean something.
 */
const UNKNOWN_PROJECT =
  'no project with that slug. Nothing was stored — a credential filed under a slug ' +
  'nothing polls is one that reports as configured and is read by nothing.'

/**
 * `POST /api/oauth/linear/connect/:project` — register the application and take a token,
 * in one request.
 *
 * The default mechanism, and the reason it can be one request is that `client_credentials`
 * has nothing in it for a human to do. There is no consent screen to visit, so there is no
 * second step for the operator to be sent away and come back from — which was the whole
 * reason `app` and `connect` were ever two commands.
 *
 * ### The client secret may be omitted, and that is the interesting case
 *
 * A body of `{}` reuses the client id and secret of the application **this project's grant
 * already came from**. That covers reconnecting a project whose 30-day token lapsed with
 * nothing to renew it from, and the Settings card's reconnect button — both of which would
 * otherwise send a person back to Linear's settings page for a value this machine already
 * holds, and a value re-pasted is a value re-typed, which is how a trailing space gets into
 * a credential.
 *
 * It no longer covers *retrying after a failed first connect*, and that is the cost of the
 * reordering `connectWithAppToken` documents: a connect that never got a token stored
 * nothing, so there is nothing here to reuse. The 409 names `--link` instead, which is the
 * answer when the credentials are on this machine under another project.
 *
 * ### The transport gate, and when it does not apply
 *
 * Gated by `secretWriteTransport` **only when the request carries a client secret**, which
 * is ADR-0012's rule rather than a new one: the gate follows the value, not the endpoint.
 * A reconnect that sends `{}` puts nothing on the wire that a leaked request would give an
 * attacker, so refusing it would deny a remote operator the one action that repairs a
 * lapsed connection, over a hazard that request does not have.
 */
oauthRoutes.post('/linear/connect/:project', async (c) => {
  const project = c.req.param('project')
  const known = await c.var.ctx.db.query.projects.findFirst({
    where: eq(projects.slug, project),
    columns: { id: true },
  })
  if (!known) return c.json({ error: UNKNOWN_PROJECT }, 404)

  const raw = await c.req.text()
  let body: unknown
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    // The parser quotes a window of its source, and the source is a client secret.
    return c.json({ error: 'the request body was not valid JSON. Nothing was stored.' }, 400)
  }
  const fields = (body ?? {}) as { clientId?: unknown; clientSecret?: unknown }
  const supplied = fields.clientId !== undefined || fields.clientSecret !== undefined

  let credentials: { clientId: string; clientSecret: string; redirectUri: string }
  if (supplied) {
    if (typeof fields.clientId !== 'string' || typeof fields.clientSecret !== 'string') {
      return c.json(
        {
          error:
            'expected a JSON body of {"clientId": "…", "clientSecret": "…"}, or {} to ' +
            'reuse the one already stored.',
        },
        400,
      )
    }
    const transport = secretWriteTransport()
    if (!transport.allowed) return c.json({ error: transport.reason }, 403)
    try {
      // The same validator the CLI uses, so a trailing newline off a paste is caught here
      // rather than as an `ERR_INVALID_CHAR` inside undici, hours from anything that names
      // the application.
      const clientSecret: Secret = sealSecret(normalizeSecretInput(fields.clientSecret))
      credentials = {
        clientId: normalizeSecretInput(fields.clientId),
        clientSecret: clientSecret.expose(),
        redirectUri: callbackUri(c.req.url),
      }
    } catch (err) {
      if (!(err instanceof InvalidSecret)) throw err
      // Safe to forward: it names the rule that was broken, never the input that broke it.
      return c.json({ error: err.message }, 400)
    }
  } else {
    const stored = await linkedApplication(project, 'linear')
    if (!stored) {
      return c.json(
        {
          error:
            'this project holds no linear grant on this machine, so there is no ' +
            'application to reuse. An application is shared between projects now, so ' +
            'either send a client id and secret, or point this project at one this ' +
            'machine already holds — `ogun connect linear --app --link <name>`.',
        },
        409,
      )
    }
    credentials = stored
  }

  let connection: LinearConnection
  try {
    connection = await connectWithAppToken(project, 'linear', credentials)
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    /**
     * `err.message` has already been through `scrubSecrets` where it was built, so it
     * cannot carry the client secret even if Linear echoed one back. It is forwarded whole
     * because it is a sentence meant for a person — and unlike the callback, this response
     * is read by the caller that made the request rather than by a browser that would put
     * it in an address bar.
     */
    remember(project, err.kind, err.message)
    return c.json({ error: err.message, reason: err.kind }, 400)
  }
  lastFailure.delete(project)
  return c.json({ connected: connection })
})

// ── offering the application, for the flow that has a browser in it ────────

/**
 * Credentials a surface has handed over for a consent flow it is about to start, by
 * project.
 *
 * ### Why this exists at all, which is a question worth answering before reading it
 *
 * The consent flow is two authenticated requests and then a browser: `PUT …/app/:project`
 * takes the client id and secret and answers with the exact callback URL to paste into
 * Linear's form, and `POST …/start/:project` mints the `state` and hands back an
 * authorization URL. The credentials arrive at the first and are needed at the second.
 *
 * They used to be *written to config.json* by the first, which is how the second found
 * them — and that is precisely what the reordering removed: an abandoned flow left a
 * client secret on the disk that no poll would ever spend. `PendingAuthorization` is where
 * they belong once a flow has actually started, and it cannot hold them before `state`
 * exists, because an entry keyed by a nonce that has not been minted is not an entry.
 *
 * So this is the gap between the two requests and nothing more. It is deliberately **not**
 * `PendingAuthorization` with a looser key:
 *
 *  - Keyed by **project**, so a second attempt replaces the first rather than accumulating.
 *    A nonce-keyed map must not do that — two tabs mid-flow are two valid authorizations —
 *    and an offer is a draft, where the newest is the only one anybody means.
 *  - **Not single-use.** `/start` may legitimately be called twice for one offer (a
 *    refreshed Settings page), and failing the second with "start again" would send the
 *    operator back to Linear for a secret they just typed.
 *  - Swept on the same ten minutes, by the same clock, because the hazard is identical: a
 *    client secret in a long-lived process's heap for an abandoned flow.
 *
 * The CLI does not use it. `ogun connect linear --consent` sends the credentials to
 * `/start` directly, which is one request and no window at all; this exists for the web
 * UI's two-step card.
 */
type OfferedApplication = {
  clientId: string
  clientSecret: string
  redirectUri: string
  createdAt: number
}

const offered = new Map<string, OfferedApplication>()

const sweepOffers = (now: number): void => {
  for (const [project, offer] of offered) {
    if (now - offer.createdAt > STATE_TTL_MS) offered.delete(project)
  }
}

/** Only for tests, which must not inherit a previous test's half-finished offer. */
export const clearOfferedApplications = (): void => offered.clear()

/**
 * `PUT /api/oauth/linear/app/:project` — the client id and secret from Linear's form.
 *
 * **It no longer writes anything.** It validates the pair, works out the callback URL the
 * operator has to paste into Linear, and holds the credentials for the `start` that
 * follows. The name is now a slight lie — nothing is registered until a token comes back —
 * and it is kept rather than renamed because the web UI calls it by this path; the
 * registration happens in `completeAuthorization`, through the same `finishConnection`
 * every other connect goes through.
 *
 * Gated by `secretWriteTransport`, exactly like `PUT /api/system/secrets/:project/:name`
 * and through the same function, because it carries the same kind of value: a credential
 * belonging to a third party's workspace, typed by a person, crossing a network in
 * cleartext unless the operator has TLS in front. One rule, one implementation, one
 * refusal sentence that names the CLI. That gate is unchanged by this route no longer
 * writing — it is about what the request *carries*, not about what is done with it.
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
  if (!known) return c.json({ error: UNKNOWN_PROJECT }, 404)

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

  const now = Date.now()
  sweepOffers(now)
  const redirectUri = callbackUri(c.req.url)
  offered.set(project, {
    clientId,
    // Held as a string rather than as the `Secret`, because the only thing that happens to
    // it next is a token request's form body. A sealed value in a map would have to be
    // `expose()`d at the consume site, which is a second place reaching for it.
    clientSecret: clientSecret.expose(),
    redirectUri,
    createdAt: now,
  })

  /**
   * The redirect URI comes back in the response because it is the thing the operator has
   * to paste into Linear, and a value they retype from memory is a value that differs by a
   * trailing slash.
   *
   * `grantKept` says whether an existing connection will survive this — it does when only
   * the secret was rotated, and does not when the client id changed, because the tokens an
   * application issued are dead the moment the project points at a different application.
   * It is answered from the project's current grant rather than from a write that has not
   * happened yet, and it is still worth answering here: "connected" quietly becoming "not
   * connected" is the kind of state change only a poll failing at 3am notices.
   */
  const current = await linkedApplication(project, 'linear')
  return c.json({
    project,
    clientId,
    redirectUri,
    grantKept: current !== undefined && current.clientId === clientId,
    scopes: [...LINEAR_SCOPES],
    actor: LINEAR_ACTOR,
  })
})

// ── starting the flow ──────────────────────────────────────────────────────

/**
 * `POST /api/oauth/linear/start/:project` — mint a `state` and hand back an authorization
 * URL.
 *
 * ### Where the credentials come from, in order
 *
 *  1. **This request's body**, `{clientId, clientSecret}`. That is what the CLI sends, and
 *     it collapses the flow to one request with no window in which a secret is held
 *     anywhere but a `PendingAuthorization`. Gated by `secretWriteTransport` when it is
 *     present, because the gate follows the value and not the endpoint — the same rule
 *     `PUT …/app/:project` is held to.
 *  2. **An offer** left by `PUT …/app/:project`, which is the web UI's two-step card.
 *  3. **The application this project's grant already came from**, for a re-consent that
 *     should not send anybody back to Linear's settings page for a value this machine is
 *     holding.
 *
 * Nothing has been written to the store at this point by any of the three, and that is the
 * change: this route used to require an application to exist first. See
 * `PendingAuthorization` for why the credentials ride in the entry instead.
 */
oauthRoutes.post('/linear/start/:project', async (c) => {
  const project = c.req.param('project')
  const current = callbackUri(c.req.url)

  const raw = await c.req.text()
  let body: unknown
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    // The parser quotes a window of its source, and the source is a client secret.
    return c.json({ error: 'the request body was not valid JSON. Nothing was stored.' }, 400)
  }
  const fields = (body ?? {}) as { clientId?: unknown; clientSecret?: unknown }
  const supplied = fields.clientId !== undefined || fields.clientSecret !== undefined

  let credentials: { clientId: string; clientSecret: string; redirectUri: string }
  if (supplied) {
    if (typeof fields.clientId !== 'string' || typeof fields.clientSecret !== 'string') {
      return c.json(
        {
          error:
            'expected a JSON body of {"clientId": "…", "clientSecret": "…"}, or {} to use ' +
            'the credentials already offered for this project.',
        },
        400,
      )
    }
    const transport = secretWriteTransport()
    if (!transport.allowed) return c.json({ error: transport.reason }, 403)
    try {
      // The same validator every other door uses, so a trailing newline off a paste is
      // caught here rather than as an `ERR_INVALID_CHAR` inside undici at exchange time.
      credentials = {
        clientId: normalizeSecretInput(fields.clientId),
        clientSecret: normalizeSecretInput(fields.clientSecret),
        redirectUri: current,
      }
    } catch (err) {
      if (!(err instanceof InvalidSecret)) throw err
      // Safe to forward: it names the rule that was broken, never the input that broke it.
      return c.json({ error: err.message }, 400)
    }
  } else {
    sweepOffers(Date.now())
    const offer = offered.get(project)
    if (offer) {
      credentials = {
        clientId: offer.clientId,
        clientSecret: offer.clientSecret,
        redirectUri: offer.redirectUri,
      }
    } else {
      const linked = await linkedApplication(project, 'linear')
      if (!linked) {
        return c.json(
          {
            error:
              'no linear credentials have been offered for this project and it holds no ' +
              'grant to reuse one from. Create an application at ' +
              'https://linear.app/settings/api/applications/new and send its client id ' +
              'and secret — nothing is stored until the authorization comes back.',
          },
          409,
        )
      }
      credentials = {
        clientId: linked.clientId,
        clientSecret: linked.clientSecret,
        /**
         * An application with no callback URL recorded was registered by the browserless
         * path, which has no browser round trip to have one — so the current address is
         * adopted here rather than refused.
         *
         * This used to refuse, on the grounds that *"adopting the current address would
         * authorize against a URI Linear was never told about and get an error that names
         * nothing"*. The hazard is real and the refusal was aimed at the wrong half of it:
         * the URI Linear has to have been told about is the one in the **authorization
         * request**, and that is this request's address either way. What the stored value
         * protects is the *exchange* echoing the same string the authorization used, and
         * that is now carried in the pending entry rather than read back out of the store.
         * So the mismatch check below is what remains, and it only has something to
         * compare when there is a recorded URI to compare against.
         */
        redirectUri: linked.redirectUri === '' ? current : linked.redirectUri,
      }
    }
  }

  /**
   * The redirect URI the authorization will use must be one this control plane can
   * actually receive a callback at, and a *recorded* one that differs from where the
   * operator is standing is the failure worth naming: somebody who registered the
   * application while reaching the control plane on `localhost` and is now on
   * `192.168.1.10` would otherwise silently authorize against a URI Linear has never been
   * told about, and Linear's refusal names nothing useful.
   */
  if (credentials.redirectUri !== current) {
    return c.json(
      {
        error:
          `this project's linear application was registered with the callback URL ` +
          `${credentials.redirectUri}, and you are reaching this control plane at ` +
          `${current}. Linear matches the redirect URI exactly, so authorizing now would ` +
          'fail with an error that does not say why. Either open the control plane at the ' +
          'registered address, or register the application again from this one.',
      },
      409,
    )
  }

  const state = beginAuthorization({
    project,
    redirectUri: credentials.redirectUri,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  })
  return c.json({
    authorizeUrl: authorizationUrl({
      clientId: credentials.clientId,
      redirectUri: credentials.redirectUri,
      state,
    }),
    redirectUri: credentials.redirectUri,
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

  const outcome = await completeAuthorization({ ...entry, code })
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
 * The URL goes in a **body**, never in argv. That is the same rule `ogun secret set`
 * refuses a positional value for: `/proc/<pid>/cmdline` is world-readable while the
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

  const outcome = await completeAuthorization({ ...entry, code })
  if (!outcome.ok) return c.json({ error: outcome.detail, reason: outcome.reason }, 400)
  return c.json({ connected: outcome.summary })
})

// ── status and disconnect ──────────────────────────────────────────────────

/**
 * What every surface reads: which projects are connected to Linear and how healthy each
 * connection is. Never a token — neither `GrantPresence` nor `ApplicationListing` has a
 * field one fits in.
 *
 * ### The `apps` array keeps ADR-0014's field names, deliberately, for now
 *
 * The store underneath it is two maps rather than one, so this row is now **composed**: a
 * project and an expiry come from the grant, a client id and a callback URL from the
 * application it names. The shape going out is unchanged because the web UI declares its
 * own copy of it (`apps/web/src/api.ts`), and that app is being reworked in a separate
 * pass — a field renamed here would be a Settings page that renders blanks with nothing
 * saying why.
 *
 * Two consequences are worth stating rather than discovering:
 *
 *  - `connected` is now **always true**. A row exists because a grant exists, and a grant
 *    is a connection by construction; "registered but never connected" is a state the
 *    write path can no longer create (see `connectWithAppToken`).
 *  - A row says nothing about **who else shares** the application, which is the fact the
 *    split exists to expose. That belongs on this response and is the one thing the next
 *    pass over the UI should add; `ogun connect list` already prints it.
 */
oauthRoutes.get('/linear', async (c) => {
  const [grants, applications] = await Promise.all([
    listGrants().catch(() => []),
    listApplications().catch(() => []),
  ])
  const byName = new Map(applications.map((a) => [a.name, a]))

  const apps = grants
    .filter((g) => g.provider === 'linear')
    .map((g) => {
      const listed = byName.get(g.app)
      const app = listed?.state === 'present' && listed.app.provider === 'linear' ? listed.app : undefined
      return {
        project: g.project,
        provider: g.provider,
        clientId: app?.clientId ?? '',
        // The one place a secret's *presence* is reported, and it is a boolean for the
        // reason `ProjectGrantPresence` gave: the honest thing to report is whether one is
        // stored, and a future editor cannot widen a boolean into a disclosure.
        clientSecretSet: app !== undefined,
        redirectUri: app?.redirectUri ?? '',
        connected: g.malformed === undefined,
        scopes: g.scopes,
        actor: g.actor,
        ...(g.grantType ? { grantType: g.grantType } : {}),
        ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
        ...(g.obtainedAt !== undefined ? { obtainedAt: g.obtainedAt } : {}),
        // `workspace` on the wire, `account` in the store: the store's field is shared with
        // GitHub, where "workspace" would be a word for something that is not one.
        ...(g.account ? { workspace: { id: g.account.id ?? '', ...g.account } } : {}),
        ...(g.malformed !== undefined
          ? { malformed: g.malformed }
          : listed?.state === 'malformed'
            ? { malformed: `its application is unreadable (${listed.reason})` }
            : {}),
      }
    })

  return c.json({
    apps,
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
 * `DELETE /api/oauth/linear/:project` — disconnect: remove every credential this project
 * has for Linear.
 *
 * ### Why the default is now "remove everything", where ADR-0014's was "keep the
 * application"
 *
 * Because under `client_credentials` **the client id and secret *are* the credential.**
 * ADR-0014 could treat an application registration as inert — a client secret alone
 * authenticated nothing without a browser, a workspace admin and a consent screen behind
 * it, so leaving one in place cost nothing and saved a reconnect. That is no longer true
 * of the default grant: the pair can be exchanged for a live token by anybody holding it,
 * including the next poll. A disconnect that left them behind would be a disconnect the
 * machine undoes by itself, which is not a disconnect.
 *
 * ADR-0012 already settled the general form of this — *"a superseded key is gone from the
 * file rather than kept, because one that is still accepted is a live credential nobody is
 * watching, and it would be in every backup of the machine"*. This is that rule reaching a
 * value that only just became a credential.
 *
 * `?keep=application` is the opt-out, and it is **refused for a `client_credentials`
 * connection** rather than honoured with a warning. Honouring it would leave a project one
 * scheduled poll away from being connected again, which is worse than a refusal that says
 * why in a sentence. It exists for the consent grant, where the client secret genuinely
 * cannot mint anything on its own and keeping it makes reconnecting one command instead of
 * a trip to Linear's settings page.
 *
 * A personal API key goes too. `ogun connect linear --api-key` is how one is stored now, so
 * this is the inverse of the same command — and a `disconnect` that removed a grant and
 * silently left a key behind would leave the project *still connected*, by the credential
 * the operator was least likely to be thinking about.
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
  const keepApplication = c.req.query('keep') === 'application'

  // The same function `ogun disconnect` calls, for the reason `connect` shares one: a
  // credential removed from the UI and a credential removed from a terminal must leave the
  // store in the same state, and the way to guarantee that is for there to be one removal.
  const outcome = await disconnectProject(project, 'linear', { keepApplication })
  if (!outcome.ok) return c.json({ error: outcome.detail, reason: outcome.reason }, 409)
  lastFailure.delete(project)

  // "removed" and "there was nothing here" are different answers all the way out to the
  // browser, and `revoked` is a third fact: the local credential is gone either way, and
  // whether Linear was told is something the operator may want to follow up on.
  return c.json(outcome)
})

// ── the shared completion ──────────────────────────────────────────────────

type Completion =
  | { ok: true; summary: LinearConnection }
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
 *
 * Everything after the exchange is `finishConnection` in core — identity, teams, the
 * write, and retiring a personal key the connection now supersedes. It is shared with the
 * default grant on purpose: a project connected through a browser and a project connected
 * without one must be the same row in the store, or `connections` grows a case for each
 * and the two drift.
 */
async function completeAuthorization(input: {
  project: string
  code: string
  redirectUri: string
  clientId: string
  clientSecret: string
}): Promise<Completion> {
  let tokens
  try {
    tokens = await exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      // The one `expose()`-equivalent on this path, and it is at a wire: the value goes
      // into the form body of a token request and is held nowhere else. It never was a
      // `Secret` here — it came out of a request body and into the pending entry — which
      // is why the entry's doc comment carries the containment argument instead.
      clientSecret: input.clientSecret,
    })
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    // `err.message` has already been through `scrubSecrets` where it was built, so it
    // cannot contain the client secret or the code even if Linear echoed one back.
    return fail(input.project, err.kind, err.message)
  }

  /**
   * The application is written **here**, after the exchange, by `finishConnection` — which
   * is the same function the browserless connect uses, so a project connected through a
   * browser and a project connected without one are the same two rows in the store. The
   * credentials came out of the pending entry rather than out of config.json, which is
   * what makes "nothing is written until a token comes back" true of this path as well.
   */
  const summary = await finishConnection(
    input.project,
    'linear',
    {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      method: 'authorization_code',
    },
    tokens,
  )
  offered.delete(input.project)
  lastFailure.delete(input.project)
  return { ok: true, summary }
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

/**
 * Every application on this machine, and which projects go through each.
 *
 * Its own route rather than a field on `GET /linear`, because an application is not a
 * Linear concept: one GitHub App serves an organisation, and the sharing it makes
 * possible is the thing the Settings page was blind to. A `/linear` route that answered
 * "here are your GitHub applications too" would be a name that lies.
 *
 * **No secret, ever.** `identifiesAs` is the non-secret half of whatever identifies the
 * application to its provider — a client id for Linear, an app and installation id for
 * GitHub — on the same terms `connect list` prints them: those values are in every
 * authorization URL and on the provider's own settings page, and withholding them would
 * mean the page could not say *which* application a project is connected through, which
 * is the first question the moment two exist.
 */
oauthRoutes.get('/applications', async (c) => {
  const listed = await listApplications().catch(() => [])
  return c.json({
    applications: listed.map((entry) =>
      entry.state === 'present'
        ? {
            name: entry.name,
            provider: entry.app.provider,
            method: entry.app.method,
            identifiesAs: applicationIdentifier(entry.app),
            usedBy: entry.usedBy,
            malformed: null,
          }
        : {
            name: entry.name,
            provider: null,
            method: null,
            identifiesAs: null,
            usedBy: entry.usedBy,
            /**
             * Listed rather than dropped. An application this build cannot parse is
             * exactly the one somebody needs to see, and omitting it would answer "what
             * is connected here" with a list missing the broken thing.
             */
            malformed: entry.reason,
          },
    ),
  })
})
