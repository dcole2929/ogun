/**
 * The placeholder credentials a sandbox gets instead of the real ones, and the
 * environment that points it at the gateway.
 *
 * A stub has one job and it is subtle: be convincing enough that the CLI decides it is
 * logged in and sends a request, and worthless enough that stealing it gains nothing. The
 * failure mode both stubs below are shaped against is the same one — a CLI that inspects
 * its own credential, concludes it is expired or unusable, and either refuses to start or
 * tries to refresh it against a token endpoint that will reject a placeholder. Either way
 * the run dies before a single request reaches the gateway, and the error blames auth.
 */

/** Where the runner bind-mounts the gateway's CA certificate, read-only. */
export const CA_CONTAINER_PATH = '/etc/ogun/gateway-ca.pem'

/**
 * The staging paths `entrypoint.sh` already copies from.
 *
 * Reusing them is the point: the stubs land exactly where the real credential files used
 * to be mounted, so the image, the entrypoint, and both CLIs need no change at all. What
 * changes is only *what* is at those paths — a placeholder instead of an OAuth token.
 */
export const CLAUDE_STUB_CONTAINER_PATH = '/host-credentials/claude/.credentials.json'
export const CODEX_STUB_CONTAINER_PATH = '/host-credentials/codex/auth.json'

/** Recognisable in a transcript, and obviously not a token. */
export const PLACEHOLDER = 'ogun-gateway-placeholder'

/** 2100-01-01. Far enough out that no expiry check ever fires. */
const NEVER = Date.UTC(2100, 0, 1)

export type CredentialStub = { containerPath: string; content: string; mode: number }

/**
 * `~/.claude/.credentials.json`, with nothing in it.
 *
 * Two fields are load-bearing and neither is the token:
 *
 * - `expiresAt` in the far future. A CLI that reads its own credential as expired refuses
 *   to use it at request time, so a stub with a realistic expiry works until the moment
 *   the clock passes it and then fails for a reason that looks like a real expiry.
 * - `refreshToken` empty. A present-but-fake refresh token invites the CLI to spend it
 *   at `console.anthropic.com` and rewrite this file with the failure; an empty one reads
 *   as "there is nothing to refresh with" and the refresh path is never entered.
 *
 * `scopes` and `subscriptionType` are there because the CLI branches on them to pick the
 * subscription path rather than the API-key path. `mcpOAuth` is deliberately absent — the
 * host's copy of this file holds live OAuth tokens for every connected MCP server, and
 * not carrying them across is half of what this change is for.
 */
export const claudeCredentialStub = (): string =>
  `${JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: PLACEHOLDER,
        refreshToken: '',
        expiresAt: NEVER,
        refreshTokenExpiresAt: NEVER,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    },
    null,
    2,
  )}\n`

/**
 * `~/.codex/auth.json`, with nothing in it.
 *
 * `last_refresh` is stamped at build time rather than being a constant. Codex treats an
 * `auth.json` whose last refresh is older than its refresh window as stale and tries to
 * self-refresh — which fails against a placeholder refresh token, and takes the run with
 * it. Built per call so a long-lived runner never hands out a timestamp from the day it
 * started.
 *
 * `id_token` has to parse as a JWT because Codex decodes it for the plan type and account
 * id before it sends anything. It is unsigned nonsense with a far-future `exp`; the
 * gateway replaces the `authorization` header and the `chatgpt-account-id` header at the
 * wire, so nothing in here is ever presented to OpenAI.
 */
export function codexAuthStub(now = new Date()): string {
  return `${JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: placeholderIdToken(),
        access_token: PLACEHOLDER,
        refresh_token: PLACEHOLDER,
        account_id: PLACEHOLDER,
      },
      last_refresh: now.toISOString(),
    },
    null,
    2,
  )}\n`
}

function placeholderIdToken(): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      sub: PLACEHOLDER,
      email: 'ogun@localhost',
      exp: Math.floor(NEVER / 1000),
      iat: Math.floor(Date.UTC(2025, 0, 1) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: PLACEHOLDER,
        chatgpt_account_id: PLACEHOLDER,
      },
    }),
    Buffer.from(PLACEHOLDER, 'utf8').toString('base64url'),
  ].join('.')
}

export function credentialStubs(runtime: 'claude' | 'codex', now = new Date()): CredentialStub[] {
  // 0600, even though every byte of it is a placeholder. The file is credential-SHAPED,
  // it sits at the path a real credential used to occupy, and the mode has to already be
  // right on the day somebody reaches for this code for something that is not.
  return runtime === 'claude'
    ? [{ containerPath: CLAUDE_STUB_CONTAINER_PATH, content: claudeCredentialStub(), mode: 0o600 }]
    : [{ containerPath: CODEX_STUB_CONTAINER_PATH, content: codexAuthStub(now), mode: 0o600 }]
}

/**
 * The environment that makes a container route everything through the gateway and
 * believe the certificates it gets back.
 *
 * `proxyUrl` carries the per-job token as HTTP basic credentials
 * (`http://x:<token>@host:port`), which is how every one of these clients passes
 * `Proxy-Authorization` — there is no other portable way to give a proxy a secret.
 */
export function sandboxProxyEnv(proxyUrl: string): Record<string, string> {
  return {
    // Both spellings, always. curl reads lowercase only; Go tools read either; some Node
    // libraries read uppercase only. A proxy set in one spelling is a container that
    // reaches the internet directly for half its traffic and cannot explain why.
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,

    // Node 24 no longer honours HTTPS_PROXY implicitly — `fetch` ignores it unless this
    // is set. The claude CLI is Node, so without this it talks straight past the gateway
    // to api.anthropic.com with a placeholder token and 401s.
    NODE_USE_ENV_PROXY: '1',

    // A container's own loopback is not the gateway's business, and a project's test
    // suite talking to its own postgres through an HTTP proxy fails in a way nobody
    // would connect back to this. Both spellings again, for the same reason.
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',

    // NODE_EXTRA_CA_CERTS *adds* to Node's bundled roots. The rest *replace* the system
    // bundle, which is deliberate and is a second layer of enforcement: inside this
    // container the gateway's CA is the only certificate that verifies, so a client that
    // found a way around the proxy variables cannot complete a TLS handshake with anyone.
    NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
    SSL_CERT_FILE: CA_CONTAINER_PATH,
    CURL_CA_BUNDLE: CA_CONTAINER_PATH,
    REQUESTS_CA_BUNDLE: CA_CONTAINER_PATH,

    // git needs telling three separate things: use this CA, authenticate to the proxy
    // with Basic (its default is to negotiate, which the gateway does not offer), and
    // never stop to ask a human for a password — an unattended run that prompts hangs
    // until the job's budget runs out and is then reported as a timeout.
    GIT_SSL_CAINFO: CA_CONTAINER_PATH,
    GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
    GIT_TERMINAL_PROMPT: '0',
  }
}
