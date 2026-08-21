import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the real credentials live, and how the gateway gets at them.
 *
 * They live exactly where they lived before — `~/.claude/.credentials.json` and
 * `~/.codex/auth.json` on the runner host. What changes is who reads them. Before, the
 * files were bind-mounted into every sandbox and copied into a writable home by
 * `entrypoint.sh`, so a prompt-injected agent could simply `cat` its own OAuth token and
 * post it somewhere. Now nothing but this module reads them, and it runs in the runner
 * process, on the host, outside every container.
 */

export type AnthropicCredential =
  | { provider: 'anthropic'; mode: 'oauth'; accessToken: string; expiresAt?: number }
  | { provider: 'anthropic'; mode: 'api-key'; apiKey: string }

export type OpenAiCredential =
  | { provider: 'openai'; mode: 'oauth'; accessToken: string; accountId?: string }
  | { provider: 'openai'; mode: 'api-key'; apiKey: string }

export type GitHubCredential = { provider: 'github'; token: string }

export type Credential = AnthropicCredential | OpenAiCredential | GitHubCredential
export type Provider = Credential['provider']

export type CredentialSet = {
  anthropic?: AnthropicCredential
  openai?: OpenAiCredential
  github?: GitHubCredential
}

export type CredentialPaths = {
  claudeCredentials: string
  codexAuth: string
  env: Record<string, string | undefined>
}

export const defaultCredentialPaths = (): CredentialPaths => ({
  claudeCredentials: join(homedir(), '.claude', '.credentials.json'),
  codexAuth: join(homedir(), '.codex', 'auth.json'),
  env: process.env,
})

/**
 * Read what is on disk right now.
 *
 * Deliberately not a one-shot load at startup. Both CLIs refresh their own OAuth tokens
 * when a human uses them on the host, rewriting these files in place; a gateway that read
 * them once would keep serving the token it saw at boot and start 401-ing somewhere
 * between one and eight hours later, on a long-lived runner, at night. Re-reading is two
 * small files and is memoised below.
 *
 * Note what is *not* read: `mcpOAuth`. `~/.claude/.credentials.json` on a working machine
 * also holds live OAuth access AND refresh tokens for every MCP server the user has
 * connected — Linear, PostHog, whatever else. Mounting that file into a sandbox leaked
 * all of them, which is strictly worse than the "worst case is burning rate limit" that
 * §4.6 claimed. The gateway injects for three providers and reads exactly the fields
 * those three need.
 */
export function readCredentials(paths = defaultCredentialPaths()): CredentialSet {
  const set: CredentialSet = {}

  const claude = readJson(paths.claudeCredentials)
  const oauth = asRecord(claude?.claudeAiOauth)
  const accessToken = asString(oauth?.accessToken)
  if (accessToken) {
    const expiresAt = asNumber(oauth?.expiresAt)
    set.anthropic =
      expiresAt === undefined
        ? { provider: 'anthropic', mode: 'oauth', accessToken }
        : { provider: 'anthropic', mode: 'oauth', accessToken, expiresAt }
  }
  // An explicit API key wins over the subscription token. It is the narrower, more
  // deliberate act — you set it for this process — and it is the only way to point a run
  // at a different account than the one the host's `claude` is logged into.
  const anthropicKey = paths.env.ANTHROPIC_API_KEY?.trim()
  if (anthropicKey) set.anthropic = { provider: 'anthropic', mode: 'api-key', apiKey: anthropicKey }

  const codex = readJson(paths.codexAuth)
  const tokens = asRecord(codex?.tokens)
  const codexAccess = asString(tokens?.access_token)
  if (asString(codex?.auth_mode) === 'chatgpt' && codexAccess) {
    const accountId = asString(tokens?.account_id)
    set.openai = accountId
      ? { provider: 'openai', mode: 'oauth', accessToken: codexAccess, accountId }
      : { provider: 'openai', mode: 'oauth', accessToken: codexAccess }
  }
  const codexKey = asString(codex?.OPENAI_API_KEY) ?? paths.env.OPENAI_API_KEY?.trim()
  if (codexKey && !set.openai) set.openai = { provider: 'openai', mode: 'api-key', apiKey: codexKey }

  /**
   * GitHub is opt-in and env-only, and defaults to absent.
   *
   * There is no discovery here — no `gh auth token`, no `~/.config/gh/hosts.yml`. ADR-0005
   * is that the sandbox never pushes and no git credential enters it; a gateway that went
   * looking for one would quietly re-grant, through a different door, the thing that ADR
   * removed. A token has to be handed over on purpose, by name, and even then
   * `isGitPushRequest` refuses to carry a push with it.
   */
  const githubToken = paths.env.OGUN_GATEWAY_GITHUB_TOKEN?.trim()
  if (githubToken) set.github = { provider: 'github', token: githubToken }

  return set
}

/**
 * `readCredentials` behind a short memo.
 *
 * Five seconds, not five minutes: the point of re-reading is that a host-side refresh
 * reaches an in-flight job, and a window longer than a retry backoff defeats that. Not
 * zero either — a streaming run makes a request per turn and the files are read under a
 * lock nobody else holds, but a sync read on the proxy's event loop per request is a
 * cost with no matching benefit.
 */
export function credentialReader(
  paths = defaultCredentialPaths(),
  ttlMs = 5_000,
): () => CredentialSet {
  let at = 0
  let cached: CredentialSet = {}
  return () => {
    if (Date.now() - at >= ttlMs) {
      cached = readCredentials(paths)
      at = Date.now()
    }
    return cached
  }
}

export type CredentialStatus = {
  provider: Provider
  present: boolean
  detail: string
}

/**
 * What `ogun runner doctor` prints.
 *
 * The expiry line is the one that earns this function. The gateway does not refresh an
 * Anthropic OAuth token — it re-reads the file the host's own `claude` refreshes — so an
 * expired token is a real, recoverable state whose only symptom is otherwise a 401 buried
 * in an agent transcript at 3am. Saying "expired 6h ago, run `claude` once on this host"
 * is the difference between a two-minute fix and an evening.
 */
export function credentialStatuses(set: CredentialSet, now = Date.now()): CredentialStatus[] {
  const anthropic = set.anthropic
  const openai = set.openai
  return [
    {
      provider: 'anthropic',
      present: Boolean(anthropic),
      detail: !anthropic
        ? 'none — the claude runtime cannot authenticate'
        : anthropic.mode === 'api-key'
          ? 'ANTHROPIC_API_KEY'
          : describeExpiry(anthropic.expiresAt, now),
    },
    {
      provider: 'openai',
      present: Boolean(openai),
      detail: !openai
        ? 'none — the codex runtime cannot authenticate'
        : openai.mode === 'api-key'
          ? 'api key'
          : 'chatgpt oauth',
    },
    {
      provider: 'github',
      present: Boolean(set.github),
      detail: set.github
        ? 'OGUN_GATEWAY_GITHUB_TOKEN — read-only; pushes are refused (ADR-0005)'
        : 'none — public reads only, which is the intended default',
    },
  ]
}

function describeExpiry(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'oauth, no expiry recorded'
  const hours = Math.round((expiresAt - now) / 36e5)
  if (hours < 0) {
    return `oauth, EXPIRED ${-hours}h ago — run \`claude\` once on this host to refresh it`
  }
  return `oauth, ${hours}h left`
}

// ── Reading JSON that a human's tooling wrote ───────────────────────────────
//
// Every accessor is total. These files are written by two third-party CLIs that change
// their own formats, and the failure this guards against is not a crash — it is a runner
// that crashes *on the credential path* and so cannot report why. A missing field means
// "no credential", which `doctor` and the 502 body both say out loud.

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
