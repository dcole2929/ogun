import {
  botLogin,
  credentialHealth,
  GithubAppError,
  GRANT_REFRESH_HORIZON_MS,
  installationToken,
  NoApplication,
  readApplication,
  sealSecret,
  storeGrant,
  type Application,
  type Fetch,
  type Grant,
} from '@ogun/core'
import type { GithubCredential } from '../integrations/github.ts'

/**
 * Keeping a GitHub App installation token alive for a poller that wakes at 3am.
 *
 * ### Why this is the same design as `linear-grant.ts` and not a timer
 *
 * The three designs weighed there were a twenty-hour timer, a reaction to a 401, and
 * renewal on demand immediately before the poll that needs it. Read that file for the
 * argument; **every line of it applies here with more force**, because an installation
 * token lasts about **one hour** rather than thirty days:
 *
 *  - A timer refreshes in a process that may not be running. With a one-hour life, "the
 *    machine was asleep and the token died before the first tick" stops being the
 *    interesting case and becomes the *only* case — a laptop closed over lunch comes back
 *    to a dead token every single time.
 *  - Reacting to a 401 spends a poll. The request has already gone out, the page it was
 *    fetching is lost, and `source_polls` records a failure for a poll that was always
 *    going to need one round trip.
 *  - Renewing on demand costs the same request at a moment when nothing is riding on it,
 *    and the poll is the only thing that knows it is about to need a token.
 *
 * The horizon is `GRANT_REFRESH_HORIZON_MS`, shared with Linear deliberately: ten minutes
 * is what `doctor`, the CLI and the web UI all mean by "expiring", and a second number
 * here would make `doctor` warn about a token the next poll renews by itself.
 *
 * Ten minutes against a sixty-minute life means a healthy connection renews roughly hourly
 * rather than roughly daily. That is the honest cost of a one-hour credential and it is
 * paid in one HTTP request per poll cycle at most, because `inFlight` below collapses
 * concurrent attempts and a renewed token is good for the next fifty.
 *
 * ### What renewal costs here, and why none of ADR-0010's care is needed
 *
 * **Nothing is spent.** There is no refresh token and nothing rotates: a renewal signs a
 * fresh JWT with the private key already in the application and asks for another token.
 * ADR-0010 rejected refreshing a *borrowed* OAuth credential because the provider rotated
 * the refresh token on use, which logged a human out of their own CLI. There is no
 * rotation here, nothing else on the machine holds this key, and a failed renewal leaves
 * the store exactly as it was. That makes this the cheapest of the three grants to keep
 * alive, and it is why a one-hour token is not a problem.
 *
 * The trap that *does* apply is the other one ADR-0010 named: two writers racing over a
 * credential file. Handled rather than argued away — the write goes through `storeGrant`
 * and therefore `updateLocalConfig`'s lock, the same lock `ogun project add` takes.
 *
 * ### What has not been proved
 *
 * No GitHub App exists for this repository and no private key exists on any machine here,
 * so this path has never spoken to GitHub. It is covered against a stub
 * (`test/github-grant.test.ts`) and written against GitHub's published documentation; the
 * claim "GitHub accepts the JWT this signs" is not one any test here makes.
 */

export type GithubGrantDeps = {
  readApp?: typeof readApplication
  store?: typeof storeGrant
  /** The renewal, which is a fresh JWT and one POST — see `installationToken`. */
  mint?: typeof installationToken
  fetch?: Fetch
  endpoint?: string
  now?: () => number
}

/**
 * A credential a poll can use, or the reason it cannot — the three outcomes
 * `source_polls` already distinguishes, in the same shape `usableGrant` returns.
 *
 * `refused` is a fact about the configuration that will still be true in five minutes: the
 * private key is wrong, the installation is gone, the application is missing. `failed` is a
 * fact about this moment, and `kind` splits it the way the Linear path does — `transport`
 * is GitHub or the network and the next poll retries it; `local` is a token that was
 * **minted successfully** and could not be written to this machine's config, where waiting
 * fixes nothing and the store is what needs attention.
 */
export type UsableGithubGrant =
  | { state: 'ready'; credential: GithubCredential; expiresAt: number; refreshed: boolean }
  | { state: 'refused'; detail: string }
  | { state: 'failed'; detail: string; kind: 'transport' | 'local' }

/**
 * One mint per project at a time, across the whole process.
 *
 * The same module-level map `linear-grant.ts` keeps, for the same reason and against the
 * same objection: this repository is suspicious of mutable globals (`4525a43` exists
 * because two concurrent things shared one), and here the *point* is to be shared. A
 * per-call map single-flights nothing.
 *
 * The window is real: `main.ts` drives `pollSources` from an interval that does not await
 * its callback, so two ticks overlap whenever a poll runs long, and two sources in one
 * project would then both find the same expiring grant. Nothing is spent by a duplicate
 * mint — unlike a rotating refresh token — so this is about not making two requests and
 * two writes where one will do, rather than about correctness.
 */
const inFlight = new Map<string, Promise<UsableGithubGrant>>()

export async function usableGithubGrant(
  projectSlug: string,
  grant: Grant,
  deps: GithubGrantDeps = {},
): Promise<UsableGithubGrant> {
  const now = deps.now?.() ?? Date.now()

  /**
   * The application is read even when the token is still good, which the Linear path does
   * not do. It has to be: `GithubCredential` carries the `installationId`, and that lives
   * on the application rather than on the grant — the grant records what came *back*, and
   * the installation is part of what went out. `describeGithubCredential` prints it when a
   * poll 401s, which is the one moment it matters.
   */
  const app = await (deps.readApp ?? readApplication)(grant.app)
  if (app.state !== 'present' || app.app.provider !== 'github') {
    const why =
      app.state === 'present'
        ? `it is a ${app.app.provider} application`
        : app.state === 'malformed'
          ? app.reason
          : app.state
    return {
      state: 'refused',
      detail:
        `"${projectSlug}" has a github grant from an application this machine cannot use ` +
        `("${grant.app}": ${why}), so its installation token cannot be renewed. Register ` +
        'the application again and reconnect',
    }
  }
  const application = app.app

  const health = credentialHealth(
    { kind: 'at', expiresAt: grant.expiresAt },
    { now, horizonMs: GRANT_REFRESH_HORIZON_MS },
  )
  if (health.state === 'valid') {
    return {
      state: 'ready',
      credential: credential(grant, application.installationId, grant.access.expose()),
      expiresAt: grant.expiresAt,
      refreshed: false,
    }
  }

  // `github:slug` rather than a separator that has to be argued about: neither half can
  // contain a colon that would run the two together into another pair's key, because the
  // provider is a literal from a closed set.
  const key = `github:${projectSlug}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const attempt = mintOnce(projectSlug, grant, application, deps, now).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, attempt)
  return attempt
}

async function mintOnce(
  projectSlug: string,
  grant: Grant,
  application: Extract<Application, { provider: 'github' }>,
  deps: GithubGrantDeps,
  now: number,
): Promise<UsableGithubGrant> {
  let token
  try {
    token = await (deps.mint ?? installationToken)({
      appId: application.appId,
      installationId: application.installationId,
      // One of the two `expose()`s in this module, and it is at a wire: the value goes
      // straight to `createSign` and is held nowhere else. The other is the access token
      // becoming an `authorization` header, in `credential` below.
      privateKey: application.privateKey.expose(),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
  } catch (err) {
    if (!(err instanceof GithubAppError)) throw err
    /**
     * `config` is permanent and `transport` is not, and **neither deletes anything**. An
     * operator disconnects deliberately, from a surface that says what it is doing; a
     * poller erasing a credential at 3am is the destructive write `empty` exists to make
     * visible one field over. A revoked private key is a fact somebody has to see, not one
     * to be tidied away by the thing that discovered it.
     */
    return err.kind === 'config'
      ? {
          state: 'refused',
          detail:
            `the github connection for "${projectSlug}" could not be renewed: ` +
            `${err.message}. Nothing was deleted — reconnect with ` +
            `\`ogun connect github --app --project ${projectSlug}\``,
        }
      : {
          state: 'failed',
          kind: 'transport',
          detail:
            `could not renew the github installation token for "${projectSlug}": ` +
            `${err.message}. Nothing was spent; the next poll asks again`,
        }
  }

  try {
    await (deps.store ?? storeGrant)(projectSlug, 'github', {
      app: grant.app,
      accessToken: token.accessToken,
      grantType: 'installation',
      expiresAt: token.expiresAt,
      obtainedAt: now,
      // As granted, from the mint response, which is the only place GitHub reports them.
      scopes: token.permissions.length > 0 ? token.permissions : grant.scopes,
      // Carried forward. The bot login and the account were settled when the App was
      // installed and cannot change under a renewal, so re-asking `/app/installations/:id`
      // on every mint would be a request a poll does not need.
      actor: grant.actor,
      ...(grant.account ? { account: grant.account } : {}),
    })
  } catch (err) {
    /**
     * Written before used, and a write that failed stops the poll.
     *
     * Nothing was spent — there is no rotation here — so proceeding on the new token would
     * be *safe*, and it is still wrong, for the reason the Linear path gives about its own
     * non-rotating grant: a poll that ran on a token the store never recorded would leave
     * `connect list`, `doctor` and the Settings card all reporting an expired grant while
     * the polls quietly worked. That is a store that disagrees with reality, which is the
     * class of bug where the evidence an operator debugs from is the thing that is wrong.
     */
    return {
      state: 'failed',
      // `local`, not `transport`: GitHub answered and this machine could not write it down.
      // A config.json that is unwritable at 3am is unwritable at 4am, so a surface that
      // said "the next poll will retry" would be describing a loop with no exit.
      kind: 'local',
      detail:
        `minted a github installation token for "${projectSlug}" and could not write it to ` +
        `this machine's config (${err instanceof NoApplication ? err.message : asMessage(err)}). ` +
        'The poll was stopped rather than run on a token nothing recorded; nothing was ' +
        'spent, so fixing the store and waiting for the next poll recovers it',
    }
  }

  return {
    state: 'ready',
    credential: credential(
      { ...grant, expiresAt: token.expiresAt, access: sealSecret(token.accessToken) },
      application.installationId,
      token.accessToken,
    ),
    expiresAt: token.expiresAt,
    refreshed: true,
  }
}

/**
 * The grant plus the application, as the GitHub client wants it — and the other
 * `expose()`, at the point the token becomes an `authorization` header (ADR-0012's "once
 * per consumer, at the wire"). It is passed in rather than read here, because the renewed
 * token has never been sealed: it came back from the mint as a string and goes out as one.
 *
 * `login` comes from `grant.actor`, which `connectGithubApp` set to `<app-slug>[bot]` from
 * what GitHub reported at install time. It is recorded rather than recomputed because
 * `loopGuard` compares comment authors against it, and a source that gets it wrong feeds
 * itself. A grant written before that field meant this — or hand-edited — falls back to
 * `botLogin` of nothing, which is why the fallback is the empty-ish literal rather than a
 * plausible guess: `loopGuard` filtering on a login that matches nobody errs towards
 * reacting to its own comment, which is noisy and visible, where a login that matches the
 * *wrong* account silently eats a human's words.
 */
const credential = (
  grant: Grant,
  installationId: string,
  token: string,
): GithubCredential => ({
  kind: 'app',
  token,
  login: grant.actor.endsWith('[bot]') ? grant.actor : botLogin(grant.actor),
  // A number on `GithubCredential` and a string in the store, and the conversion is here
  // because the store is hand-editable text and `describeGithubCredential` prints this.
  // `NaN` would print as "installation NaN", which at least names the field that is wrong.
  installationId: Number(installationId),
})

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
