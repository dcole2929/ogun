import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import {
  bodyIsBufferable,
  isSyntheticRefreshTarget,
  MAX_SYNTHETIC_BODY_BYTES,
  syntheticRefresh,
} from '../src/synthetic.ts'
import { PLACEHOLDER } from '../src/stubs.ts'
import { requestThroughProxy, startHarness } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The refresh the gateway answers itself.
 *
 * Codex on a ChatGPT subscription will not accept a credential it cannot refresh. Given
 * the sandbox's placeholder `auth.json` it `POST`s `auth.openai.com/oauth/token` with the
 * placeholder refresh token, OpenAI answers `401 invalid_client` — correctly — and the run
 * ends with "Your access token could not be refreshed. Please log out and sign in again."
 * `stubs.ts` already stamps `last_refresh` to head this off and it is not enough: this
 * Codex also refreshes reactively, so the first 401 from anywhere restarts the same loop.
 *
 * The naive fix is to hand back the host's real access token, which is what the reference
 * implementation of this pattern does. That would write a live credential into
 * `~/.codex/auth.json` *inside* the container — the exact file ADR-0010 exists to empty —
 * so the tests below assert the shape of the answer *and* that the real token is not in
 * it.
 */

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await harness.cleanup()
})

const REAL_TOKEN = 'oai-REAL-ACCESS-TOKEN-do-not-hand-this-out'

const authOpenAi = async (): Promise<Harness> => {
  const harness = await startHarness({
    hostname: 'auth.openai.com',
    credentials: {
      openai: {
        provider: 'openai',
        mode: 'oauth',
        accessToken: REAL_TOKEN,
        accountId: 'acct-REAL',
      },
    },
  })
  harnesses.push(harness)
  return harness
}

const refreshBody = (refreshToken: string, grantType = 'refresh_token'): string =>
  JSON.stringify({
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    grant_type: grantType,
    refresh_token: refreshToken,
    scope: 'openid profile email',
  })

// ── the decision, as a pure function ────────────────────────────────────────

test('a placeholder refresh is answered with placeholders and nothing else', () => {
  /**
   * The whole security property of this feature in one assertion: what comes back is
   * worthless. A CLI stores whatever it is handed, so anything real here lands on disk
   * inside the container and is readable by the agent — which is the state this component
   * was built to remove. It works because the client never needs a working token: the
   * gateway rewrites `authorization` on every request to a provider host regardless of
   * what arrived.
   */
  const answer = syntheticRefresh(refreshBody(PLACEHOLDER))
  assert.ok(answer)
  assert.equal(answer.status, 200)
  const fields = JSON.parse(answer.body) as Record<string, unknown>
  assert.equal(fields.access_token, PLACEHOLDER)
  assert.equal(fields.refresh_token, PLACEHOLDER)
  assert.equal(fields.token_type, 'Bearer')
  assert.equal(typeof fields.expires_in, 'number')
  /**
   * No `id_token`. Codex parses that one for the plan type and the account id, and it has
   * already accepted the stub's. Returning a fresh one means it re-parses whatever is
   * here, and anything that is not a well-formed JWT with those claims fails the very
   * refresh this response exists to satisfy.
   */
  assert.equal('id_token' in fields, false)
})

test('a real refresh token is forwarded, not answered', () => {
  /**
   * The check that keeps this from breaking a working login. A `worktree` sandbox runs the
   * host's own `codex` through this gateway with its *real* refresh token; answering that
   * synthetically would hand back a placeholder, the CLI would write it over a live
   * credential in the host's own `~/.codex/auth.json`, and the human would be logged out
   * by a proxy. Matching the sentinel exactly — rather than "does this look fake" — is
   * what separates the two cases.
   */
  assert.equal(syntheticRefresh(refreshBody('rt.1.AAAUasslongrealrefreshtoken')), undefined)
})

test('only a refresh grant is answered', () => {
  // An authorization-code exchange is a login in progress, and a 200 full of placeholders
  // would complete it with credentials that authenticate nothing.
  assert.equal(syntheticRefresh(refreshBody(PLACEHOLDER, 'authorization_code')), undefined)
})

test('a body that is not a refresh request at all is forwarded', () => {
  // Deciding a malformed request has failed is the upstream's job, not the gateway's: an
  // error written here would be attributed to OpenAI by whoever read it.
  for (const body of ['', 'not json', '{}', '[]', 'null', '{"grant_type":"refresh_token"}']) {
    assert.equal(syntheticRefresh(body), undefined, body)
  }
})

test('the pre-match is exactly one host, one method and one path', () => {
  /**
   * Narrow on purpose. This check runs on every request that crosses the gateway, and each
   * host or path it matches is one more place a body gets buffered — so the registry is a
   * single endpoint rather than a pattern that might grow to cover an upload.
   */
  assert.equal(isSyntheticRefreshTarget('auth.openai.com', 'POST', '/oauth/token'), true)
  // The query string is not part of the path, and a client that appends one is still
  // making the same request.
  assert.equal(isSyntheticRefreshTarget('auth.openai.com', 'POST', '/oauth/token?x=1'), true)
  // DNS is case-insensitive and the fully-qualified spelling ends in a dot; both are the
  // same host, and both are written by the client.
  assert.equal(isSyntheticRefreshTarget('AUTH.OpenAI.com.', 'post', '/oauth/token'), true)

  assert.equal(isSyntheticRefreshTarget('api.openai.com', 'POST', '/oauth/token'), false)
  assert.equal(isSyntheticRefreshTarget('auth.openai.com', 'GET', '/oauth/token'), false)
  assert.equal(isSyntheticRefreshTarget('auth.openai.com', 'POST', '/oauth/authorize'), false)
  // Not a prefix match: a longer path is a different endpoint.
  assert.equal(isSyntheticRefreshTarget('auth.openai.com', 'POST', '/oauth/token/extra'), false)
  // `*.openai.com` would match this and must not.
  assert.equal(isSyntheticRefreshTarget('evil-auth.openai.com', 'POST', '/oauth/token'), false)
})

test('only a small, declared body is ever held in memory', () => {
  /**
   * The bound is what stops this check from becoming a way to make the runner buffer an
   * arbitrary upload. A body that does not declare its length cannot be bounded before it
   * is read, so it is streamed and never inspected — the cost of failing that way round is
   * the refusal Codex was already getting, and the cost of failing the other way is a
   * runner holding a gigabyte because a container asked it to.
   */
  assert.equal(bodyIsBufferable('200'), true)
  assert.equal(bodyIsBufferable(String(MAX_SYNTHETIC_BODY_BYTES)), true)
  assert.equal(bodyIsBufferable(String(MAX_SYNTHETIC_BODY_BYTES + 1)), false)
  assert.equal(bodyIsBufferable(undefined), false)
  assert.equal(bodyIsBufferable('not-a-number'), false)
  // `Number()` would accept every one of these from a string the client wrote.
  assert.equal(bodyIsBufferable('0x10'), false)
  assert.equal(bodyIsBufferable('1e3'), false)
  assert.equal(bodyIsBufferable(['200', '999999999']), false)
})

// ── the same decision, through the whole gateway ────────────────────────────

test('a placeholder refresh never reaches OpenAI and never returns the real token', async () => {
  /**
   * End to end, because the pure function above cannot prove the part that matters: that
   * the request is *short-circuited*. A gateway that computed the right answer and then
   * forwarded anyway would still get the 401 that kills the run, and would still have
   * spent the host's placeholder against a real endpoint.
   */
  const harness = await authOpenAi()
  const session = harness.gateway.open(undefined, ['auth.openai.com'])
  const body = refreshBody(PLACEHOLDER)

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'auth.openai.com',
    method: 'POST',
    path: '/oauth/token',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  })

  assert.equal(response.status, 200)
  assert.equal(harness.upstream.received.length, 0)
  assert.equal(response.body?.includes(REAL_TOKEN), false)
  assert.equal((JSON.parse(response.body ?? '{}') as { access_token: string }).access_token, PLACEHOLDER)
})

test('a real refresh reaches OpenAI with its body intact', async () => {
  /**
   * The transparency half. The interception buffers the body to decide, so the forwarding
   * path has to write those bytes back out — a version that dropped them would leave the
   * upstream waiting on a `content-length` that never arrives, and the symptom would be a
   * host-side login that hangs rather than one that fails.
   */
  const harness = await authOpenAi()
  const session = harness.gateway.open(undefined, ['auth.openai.com'])
  const body = refreshBody('rt.1.AAAUasslongrealrefreshtoken')
  harness.upstream.respond((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"access_token":"fresh"}')
  })

  const response = await requestThroughProxy(harness, {
    token: session.token,
    hostname: 'auth.openai.com',
    method: 'POST',
    path: '/oauth/token',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  })

  assert.equal(response.status, 200)
  assert.equal(harness.upstream.received.length, 1)
  assert.equal(harness.upstream.received[0]?.body, body)
  assert.equal(response.body, '{"access_token":"fresh"}')
})
