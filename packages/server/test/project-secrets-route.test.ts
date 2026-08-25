import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '@ogun/core/db'
import { listProjectSecrets, readProjectSecret } from '@ogun/core'
import { startHarness } from './harness.ts'
import { secretWriteTransport, TLS_PROXY_ENV } from '../src/auth.ts'

/**
 * Setting a project's API key from the browser (ADR-0012, amended).
 *
 * The route exists because the reason it did not is narrower than it looked: this server
 * logs method, path and status and never a body, a proxy's access log is the operator's
 * configuration, and a browser's network panel shows the value to the person who just
 * typed it. What is left is a key crossing a network in cleartext — a property of the
 * bind, not of the existence of a route. So every test here is about one of two things:
 * the condition under which the route refuses, and the value never coming back out.
 */

const KEY = 'lin_api_QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'

// ── the transport condition ────────────────────────────────────────────────

/**
 * The property: what decides this is the bind, which Ogun owns, and not anything the
 * request says about itself.
 *
 * The naive implementation trusts `x-forwarded-proto: https`, which is the header a
 * TLS-terminating proxy sets — and which, on the exact deployment this guard exists for
 * (plain HTTP straight off a LAN), is set by whoever is talking to us. A guard a request
 * can switch off by claiming to be safe is decoration. There is a route test for the
 * header below; this one fixes the rule itself.
 */
test('loopback can carry a secret; a wider bind cannot', () => {
  for (const bind of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(secretWriteTransport({ OGUN_BIND: bind }).allowed, true, bind)
  }
  // The default, which is what an operator who set nothing is running.
  assert.equal(secretWriteTransport({}).allowed, true)

  for (const bind of ['0.0.0.0', '192.168.1.10', '::']) {
    const transport = secretWriteTransport({ OGUN_BIND: bind })
    assert.equal(transport.allowed, false, bind)
    // The refusal has to name the path that always works, or it is a wall with no door.
    assert.match(
      transport.allowed ? '' : transport.reason,
      /ogun connect <integration>/,
      'a refusal that does not name the CLI leaves the operator with nothing to do',
    )
  }
})

/**
 * The property: an operator can say "TLS is terminated in front of me", because Ogun
 * cannot see past its own socket and refusing forever would strand exactly the deployment
 * that needs this most — a control plane on a VPS, which ADR-0012 named as a real gap.
 *
 * Any non-blank value counts. A variable whose meaning turned on `1` versus `true` is one
 * somebody sets to `yes` and then believes they have set.
 */
test('a declared TLS terminator in front makes a wider bind acceptable', () => {
  const env = { OGUN_BIND: '0.0.0.0', [TLS_PROXY_ENV]: '1' }
  assert.equal(secretWriteTransport(env).allowed, true)
  assert.equal(secretWriteTransport({ OGUN_BIND: '0.0.0.0', [TLS_PROXY_ENV]: 'yes' }).allowed, true)
  // Blank is not a declaration: `OGUN_BEHIND_TLS_PROXY=` in a .env would otherwise
  // silently disable the check it looks like it sets.
  assert.equal(secretWriteTransport({ OGUN_BIND: '0.0.0.0', [TLS_PROXY_ENV]: '  ' }).allowed, false)
})

// ── the route ──────────────────────────────────────────────────────────────

describe('a project secret can be set over HTTP, and only when the wire can carry it', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let store = ''
  let dir = ''
  const slug = `secrets-route-${Date.now()}`

  const envBefore: Record<string, string | undefined> = {}
  const setEnv = (name: string, value: string | undefined): void => {
    if (!(name in envBefore)) envBefore[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  before(async () => {
    h = await startHarness()
    await h.db.insert(schema.projects).values({ slug })
    dir = await mkdtemp(join(tmpdir(), 'ogun-secret-route-'))
    store = join(dir, 'config.json')
    /**
     * A store that already holds something. Every write here has to preserve it, which is
     * the difference between going through `updateLocalConfig` and having a second writer:
     * a read-modify-write that raced or a fresh file written over the top both look like a
     * success and take the admin token with them.
     */
    await writeFile(
      store,
      JSON.stringify({ projects: { [slug]: '/srv/x' }, server: { token: 'ogun_keep_me' } }),
    )
    setEnv('OGUN_CONFIG', store)
    setEnv('OGUN_BIND', '127.0.0.1')
    setEnv(TLS_PROXY_ENV, undefined)
  })

  after(async () => {
    await h.stop()
    await rm(dir, { recursive: true, force: true })
    for (const [name, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const put = (project: string, name: string, body: string, init?: RequestInit) =>
    h.fetch(`/api/system/secrets/${project}/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      ...init,
    })

  const setSecret = (project: string, name: string, value: string) =>
    put(project, name, JSON.stringify({ value }))

  /**
   * The property: the route writes through the same function the CLI calls, so the rest of
   * `~/.ogun/config.json` survives.
   *
   * The naive implementation writes its own file — or its own `writeFile` over the same
   * path — and loses whatever it did not know about. That is not a hypothetical here:
   * `updateLocalConfig` grew a lockfile precisely because concurrent read-modify-writers
   * were dropping each other's edits, and the three things that go missing are the
   * projects map, the admin token and the runner credential. A second writer in this route
   * would reintroduce it through a door the lock does not cover.
   */
  test('storing a key preserves everything else in the machine file', async () => {
    const res = await setSecret(slug, 'linear', KEY)
    assert.equal(res.status, 200)

    const secret = await readProjectSecret(slug, 'linear', store)
    assert.equal(secret.state, 'present')
    assert.equal(secret.state === 'present' ? secret.secret.expose() : '', KEY)

    const config = JSON.parse(await readFile(store, 'utf8')) as {
      projects: Record<string, string>
      server: { token?: string }
    }
    assert.equal(config.server.token, 'ogun_keep_me', 'the admin token was dropped by the write')
    assert.equal(config.projects[slug], '/srv/x', 'the projects map was dropped by the write')
  })

  /**
   * The property: nothing the browser gets back can carry the value — not the write's own
   * response, and not the listing afterwards.
   *
   * This is ADR-0012's structural rule rather than a review habit: `ProjectSecretPresence`
   * has no field a value fits in. The assertion scans the whole serialised payload rather
   * than named fields, because the failure being guarded against is somebody *adding* a
   * field, which a field-by-field check would not see.
   */
  test('neither the write nor the listing can return the value', async () => {
    const res = await setSecret(slug, 'linear', KEY)
    const body = await res.text()
    assert.ok(!body.includes(KEY), 'the write echoed the key back')
    assert.match(body, /"characters":\s*\d+/, 'the length is the only confirmation offered')

    const system = await (await h.fetch('/api/system')).text()
    assert.ok(!system.includes(KEY), 'GET /api/system carried the key')
    const parsed = JSON.parse(system) as {
      projectSecrets: Array<{ project: string; name: string; state: string }>
    }
    const row = parsed.projectSecrets.find((s) => s.project === slug && s.name === 'linear')
    assert.deepEqual(row, { project: slug, name: 'linear', state: 'present' })
  })

  /**
   * The property: a malformed body does not quote itself back.
   *
   * This is the leak, and it is measurable rather than theoretical. V8 builds
   * `JSON.parse`'s message from a window of the source it choked on — on this Node,
   * `JSON.parse('{"value": lin_api_QQ…}')` answers `Unexpected token 'l', ..."{"value":
   * lin_api_QQ"... is not valid JSON`. The naive route calls `c.req.json()`, lets that
   * SyntaxError reach `app.onError`, and `onError` both returns `err.message` to the
   * caller and `console.error`s it — which is the journal. Ten characters of a live key,
   * in a log, from a typo. It is the same failure `parseLocalConfig` was hardened against
   * for this exact file, and the third of its kind in this repository.
   */
  test('a body that is not valid JSON is refused without quoting it', async () => {
    const res = await put(slug, 'linear', `{"value": ${KEY}}`)
    assert.equal(res.status, 400)
    const body = await res.text()
    assert.ok(!body.includes(KEY), 'the whole key came back in the parse error')
    // The window V8 would have quoted. Checking a prefix rather than the whole value is
    // the point: the leak is partial, and a check for the full string would pass.
    assert.ok(!body.includes(KEY.slice(0, 10)), 'a window of the key came back in the parse error')
  })

  /**
   * The property: a rejected value is never in the rejection.
   *
   * `normalizeSecretInput` is the CLI's validator, reused rather than reimplemented, and
   * it refuses without naming what it saw — not even the offending character and its
   * offset, which is the tempting thing to include, because the whole input is the secret
   * and naming a byte at a position has narrowed it. A zod schema here would be the other
   * naive answer: `zod@4` happens not to echo the input for any code this would produce,
   * but `zod@3` did exactly that for `invalid_enum_value`, and the distance between a
   * validator that echoes and a leak is one dependency bump.
   */
  test('a value with a control character in it is refused, and not quoted', async () => {
    const pasted = `${KEY}\nsecond line`
    const res = await setSecret(slug, 'linear', pasted)
    assert.equal(res.status, 400)
    const body = await res.text()
    assert.ok(!body.includes(KEY), 'the refusal quoted the value')
    assert.match(body, /control character/)

    // And an empty one, which is not a way to remove a secret: the state it would create
    // reads as a key that exists and does not work.
    const empty = await setSecret(slug, 'linear', '   ')
    assert.equal(empty.status, 400)
  })

  /**
   * The property: whitespace is stripped before the value is stored, by the same rule the
   * CLI applies.
   *
   * A key pasted into a browser field picks up a trailing space as easily as one piped
   * from `key.txt` picks up a newline, and the consequence is the one that is hardest to
   * diagnose: a leading space is accepted by `fetch` and rejected by the provider, so a
   * correct key reads as a wrong one, hours later, in a poller's log.
   */
  test('a pasted value is trimmed, not stored as typed', async () => {
    assert.equal((await setSecret(slug, 'linear', `  ${KEY}  `)).status, 200)
    const secret = await readProjectSecret(slug, 'linear', store)
    assert.equal(secret.state === 'present' ? secret.secret.expose() : '', KEY)
  })

  /**
   * The property: a name Ogun does not read is refused rather than stored.
   *
   * `SECRET_NAMES` is closed for a reason with a shape: a key that nothing reads is
   * indistinguishable from a key that works, right up until the night it mattered. A store
   * that accepts `linaer` reports it as set on this very page and leaves the poller
   * unauthenticated, with nothing anywhere connecting the two.
   */
  test('an unknown secret name is refused, and nothing is stored under it', async () => {
    const res = await setSecret(slug, 'linaer', KEY)
    assert.equal(res.status, 400)
    const body = await res.text()
    assert.match(body, /Known: linear/)
    // Not echoed. The name is a path segment, so `hono/logger` has already written it to
    // the journal — and a caller who swapped the arguments has just put the key there.
    // Repeating it into the response would spread that rather than contain it.
    assert.ok(!body.includes('linaer'))

    const rows = await listProjectSecrets(store)
    assert.ok(!rows.some((r) => r.name === 'linaer'), 'an unreadable name was stored anyway')
  })

  /**
   * The property: the project has to be one this control plane knows.
   *
   * The same argument as the closed name set, applied to the other half of the key: a
   * secret filed under a slug nothing polls reports as set and is read by nothing. The CLI
   * cannot make this check and does not pretend to — it writes the file with no database
   * up and no control plane running — and that asymmetry is deliberate rather than an
   * oversight. This route has a handle, so it uses it.
   */
  test('a project the control plane does not know is refused', async () => {
    const res = await setSecret('no-such-project', 'linear', KEY)
    assert.equal(res.status, 404)
    const rows = await listProjectSecrets(store)
    assert.ok(!rows.some((r) => r.project === 'no-such-project'))
  })

  /**
   * The property: on a bind that cannot carry a secret, the route refuses — and the
   * request cannot talk it out of that.
   *
   * `x-forwarded-proto: https` is what a TLS-terminating proxy sets, and it is also two
   * words a client can type. On the deployment this guard is for — plain HTTP on a LAN —
   * the client is the only thing setting it, so a route that believed it would hand the
   * attacker the switch to the guard. The environment is the one input to the decision
   * that nothing on the wire can supply.
   */
  test('a wider bind refuses the write, and a forwarded-proto header does not change that', async () => {
    setEnv('OGUN_BIND', '0.0.0.0')
    const res = await setSecret(slug, 'linear', 'lin_api_NEVER_STORED_XXXXXXXXXXXXXXXX')
    assert.equal(res.status, 403)
    assert.match(await res.text(), /cleartext[\s\S]*ogun connect <integration>/)

    const forged = await put(slug, 'linear', JSON.stringify({ value: 'lin_api_ALSO_NEVER' }), {
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    })
    assert.equal(forged.status, 403, 'a header switched off the guard')

    const secret = await readProjectSecret(slug, 'linear', store)
    assert.equal(
      secret.state === 'present' ? secret.secret.expose() : '',
      KEY,
      'a refused write reached the store anyway',
    )

    // And the page is told, so it renders the CLI command rather than a form that 403s.
    const system = (await (await h.fetch('/api/system')).json()) as {
      projectSecretWrites: { allowed: boolean; reason: string | null; names: string[] }
    }
    assert.equal(system.projectSecretWrites.allowed, false)
    assert.match(system.projectSecretWrites.reason ?? '', /ogun connect <integration>/)
    assert.deepEqual(system.projectSecretWrites.names, ['linear'])

    // Declared TLS in front, and the same request is fine.
    setEnv(TLS_PROXY_ENV, '1')
    assert.equal((await setSecret(slug, 'linear', KEY)).status, 200)

    setEnv(TLS_PROXY_ENV, undefined)
    setEnv('OGUN_BIND', '127.0.0.1')
  })

  /**
   * The property: removal is not gated on the transport, and answers whether there was
   * anything there.
   *
   * The guard on the write is about what a request *carries*; a delete carries nothing
   * towards the wire and returns nothing but a boolean, so gating it would refuse an
   * operator the one action that makes a leaked key harmless — on the exact deployment
   * where they cannot reach a shell. And "removed" and "there was nothing here" stay
   * different answers all the way out to the browser: collapsing them is how you learn it
   * worked after removing it from the wrong project.
   */
  test('a secret can be removed from any bind, and says whether there was one', async () => {
    setEnv('OGUN_BIND', '0.0.0.0')
    const res = await h.fetch(`/api/system/secrets/${slug}/linear`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { removed: boolean }).removed, true)
    assert.deepEqual(await readProjectSecret(slug, 'linear', store), { state: 'absent' })

    const again = await h.fetch(`/api/system/secrets/${slug}/linear`, { method: 'DELETE' })
    assert.equal(((await again.json()) as { removed: boolean }).removed, false)
    setEnv('OGUN_BIND', '127.0.0.1')
  })

  /**
   * The property: a name that is in the store but not in `SECRET_NAMES` can still be
   * removed.
   *
   * §4.5 says `~/.ogun/config.json` gets hand-edited, `listProjectSecrets` reports whatever
   * it finds, and the Settings page renders that — so a `linaer` typed in by hand is a row
   * an operator can see. The naive implementation validates the name on the way out as
   * well as on the way in, which leaves a live credential in the file, permanently
   * advertised by the listing, with the remove button refusing it. The closed set is there
   * to stop a write creating a key nothing reads; there is nothing to protect on a delete.
   */
  test('a name Ogun does not read can still be removed once it is in the file', async () => {
    const config = JSON.parse(await readFile(store, 'utf8')) as Record<string, unknown>
    await writeFile(
      store,
      JSON.stringify({ ...config, secrets: { [slug]: { linaer: 'lin_api_HANDEDITED' } } }),
    )
    assert.ok((await listProjectSecrets(store)).some((r) => r.name === 'linaer'))

    const res = await h.fetch(`/api/system/secrets/${slug}/linaer`, { method: 'DELETE' })
    assert.equal(((await res.json()) as { removed: boolean }).removed, true)
    assert.deepEqual(await listProjectSecrets(store), [])
  })
})
