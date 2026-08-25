import {
  credentialHealth,
  GRANT_REFRESH_HORIZON_MS,
  NoOAuthApp,
  readOAuthApp,
  sealSecret,
  storeOAuthGrant,
  type OAuthGrant,
  type SecretName,
} from '@ogun/core'
import { LinearOAuthError, refreshGrant, type Fetch } from '../integrations/linear-oauth.ts'
import type { LinearCredential } from '../integrations/linear.ts'

/**
 * Keeping a 24-hour token alive for a poller that wakes at 3am (ADR-0014).
 *
 * ### The problem, stated at the size it actually is
 *
 * A Linear access token lasts 24 hours. A source polls every five minutes when the control
 * plane is up, and the machine this runs on is a workstation that gets closed, a VPS that
 * gets restarted, or a laptop that sleeps. So the interesting case is not "the token
 * expires while we are watching" — it is "the process starts, or wakes, holding a token
 * that died some hours ago", and that is the *ordinary* case rather than the edge one.
 *
 * ### Refresh on demand, immediately before the poll that needs it
 *
 * Three designs were on the table.
 *
 * **A timer that refreshes every twenty hours.** Rejected first, and it is the one that
 * looks most like what a token lifetime asks for. It refreshes in a process that may not
 * be running: the machine that has been asleep since yesterday evening has no timer, and
 * the token is dead before the first tick ever fires. It also refreshes when nothing needs
 * a token — spending a rotation, and therefore a chance to lose one, on a night when no
 * source was due.
 *
 * **React to a 401.** Rejected second, and it is the design that costs the most on the
 * night it matters. The poll has already spent a request; Linear answers an expired token
 * with `AUTHENTICATION_ERROR`, which is the same code it answers a *revoked* token with,
 * so the reactive path cannot tell "refresh this" from "this connection is over" without
 * trying — and `source_polls` records a failure for a poll that was always going to need
 * one round trip. It is also the shape ADR-0010 already declined for the model providers,
 * where the answer was "catch the lapse before it costs a night".
 *
 * **Refresh on demand, here, before the request.** Chosen. The poll is the only thing that
 * knows it is about to need a token, and it knows this at the one moment when doing
 * something about it is free. The check is `credentialHealth` — the same function the
 * credential preflight uses, against a horizon — so a token with four minutes left is
 * refreshed rather than used and lost halfway through a paged read.
 *
 * ### How this relates to the credential preflight, which is a different thing
 *
 * `fleetCredentials` and admission refuse a *job* whose model-provider credential will not
 * outlive it. This grant is not part of that and must not become part of it: nothing about
 * Linear reaches a sandbox (ADR-0010, ADR-0012), so a job emitted from a ticket does not
 * authenticate to Linear at all and refusing it over a Linear token would be refusing work
 * for a credential it never uses. What is shared is the *vocabulary* — `CredentialExpiry`,
 * `credentialHealth`, `humanDuration` — so that "expires in 42 minutes" means the same
 * thing in `doctor` whether it is about Anthropic or about a workspace. The grant gates the
 * poll; the preflight gates the job.
 *
 * ### The ADR-0010 trap that does not apply, and the one that does
 *
 * ADR-0010 rejected refreshing an OAuth token because the provider **rotates the refresh
 * token on use** — and Linear does, explicitly: "a new valid access token and a new refresh
 * token will be returned". There, the credential was *borrowed* from
 * `~/.claude/.credentials.json`, which a human's own `claude` also reads and writes, so
 * spending the refresh token logged them out of their own CLI by a background process they
 * did not know existed. **That does not apply here.** Ogun obtained this grant for itself,
 * through a flow it ran; no other program on the machine has a copy; there is no user-facing
 * CLI whose session this can end. Rotation costs nothing because nobody else is holding the
 * thing being rotated.
 *
 * The trap that *does* apply is the second one ADR-0010 named: two writers racing over a
 * credential file. It is handled rather than argued away — the write goes through
 * `storeOAuthGrant` and therefore `updateLocalConfig`'s lock, which is the same lock
 * `ogun project add` and a runner joining take, and which was itself recently fixed for a
 * race where it deleted a live lock. One writer, not a second one racing the first.
 */

export type GrantDeps = {
  readApp?: typeof readOAuthApp
  store?: typeof storeOAuthGrant
  refresh?: typeof refreshGrant
  fetch?: Fetch
  now?: () => number
}

/**
 * A credential a poll can use, or the reason it cannot — as the two outcomes
 * `source_polls` already distinguishes.
 *
 * `refused` is a fact about the configuration that will still be true in five minutes: the
 * connection is over, the application is gone, the entry is unreadable. `failed` is a fact
 * about this moment: the network, or Linear. They are kept apart because the ledger is the
 * only evidence a source leaves, and a `refused` row tells an operator to go and do
 * something while a `failed` row tells them to look again tomorrow.
 */
export type UsableGrant =
  | { state: 'ready'; credential: LinearCredential; expiresAt: number; refreshed: boolean }
  | { state: 'refused'; detail: string }
  | { state: 'failed'; detail: string }

/**
 * One refresh per project at a time, across the whole process.
 *
 * A module-level map, which this repository is otherwise suspicious of — `4525a43` exists
 * because two concurrent things shared one mutable global. It is right here for the reason
 * it was wrong there: the *point* is to be shared. A per-call map single-flights nothing,
 * and the thing being prevented is two callers in one process spending the same refresh
 * token, which only a process-wide rendezvous can prevent.
 *
 * The window is real rather than theoretical. `main.ts` drives `pollSources` from an
 * interval that does not await its callback, so two ticks overlap whenever a poll takes
 * longer than the interval — and two sources in one project would then both find the same
 * expiring grant.
 *
 * The residual race, stated: two *processes* sharing one config.json would still both
 * refresh. That is not a supported configuration (one control plane polls), and Linear's
 * 30-minute replay window for a consumed refresh token means even that case recovers —
 * the second spend returns the same new pair rather than failing. Single-flight is here to
 * make the ordinary case cheap and legible, not because the alternative corrupts anything.
 */
const inFlight = new Map<string, Promise<UsableGrant>>()

export async function usableGrant(
  projectSlug: string,
  provider: SecretName,
  grant: OAuthGrant,
  deps: GrantDeps = {},
): Promise<UsableGrant> {
  const now = deps.now?.() ?? Date.now()
  const health = credentialHealth(
    { kind: 'at', expiresAt: grant.expiresAt },
    { now, horizonMs: GRANT_REFRESH_HORIZON_MS },
  )

  if (health.state === 'valid') {
    return {
      state: 'ready',
      credential: bearer(grant),
      expiresAt: grant.expiresAt,
      refreshed: false,
    }
  }

  // `provider:slug` rather than a separator that has to be argued about. `provider` is
  // a `SecretName`, a closed set of literals with no colon in any of them, so the two
  // halves cannot run together into another pair’s key.
  const key = `${provider}:${projectSlug}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const attempt = refreshOnce(projectSlug, provider, grant, deps, now).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, attempt)
  return attempt
}

async function refreshOnce(
  projectSlug: string,
  provider: SecretName,
  grant: OAuthGrant,
  deps: GrantDeps,
  now: number,
): Promise<UsableGrant> {
  const app = await (deps.readApp ?? readOAuthApp)(projectSlug, provider)
  if (app.state !== 'present') {
    /**
     * A grant with no application behind it. `storeOAuthGrant` refuses to create this and
     * `setOAuthApp` drops a grant whose client id changed, so reaching it means a hand-edit
     * of config.json — which §4.5 says happens. Said plainly rather than reported as an
     * expired token, because the fix is to register the application, not to reconnect.
     */
    return {
      state: 'refused',
      detail:
        `"${projectSlug}" has a ${provider} grant with no application behind it ` +
        `(${app.state}), so its access token cannot be refreshed. Register the ` +
        'application again and reconnect',
    }
  }

  let tokens
  try {
    tokens = await (deps.refresh ?? refreshGrant)({
      refreshToken: grant.refresh.expose(),
      clientId: app.app.clientId,
      clientSecret: app.app.clientSecret.expose(),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    /**
     * The one branch where getting it wrong destroys something. A `transport` failure
     * leaves the stored refresh token exactly where it is — nothing here deletes it —
     * because Linear's 30-minute replay window is what turns "the response never arrived"
     * into "try again shortly", and a client that discarded its token on a timeout has
     * thrown away a connection over a blip.
     *
     * Only `invalid-grant` and `config` are permanent, and even those do not delete: an
     * operator disconnects deliberately, from a surface that says what it is doing. A
     * poller silently erasing a credential at 3am is the destructive write `empty` exists
     * to make visible one field over.
     */
    const permanent = err.kind === 'invalid-grant' || err.kind === 'config'
    return {
      state: permanent ? 'refused' : 'failed',
      detail: permanent
        ? `the ${provider} connection for "${projectSlug}" could not be renewed: ` +
          `${err.message}. Nothing was deleted — reconnect from Settings, or ` +
          `\`ogun linear connect --project ${projectSlug}\``
        : `could not renew the ${provider} access token for "${projectSlug}": ${err.message}. ` +
          'The refresh token was kept; the next poll tries again',
    }
  }

  try {
    await (deps.store ?? storeOAuthGrant)(projectSlug, provider, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      obtainedAt: now,
      // Carried forward rather than re-fetched. A refresh response reports the scopes it
      // was granted, and everything else about the grant — who the workspace is, whether
      // the actor is the app — was settled at authorization and cannot change under a
      // refresh. Re-running `identify` on every renewal would be a GraphQL request a poll
      // does not need.
      scopes: tokens.scopes.length > 0 ? tokens.scopes : grant.scopes,
      actor: grant.actor,
      ...(grant.workspace ? { workspace: grant.workspace } : {}),
      ...(grant.appUserId ? { appUserId: grant.appUserId } : {}),
    })
  } catch (err) {
    /**
     * Written *before* used, and a write that failed stops the poll.
     *
     * The tempting alternative is to poll with the new token anyway and hope the next
     * write lands. It is wrong because the rotation already happened at Linear: the
     * refresh token on disk is spent, so a poll that proceeds is a poll whose next renewal
     * replays a consumed token. Stopping here keeps that inside Linear's 30-minute replay
     * window, where the next attempt recovers the same pair — which is exactly what the
     * window is documented to be for.
     */
    const detail = err instanceof NoOAuthApp ? err.message : asMessage(err)
    return {
      state: 'failed',
      detail:
        `renewed the ${provider} token for "${projectSlug}" and could not write it to this ` +
        `machine's config (${detail}). The poll was stopped rather than run on a token ` +
        'nothing recorded; Linear allows the renewal to be replayed for 30 minutes, so ' +
        'fixing the store and waiting for the next poll recovers it',
    }
  }

  return {
    state: 'ready',
    credential: bearer({
      ...grant,
      expiresAt: tokens.expiresAt,
      access: sealSecret(tokens.accessToken),
    }),
    expiresAt: tokens.expiresAt,
    refreshed: true,
  }
}

/**
 * The one `expose()` on the poll's side of this module, at the point the token becomes a
 * header — ADR-0012's "once per consumer, at the wire".
 */
const bearer = (grant: OAuthGrant): LinearCredential => ({
  kind: 'oauth',
  token: grant.access.expose(),
  workspace: grant.workspace?.name,
})

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
