import type { ConnectedApp } from '@ogun/core/connections'

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
 *
 * A third kind lives here too: what a container is told about a *connected application* it
 * was granted (§4.13). Same property, different audience — the reader is an agent rather
 * than a CLI, so the stub carries a sentence saying it is a placeholder, which is the
 * natural-language form of the same failure. See `connections.ts` for what decides whether
 * a sandbox gets one at all.
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

/**
 * Where a connected application's description is mounted, read-only.
 *
 * Under `/etc/ogun/` beside the CA rather than under `/host-credentials/`, and the reason
 * is `entrypoint.sh`: it *copies* `/host-credentials/...` into a writable home, because
 * both CLIs rewrite their own credential files. Nothing rewrites this one, and a copy step
 * would mean the image had to learn about connections — a change to a shell script that
 * ships inside every project image, for a file that wants to be read where it lands. The
 * mount point is created by docker, so no image rebuild is needed to gain a connection.
 */
export const CONNECTIONS_CONTAINER_DIR = '/etc/ogun/connections'

export const connectionStubPath = (app: ConnectedApp): string =>
  `${CONNECTIONS_CONTAINER_DIR}/${app}.json`

/**
 * What the container is told about a connection it has been granted.
 *
 * The agent has to know three things and none of them is a credential: that the
 * application is reachable at all, the endpoint, and what to put in `Authorization` so
 * that the *shape* of its request is right. The last one is the placeholder, and it is the
 * same `PLACEHOLDER` every other stub uses — worthless if exfiltrated, recognisable in a
 * transcript, and swapped out at the wire by `connectionInjections`.
 *
 * `note` is in the file on purpose. This is a document an agent reads, and an agent that
 * knows the token is a placeholder does not waste a turn deciding it is unauthenticated
 * and looking for the real one — which is the failure both credential stubs above are
 * shaped against, arriving here in its natural-language form. It also states the two
 * limits, because the alternative is discovering them as a 403 with no context: only
 * `POST /graphql`, and the scope is whatever the workspace admin approved.
 *
 * Deliberately not a `.env`, a `settings.json`, or anything a library auto-discovers. A
 * format nothing parses by convention is a format nothing can be tricked into re-emitting.
 */
export function connectionStub(app: ConnectedApp): string {
  if (app === 'linear') {
    return `${JSON.stringify(
      {
        app: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        method: 'POST',
        authorization: PLACEHOLDER,
        note:
          'This is a placeholder, not a credential. Send it; the Ogun gateway replaces it ' +
          'with the project\'s real Linear token on the host, outside this container. Only ' +
          'POST /graphql on this host is reachable — every other path, including the OAuth ' +
          'endpoints, is refused. What the token may do is whatever scope the workspace ' +
          'admin approved for this application.',
      },
      null,
      2,
    )}\n`
  }
  // Exhaustive rather than a fallthrough: the second application must be a compile error
  // in the function that decides what its container is told, not a missing file at 3am.
  const exhaustive: never = app
  return exhaustive
}

/**
 * The stub files for a set of granted applications.
 *
 * 0644, unlike `credentialStubs`' 0600, and the difference is deliberate rather than an
 * oversight. Those files are credential-*shaped* and sit at the paths real credentials
 * used to occupy, so their mode has to already be right on the day somebody reaches for
 * that code for something that is not a placeholder. This file is a *description of a
 * connection* — an endpoint, a method, a sentence — and can never hold a credential,
 * because the credential is spliced in at the wire and has no path through this function.
 * A 0600 file mounted into a container that runs as uid 1000 would also be unreadable the
 * first time somebody ran a container as a different user, which is a support ticket
 * bought for a secret that is not there.
 */
export function connectionStubs(apps: readonly ConnectedApp[]): CredentialStub[] {
  return apps.map((app) => ({
    containerPath: connectionStubPath(app),
    content: connectionStub(app),
    mode: 0o644,
  }))
}

/**
 * The environment that tells an agent a connection exists, without it having to find a
 * file first.
 *
 * `OGUN_CONNECTIONS` is the roster — the one variable a skill can read to branch on
 * "may I call Linear?" without guessing at a path. The per-app variables are the values a
 * conventional client already looks for, so a skill that reaches for a Linear SDK gets a
 * working call rather than an unauthenticated one; the value is the placeholder, which is
 * the whole point of it being safe to put in a `docker run` argv.
 *
 * Absent when nothing was granted, rather than set to an empty string. `OGUN_CONNECTIONS=`
 * and no `OGUN_CONNECTIONS` are the same to a shell test and different to anything that
 * splits on commas, and "granted nothing" is the state that must never read as "granted
 * something I could not name".
 */
export function sandboxConnectionEnv(apps: readonly ConnectedApp[]): Record<string, string> {
  if (apps.length === 0) return {}
  const env: Record<string, string> = { OGUN_CONNECTIONS: apps.join(',') }
  for (const app of apps) {
    if (app === 'linear') {
      env.OGUN_LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
      env.LINEAR_API_KEY = PLACEHOLDER
    }
  }
  return env
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
