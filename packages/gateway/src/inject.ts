import type { CredentialSet, Provider } from './credentials.ts'
import { hostMatches } from './hosts.ts'

/**
 * What the gateway does to a request's headers on its way out.
 *
 * The container was given a *placeholder* credential — real enough in shape for the CLI
 * to start and to decide it is authenticated, but worth nothing. Every request arrives
 * carrying that placeholder, and this is where it is taken out and the real value put in.
 * You cannot exfiltrate a token that was never in the container.
 *
 * Header names are lowercase throughout: `node:http` lowercases what it parses, and a
 * `remove` that spelled it `Authorization` would silently miss.
 */

export type Injection =
  | { kind: 'set'; name: string; value: string }
  | { kind: 'remove'; name: string }

/**
 * Which provider owns a host, or `undefined` for a host that gets no credential at all.
 *
 * Note what is absent. `statsig.anthropic.com` is allowlisted and takes no credential.
 * `objects.githubusercontent.com` is allowlisted and takes no credential *specifically*:
 * it serves pre-signed redirect targets, and an `Authorization` header sent alongside a
 * pre-signed URL is not ignored — the storage layer rejects the request outright. A
 * "inject on every host of the provider" rule breaks large-file downloads and does it in
 * a way that looks like a network flake.
 */
export function providerForHost(hostname: string): Provider | undefined {
  if (hostMatches('api.anthropic.com', hostname)) return 'anthropic'
  for (const pattern of ['api.openai.com', 'chatgpt.com', '*.chatgpt.com', '*.openai.com']) {
    if (hostMatches(pattern, hostname)) return 'openai'
  }
  for (const pattern of ['api.github.com', 'github.com', 'codeload.github.com', 'raw.githubusercontent.com']) {
    if (hostMatches(pattern, hostname)) return 'github'
  }
  return undefined
}

/**
 * A provider host where arriving without a credential is certainly a failed run, so the
 * gateway says so itself instead of forwarding a placeholder and letting the CLI report
 * somebody else's 401.
 *
 * GitHub is deliberately not in this set. Reading a public repository with no token is
 * the *intended* default (see credentials.ts), and refusing it would break the common
 * case to protect against a rare one.
 */
export const requiresCredential = (provider: Provider): boolean => provider !== 'github'

/**
 * The header edits for one request.
 *
 * Every arm removes as well as sets. A request that arrives with both `authorization` and
 * `x-api-key` is resolved by the *upstream's* precedence rule, not ours — Anthropic reads
 * `x-api-key` first — so leaving the placeholder behind next to a real token is a 401
 * whose cause is invisible from either end.
 */
export function planInjections(provider: Provider, credentials: CredentialSet): Injection[] {
  if (provider === 'anthropic') {
    const credential = credentials.anthropic
    if (!credential) return []
    return credential.mode === 'oauth'
      ? [
          { kind: 'set', name: 'authorization', value: `Bearer ${credential.accessToken}` },
          { kind: 'remove', name: 'x-api-key' },
        ]
      : [
          { kind: 'set', name: 'x-api-key', value: credential.apiKey },
          { kind: 'remove', name: 'authorization' },
        ]
  }

  if (provider === 'openai') {
    const credential = credentials.openai
    if (!credential) return []
    if (credential.mode === 'api-key') {
      return [{ kind: 'set', name: 'authorization', value: `Bearer ${credential.apiKey}` }]
    }
    const injections: Injection[] = [
      { kind: 'set', name: 'authorization', value: `Bearer ${credential.accessToken}` },
    ]
    // Codex on a ChatGPT subscription is billed per *account*, and the account is not in
    // the token — it is a separate header the CLI reads out of its own `auth.json`. The
    // stub's `account_id` is a placeholder, so without this the request authenticates and
    // then fails on entitlement, which reads as "your plan does not include Codex".
    if (credential.accountId) {
      injections.push({ kind: 'set', name: 'chatgpt-account-id', value: credential.accountId })
    }
    return injections
  }

  const credential = credentials.github
  if (!credential) return []
  return [{ kind: 'set', name: 'authorization', value: `Bearer ${credential.token}` }]
}

/**
 * Git over HTTPS does not speak Bearer.
 *
 * `git push`/`git fetch` against an HTTPS remote authenticate with HTTP Basic, and
 * GitHub's convention for a token there is the username `x-access-token` with the token
 * as the password. A Bearer header on `github.com` is ignored, git falls through to
 * prompting for a password, and with `GIT_TERMINAL_PROMPT=0` that surfaces as
 * "could not read Username" rather than as an auth failure.
 *
 * Only the git-transport hosts. `api.github.com` is a REST API and wants Bearer.
 */
export function gitBasicAuthorization(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
}

const GIT_TRANSPORT_HOSTS = ['github.com', 'codeload.github.com']

export function injectionsFor(hostname: string, credentials: CredentialSet): Injection[] {
  const provider = providerForHost(hostname)
  if (!provider) return []
  const injections = planInjections(provider, credentials)
  if (provider !== 'github' || !credentials.github) return injections
  if (!GIT_TRANSPORT_HOSTS.some((h) => hostMatches(h, hostname))) return injections
  return [
    { kind: 'set', name: 'authorization', value: gitBasicAuthorization(credentials.github.token) },
  ]
}

/** Apply the plan to a header bag, in order. */
export function applyInjections(
  headers: Record<string, string | string[] | undefined>,
  injections: readonly Injection[],
): Record<string, string | string[] | undefined> {
  const out = { ...headers }
  for (const injection of injections) {
    if (injection.kind === 'remove') delete out[injection.name]
    else out[injection.name] = injection.value
  }
  return out
}

/**
 * Headers that must not be forwarded, whatever the request said.
 *
 * `proxy-authorization` is the one that matters and the one an obvious implementation
 * forgets: it carries the per-job token the container uses to talk to the gateway, and
 * forwarding it to `api.anthropic.com` publishes that token to a third party. The rest
 * are RFC 9110 hop-by-hop fields, which by definition describe *this* connection and are
 * meaningless on the next one.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

export function stripHopByHop(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out = { ...headers }
  for (const name of HOP_BY_HOP_HEADERS) delete out[name]
  // `Connection: X-Foo` names further headers as hop-by-hop. Rare, but a client that uses
  // it and a proxy that ignores it produce a request the upstream rejects as malformed.
  const connection = headers.connection
  const named = typeof connection === 'string' ? connection.split(',') : []
  for (const name of named) delete out[name.trim().toLowerCase()]
  return out
}
