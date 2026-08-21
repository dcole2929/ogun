import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { credentialStatuses, readCredentials } from '../src/credentials.ts'
import type { CredentialPaths } from '../src/credentials.ts'
import {
  CA_CONTAINER_PATH,
  claudeCredentialStub,
  codexAuthStub,
  credentialStubs,
  PLACEHOLDER,
  sandboxProxyEnv,
} from '../src/stubs.ts'

/**
 * The zero-credential bootstrap: what the host reads, and what the container is given
 * instead.
 *
 * The stubs are where this whole design is most likely to fail in a way that looks like
 * something else. A CLI that decides its own credential is stale refuses to start, or
 * spends a placeholder refresh token against a real token endpoint, and the run dies
 * before a single request reaches the gateway — reported as an auth failure, which sends
 * whoever reads it to re-authenticate a host credential that was fine.
 */

const directories: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ogun-creds-'))
  directories.push(dir)
  return dir
}
after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
})

const paths = (files: Record<string, unknown>, env: Record<string, string> = {}): CredentialPaths => {
  const dir = scratch()
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content))
  }
  return {
    claudeCredentials: join(dir, 'claude.json'),
    codexAuth: join(dir, 'codex.json'),
    env,
  }
}

// ── what the host holds ────────────────────────────────────────────────────

/**
 * The reason this is worth a test of its own: `~/.claude/.credentials.json` on a working
 * machine holds a great deal more than the Anthropic session. `mcpOAuth` carries live
 * access AND refresh tokens for every MCP server the user has connected — Linear, PostHog,
 * whatever else — and the old design bind-mounted that whole file into every sandbox. §4.6
 * said the worst case was burning rate limit; it was handing an autonomous agent a set of
 * third-party credentials from unrelated products.
 */
test('reading a credential file takes the anthropic session and nothing else', () => {
  const set = readCredentials(
    paths({
      'claude.json': {
        claudeAiOauth: { accessToken: 'sk-ant-oat01-real', expiresAt: 1e13 },
        mcpOAuth: {
          'linear|abc': { accessToken: 'linear-secret', refreshToken: 'linear-refresh' },
        },
      },
    }),
  )
  assert.deepEqual(set.anthropic, {
    provider: 'anthropic',
    mode: 'oauth',
    accessToken: 'sk-ant-oat01-real',
    expiresAt: 1e13,
  })
  assert.ok(!JSON.stringify(set).includes('linear'))
})

/**
 * An explicit `ANTHROPIC_API_KEY` is the narrower, more deliberate act — you set it for
 * this process — and it is the only way to point a run at an account other than the one
 * the host's `claude` is logged into.
 */
test('an explicit API key wins over the logged-in subscription token', () => {
  const set = readCredentials(
    paths({ 'claude.json': { claudeAiOauth: { accessToken: 'sk-ant-oat01-real' } } }, {
      ANTHROPIC_API_KEY: 'sk-ant-api03-explicit',
    }),
  )
  assert.deepEqual(set.anthropic, {
    provider: 'anthropic',
    mode: 'api-key',
    apiKey: 'sk-ant-api03-explicit',
  })
})

/**
 * ADR-0005 is that no git credential enters the sandbox. A gateway that went looking for
 * one — `gh auth token`, `~/.config/gh/hosts.yml` — would quietly re-grant through a new
 * door exactly what that ADR removed. It has to be handed over on purpose, by name.
 */
test('no GitHub credential is discovered, only accepted', () => {
  assert.equal(readCredentials(paths({})).github, undefined)
  assert.deepEqual(readCredentials(paths({}, { GITHUB_TOKEN: 'ghp_ambient' })).github, undefined)
  assert.deepEqual(readCredentials(paths({}, { OGUN_GATEWAY_GITHUB_TOKEN: 'ghp_given' })).github, {
    provider: 'github',
    token: 'ghp_given',
  })
})

/**
 * Every accessor is total, because the failure being guarded against is not a crash — it
 * is a runner that crashes *on the credential path* and therefore cannot report why. These
 * files are written by two third-party CLIs that change their own formats.
 */
test('a missing, empty or reshaped credential file reads as "no credential"', () => {
  assert.deepEqual(readCredentials(paths({})), {})
  assert.deepEqual(readCredentials(paths({ 'claude.json': { claudeAiOauth: null } })), {})
  assert.deepEqual(readCredentials(paths({ 'codex.json': { auth_mode: 'chatgpt' } })), {})
})

test('a codex chatgpt session is read with its account id', () => {
  const set = readCredentials(
    paths({
      'codex.json': {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'oa-real', account_id: 'acct-1' },
      },
    }),
  )
  assert.deepEqual(set.openai, {
    provider: 'openai',
    mode: 'oauth',
    accessToken: 'oa-real',
    accountId: 'acct-1',
  })
})

/**
 * The gateway does not refresh an Anthropic OAuth token — it re-reads the file the host's
 * own `claude` refreshes. That makes an expired token a real, recoverable state whose only
 * other symptom is a 401 buried in a 3am transcript, so `doctor` has to name it and say
 * what fixes it.
 *
 * The shape of the answer — the five states a caller may not collapse, and the boundaries
 * between them — is in `expiry.test.ts`. This one stays on the prose, which is what a
 * person at 3am actually reads.
 */
test('doctor is told how long a token has left, and what to do when it has none', () => {
  const now = Date.UTC(2026, 0, 1)
  const expired = credentialStatuses(
    { anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'x', expiresAt: now - 6 * 36e5 } },
    now,
  )
  assert.match(expired[0]!.detail, /EXPIRED 6h ago/)
  assert.match(expired[0]!.detail, /run `claude` on this host/)

  const fresh = credentialStatuses(
    { anthropic: { provider: 'anthropic', mode: 'oauth', accessToken: 'x', expiresAt: now + 2 * 36e5 } },
    now,
  )
  assert.match(fresh[0]!.detail, /2h left/)
  assert.equal(credentialStatuses({}, now)[0]?.present, false)
})

// ── what the container gets ────────────────────────────────────────────────

/**
 * The two fields that make the claude stub work, and neither of them is the token.
 *
 * A far-future `expiresAt`, because a CLI that reads its own credential as expired refuses
 * it at request time — so a stub with a realistic expiry works until the clock passes it
 * and then fails for a reason that looks exactly like a real expiry. And an empty
 * `refreshToken`, because a present-but-fake one invites the CLI to spend it at
 * `console.anthropic.com` and rewrite the file with the failure.
 */
test('the claude stub never expires and has nothing to refresh with', () => {
  const stub = JSON.parse(claudeCredentialStub()) as {
    claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number }
    mcpOAuth?: unknown
  }
  assert.equal(stub.claudeAiOauth.accessToken, PLACEHOLDER)
  assert.equal(stub.claudeAiOauth.refreshToken, '')
  assert.ok(stub.claudeAiOauth.expiresAt > Date.now() + 50 * 365 * 24 * 36e5)
  assert.equal(stub.mcpOAuth, undefined, 'the MCP tokens are the point of not copying this file')
})

/**
 * `last_refresh` is stamped at build time rather than being a constant. Codex treats an
 * `auth.json` whose last refresh is older than its refresh window as stale and tries to
 * self-refresh, which fails against a placeholder refresh token and takes the run with it.
 * A long-lived runner must never hand out the timestamp from the day it started.
 */
test('the codex stub always looks freshly refreshed', () => {
  const at = new Date('2026-08-20T12:00:00.000Z')
  const stub = JSON.parse(codexAuthStub(at)) as { last_refresh: string; tokens: { id_token: string } }
  assert.equal(stub.last_refresh, at.toISOString())
  assert.notEqual(JSON.parse(codexAuthStub(new Date())).last_refresh, stub.last_refresh)
})

/**
 * Codex decodes `id_token` for the plan type and account id before it sends anything, so
 * the placeholder has to parse as a JWT. A plain string there is a crash on startup, not a
 * failed request.
 */
test('the codex stub id_token parses as a JWT with the claims codex reads', () => {
  const { tokens } = JSON.parse(codexAuthStub()) as { tokens: { id_token: string } }
  const [, payload] = tokens.id_token.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
    string,
    Record<string, string>
  >
  assert.ok(claims.exp !== undefined)
  assert.equal(claims['https://api.openai.com/auth']?.chatgpt_account_id, PLACEHOLDER)
})

/**
 * The stubs land at the paths `entrypoint.sh` already copies from, which is what makes
 * this change reach the sandbox without touching the image, the entrypoint or either CLI.
 * 0600 because the file is credential-*shaped* and sits where a real credential used to.
 */
test('a stub replaces the file it stands in for, at the same path and mode', () => {
  const [claude] = credentialStubs('claude')
  assert.equal(claude?.containerPath, '/host-credentials/claude/.credentials.json')
  assert.equal(claude?.mode, 0o600)
  const [codex] = credentialStubs('codex')
  assert.equal(codex?.containerPath, '/host-credentials/codex/auth.json')
})

/**
 * Both spellings of every proxy variable, because the clients disagree: curl reads
 * lowercase, some Node libraries read uppercase only. A proxy set in one spelling is a
 * container that reaches the internet directly for half its traffic and cannot explain why.
 */
test('the sandbox environment sets both spellings of the proxy variables', () => {
  const env = sandboxProxyEnv('http://x:tok@172.17.0.1:9999')
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.equal(env[name], 'http://x:tok@172.17.0.1:9999', name)
  }
  assert.equal(env.NO_PROXY, env.no_proxy)
  assert.match(env.NO_PROXY ?? '', /127\.0\.0\.1/)
})

/**
 * Node 24+ ignores `HTTPS_PROXY` in `fetch` unless this is set, and the claude CLI is
 * Node. Without it the runtime talks straight past the gateway to `api.anthropic.com`
 * carrying a placeholder, and every run 401s while the gateway sits idle looking healthy.
 */
test('node is told to honour the proxy environment at all', () => {
  assert.equal(sandboxProxyEnv('http://x:t@h:1').NODE_USE_ENV_PROXY, '1')
})

/**
 * Four CA variables because four TLS stacks read four different names — Node, OpenSSL,
 * curl, python-requests — plus git's own. Three of them *replace* the system bundle rather
 * than adding to it, which is deliberate: inside this container the gateway's CA is then
 * the only certificate that verifies, so a client that found its way around the proxy
 * variables cannot complete a handshake with anyone.
 */
test('every TLS stack in the image is pointed at the gateway CA', () => {
  const env = sandboxProxyEnv('http://x:t@h:1')
  for (const name of [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'CURL_CA_BUNDLE',
    'REQUESTS_CA_BUNDLE',
    'GIT_SSL_CAINFO',
  ]) {
    assert.equal(env[name], CA_CONTAINER_PATH, name)
  }
  // libcurl otherwise negotiates proxy auth: it sends the first CONNECT with no
  // credentials, takes the 407, and only then retries. Forcing basic sends it first time.
  assert.equal(env.GIT_HTTP_PROXY_AUTHMETHOD, 'basic')
  // An unattended run that stops to ask for a password hangs until the job's budget runs
  // out, and is then filed as a timeout rather than as an auth failure.
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})
