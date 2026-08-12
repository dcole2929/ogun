import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assertBindIsSafe, bearerAuth, InsecureBind, resolveAuth } from '../src/auth.ts'

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

const call = async (token: string | undefined, header: Record<string, string>, path = '/api/x') => {
  let reached = false
  const res = await bearerAuth(token)(
    {
      req: { path, header: (n: string) => header[n.toLowerCase()] },
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
  assert.equal((await call('secret', {}, '/api/health')).reached, true)
})
