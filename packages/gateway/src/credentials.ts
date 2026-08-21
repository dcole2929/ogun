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

// ── When a credential stops working ────────────────────────────────────────
//
// The gateway does not refresh anything; it re-reads the files the host's own CLIs
// rewrite when a human uses them. On a runner nobody logs into, nothing rewrites them,
// the access token lapses, and the gateway goes on injecting a dead one — every job
// fails on auth at 3am and the only evidence is a provider 401 inside an agent
// transcript, which names the wrong cause and sends whoever reads it to re-authenticate
// something that was fine.
//
// So the expiry is turned into a fact two preflights can act on: `ogun runner doctor`
// before the night, and admission before a job is dispatched (§4.3). Both ask the same
// question of the same data and want different answers out of it, which is why the fact
// and the judgement are separate types below.

/**
 * When a credential stops working, as far as anything on this host can tell.
 *
 * Four values, and the last three are three different things a boolean would collapse
 * into "fine" (principle 6). `never` is an API key, which genuinely does not expire.
 * `unrecorded` is a credential that may well expire and whose file does not say when — a
 * `~/.codex/auth.json` OAuth token, or a `claudeAiOauth` block in a shape we no longer
 * recognise. Refusing on `unrecorded` would refuse a working machine; calling it `never`
 * would promise something nothing here has checked.
 */
export type CredentialExpiry =
  | { kind: 'absent' }
  | { kind: 'never' }
  | { kind: 'unrecorded' }
  | { kind: 'at'; expiresAt: number }

/**
 * A `CredentialExpiry` judged against a clock and a horizon.
 *
 * The horizon is what makes this a preflight rather than a status line. "Is it valid
 * right now?" is the wrong question when the thing asking is about to start a job that
 * runs for half an hour: a token with five minutes left passes that test and dies
 * mid-stream, which is the same 3am 401 arriving slightly later. So callers pass the
 * window they actually care about — a worker's `timeoutMs` for admission, an hour for
 * `doctor` — and `expiring` is the answer that separates the two.
 */
export type CredentialHealth =
  | { state: 'absent' }
  | { state: 'no-expiry' }
  | { state: 'unknown-expiry' }
  | { state: 'valid'; expiresAt: number; msRemaining: number }
  | { state: 'expiring'; expiresAt: number; msRemaining: number }
  | { state: 'expired'; expiresAt: number; msElapsed: number }

/**
 * The lower bound on an `expiresAt` this module will believe: 2001-09-09, the moment
 * epoch-milliseconds passed 1e12.
 *
 * `claudeAiOauth.expiresAt` is epoch milliseconds today. If a future version of the CLI
 * writes seconds instead — the more common convention, and exactly the kind of thing a
 * third-party format changes without telling anyone — the value lands near 1.7e9, and
 * subtracting it from `Date.now()` reports a token that expired fifty-four years ago.
 * That is no longer a status line; downstream it is an admission refusal, so every job on
 * the machine would be refused indefinitely with a reason that reads as certain.
 *
 * A number that cannot be interpreted is `unrecorded`, never `expired`. "I do not
 * understand this" and "I checked, and it is dead" are different facts (principle 6).
 */
const EPOCH_MS_FLOOR = 1e12

/** What a credential's own shape says about its expiry. No clock involved. */
export function credentialExpiry(credential: Credential | undefined): CredentialExpiry {
  if (!credential) return { kind: 'absent' }
  // Env-supplied, and a fine-grained PAT does expire — nothing here can see when.
  if (credential.provider === 'github') return { kind: 'unrecorded' }
  if (credential.mode === 'api-key') return { kind: 'never' }
  if (credential.provider === 'openai') {
    /**
     * `~/.codex/auth.json` records no expiry in the fields this module reads.
     *
     * The access token is a JWT and its `exp` could be pulled out of the payload. Not
     * done, deliberately: that adds an unverified parse of a credential body to the one
     * code path that must not throw, in order to predict an answer the provider gives
     * authoritatively in a 401. Codex jobs are therefore never refused on expiry grounds,
     * and `doctor` says so rather than implying it looked.
     */
    return { kind: 'unrecorded' }
  }
  const expiresAt = credential.expiresAt
  if (expiresAt === undefined || expiresAt < EPOCH_MS_FLOOR) return { kind: 'unrecorded' }
  return { kind: 'at', expiresAt }
}

/**
 * `expiry` judged at `now`, against a window the caller says it needs.
 *
 * The boundaries are the whole content of this function. A token whose `expiresAt` is
 * exactly `now` is expired rather than expiring — the next request it is spliced into
 * fails. A `horizonMs` of zero asks only "is it alive right now" and can never return
 * `expiring`, which is what a caller with no run to protect should pass.
 */
export function credentialHealth(
  expiry: CredentialExpiry,
  { now = Date.now(), horizonMs = 0 }: { now?: number; horizonMs?: number } = {},
): CredentialHealth {
  switch (expiry.kind) {
    case 'absent':
      return { state: 'absent' }
    case 'never':
      return { state: 'no-expiry' }
    case 'unrecorded':
      return { state: 'unknown-expiry' }
    default: {
      const msRemaining = expiry.expiresAt - now
      if (msRemaining <= 0) {
        return { state: 'expired', expiresAt: expiry.expiresAt, msElapsed: -msRemaining }
      }
      const state = msRemaining <= horizonMs ? 'expiring' : 'valid'
      return { state, expiresAt: expiry.expiresAt, msRemaining }
    }
  }
}

/**
 * What the two model providers' credentials on this host look like right now.
 *
 * Deliberately the *fact* and not the judgement. A caller establishes this once and then
 * asks about several jobs, each with its own run length; a health baked in here would
 * answer all of them with the first one's window.
 */
export type CredentialOutlook = {
  anthropic: CredentialExpiry
  openai: CredentialExpiry
}

export const credentialOutlook = (set: CredentialSet): CredentialOutlook => ({
  anthropic: credentialExpiry(set.anthropic),
  openai: credentialExpiry(set.openai),
})

/**
 * How long, in the terse form `doctor`'s one-line details use.
 *
 * Minutes below ninety, and that is the point of the function rather than a nicety.
 * Rounding to whole hours renders "expires in 42 minutes" as "1h left" and "expired
 * eleven minutes ago" as "EXPIRED 0h ago" — so the one window this preflight exists to
 * warn about was the one window the string could not express.
 */
export function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(ms / 36e5)
  return hours < 48 ? `${hours}h` : `${Math.round(ms / 864e5)}d`
}

/**
 * How far ahead `ogun runner doctor` looks.
 *
 * A worker's `timeoutMs` defaults to thirty minutes, so an hour is the longest job this
 * machine is likely to be handed plus the time it may sit in the queue first. Wider than
 * that and the warning fires on a token in the ordinary middle of its life, which teaches
 * whoever reads the output to skip the line.
 */
export const DOCTOR_EXPIRY_HORIZON_MS = 60 * 60_000

export type CredentialStatus = {
  provider: Provider
  present: boolean
  detail: string
  /**
   * The classification behind `detail`, so a caller can branch on it instead of matching
   * the prose. `doctor` degrades a check to a warning on `expiring` and `expired`, and a
   * check that decided that by grepping its own message would start passing silently the
   * first time the wording changed.
   */
  health: CredentialHealth
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
export function credentialStatuses(
  set: CredentialSet,
  now = Date.now(),
  horizonMs = DOCTOR_EXPIRY_HORIZON_MS,
): CredentialStatus[] {
  const health = (credential: Credential | undefined): CredentialHealth =>
    credentialHealth(credentialExpiry(credential), { now, horizonMs })

  const anthropic = health(set.anthropic)
  return [
    {
      provider: 'anthropic',
      present: Boolean(set.anthropic),
      health: anthropic,
      detail: describeAnthropic(anthropic),
    },
    {
      provider: 'openai',
      present: Boolean(set.openai),
      health: health(set.openai),
      detail: !set.openai
        ? 'none — the codex runtime cannot authenticate'
        : set.openai.mode === 'api-key'
          ? 'api key — does not expire'
          : // Said out loud rather than left blank: a missing warning must not read as a
            // token that was checked and found healthy (principle 6).
            'chatgpt oauth — auth.json records no expiry, so this is not preflighted',
    },
    {
      provider: 'github',
      present: Boolean(set.github),
      health: health(set.github),
      detail: set.github
        ? 'OGUN_GATEWAY_GITHUB_TOKEN — read-only; pushes are refused (ADR-0005)'
        : 'none — public reads only, which is the intended default',
    },
  ]
}

/**
 * The fix belongs in the message, and there are two of them because they are fixes for
 * two different machines: `claude` on the host is the two-minute answer for a
 * workstation, and `ANTHROPIC_API_KEY` is the answer for a runner nobody logs into, where
 * an OAuth token will simply lapse again tomorrow night (§4.6, docs/setup.md).
 */
const REFRESH_HINT =
  'run `claude` on this host, or set ANTHROPIC_API_KEY for an unattended runner'

function describeAnthropic(health: CredentialHealth): string {
  switch (health.state) {
    case 'absent':
      return `none — the claude runtime cannot authenticate. ${REFRESH_HINT}`
    case 'no-expiry':
      return 'ANTHROPIC_API_KEY — does not expire'
    case 'unknown-expiry':
      return 'oauth, no expiry recorded'
    case 'valid':
      return `oauth, ${humanDuration(health.msRemaining)} left`
    case 'expiring':
      return (
        `oauth, only ${humanDuration(health.msRemaining)} left — a job starting now would ` +
        `401 partway. ${REFRESH_HINT}`
      )
    default:
      return `oauth, EXPIRED ${humanDuration(health.msElapsed)} ago — ${REFRESH_HINT}`
  }
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
