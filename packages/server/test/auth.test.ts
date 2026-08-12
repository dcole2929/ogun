import { strict as assert } from 'node:assert'
import { test } from 'node:test'
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
test('the default bind is localhost, not every interface', () => {
  assert.equal(resolveAuth({} as NodeJS.ProcessEnv).bind, '127.0.0.1')
})

test('localhost needs no token', () => {
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '127.0.0.1', token: undefined }))
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '::1', token: undefined }))
})

test('a wider bind without a token is refused at boot', () => {
  for (const bind of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertBindIsSafe({ bind, token: undefined }), InsecureBind, bind)
  }
})

test('a wider bind with a token is allowed', () => {
  assert.doesNotThrow(() => assertBindIsSafe({ bind: '0.0.0.0', token: 'secret' }))
})

test('an empty token counts as no token', () => {
  // Otherwise `OGUN_TOKEN=` in a .env silently disables the check it looks like it sets.
  assert.equal(resolveAuth({ OGUN_TOKEN: '   ' } as NodeJS.ProcessEnv).token, undefined)
  assert.throws(() => assertBindIsSafe({ bind: '0.0.0.0', token: undefined }), InsecureBind)
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
    // Not a runner route despite the prefix — a runner has no business listing jobs.
    '/api/jobs',
  ]) {
    assert.equal(scopeForPath(path), 'admin', path)
  }
})
