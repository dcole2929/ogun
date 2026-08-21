/**
 * Which hosts a sandbox may reach, and the one request shape that is refused everywhere.
 *
 * The allowlist is not the security property this component exists for — a gateway that
 * splices credentials in at the wire already means the container has nothing to steal,
 * allowlist or no allowlist. What the allowlist buys is narrower and still worth having:
 * a compromised agent cannot use the *gateway's own* connection to reach an arbitrary
 * host, so the credentials it does hold (none) plus the network it does have (this list)
 * are both bounded and both writable down.
 *
 * ADR-0005 is explicit that exfiltration through the model API is a different and harder
 * problem, and this does not solve it. `api.anthropic.com` is on the list, and anything
 * an agent can put in a prompt leaves through it.
 */

/**
 * Everything a job needs to run, and nothing else.
 *
 * Grouped by *why* each entry is here, because the temptation whenever a job fails is to
 * add a host and move on, and six months later nobody can tell which entries are load
 * bearing. An entry with no reason next to it is an entry that should not be here.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  // The claude runtime. `statsig` is feature-flag delivery: blocking it does not fail a
  // run, it makes every start pay a connect timeout first.
  'api.anthropic.com',
  'statsig.anthropic.com',
  // The OAuth token endpoint. The gateway does not currently refresh (see credentials.ts),
  // but a host-side `claude` refreshing its own token goes through here on a worktree
  // sandbox, and blocking it would break that for no gain.
  'console.anthropic.com',

  // The codex runtime. `chatgpt.com` is where a ChatGPT-subscription Codex actually
  // sends completions (`/backend-api/codex/responses`); `api.openai.com` is the API-key
  // path; `auth.openai.com` is token refresh.
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',

  // Reading a repository the job did not clone: a reviewer following a dependency to its
  // source, an agent checking an upstream issue. Never *writing* one — see
  // `isGitPushRequest`.
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',

  // A project's own test suite (§4.10's verification gate) installs dependencies. Today
  // egress is `open` and this simply works; a gateway that omitted these would turn every
  // modifier's test gate red and be blamed on the modifier.
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
]

/**
 * `example.com` matches itself; `*.example.com` matches any strict subdomain.
 *
 * Strict: `*.example.com` does NOT match `example.com`, and it does not match
 * `evilexample.com`. The second is the one that bites — a naive `endsWith('.example.com')`
 * against a hostname of `notexample.com` is fine, but `endsWith('example.com')` is not,
 * and the difference is one character in a file nobody re-reads.
 *
 * Comparison is case-insensitive because DNS is, and a CONNECT line is written by the
 * client: `API.GitHub.com` is the same host and must not be a way past the list.
 */
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase()
  const pat = pattern.toLowerCase()
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1) // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix)
  }
  return host === pat
}

export const isAllowedHost = (hostname: string, allowed: readonly string[]): boolean =>
  allowed.some((pattern) => hostMatches(pattern, hostname))

/**
 * A CONNECT authority (`host:port`) split into its parts.
 *
 * Returns the port because a proxy that ignores it will happily tunnel to
 * `api.anthropic.com:22`, which is an allowlisted host and somebody else's SSH server.
 * IPv6 literals arrive bracketed (`[::1]:443`) and their colons are not the separator.
 */
export function parseAuthority(authority: string): { hostname: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(authority)
  if (bracketed) return { hostname: bracketed[1]!.toLowerCase(), port: Number(bracketed[2]) }
  const at = authority.lastIndexOf(':')
  if (at <= 0) return null
  const hostname = authority.slice(0, at).toLowerCase()
  const port = Number(authority.slice(at + 1))
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { hostname, port }
}

/**
 * A push, in either of the two shapes it arrives in.
 *
 * ADR-0005 says the sandbox never pushes, and the gateway is the second place that can
 * now be made true rather than merely intended. It is refused unconditionally — not by an
 * allowlist entry, not by a policy rule, and not only when a GitHub credential happens to
 * be injectable — because the reason is not "we did not grant that", it is "a proxy cannot
 * make this safe". A proxy sees `POST /owner/repo/git-receive-pack`; the refs being
 * written live in a pkt-line body nothing here parses. Allowing the repo means allowing a
 * force-push to `main`, and the granularity to say otherwise does not exist at this layer.
 *
 * Git push is two-phase: `GET /owner/repo/info/refs?service=git-receive-pack` discovers
 * the remote's refs, then `POST /owner/repo/git-receive-pack` sends the pack. Refusing
 * only the POST would let the discovery succeed, and `git push` would report a confusing
 * mid-transfer failure after uploading the objects instead of failing immediately with
 * the reason.
 */
export function isGitPushRequest(method: string, path: string): boolean {
  const [base = '', query = ''] = path.split('?', 2)
  if (base.endsWith('/git-receive-pack')) return true
  return (
    method.toUpperCase() === 'GET' &&
    base.endsWith('/info/refs') &&
    query.split('&').includes('service=git-receive-pack')
  )
}
