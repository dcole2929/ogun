import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { startHarness, truncate } from './harness.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertBindIsSafe,
  hashToken,
  InsecureBind,
  mintToken,
  requireScope,
  resolveAuth,
  scopeForPath,
} from '../src/auth.ts'
import type { Scope } from '../src/auth.ts'

/**
 * This API can define a worker and trigger it, so an unauthenticated instance reachable
 * from the network is remote code execution on the host — not a data-exposure problem.
 * The default has to be safe, and the unsafe combination has to be impossible to reach
 * by accident.
 */
test('the default bind is localhost, not every interface', async () => {
  assert.equal((await resolveAuth({} as NodeJS.ProcessEnv)).bind, '127.0.0.1')
})

test('localhost generates no token — nothing off this machine can reach it', async () => {
  const auth = await resolveAuth({} as NodeJS.ProcessEnv)
  assert.equal(auth.token, undefined)
  assert.equal(auth.generated, false)
})

test('localhost needs no token', () => {
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '127.0.0.1', token: undefined, generated: false }))
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '::1', token: undefined, generated: false }))
})

test('a wider bind without a token is refused at boot', () => {
  for (const bind of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertBindIsSafe({ bind, token: undefined, generated: false }), InsecureBind, bind)
  }
})

test('a wider bind with a token is allowed', () => {
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '0.0.0.0', token: 'secret', generated: false }))
})

test('an empty env token falls through to the stored one', async () => {
  // Otherwise `OGUN_TOKEN=` in a .env silently disables the check it looks like it sets.
  const auth = await resolveAuth({ OGUN_TOKEN: '   ' } as NodeJS.ProcessEnv)
  assert.equal(auth.token, undefined, 'localhost still needs none')
  assert.throws(
    () => assertBindIsSafe({ bind: '0.0.0.0', token: undefined, generated: false }),
    InsecureBind,
  )
})

test('a wider bind generates and stores a token rather than demanding one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-auth-'))
  const path = join(dir, 'local.json')
  t.after(() => rm(dir, { recursive: true, force: true }))

  const previous = process.env.OGUN_CONFIG
  process.env.OGUN_CONFIG = path
  t.after(() => {
    if (previous === undefined) delete process.env.OGUN_CONFIG
    else process.env.OGUN_CONFIG = previous
  })

  const first = await resolveAuth({ OGUN_BIND: '0.0.0.0' } as NodeJS.ProcessEnv)
  assert.equal(first.generated, true)
  assert.match(first.token ?? '', /^ogun_[0-9a-f]{64}$/)

  // Stable across restarts, or every restart would invalidate every operator's session.
  const second = await resolveAuth({ OGUN_BIND: '0.0.0.0' } as NodeJS.ProcessEnv)
  assert.equal(second.token, first.token)
  assert.equal(second.generated, false)

  const stored = JSON.parse(await readFile(path, 'utf8')) as { server: { token: string } }
  assert.equal(stored.server.token, first.token)
})

/**
 * A stub db standing in for the enrolled-runner lookup. It answers "yes, that is a
 * runner" when the test says one exists — the real query builds a `where` out of drizzle
 * table objects, which cannot be inspected here without reaching into their internals.
 * Rejection of an unknown token is covered by the case where no runner exists at all.
 */
const dbWith = (runnerToken?: string) => ({
  query: {
    runners: {
      findFirst: async () =>
        runnerToken ? { id: 'stub', tokenHash: hashToken(runnerToken) } : undefined,
    },
  },
})

const call = async (
  token: string | undefined,
  header: Record<string, string>,
  opts: { path?: string; scope?: Scope; runnerToken?: string } = {},
) => {
  let reached = false
  const res = await requireScope(token, opts.scope ?? 'admin')(
    {
      req: { path: opts.path ?? '/api/x', header: (n: string) => header[n.toLowerCase()] },
      var: { ctx: { db: dbWith(opts.runnerToken) } },
      json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    } as never,
    async () => {
      reached = true
    },
  )
  return { reached, res: res as { status?: number } | undefined }
}

test('with no token configured every request passes', async () => {
  assert.equal((await call(undefined, {})).reached, true)
})

test('with a token, a request without one is rejected', async () => {
  const { reached, res } = await call('secret', {})
  assert.equal(reached, false)
  assert.equal(res?.status, 401)
})

test('a wrong token is rejected, the right one passes', async () => {
  assert.equal((await call('secret', { authorization: 'Bearer nope' })).reached, false)
  assert.equal((await call('secret', { authorization: 'Bearer secret' })).reached, true)
  // A header-based fallback, for clients that cannot set Authorization.
  assert.equal((await call('secret', { 'x-ogun-token': 'secret' })).reached, true)
})

test('health stays open so a probe needs no secret', async () => {
  assert.equal((await call('secret', {}, { path: '/api/health' })).reached, true)
})

/**
 * The scope split is the point: a compromised runner must not be able to rewrite
 * config.yaml and hand itself a new prompt to execute.
 */
test('a runner token claims work but cannot administer', async () => {
  const runnerToken = mintToken('ogr')
  const header = { authorization: `Bearer ${runnerToken}` }

  const claiming = await call('admin-secret', header, {
    scope: 'runner',
    path: '/api/jobs/claim',
    runnerToken,
  })
  assert.equal(claiming.reached, true, 'a runner must be able to claim')

  const administering = await call('admin-secret', header, { scope: 'admin', runnerToken })
  assert.equal(administering.reached, false)
  assert.equal(administering.res?.status, 403, 'not 401 — the token is valid, just not allowed')
})

test('an admin token satisfies a runner-scoped route', async () => {
  const r = await call('admin-secret', { authorization: 'Bearer admin-secret' }, {
    scope: 'runner',
    path: '/api/jobs/claim',
  })
  assert.equal(r.reached, true)
})

test('an unknown token is rejected at either scope', async () => {
  for (const scope of ['runner', 'admin'] as const) {
    const r = await call('admin-secret', { authorization: 'Bearer nope' }, { scope })
    assert.equal(r.reached, false)
    assert.equal(r.res?.status, 401, scope)
  }
})

test('a minted token is prefixed and not guessable', () => {
  const a = mintToken('ogr')
  const b = mintToken('ogr')
  assert.match(a, /^ogr_[0-9a-f]{64}$/)
  assert.notEqual(a, b)
  // Only the hash is ever stored, so a lost token is re-issued rather than recovered.
  assert.notEqual(hashToken(a), a)
  assert.equal(hashToken(a), hashToken(a))
})

/**
 * The path→scope mapping, tested directly. Previously this was two layered middlewares,
 * and both matched /api/jobs/claim — the admin one ran after the runner one passed and
 * rejected it anyway. A stubbed unit test could not see that, because the bug was in how
 * they were registered rather than in either one.
 */
test('only the runner endpoints are runner-scoped', () => {
  for (const path of [
    '/api/jobs/claim',
    '/api/runs/abc-123/started',
    '/api/runs/abc-123/events',
    '/api/runs/abc-123/report',
    // A triage node reads its upstream's staged findings through this, holding only a
    // runner token. A 401 here does not look like a failure from inside the sandbox —
    // it looks like a night on which nobody found anything.
    '/api/jobs/abc-123/inputs',
  ]) {
    assert.equal(scopeForPath(path), 'runner', path)
  }
})

test('everything that changes what runs is admin-scoped', () => {
  for (const path of [
    '/api/workers',
    '/api/workers/abc-123',
    '/api/trigger',
    '/api/projects/sync',
    '/api/runners',
    '/api/findings',
    '/api/runs',
    '/api/runs/abc-123',
    // Not runner routes despite the prefix — a runner has no business listing jobs, or
    // reading a job it did not claim.
    '/api/jobs',
    '/api/jobs/abc-123',
  ]) {
    assert.equal(scopeForPath(path), 'admin', path)
  }
})

/**
 * The two credentials must not share an environment variable name. They did, and the
 * consequence was quiet: on a one-machine setup, exporting the admin token for the CLI
 * also handed it to the runner — which *works*, because admin satisfies runner scope,
 * and so silently undoes the entire reason runner tokens cannot define workers.
 */
test('the admin token comes from OGUN_ADMIN_TOKEN, not a shared name', async () => {
  const shared = await resolveAuth({ OGUN_TOKEN: 'ogun_shared' } as NodeJS.ProcessEnv)
  assert.equal(shared.token, undefined, 'the old ambiguous name must not be honoured')

  const explicit = await resolveAuth({
    OGUN_ADMIN_TOKEN: 'ogun_explicit',
    OGUN_BIND: '0.0.0.0',
  } as NodeJS.ProcessEnv)
  assert.equal(explicit.token, 'ogun_explicit')
  assert.equal(explicit.generated, false, 'an explicit token must not be overwritten')
})

/**
 * Two machines answering to one name would share a claim identity and a run history,
 * and neither would be attributable. `runner init` originally never contacted the
 * control plane at all, so nothing could have noticed.
 *
 * The rule is conditional, and the test says which mode it is checking rather than
 * assuming one: a control plane with no admin token is reachable only from its own
 * machine, so a collision there cannot mean "another machine" and always means "me
 * again" — re-running init, or reconnecting after the local config was lost.
 */
describe('runner names', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  before(async () => {
    h = await startHarness()
  })
  after(async () => {
    await truncate(h.db)
    await h.stop()
  })

  const register = (name: string) =>
    h.fetch('/api/runners/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, labels: ['claude'], maxConcurrency: 1 }),
    })

  /** By uuid, as every real caller does — the route stopped taking a name when runners
   *  got a real identity, and a test still passing one silently 404s and cleans nothing. */
  const idOf = async (name: string): Promise<string | undefined> => {
    const body = (await (await h.fetch('/api/runners')).json()) as {
      runners: Array<{ id: string; name: string }>
    }
    return body.runners.find((r) => r.name === name)?.id
  }

  const revoke = async (name: string) => {
    const id = await idOf(name)
    if (id) await h.fetch(`/api/runners/${id}`, { method: 'DELETE' })
  }

  test('a name is claimed on first registration', async () => {
    assert.equal((await register('first')).status, 201)
    assert.ok(await idOf('first'))
  })

  test('an unprotected control plane treats a collision as the same machine', async () => {
    // It is only reachable from its own machine, so a collision cannot mean a second one.
    assert.equal((await register('again')).status, 201)
    assert.equal((await register('again')).status, 201)
  })

  test('a revoked name is free again', async () => {
    // Otherwise re-registering a rebuilt machine means picking a new name forever.
    assert.equal((await register('rebuilt')).status, 201)
    await revoke('rebuilt')
    assert.equal((await register('rebuilt')).status, 201)
  })

  test('revoke and forget address a runner by id, not by name', async () => {
    // The regression that leaked a row on every test run: the route takes a uuid, the
    // caller passed a name, the delete matched nothing and said so to no one.
    assert.equal((await register('addressed')).status, 201)
    const id = await idOf('addressed')

    assert.equal((await h.fetch(`/api/runners/addressed`, { method: 'DELETE' })).status, 404)
    assert.equal((await h.fetch(`/api/runners/${id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await h.fetch(`/api/runners/${id}/forget`, { method: 'DELETE' })).status, 200)

    assert.equal(await idOf('addressed'), undefined, 'forget must actually remove the row')
  })
})

/**
 * An invite enrols exactly one machine.
 *
 * It was a read, an `if (invite.usedAt)`, and an unconditional UPDATE at the far end of
 * the handler. Two joins presenting the same token with different names both saw
 * `usedAt` null, both passed, and both enrolled — the name-uniqueness check could not
 * catch them precisely because the names differed. Both rows then carried the same
 * `tokenHash`, and authentication resolves a credential by that hash alone, so revoking
 * one left the other working: a lost laptop became a rotation across every machine that
 * shared the invite, not a revocation.
 */
describe('a join token enrols one machine', () => {
  let h: Awaited<ReturnType<typeof startHarness>>

  before(async () => {
    // Protected: on an unprotected control plane there is no invite to redeem.
    h = await startHarness(undefined, true)
  })
  after(async () => {
    await truncate(h.db)
    await h.stop()
  })

  const mint = async (): Promise<string> => {
    const res = await h.fetch('/api/runners/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'test' }),
    })
    return ((await res.json()) as { token: string }).token
  }

  const join = (token: string, name: string) =>
    h.fetch('/api/runners/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, labels: ['claude'], maxConcurrency: 1 }),
    })

  const enrolled = async (): Promise<Array<{ name: string }>> =>
    ((await (await h.fetch('/api/runners')).json()) as { runners: Array<{ name: string }> }).runners

  /**
   * Sixteen, not two. Two joins issued together do not reliably interleave — measured
   * against the unfixed handler, two racers produced one winner and the test passed
   * while the bug was fully present. Four produced two winners, eight produced four, and
   * sixteen produced *fifteen*. A concurrency test that does not reproduce the race on
   * the broken code is not testing anything, so this is pinned above where it starts.
   */
  const RACERS = 16

  test('machines racing one token: exactly one wins', async () => {
    const token = await mint()

    // Distinct names on purpose — that is precisely what defeated the uniqueness check,
    // since two rows with different names never collide.
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => join(token, `racer-${i}`)),
    )

    const won = results.filter((r) => r.status === 201).length
    assert.equal(won, 1, `${won} of ${RACERS} machines enrolled on one single-use token`)
    assert.equal(
      results.filter((r) => r.status === 409).length,
      RACERS - 1,
      'every loser should be told the token is spent',
    )

    const names = (await enrolled()).map((r) => r.name).filter((n) => n.startsWith('racer-'))
    assert.equal(names.length, 1, `enrolled: ${names.join(', ')}`)
  })

  test('a spent token cannot be replayed', async () => {
    const token = await mint()
    assert.equal((await join(token, 'first-in')).status, 201)

    const again = await join(token, 'second-in')
    assert.equal(again.status, 409)
    assert.match(((await again.json()) as { error: string }).error, /already used by "first-in"/)
  })

  test('an unknown token is refused, and is not confused with a spent one', async () => {
    const res = await join('ogr_not_a_real_token', 'nobody')
    assert.equal(res.status, 401)
    assert.match(((await res.json()) as { error: string }).error, /not valid/)
  })

  /**
   * Refusing the name has to roll the claim back. Otherwise the remedy for picking a
   * taken name is minting a new token, which makes single-use feel like a punishment for
   * a typo.
   */
  test('a name collision does not burn the invite', async () => {
    const first = await mint()
    assert.equal((await join(first, 'contested')).status, 201)

    const second = await mint()
    assert.equal((await join(second, 'contested')).status, 409, 'the name is taken')

    // Still spendable on a name that is free.
    assert.equal((await join(second, 'uncontested')).status, 201)
  })
})
