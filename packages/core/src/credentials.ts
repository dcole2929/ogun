/**
 * What a credential's expiry is, and what to conclude from it. Shared vocabulary.
 *
 * Three components have to agree about this and they run in three processes: the
 * **runner** classifies the files it holds and reports the answer, the **control plane**
 * judges that report before it dispatches a job, and the **CLI** prints it in
 * `ogun runner doctor`. The moment two of them keep their own copy of "expired", the
 * preflight and the machine can disagree about a machine — which is the exact failure
 * this vocabulary exists to end, so it lives in one place by this repo's convention.
 *
 * Reading a credential is *not* here and must not move here. That belongs with the thing
 * that injects it — `packages/gateway`, in the runner process, the only component that
 * ever touches `~/.claude/.credentials.json`. What crosses to the control plane is this:
 * an expiry, and never a token.
 *
 * Deliberately import-free. `@ogun/gateway` depends on this module and on nothing else in
 * the workspace; a yaml parser or a zod schema pulled in behind it would be paid for by
 * every process that starts the gateway. The wire schema for `CredentialOutlook` lives in
 * `api.ts` with the other wire schemas for the same reason.
 */

/**
 * When a credential stops working, as far as anything on its own host can tell.
 *
 * Four values, and the last three are three different things a boolean would collapse
 * into "fine" (principle 6). `never` is an API key, which genuinely does not expire.
 * `unrecorded` is a credential that may well expire and whose file does not say when — a
 * `~/.codex/auth.json` OAuth token, or a `claudeAiOauth` block in a shape we no longer
 * recognise. Refusing on `unrecorded` would refuse a working machine; calling it `never`
 * would promise something nothing has checked.
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
 * What the two model providers' credentials on one host look like.
 *
 * Deliberately the *fact* and not the judgement, and this is what makes it safe to send
 * over the wire and store. A caller establishes it once and then asks about several jobs,
 * each with its own run length; a health baked in here would answer all of them with the
 * first one's window — and a stored one would answer tomorrow's with today's.
 *
 * It is also the reason a report does not decay the way a "healthy/unhealthy" flag would.
 * `{ kind: 'at', expiresAt }` is an absolute instant: a report from ten minutes ago is
 * still exactly true about when that token dies. What *does* go stale is whether the
 * machine still holds that credential — see `RUNNER_STALE_MS` on the control plane.
 *
 * Only the two model providers. GitHub is absent on purpose: its absence is the intended
 * default (ADR-0005) and no job is ever refused over it, so reporting it would be
 * offering an answer nothing is allowed to act on.
 */
export type CredentialOutlook = {
  anthropic: CredentialExpiry
  openai: CredentialExpiry
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
 * Whether this health means a job would fail on auth rather than run.
 *
 * Named, rather than left as a `switch` in each of the three callers, because the two
 * halves are asymmetric and the asymmetry is the whole design: `absent`, `expired` and
 * `expiring` are things we *checked and found*; `no-expiry`, `unknown-expiry` and `valid`
 * include "we could not tell", which must never be answered "so, no". A caller writing
 * its own condition eventually writes `state !== 'valid'` and turns every codex job — whose
 * `auth.json` records no expiry anywhere — into a refusal.
 */
export const wouldFailAuth = (health: CredentialHealth): boolean =>
  health.state === 'absent' || health.state === 'expired' || health.state === 'expiring'

/**
 * How much life a Linear OAuth access token needs before a poll will use it as it stands
 * (ADR-0014).
 *
 * Here rather than beside the poll for the reason at the top of this file: three things
 * have to agree about it and they live in three packages. The **server** refreshes a grant
 * that falls inside this window, the **CLI** prints what `doctor` thinks of the same
 * grant, and the **web UI** colours a pill for it. The moment two of them keep their own
 * number, `doctor` says "expiring, act now" about a token the next poll renews by itself —
 * which teaches an operator to act on something that needs no action, and then to ignore
 * the line on the night it means something.
 *
 * Not zero, for the reason the preflight above exists: a poll reads up to `maxPages`
 * pages, and a token that passes "is it alive right now" can die between the second page
 * and the third. Ten minutes is far longer than any poll and short enough that a healthy
 * connection renews about once a day rather than continuously.
 */
export const GRANT_REFRESH_HORIZON_MS = 10 * 60 * 1000

/**
 * What every surface says about an OAuth grant's remaining life.
 *
 * Deliberately reassuring where the gateway's equivalent is alarming, and the difference is
 * a fact about the system rather than a matter of tone. `describeAnthropic` warns about an
 * expiring token because **nothing renews it** — the gateway re-reads a file the host's own
 * CLI refreshes, so an expired one needs a person at a terminal (ADR-0010). A Linear grant
 * is renewed by the next poll, from a refresh token Ogun owns outright, so the same warning
 * here would be telling somebody to fix what fixes itself.
 *
 * `ok` therefore stays true through `expired`, and the sentence names who does the renewing
 * rather than implying nobody will. What is *not* claimed is that the renewal will succeed:
 * a refresh token can be revoked at the other end, and the thing that finds out is the
 * poll, which records a refusal naming the connection. A status line cannot know that, and
 * says only what it knows.
 */
export function describeGrant(
  expiresAt: number | undefined,
  now = Date.now(),
): { ok: boolean; detail: string } {
  if (expiresAt === undefined) return { ok: false, detail: 'registered, not connected' }
  const health = credentialHealth(
    { kind: 'at', expiresAt },
    { now, horizonMs: GRANT_REFRESH_HORIZON_MS },
  )
  switch (health.state) {
    case 'valid':
      return { ok: true, detail: `oauth, ${humanDuration(health.msRemaining)} left` }
    case 'expiring':
      return {
        ok: true,
        detail: `oauth, ${humanDuration(health.msRemaining)} left — the next poll renews it`,
      }
    default:
      return {
        ok: true,
        detail:
          `oauth, expired ${humanDuration(health.state === 'expired' ? health.msElapsed : 0)} ` +
          'ago — the next poll renews it from the refresh token',
      }
  }
}

/**
 * How long, in the terse form `doctor`'s one-line details and admission's refusals use.
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
