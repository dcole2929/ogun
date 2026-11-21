import {
  ApplicationInUse,
  clearApplication,
  clearGrant,
  clearProjectSecret,
  deriveApplicationName,
  readApplication,
  readGrant,
  setApplication,
  storeGrant,
} from '../config/secrets.ts'
import { localConfigPath } from '../config/machine.ts'
import {
  botLogin,
  GithubAppError,
  installationIdentity,
  installationToken,
} from './github-app.ts'
import type { Fetch } from './linear-oauth.ts'
/**
 * `Disconnection` is shared with the Linear path rather than redeclared, because two
 * surfaces render it — `ogun disconnect` and the Settings button — and a second shape with
 * the same field names is how one of them starts reporting `revoked` differently from the
 * other. It is a type-only import, so nothing is pulled in at runtime.
 */
import type { Disconnection } from './linear-connect.ts'

/**
 * Connecting a project to GitHub as an App, in one act, from wherever the operator is
 * standing.
 *
 * The sibling of `linear-connect.ts`, and deliberately the same shape down to the order of
 * the writes — because the two will be read next to each other by whoever adds the third
 * provider, and a difference between them should mean something. What differs is only what
 * the provider needs:
 *
 *  - There is no client secret and no OAuth grant. The credential is a private key, the
 *    proof is a signed JWT, and what comes back is an installation token (see
 *    `github-app.ts`).
 *  - The identity call is **not** optional. `finishConnection` lets Linear's `identify`
 *    fail and still stores the grant, because everything it returns there is for display.
 *    Here it carries the account the application is *named* after and the bot login
 *    `loopGuard` compares comment authors against — so a connect that could not ask is a
 *    connect that would have to invent both, and it refuses instead. Nothing is stored and
 *    the operator runs the command again.
 *  - A token lasts about an hour rather than thirty days, so renewal is routine rather
 *    than monthly. That is `usableGithubGrant` in the server, and it is refresh-before-use
 *    for the reasons `linear-grant.ts` sets out at length.
 *
 * ### The order of the writes
 *
 * **Mint, identify, derive the name, write the application, write the grant.** Identical
 * to the Linear path and for the identical reason: an application in the store is one that
 * has been spent at least once, and its name describes an account the credential actually
 * reached. A first-ever connect whose mint fails stores nothing and is re-run — stated
 * rather than buried, because it is a real cost and it is the right one. The alternative is
 * a private key on the disk that no poll will ever spend, which is this repository's
 * oldest failure: a credential nothing reads looks exactly like one that works.
 */

export type GithubConnection = {
  project: string
  /** The application the grant came from, by the name `--link` takes — `github:heirchive`. */
  application: string
  appId: string
  installationId: string
  /** The organisation or user the App is installed on, as GitHub spells it. */
  account: string
  /** `ogun[bot]` — the login GitHub attributes this installation's writes to. */
  login: string
  /** Absolute ms. About an hour out. */
  expiresAt: number
  /** `pull_requests:read`, as granted — see `InstallationToken.permissions`. */
  permissions: string[]
  /**
   * `all` or `selected`.
   *
   * Printed at connect time for the reason `visibleTeams` is printed for Linear: a
   * `selected` installation that does not include the repository a source polls
   * authenticates perfectly and 404s, and the only moment anybody is watching is this one.
   */
  repositorySelection: string
  /** A personal access token was in the store for this project and has been removed. */
  apiKeyRetired: boolean
  /** An application of this name was already here and its credentials were replaced. */
  applicationReplaced: boolean
  /**
   * Other projects whose grants were dropped because the application under this name now
   * points at a different App or a different installation — see `setApplication`.
   */
  displacedProjects: string[]
}

export type GithubConnectDeps = {
  fetch?: Fetch
  endpoint?: string
  now?: () => number
  path?: string
  /** The name to store the application under, overriding the derived one — `--as`. */
  as?: string
}

export type GithubApplicationInput = {
  appId: string
  installationId: string
  privateKey: string
}

export async function connectGithubApp(
  projectSlug: string,
  credentials: GithubApplicationInput,
  deps: GithubConnectDeps = {},
): Promise<GithubConnection> {
  const path = deps.path ?? localConfigPath()
  const at = deps.now?.() ?? Date.now()
  const wire = {
    ...credentials,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  }

  // The proof, first and before anything is written. A key that cannot mint a token is a
  // key that is wrong, and `GithubAppError` already says which kind of wrong.
  const token = await installationToken(wire)
  const identity = await installationIdentity(wire)

  const name = deps.as ?? deriveApplicationName('github', identity.account)

  const { replaced, droppedGrants } = await setApplication(
    {
      name,
      provider: 'github',
      method: 'private_key_jwt',
      appId: credentials.appId,
      installationId: credentials.installationId,
      privateKey: credentials.privateKey,
    },
    path,
  )

  await storeGrant(
    projectSlug,
    'github',
    {
      app: name,
      accessToken: token.accessToken,
      /**
       * No refresh token, and that is not a degraded grant. Renewal is signing a fresh JWT
       * with the private key already in the application — no person, nothing spent, and
       * repeatable — exactly as a `client_credentials` renewal is asking again.
       */
      grantType: 'installation',
      expiresAt: token.expiresAt,
      obtainedAt: at,
      scopes: token.permissions,
      /**
       * The bot login, because `actor` is "who the provider attributes a write to" and for
       * a GitHub App that is a login rather than a mode. Linear records `app` or `user`
       * here; GitHub's answer is `ogun[bot]`, and storing it is what lets the credential
       * lookup hand `loopGuard` a login without a round trip per poll.
       */
      actor: botLogin(identity.appSlug),
      account: {
        ...(identity.accountId ? { id: identity.accountId } : {}),
        name: identity.account,
        /**
         * GitHub has no `urlKey`; a login *is* the URL segment, so the two fields hold the
         * same string here. Kept rather than collapsed because `Grant.account` is shared
         * with Linear, where a workspace's display name and its url key genuinely differ,
         * and a provider-shaped account record would mean every surface that prints an
         * account needs a `switch`.
         */
        urlKey: identity.account,
      },
    },
    path,
  )

  // Last, after the grant is on disk, for the reason the Linear path gives: a key removed
  // before the write would leave a project with neither credential if the write failed.
  const apiKeyRetired = await clearProjectSecret(projectSlug, 'github', path)

  return {
    project: projectSlug,
    application: name,
    appId: credentials.appId,
    installationId: credentials.installationId,
    account: identity.account,
    login: botLogin(identity.appSlug),
    expiresAt: token.expiresAt,
    permissions: token.permissions,
    repositorySelection: token.repositorySelection,
    apiKeyRetired,
    applicationReplaced: replaced,
    displacedProjects: droppedGrants.filter((slug) => slug !== projectSlug),
  }
}

/**
 * Point a project at a GitHub App this machine already holds, and prove it still works.
 *
 * `--link`, and it mints rather than writing a pointer for the reason the Linear one does:
 * **"connected" has to mean "proved".** It costs more here than there — a private key can
 * be revoked in GitHub's UI at any time, and an installation can be removed — so a link
 * that only recorded a name would be the likeliest of all the paths to report a connection
 * that does not exist.
 */
export async function linkGithubApplication(
  projectSlug: string,
  name: string,
  deps: GithubConnectDeps = {},
): Promise<GithubConnection> {
  const path = deps.path ?? localConfigPath()
  const stored = await readApplication(name, path)
  if (stored.state !== 'present') {
    throw new GithubAppError(
      'config',
      `no application named "${name}" is registered on this machine ` +
        `(${stored.state === 'malformed' ? stored.reason : stored.state})`,
    )
  }
  if (stored.app.provider !== 'github') {
    throw new GithubAppError(
      'config',
      `"${name}" is a ${stored.app.provider} application, and this is the github connect`,
    )
  }
  return connectGithubApp(
    projectSlug,
    {
      appId: stored.app.appId,
      installationId: stored.app.installationId,
      // The one `expose()` on this path, and it is at a wire: the value is handed to
      // `createSign` and held nowhere else.
      privateKey: stored.app.privateKey.expose(),
    },
    { ...deps, as: name },
  )
}

/**
 * The GitHub App a project's grant came from, for a reconnect that asks for nothing.
 *
 * The sibling of `linkedApplication`, and it reads the grant to find the application for
 * the same reason: applications are shared, so there is no application filed under a
 * project to look up.
 */
export async function linkedGithubApplication(
  projectSlug: string,
  path?: string,
): Promise<(GithubApplicationInput & { name: string }) | undefined> {
  const at = path ?? localConfigPath()
  const grant = await readGrant(projectSlug, 'github', at)
  if (grant.state !== 'present') return undefined
  const stored = await readApplication(grant.grant.app, at)
  if (stored.state !== 'present' || stored.app.provider !== 'github') return undefined
  return {
    name: stored.app.name,
    appId: stored.app.appId,
    installationId: stored.app.installationId,
    // `expose()` here and not at the caller, for the reason `linkedApplication` gives: the
    // only thing that happens to this value next is `createSign`, and a caller that had to
    // unseal it would be a second place reaching for the key.
    privateKey: stored.app.privateKey.expose(),
  }
}

/**
 * Remove every credential a project has for GitHub.
 *
 * Separate from `disconnectProject` and not a branch inside it, because the two differ in
 * the one place that matters: **there is nothing to revoke.** GitHub has no endpoint that
 * ends an installation token early — it has a one-hour life and that is the whole of its
 * revocation story — so the only honest thing a disconnect can do is forget it locally and
 * say so. Folding that into the Linear function would mean a `revoked: false` that an
 * operator reads as "Linear could not be told", about a provider that was never going to
 * be told anything.
 *
 * Everything else is the same rule and is therefore the same code shape: the grant goes
 * unconditionally, the application goes only if nothing else points at it, and the personal
 * access token goes too, because `ogun connect github --api-key` is how one is stored and
 * leaving it would leave the project still connected by the credential the operator was
 * least likely to be thinking about.
 *
 * **Taking the private key with it is the destructive half, and it is deliberate.** Unlike
 * a client secret, which is shown on Linear's settings page forever, a GitHub App's private
 * key is displayed **once** at generation and cannot be retrieved again — so a disconnect
 * that removes the last grant from an application destroys the only copy on this machine,
 * and reconnecting means generating a new key in GitHub's UI. That is still the right
 * default, for ADR-0012's reason: a key kept after the last thing that read it is a live
 * credential nobody is watching, sitting in every backup of the machine. `keepApplication`
 * is the opt-out, and unlike the Linear path it is **never refused** — a private key with
 * no installation token beside it mints nothing until somebody signs a JWT with it, so
 * keeping it is not a disconnection the machine undoes by itself.
 */
export async function disconnectGithub(
  projectSlug: string,
  options: { keepApplication?: boolean } = {},
  deps: { path?: string } = {},
): Promise<Disconnection> {
  const path = deps.path ?? localConfigPath()
  const stored = await readGrant(projectSlug, 'github', path)
  const grant = stored.state === 'present' ? stored.grant : undefined

  const grantRemoved = await clearGrant(projectSlug, 'github', path)

  let applicationForgotten = false
  let sharedWith: string[] = []
  if (grant && options.keepApplication !== true) {
    try {
      applicationForgotten = await clearApplication(grant.app, path)
    } catch (err) {
      if (!(err instanceof ApplicationInUse)) throw err
      sharedWith = err.usedBy
    }
  }

  const apiKeyRemoved = await clearProjectSecret(projectSlug, 'github', path)

  return {
    ok: true,
    removed: grantRemoved || apiKeyRemoved,
    // Never true, and reported rather than omitted: the field is shared with the Linear
    // disconnection and a missing `revoked` would be rendered as "we do not know".
    revoked: false,
    apiKeyRemoved,
    applicationForgotten,
    ...(sharedWith.length > 0 ? { applicationSharedWith: sharedWith } : {}),
    ...(grant ? { grantType: grant.grantType } : {}),
  }
}
