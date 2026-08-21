import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { CredentialSet } from '../src/credentials.ts'
import {
  DEFAULT_ALLOWED_HOSTS,
  hostMatches,
  isAllowedHost,
  isGitPushRequest,
  parseAuthority,
} from '../src/hosts.ts'
import {
  applyInjections,
  injectionsFor,
  providerForHost,
  requiresCredential,
  stripHopByHop,
} from '../src/inject.ts'

/**
 * What goes on the wire, per provider.
 *
 * These are the assertions that cannot be checked without live credentials, so they are
 * pinned as literals instead. A wrong header name here is not a compile error and not a
 * failure anywhere else in the suite — it surfaces as a 401 from a third party, inside an
 * agent transcript, at 3am.
 */

const headers = (credentials: CredentialSet, hostname: string) =>
  applyInjections({ authorization: 'Bearer ogun-gateway-placeholder' }, injectionsFor(hostname, credentials))

// ── anthropic ──────────────────────────────────────────────────────────────

test('an anthropic OAuth token is spliced into authorization', () => {
  const out = headers(
    { anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'sk-ant-oat01-real' } },
    'api.anthropic.com',
  )
  assert.equal(out.authorization, 'Bearer sk-ant-oat01-real')
})

/**
 * API-key mode must *remove* `authorization`, not merely set `x-api-key`.
 *
 * Anthropic reads `x-api-key` in preference to `authorization`, so leaving the
 * placeholder Bearer behind is harmless there — but the reverse arm is not, and the
 * symmetry is what keeps this honest: a request that arrives with both is resolved by the
 * upstream's precedence rule rather than by ours, and whichever way that falls, the reason
 * for the 401 is invisible from both ends.
 */
test('an anthropic API key replaces the placeholder rather than sitting beside it', () => {
  const out = headers(
    { anthropic: { provider: 'anthropic', mode: 'api-key', apiKey: 'sk-ant-api03-real' } },
    'api.anthropic.com',
  )
  assert.equal(out['x-api-key'], 'sk-ant-api03-real')
  assert.equal(out.authorization, undefined)
})

test('an anthropic OAuth token clears a competing x-api-key', () => {
  const out = applyInjections(
    { authorization: 'Bearer placeholder', 'x-api-key': 'placeholder' },
    injectionsFor('api.anthropic.com', {
      anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'sk-ant-oat01-real' },
    }),
  )
  assert.equal(out['x-api-key'], undefined)
})

// ── openai ─────────────────────────────────────────────────────────────────

/**
 * Codex on a ChatGPT subscription is billed per account, and the account is not carried
 * in the token — it is a separate header the CLI reads out of its own `auth.json`. The
 * stub's `account_id` is a placeholder, so without this the request authenticates and then
 * fails on entitlement, which reads as "your plan does not include Codex".
 */
test('an openai oauth credential carries its account id alongside the token', () => {
  const out = headers(
    {
      openai: { provider: 'openai', mode: 'oauth', accessToken: 'oa-real', accountId: 'acct-1' },
    },
    'chatgpt.com',
  )
  assert.equal(out.authorization, 'Bearer oa-real')
  assert.equal(out['chatgpt-account-id'], 'acct-1')
})

test('one openai credential covers every host it is valid on', () => {
  for (const host of ['api.openai.com', 'chatgpt.com', 'auth.openai.com', 'api.chatgpt.com']) {
    assert.equal(providerForHost(host), 'openai', host)
  }
})

// ── github ─────────────────────────────────────────────────────────────────

/**
 * Git over HTTPS does not speak Bearer.
 *
 * `git fetch` against an HTTPS remote authenticates with HTTP Basic, and GitHub's
 * convention is the literal username `x-access-token` with the token as the password. A
 * Bearer header on `github.com` is ignored, git falls through to asking for a password,
 * and with `GIT_TERMINAL_PROMPT=0` that surfaces as "could not read Username" — which
 * points at the terminal, not at the header.
 */
test('git transport hosts get Basic x-access-token and the API gets Bearer', () => {
  const credentials: CredentialSet = { github: { provider: 'github', token: 'ghp_real' } }
  const expected = `Basic ${Buffer.from('x-access-token:ghp_real').toString('base64')}`
  assert.equal(headers(credentials, 'github.com').authorization, expected)
  assert.equal(headers(credentials, 'codeload.github.com').authorization, expected)
  assert.equal(headers(credentials, 'api.github.com').authorization, 'Bearer ghp_real')
})

/**
 * `objects.githubusercontent.com` serves pre-signed redirect targets — release assets,
 * LFS objects. A pre-signed URL that also carries an `Authorization` header is not
 * tolerated by the storage layer, it is rejected, and the failure looks like a flaky
 * download rather than like a header the proxy added. A registry that injects on "every
 * host of the provider" gets this wrong by construction.
 */
test('a pre-signed storage host is allowlisted but never credentialed', () => {
  assert.ok(isAllowedHost('objects.githubusercontent.com', DEFAULT_ALLOWED_HOSTS))
  assert.equal(providerForHost('objects.githubusercontent.com'), undefined)
  assert.deepEqual(
    injectionsFor('objects.githubusercontent.com', {
      github: { provider: 'github', token: 'ghp_real' },
    }),
    [],
  )
})

/**
 * Reading a public repository with no token is the intended default, so GitHub — unlike
 * the two model providers — must pass through uncredentialed rather than be refused.
 */
test('github is the one provider a request may reach without a credential', () => {
  assert.equal(requiresCredential('github'), false)
  assert.equal(requiresCredential('anthropic'), true)
  assert.equal(requiresCredential('openai'), true)
})

// ── stripping ──────────────────────────────────────────────────────────────

/**
 * `proxy-authorization` carries the per-job token the container uses to talk to the
 * gateway. A proxy that forwards the client's headers wholesale publishes that token to
 * whatever third party the request was addressed to.
 */
test('hop-by-hop headers, and the proxy token above all, do not go upstream', () => {
  const out = stripHopByHop({
    'proxy-authorization': 'Basic secret',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
    'anthropic-beta': 'oauth-2025-04-20',
  })
  assert.equal(out['proxy-authorization'], undefined)
  assert.equal(out['transfer-encoding'], undefined)
  assert.equal(out.connection, undefined)
  // And nothing else. An OAuth request to Anthropic is rejected without this header, so a
  // strip list that reached for "anything auth-adjacent" would break every OAuth run.
  assert.equal(out['anthropic-beta'], 'oauth-2025-04-20')
})

test('a Connection header naming further headers strips those too', () => {
  const out = stripHopByHop({ connection: 'keep-alive, x-custom', 'x-custom': 'v', host: 'h' })
  assert.equal(out['x-custom'], undefined)
  assert.equal(out.host, 'h')
})

// ── the allowlist ──────────────────────────────────────────────────────────

/**
 * The near-miss is the one that matters. A wildcard implemented as
 * `endsWith('example.com')` matches `evilexample.com`, which is an attacker-registrable
 * domain and a complete bypass, and the difference from the correct version is one
 * character in a file nobody re-reads.
 */
test('a wildcard matches strict subdomains and nothing that merely ends the same way', () => {
  assert.ok(hostMatches('*.openai.com', 'auth.openai.com'))
  assert.ok(!hostMatches('*.openai.com', 'openai.com'), 'strictly a subdomain')
  assert.ok(!hostMatches('*.openai.com', 'evilopenai.com'), 'the registrable near-miss')
  assert.ok(!hostMatches('api.anthropic.com', 'api.anthropic.com.evil.net'))
})

/** A CONNECT line is written by the client, and DNS is case-insensitive. */
test('host matching ignores case, because the client chooses the case', () => {
  assert.ok(hostMatches('api.github.com', 'API.GitHub.com'))
  assert.ok(isAllowedHost('API.ANTHROPIC.COM', DEFAULT_ALLOWED_HOSTS))
})

/**
 * A proxy that parses only the host from `host:port` will happily tunnel to
 * `api.anthropic.com:22`, which is an allowlisted name and somebody else's SSH server.
 */
test('a CONNECT authority is parsed with its port, including IPv6', () => {
  assert.deepEqual(parseAuthority('api.anthropic.com:443'), {
    hostname: 'api.anthropic.com',
    port: 443,
  })
  assert.deepEqual(parseAuthority('[::1]:8443'), { hostname: '::1', port: 8443 })
  assert.equal(parseAuthority('api.anthropic.com'), null, 'no port is not an authority')
  assert.equal(parseAuthority('api.anthropic.com:notaport'), null)
})

// ── ADR-0005 ───────────────────────────────────────────────────────────────

/**
 * Both halves of a push, because git is two-phase: `GET info/refs?service=git-receive-pack`
 * discovers the remote's refs, then `POST git-receive-pack` sends the pack. Refusing only
 * the POST lets git prepare and upload a packfile before failing, and it reports that as a
 * transfer error rather than as a refusal.
 *
 * A fetch must keep working — `git-upload-pack` is the same endpoint shape and is exactly
 * what a reviewer following a dependency to its source needs.
 */
test('both phases of a push are refused and a fetch is not', () => {
  assert.ok(isGitPushRequest('POST', '/owner/repo.git/git-receive-pack'))
  assert.ok(isGitPushRequest('GET', '/owner/repo.git/info/refs?service=git-receive-pack'))
  assert.ok(!isGitPushRequest('GET', '/owner/repo.git/info/refs?service=git-upload-pack'))
  assert.ok(!isGitPushRequest('POST', '/owner/repo.git/git-upload-pack'))
})

test('a push is refused whatever else is in the query string', () => {
  assert.ok(isGitPushRequest('GET', '/o/r.git/info/refs?a=1&service=git-receive-pack&b=2'))
  // …and a parameter that merely contains the name is not a push.
  assert.ok(!isGitPushRequest('GET', '/o/r.git/info/refs?service=git-receive-packet'))
})

/**
 * The default list is a promise about what a job can reach, and every entry has to earn
 * its place. This asserts the shape rather than the contents — the entries are documented
 * one by one in `hosts.ts` — plus the one absence that is a decision: no wildcard.
 */
test('the default allowlist grants no wildcards', () => {
  assert.ok(!DEFAULT_ALLOWED_HOSTS.includes('*'))
  assert.ok(DEFAULT_ALLOWED_HOSTS.every((h) => !h.startsWith('*')))
  assert.ok(!isAllowedHost('example.com', DEFAULT_ALLOWED_HOSTS))
})
