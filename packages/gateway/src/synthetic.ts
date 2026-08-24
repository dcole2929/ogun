import { PLACEHOLDER } from './stubs.ts'

/**
 * The one request the gateway answers itself instead of forwarding.
 *
 * Everything else in this component rewrites a request and sends it on. This does the
 * opposite: it short-circuits, because the request cannot be made to succeed and its
 * failure kills the run.
 *
 * The failure, observed live and not by analogy. Codex 0.149 on a ChatGPT subscription
 * reads `~/.codex/auth.json`, finds the placeholder tokens the sandbox was given, and —
 * on its own schedule, and again the moment any request comes back 401 —
 * `POST`s `auth.openai.com/oauth/token` with `grant_type=refresh_token` and the
 * placeholder `refresh_token`. OpenAI answers that, correctly, with
 * `401 invalid_client`, and Codex stops with:
 *
 *     ERROR: Your access token could not be refreshed. Please log out and sign in again.
 *
 * There is no placeholder that avoids this. `stubs.ts` already stamps `last_refresh` with
 * the current time for exactly this reason and it is not enough: this Codex refreshes
 * reactively as well as on a timer, so the first 401 from anywhere sends it down the same
 * path. The only thing the *container* could do about it is hold a real refresh token,
 * which is the property this whole component exists to remove.
 *
 * So the gateway answers. Codex gets a 200, writes whatever it was handed into its own
 * `auth.json`, stamps `last_refresh`, and goes quiet.
 *
 * ── What it is handed, and why not the real token ─────────────────────────────
 *
 * Another placeholder. The reference implementation this pattern is taken from hands back
 * the real cached access token here, and copying that would undo everything: the token
 * would be written to `~/.codex/auth.json` *inside* the container, on disk, readable by
 * the agent — the exact file ADR-0010 removed. A placeholder is enough because the client
 * never needs a working token: `injectionsFor()` rewrites `authorization` on every
 * request to a provider host regardless of what arrived, so what Codex stores is only
 * ever presented to this process, which throws it away.
 *
 * ── Why it is keyed on the placeholder, not on the host ───────────────────────
 *
 * Only a refresh *of the placeholder* is answered. A refresh carrying a real refresh
 * token is forwarded to `auth.openai.com` untouched — that is a host-side `codex`
 * refreshing its own credential through the gateway on a `worktree` sandbox, and
 * answering it synthetically would break the host's login by writing a placeholder over a
 * real token. Matching on the sentinel is what keeps those two cases apart, and it is why
 * `PLACEHOLDER` is compared exactly rather than "does this look fake".
 */

/** Where a Codex token refresh goes. Not a pattern: one host, one path, one method. */
const REFRESH_HOST = 'auth.openai.com'
const REFRESH_PATH = '/oauth/token'
const REFRESH_METHOD = 'POST'

/**
 * The most body the gateway will hold in memory to decide whether to answer it.
 *
 * A token refresh is a few hundred bytes. The bound exists so that this check can never
 * be turned into a way to make the runner buffer an arbitrary upload: anything larger, or
 * anything that does not declare its length, is forwarded as a stream and never inspected.
 */
export const MAX_SYNTHETIC_BODY_BYTES = 8 * 1024

/**
 * Cheap pre-match, run on host/method/path before any body is touched.
 *
 * Separate from `syntheticRefresh` on purpose: every request through the gateway runs
 * this, and only the handful that match pay for having their body buffered.
 */
export function isSyntheticRefreshTarget(
  hostname: string,
  method: string,
  path: string,
): boolean {
  if (hostname.trim().toLowerCase().replace(/\.$/, '') !== REFRESH_HOST) return false
  if (method.toUpperCase() !== REFRESH_METHOD) return false
  return (path.split('?', 1)[0] ?? '') === REFRESH_PATH
}

/**
 * `content-length` present and small enough to buffer.
 *
 * A missing or unparseable length means the body's size is not knowable before reading
 * it, so the request is forwarded rather than inspected. Failing that way round is the
 * safe one: the worst case is the refusal Codex was already getting, not an unbounded
 * read.
 */
export function bodyIsBufferable(contentLength: string | string[] | undefined): boolean {
  if (typeof contentLength !== 'string') return false
  if (!/^\d{1,10}$/.test(contentLength.trim())) return false
  return Number(contentLength.trim()) <= MAX_SYNTHETIC_BODY_BYTES
}

export type SyntheticResponse = { status: number; body: string }

/**
 * Seconds put in `expires_in`.
 *
 * Codex does not read it — its refresh timing comes from `last_refresh` and from the
 * `id_token` claims — so this is cosmetic. Kept large so that a different client that
 * *did* read it would not immediately refresh again and rediscover this code path.
 */
const SYNTHETIC_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60

/**
 * The answer to a placeholder refresh, or `undefined` to forward the request.
 *
 * `id_token` is deliberately absent. The stub's `id_token` is a JWT that Codex has
 * already parsed for the plan type and account id; returning a *new* one means Codex
 * re-parses whatever is here, and anything that is not a well-formed JWT with the claims
 * it expects fails the refresh it was meant to satisfy. Omitting the field leaves the one
 * Codex already accepted in place.
 */
export function syntheticRefresh(body: string): SyntheticResponse | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON, so not a refresh this understands. Forwarded, and OpenAI can say what is
    // wrong with it — the gateway does not get to decide that a malformed request fails.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const fields = parsed as Record<string, unknown>
  if (fields.grant_type !== 'refresh_token') return undefined
  if (fields.refresh_token !== PLACEHOLDER) return undefined
  return {
    status: 200,
    body: JSON.stringify({
      access_token: PLACEHOLDER,
      refresh_token: PLACEHOLDER,
      token_type: 'Bearer',
      expires_in: SYNTHETIC_EXPIRES_IN_SECONDS,
    }),
  }
}
