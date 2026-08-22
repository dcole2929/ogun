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
  // sends completions (`/backend-api/codex/responses`, over a websocket); `api.openai.com`
  // is the API-key path; `auth.openai.com` is token refresh — where the gateway answers a
  // placeholder refresh itself rather than forwarding it (see synthetic.ts).
  //
  // `ab.chatgpt.com` is the codex analogue of `statsig.anthropic.com`: experiment
  // assignment, asked for on every start. Observed being refused in a live run — the run
  // survives it, it just pays for the refusal first. Named exactly rather than as
  // `*.chatgpt.com`, because the allowlist is what decides where the host's real OAuth
  // token is allowed to go and a wildcard hands it to every subdomain OpenAI ever adds.
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'ab.chatgpt.com',

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
 * This is the only host matcher in the system. `@ogun/core` carried a second one
 * (`isHostAllowed`) for the per-sandbox proxy that this gateway replaced; when that proxy
 * was deleted the matcher kept its tests and lost its callers, which is the worst state
 * for a security rule to be in — green, and enforcing nothing. The core copy went with
 * the proxy and its cases were moved here, onto the implementation that decides.
 */
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = normalize(hostname)
  const pat = normalize(pattern)
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1) // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix)
  }
  return host === pat
}

/**
 * Lowercased, with the DNS root's trailing dot dropped.
 *
 * Case, because DNS is case-insensitive and the CONNECT line is written by the *client*:
 * `API.GitHub.com` is the same host and must not be a way past the list.
 *
 * The trailing dot, because `api.anthropic.com.` is the fully-qualified spelling of the
 * same name and some clients emit it. Without this the comparison is byte-exact and the
 * fully-qualified form is refused — which fails closed rather than open, so it is not a
 * hole, but the symptom is an agent that cannot reach its model API for a reason nothing
 * in the error mentions. Stripped from the pattern too, so a hand-written `egress:` entry
 * with a stray dot behaves the same way.
 */
const normalize = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '')

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
  const [rawHost, rawPort] = bracketed
    ? [bracketed[1]!, bracketed[2]!]
    : splitOnLastColon(authority)
  if (!rawHost || rawPort === undefined) return null
  const port = strictPort(rawPort)
  return port === null ? null : { hostname: rawHost.toLowerCase(), port }
}

const splitOnLastColon = (authority: string): [string | undefined, string | undefined] => {
  const at = authority.lastIndexOf(':')
  return at <= 0 ? [undefined, undefined] : [authority.slice(0, at), authority.slice(at + 1)]
}

/**
 * A port, or nothing.
 *
 * `Number()` is not a port parser: it accepts `0x1bb`, `1e3`, `+443`, and `" 443"`, all of
 * which come back as plausible numbers from a string the *client* wrote. Digits only, and
 * the range check applies to every branch — the IPv6 arm used to return before reaching it,
 * so `[::1]:99999` parsed.
 */
function strictPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * The only port a sandbox has business reaching.
 *
 * Every entry on the allowlist is an HTTPS API, and the allowlist matches on hostname
 * alone — so without this, `CONNECT api.anthropic.com:22` is an allowlisted name pointing
 * at somebody else's SSH port, and the gateway would happily intercept and credential it.
 * The check was described in a comment here and enforced nowhere.
 */
export const ALLOWED_CONNECT_PORT = 443

export const isAllowedPort = (port: number): boolean => port === ALLOWED_CONNECT_PORT

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
  // Every spelling of the path the origin server would accept, not just the one on the
  // wire. GitHub percent-decodes before routing, so `/git-receive-pac%6b` is a push — and
  // a matcher that compares the raw bytes says it is not. That is a one-curl walk around
  // ADR-0005, live in exactly the configuration the rule exists for (a GitHub token
  // configured). Case-insensitive for the same reason: it costs nothing and removes the
  // next variant of the same trick.
  return spellings(path).some((candidate) => matchesPush(method, candidate))
}

function spellings(path: string): string[] {
  const lower = path.toLowerCase()
  const out = [lower]
  try {
    // Repeated, because `%2569` decodes to `%69` decodes to `i`. Bounded at three passes:
    // a fixed point is normal, and a path that is still changing after three rounds is not
    // a path anyone legitimately sent.
    let decoded = lower
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      out.push(decoded)
    }
  } catch {
    // A malformed escape cannot be decoded, so it cannot be reasoned about. Treated as a
    // push if it looks anything like one, on the principle that this rule refuses rather
    // than permits when it cannot tell.
    out.push(lower.replaceAll('%', ''))
  }
  return out
}

function matchesPush(method: string, path: string): boolean {
  const [base = '', query = ''] = path.split('?', 2)
  if (base.endsWith('/git-receive-pack')) return true
  return (
    method.toUpperCase() === 'GET' &&
    base.endsWith('/info/refs') &&
    query.split('&').includes('service=git-receive-pack')
  )
}
