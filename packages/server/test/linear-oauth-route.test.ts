import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { schema } from '@ogun/core/db'
import { listOAuthApps, readOAuthApp } from '@ogun/core'
import { startHarness } from './harness.ts'
import { TLS_PROXY_ENV } from '../src/auth.ts'
import { scopeForPath } from '../src/auth.ts'
import {
  beginAuthorization,
  callbackUri,
  clearPendingAuthorizations,
  consumeState,
  LINEAR_CALLBACK_PATH,
  PUBLIC_URL_ENV,
} from '../src/routes/oauth.ts'

/**
 * Connecting a project to Linear over HTTP (ADR-0014).
 *
 * The flow itself cannot be run here: there is no Linear application registered to this
 * project and nothing has ever completed an authorization, which
 * `linear-oauth-fixtures.ts` records in full. What *can* be fixed, and is what actually
 * goes wrong, is everything around the exchange — the CSRF check and its ordering, the
 * transport gate on the client secret, and the fact that an authorization code reaches
 * neither a response body nor a redirect URL.
 */

const CLIENT_SECRET = 'lin_secret_QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'

// ── the state parameter, as a unit ─────────────────────────────────────────

/**
 * The property: **a state is single-use.**
 *
 * The naive implementation looks the state up and leaves it in the map, which makes every
 * callback replayable — the back button, a duplicated tab, or a code an attacker read out
 * of a proxy log. Deleting on read is the whole of the fix and it is one line, which is
 * exactly why it gets left out.
 */
test('a state can be consumed once', () => {
  clearPendingAuthorizations()
  const state = beginAuthorization({ project: 'ogun', redirectUri: 'http://x/cb' })
  assert.deepEqual(consumeState(state)?.project, 'ogun')
  assert.equal(consumeState(state), undefined, 'the same state was accepted twice')
})

/**
 * The property: a state expires, and an expired one is refused rather than honoured.
 *
 * Ten minutes bounds the window in which a captured state is worth anything, and it is far
 * longer than the flow takes. The second half is that entries are swept: a map on a
 * long-lived control plane would otherwise accumulate one entry for every abandoned tab,
 * forever.
 */
test('a state older than the window is refused, and abandoned ones are swept', () => {
  clearPendingAuthorizations()
  const now = Date.now()
  const stale = beginAuthorization({ project: 'ogun', redirectUri: 'http://x/cb' }, now)
  assert.equal(consumeState(stale, now + 11 * 60 * 1000), undefined)

  const swept = beginAuthorization({ project: 'ogun', redirectUri: 'http://x/cb' }, now)
  // A later, unrelated use sweeps it: the entry is gone before anybody presents it.
  beginAuthorization({ project: 'other', redirectUri: 'http://x/cb' }, now + 11 * 60 * 1000)
  assert.equal(consumeState(swept, now + 11 * 60 * 1000), undefined)
})

/**
 * The property: the state carries **which project** server-side, so a callback cannot
 * choose one.
 *
 * The tempting encoding is `state=<slug>:<nonce>`, which needs no map. It reopens the hole
 * the parameter exists to close from a different angle: a caller who obtained a valid
 * nonce for project A could present it with project B's slug and file a grant under the
 * wrong project. The project is a fact about the authorization that was started, not about
 * the request that comes back.
 */
test('the project is a property of the stored authorization, not of the callback', () => {
  clearPendingAuthorizations()
  const state = beginAuthorization({ project: 'ogun', redirectUri: 'http://x/cb' })
  const entry = consumeState(state)
  assert.equal(entry?.project, 'ogun')
  assert.equal(entry?.redirectUri, 'http://x/cb')
})

/**
 * The fact the exemption in `app.ts` rests on, fixed here rather than trusted.
 *
 * ADR-0012's amendment says `hono/logger` "writes method, path and status", and that
 * paraphrase is what made a query-carrying route look safe. The middleware actually
 * computes `url.slice(url.indexOf('/', 8))` — everything after the host, query string
 * included — and writes it twice, once incoming and once outgoing.
 *
 * This test is the control for the one below it. If a future version of hono stops logging
 * the query, this fails and the exemption becomes unnecessary rather than load-bearing;
 * if it keeps logging it, the exemption stays justified. Either way the reason is checked
 * against the dependency rather than remembered from a comment.
 */
test("hono's request logger writes the query string, not only the path", async () => {
  const lines: string[] = []
  const app = new Hono()
  app.use('*', logger((message: string) => lines.push(message)))
  app.get('/thing', (c) => c.text('ok'))

  await app.request('http://x/thing?code=a-secret-looking-value')

  assert.ok(
    lines.some((l) => l.includes('a-secret-looking-value')),
    'hono no longer logs the query — the callback exemption may no longer be needed',
  )
})

// ── the callback path's authentication ─────────────────────────────────────

/**
 * The property: the callback authenticates itself, because it cannot present the admin
 * token.
 *
 * This looks like a hole and is the opposite. `SESSION_COOKIE` is `SameSite=Strict`, and a
 * redirect from `linear.app` to this origin is a cross-site navigation — so the browser
 * does not send it. A callback behind `requireScope('admin')` would 401 on every control
 * plane that has a token, which is every control plane bound beyond localhost, which is
 * the deployment this feature exists for. The credential it checks instead is the `state`
 * nonce, and the tests above fix what that is worth.
 */
test('the callback is classified as a route that carries its own credential', () => {
  assert.equal(scopeForPath(LINEAR_CALLBACK_PATH), 'enrollment')
  // Everything else about oauth stays behind the admin token — the start route mints a
  // nonce and the app route accepts a client secret, and neither is reachable from a
  // cross-site redirect.
  assert.equal(scopeForPath('/api/oauth/linear/start/ogun'), 'admin')
  assert.equal(scopeForPath('/api/oauth/linear/app/ogun'), 'admin')
  assert.equal(scopeForPath('/api/oauth/linear/exchange'), 'admin')
})

// ── the redirect uri ───────────────────────────────────────────────────────

/**
 * The property: the redirect URI is the address the operator actually reaches this control
 * plane at, and `OGUN_PUBLIC_URL` wins over it.
 *
 * Derived from the request rather than from `OGUN_BIND`, because the bind is `0.0.0.0` on
 * exactly the deployments where this matters and `0.0.0.0` is not a URL anybody can open.
 * The override exists for a reverse proxy terminating TLS: the browser spoke `https://` to
 * the proxy and the proxy spoke plain HTTP to us, so the request we see carries the wrong
 * scheme — and Linear matches the string exactly, so being wrong here is the classic
 * failure of this whole flow.
 */
test('the redirect uri follows the address the browser used, and the declared public url wins', () => {
  assert.equal(
    callbackUri('http://192.168.1.10:7777/api/oauth/linear', {}),
    `http://192.168.1.10:7777${LINEAR_CALLBACK_PATH}`,
  )
  assert.equal(
    callbackUri('http://127.0.0.1:7777/api/oauth/linear', {
      [PUBLIC_URL_ENV]: 'https://ogun.example.com',
    }),
    `https://ogun.example.com${LINEAR_CALLBACK_PATH}`,
  )
})

// ── the routes ─────────────────────────────────────────────────────────────

describe('a project can be connected to linear, and only through a flow it started', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let store = ''
  let dir = ''
  const slug = `oauth-route-${Date.now()}`

  const envBefore: Record<string, string | undefined> = {}
  const setEnv = (name: string, value: string | undefined): void => {
    if (!(name in envBefore)) envBefore[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  before(async () => {
    h = await startHarness()
    await h.db.insert(schema.projects).values({ slug })
    dir = await mkdtemp(join(tmpdir(), 'ogun-oauth-route-'))
    store = join(dir, 'config.json')
    await writeFile(
      store,
      JSON.stringify({ projects: { [slug]: '/srv/x' }, server: { token: 'ogun_keep_me' } }),
    )
    setEnv('OGUN_CONFIG', store)
    setEnv('OGUN_BIND', '127.0.0.1')
    setEnv(TLS_PROXY_ENV, undefined)
    setEnv(PUBLIC_URL_ENV, undefined)
  })

  after(async () => {
    await h.stop()
    await rm(dir, { recursive: true, force: true })
    for (const [name, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const registerApp = (project: string, body: unknown) =>
    h.fetch(`/api/oauth/linear/app/${project}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  /**
   * The property: registering an application answers with the **exact** redirect URI to
   * paste into Linear's form.
   *
   * The single most common way this feature fails is a redirect URI that differs from the
   * registered one by a port or a trailing slash, and Linear's error for it names nothing.
   * Generating the string on the server that will receive the callback — rather than
   * documenting it and hoping — is what turns that from a mystery into a copy button.
   */
  test('registering an application answers with the callback url to register', async () => {
    const res = await registerApp(slug, { clientId: 'client-1', clientSecret: CLIENT_SECRET })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { redirectUri: string; scopes: string[]; actor: string }
    assert.equal(body.redirectUri, `${h.url}${LINEAR_CALLBACK_PATH}`)
    // `read` and nothing else, and as the app — the two facts that make this different
    // from a personal key, surfaced where the operator is deciding whether to approve it.
    assert.deepEqual(body.scopes, ['read'])
    assert.equal(body.actor, 'app')
  })

  /**
   * The property: nothing the browser gets back carries the client secret, and a malformed
   * body does not quote itself.
   *
   * The second half is the leak this repository has had three times already. V8 builds
   * `JSON.parse`'s message from a window of the source it choked on, `app.onError` returns
   * that message *and* `console.error`s it into the journal — so a mistyped body would put
   * a window of a live client secret into a log. The route parses by hand for exactly the
   * reason the secrets route does.
   */
  test('neither the response nor a parse failure quotes the client secret', async () => {
    const ok = await (await registerApp(slug, { clientId: 'client-1', clientSecret: CLIENT_SECRET })).text()
    assert.ok(!ok.includes(CLIENT_SECRET), 'the registration echoed the secret back')

    const broken = await registerApp(slug, `{"clientSecret": ${CLIENT_SECRET}}`)
    assert.equal(broken.status, 400)
    const body = await broken.text()
    assert.ok(!body.includes(CLIENT_SECRET.slice(0, 10)), 'a window of the secret came back')

    const listed = await (await h.fetch('/api/oauth/linear')).text()
    assert.ok(!listed.includes(CLIENT_SECRET), 'the listing carried the secret')
  })

  /**
   * The property: a client secret is gated on the transport exactly like an API key, by
   * the same function.
   *
   * It is the same kind of value — a credential in a third party's workspace, typed by a
   * person, crossing a network in cleartext unless the operator has TLS in front — so it
   * would be incoherent for one to be refused and the other accepted. One rule, one
   * implementation, one refusal that names a path that always works.
   */
  test('a wider bind refuses a client secret, and the refusal names the CLI', async () => {
    setEnv('OGUN_BIND', '0.0.0.0')
    const res = await registerApp(slug, { clientId: 'client-9', clientSecret: 'lin_secret_NEVER' })
    assert.equal(res.status, 403)
    assert.match(await res.text(), /cleartext/)

    const app = await readOAuthApp(slug, 'linear', store)
    assert.equal(
      app.state === 'present' ? app.app.clientId : '',
      'client-1',
      'a refused registration reached the store anyway',
    )
    setEnv('OGUN_BIND', '127.0.0.1')
  })

  /**
   * The property: the authorization code in a callback whose state does not match is
   * **never exchanged**, and nothing is stored.
   *
   * This is what the parameter is for. Without it, any page can make the operator's
   * browser visit the callback with an attacker's code — an image tag is enough — and the
   * control plane would exchange it and start polling the attacker's workspace while the
   * operator believes it is polling theirs. Nothing later in the flow can detect it: the
   * code is valid, the exchange succeeds, and the tokens work.
   *
   * The ordering is the substance. Exchanging first and checking afterwards would already
   * have created the grant, and unwinding it is not something a callback handler can do.
   * The proof here is that the store is untouched and the browser was sent to a page that
   * says to start again.
   */
  test('a callback whose state does not match is refused before the code is spent', async () => {
    const res = await h.fetch(
      `${LINEAR_CALLBACK_PATH}?code=an-attackers-code&state=not-one-we-minted`,
      { redirect: 'manual' },
    )
    assert.equal(res.status, 302)
    const location = res.headers.get('location') ?? ''
    assert.match(location, /^\/settings\?linear=state$/)
    // No project is named: without a valid state there is nothing that says which project
    // this callback was ever about.
    assert.ok(!location.includes('project='))

    const apps = await listOAuthApps(store)
    assert.equal(apps.find((a) => a.project === slug)?.connected, false)
  })

  /**
   * The property: **the authorization code never appears in what the browser is sent to
   * next**, and never in a response body.
   *
   * `hono/logger` writes the path *and the query string*, twice per request — that was read
   * out of its source rather than assumed — so the callback is exempted from it in
   * `app.ts`. This test covers the other two halves: the redirect goes to a clean URL, so
   * the code leaves the address bar, the history and any onward `Referer`; and the failure
   * carries a short reason code from a closed set rather than a message, because part of
   * such a message would have been written by an upstream server out of the parameters we
   * sent it.
   */
  test('no redirect out of the callback carries the code or an upstream message', async () => {
    const code = 'code_SHOULD_NEVER_APPEAR_ANYWHERE'
    for (const query of [
      `?code=${code}&state=wrong`,
      `?state=wrong&error=access_denied&error_description=${code}`,
    ]) {
      const res = await h.fetch(`${LINEAR_CALLBACK_PATH}${query}`, { redirect: 'manual' })
      const location = res.headers.get('location') ?? ''
      assert.ok(!location.includes(code), `the redirect carried the code: ${location}`)
      assert.ok(!(await res.text()).includes(code), 'the body carried the code')
    }
  })

  /**
   * The property: **the authorization code does not reach Ogun's own journal.**
   *
   * `hono/logger` is registered on `*` and logs `url.slice(url.indexOf('/', 8))` — the path
   * *and the query string* — once on the way in and once on the way out. That was read out
   * of the middleware's source rather than taken from ADR-0012's paraphrase of it, and it
   * is the fact that makes the callback different from every other route here: the code
   * arrives as a query parameter, so the default arrangement writes it to the one log this
   * process definitely produces.
   *
   * Silence was the other option and was rejected. A callback that arrived and failed has
   * to leave evidence — an absent line is indistinguishable from a callback Linear never
   * sent — so the substitute records the method, the path and the status, and says that
   * the query was withheld and why. A grep for the code finds the sentence explaining its
   * absence rather than nothing at all.
   */
  test('the request log records the callback without its query string', async () => {
    const code = 'code_MUST_NOT_BE_LOGGED_ANYWHERE'
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await h.fetch(`${LINEAR_CALLBACK_PATH}?code=${code}&state=wrong`, { redirect: 'manual' })
      // A control: an ordinary route still gets a full log line, so this test would notice
      // if the logger had simply been turned off.
      await h.fetch('/api/oauth/linear')
    } finally {
      console.log = original
    }

    const journal = lines.join('\n')
    assert.ok(!journal.includes(code), `the code reached the journal:\n${journal}`)
    assert.match(journal, /GET \/api\/oauth\/linear\/callback 302/)
    assert.match(journal, /query withheld/)
  })

  /**
   * The property: a `start` refuses when the address the operator is on is not the address
   * the application was registered with.
   *
   * The alternative is to authorize anyway and let Linear refuse — which it does, with a
   * message that names nothing the operator can act on. The mismatch is completely
   * ordinary: register while reaching the control plane on `localhost`, then open it from
   * another machine on the LAN. Reporting both strings is what makes it a sentence rather
   * than an afternoon.
   */
  test('starting from an address the application was not registered with is refused', async () => {
    setEnv(PUBLIC_URL_ENV, 'http://somewhere-else:9999')
    const res = await h.fetch(`/api/oauth/linear/start/${slug}`, { method: 'POST' })
    assert.equal(res.status, 409)
    const body = await res.text()
    assert.match(body, /registered with the callback URL/)
    assert.match(body, /somewhere-else:9999/)
    setEnv(PUBLIC_URL_ENV, undefined)
  })

  /**
   * The property: `start` mints a state and builds a URL the page could not have built
   * itself.
   *
   * The nonce is generated by the server and never by the browser. A CSRF nonce made in a
   * bundle that anybody can edit protects nothing — the whole value is that the far end
   * knows which authorizations it started.
   */
  test('starting an authorization returns a url carrying a server-minted state', async () => {
    const res = await h.fetch(`/api/oauth/linear/start/${slug}`, { method: 'POST' })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { authorizeUrl: string; redirectUri: string }
    const url = new URL(body.authorizeUrl)
    assert.equal(url.host, 'linear.app')
    assert.equal(url.searchParams.get('client_id'), 'client-1')
    assert.equal(url.searchParams.get('actor'), 'app')
    assert.equal(url.searchParams.get('scope'), 'read')
    assert.equal(url.searchParams.get('redirect_uri'), body.redirectUri)
    assert.match(url.searchParams.get('state') ?? '', /^[0-9a-f]{64}$/)
  })

  /**
   * The property: a project with no application cannot start a flow, and is told where
   * applications come from.
   *
   * Ogun ships no client id — it is self-hosted, so each workspace registers its own — and
   * an operator who has never done that has no way to guess. The refusal carries the URL.
   */
  test('a project with no application is told to create one, with the url', async () => {
    const res = await h.fetch('/api/oauth/linear/start/no-such-project', { method: 'POST' })
    assert.equal(res.status, 409)
    assert.match(await res.text(), /linear\.app\/settings\/api\/applications\/new/)
  })

  /**
   * The property: the exchange endpoint refuses a URL whose state it did not mint, and
   * says nothing was exchanged.
   *
   * This is the headless path — the operator pastes the URL their browser landed on — and
   * it has to apply the same check as the callback, because it is the same act. A version
   * that trusted the paste on the grounds that "the operator is authenticated" would let a
   * pasted URL from anywhere file a grant.
   */
  test('a pasted redirect url with an unknown state is refused', async () => {
    const res = await h.fetch('/api/oauth/linear/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl: 'http://x/cb?code=abc&state=never-minted' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /Nothing was exchanged/)
  })

  /**
   * The property: disconnecting is not gated on the transport, and distinguishes "removed"
   * from "there was nothing here".
   *
   * The write gate is about what a request *carries*, and a delete carries nothing towards
   * the wire. Gating it would refuse a remote operator the one action that makes a leaked
   * token harmless — on the exact deployment where they cannot reach a shell.
   */
  test('an application can be disconnected and forgotten from any bind', async () => {
    setEnv('OGUN_BIND', '0.0.0.0')
    const res = await h.fetch(`/api/oauth/linear/${slug}?app=true`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { removed: boolean }).removed, true)

    const again = await h.fetch(`/api/oauth/linear/${slug}`, { method: 'DELETE' })
    assert.equal(((await again.json()) as { removed: boolean }).removed, false)

    // And the rest of the machine file is intact — one writer, through the same lock.
    const config = JSON.parse(await readFile(store, 'utf8')) as { server: { token?: string } }
    assert.equal(config.server.token, 'ogun_keep_me')
    setEnv('OGUN_BIND', '127.0.0.1')
  })
})
