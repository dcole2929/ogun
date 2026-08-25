import {
  clearOAuthApp,
  clearOAuthGrant,
  clearProjectSecret,
  readOAuthApp,
  setOAuthApp,
  storeOAuthGrant,
  type SecretName,
} from '../config/secrets.ts'
import { localConfigPath } from '../config/machine.ts'
import {
  appTokenGrant,
  identify,
  revokeToken,
  visibleTeams,
  LINEAR_ACTOR,
  LINEAR_SCOPES,
  type Fetch,
  type LinearGrantType,
  type LinearIdentity,
  type LinearTeam,
} from './linear-oauth.ts'

/**
 * Connecting a project to Linear in one act, from wherever the operator is standing.
 *
 * ### Why this is a function in core rather than a route
 *
 * Because two surfaces perform it and they must not be able to store different things.
 * `ogun connect linear` runs it locally — no control plane, no database, no browser — and
 * the Settings page runs it through `POST /api/oauth/linear/connect/:project`. If each
 * assembled its own sequence of "register the application, get a token, ask who we are,
 * write it down", the difference between them would surface as a project connected from
 * the UI behaving unlike one connected from a terminal, months later, in a poll.
 *
 * ### The ordering, which is the part with a failure mode in it
 *
 * The application is written **first**, before the token is asked for. That looks
 * backwards — it stores a client secret for a connection that may not work — and it is the
 * right way round for two reasons:
 *
 *  - A token request that fails leaves the project in `unconnected`, which is a state
 *    ADR-0014 already defines, already reports, and already has a remedy for. The operator
 *    runs `ogun connect linear` again and is **not asked to paste anything**, because the
 *    application is there. Writing the application last would mean a network blip costing
 *    a second trip to Linear's settings page for a client secret that is shown on it.
 *  - It puts the two writes in the order that never leaves a grant with no application
 *    behind it — the one shape `storeOAuthGrant` refuses to create, because a grant whose
 *    client id and secret are missing can never be renewed.
 *
 * ### What it does to a personal API key, and why that is not silent destruction
 *
 * It removes one, and says so. ADR-0014 left it in place and reported it as shadowed, in
 * four separate surfaces, because at that time the key was written by a *different
 * command* — so an operator could have had one without ever having asked for it in the
 * same breath as a grant. Under one `connect` there is one place to give Ogun access to
 * Linear, so leaving a second credential in the store is leaving exactly the ambiguity
 * this vocabulary exists to end: a credential that reports as set, is read by nothing, and
 * is the first thing somebody rotates when a poll fails.
 *
 * Nothing is lost that Ogun could have given back. A personal API key lives in Linear,
 * where the person minted it; Ogun has never displayed a stored value and never will
 * (ADR-0012), so a copy it keeps but cannot show and does not read has no recoverable
 * content. The shadowed state stays *readable* — `readProjectSecret` still reports
 * `apiKeyIgnored`, because config.json gets hand-edited and an older build may have
 * written one — but the ordinary path stops creating it.
 */
export type LinearConnection = {
  project: string
  clientId: string
  grantType: LinearGrantType
  /** Absolute ms. What `connections` and `doctor` turn into "29d left". */
  expiresAt: number
  scopes: string[]
  /** What Linear says it is, never what was asked for. */
  actor: string
  workspace?: string
  /**
   * The teams this token can actually read, asked once and never stored.
   *
   * Empty means the probe failed *or* the token sees nothing, and the caller must not
   * render those as the same sentence: the first is a display problem on a working
   * connection, the second is the silent-empty-poll trap `visibleTeams` exists to expose.
   * `teamsProbed` is what tells them apart.
   */
  teams: LinearTeam[]
  teamsProbed: boolean
  /** A personal API key was in the store for this project and has been removed. */
  apiKeyRetired: boolean
}

export type ConnectDeps = {
  fetch?: Fetch
  tokenUrl?: string
  graphqlEndpoint?: string
  now?: () => number
  path?: string
}

/**
 * The default mechanism: Ogun's own client credentials, exchanged for an app-actor token.
 *
 * No browser, no redirect URI, no `state`, no authorization code in a query string — see
 * `appTokenGrant` for why removing that machinery is a smaller attack surface rather than
 * a shortcut, and ADR-0014's amendment for why it is the default despite reaching only the
 * workspace's public teams.
 */
export async function connectWithAppToken(
  projectSlug: string,
  provider: SecretName,
  credentials: { clientId: string; clientSecret: string; redirectUri: string },
  deps: ConnectDeps = {},
): Promise<LinearConnection> {
  const path = deps.path ?? localConfigPath()
  await setOAuthApp(projectSlug, provider, credentials, path)

  const tokens = await appTokenGrant({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.tokenUrl ? { tokenUrl: deps.tokenUrl } : {}),
  })

  return finishConnection(projectSlug, provider, credentials.clientId, tokens, deps)
}

/**
 * The completion both mechanisms share: ask who this token is, write it down, and tidy up
 * the credential it replaces.
 *
 * Exported because the consent flow's other half lives in the server — the `state` nonce
 * and the callback cannot leave the process that receives them — and the two must agree
 * about what a finished connection looks like down to the field.
 */
export async function finishConnection(
  projectSlug: string,
  provider: SecretName,
  clientId: string,
  tokens: {
    accessToken: string
    refreshToken?: string
    grantType: LinearGrantType
    expiresAt: number
    scopes: string[]
  },
  deps: ConnectDeps = {},
): Promise<LinearConnection> {
  const path = deps.path ?? localConfigPath()
  const at = deps.now?.() ?? Date.now()

  /**
   * Identity, and then teams, and neither is allowed to fail the connection.
   *
   * The tokens are valid — Linear issued them a moment ago — and refusing to store a
   * working grant because a cosmetic query timed out would turn a display problem into a
   * broken connect. `identify` already returns rather than throwing for the parse it can
   * recover from; the `catch` is for the transport it cannot.
   */
  const identity: LinearIdentity = await identify({
    accessToken: tokens.accessToken,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
  }).catch(() => ({ actorIsApp: false }))

  const teams = await visibleTeams({
    accessToken: tokens.accessToken,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
  })

  await storeOAuthGrant(
    projectSlug,
    provider,
    {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      grantType: tokens.grantType,
      expiresAt: tokens.expiresAt,
      obtainedAt: at,
      scopes: tokens.scopes,
      /**
       * What Linear says it is, not what was asked for. Under the authorization-code flow
       * `actor` is a request parameter the response does not echo; under
       * `client_credentials` it is implicit and never sent at all. Either way `viewer.app`
       * is the only evidence the grant really came back as an application, and the
       * difference is invisible until something writes under the wrong name.
       */
      actor: identity.actorIsApp ? LINEAR_ACTOR : 'user',
      ...(identity.workspace ? { workspace: identity.workspace } : {}),
      ...(identity.appUserId ? { appUserId: identity.appUserId } : {}),
    },
    path,
  )

  // Last, after the grant is on disk. A key removed before the write would leave a project
  // with neither credential if the write failed — trading a shadowed key for no key at all.
  const apiKeyRetired = await clearProjectSecret(projectSlug, provider, path)

  return {
    project: projectSlug,
    clientId,
    grantType: tokens.grantType,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [...LINEAR_SCOPES],
    actor: identity.actorIsApp ? LINEAR_ACTOR : 'user',
    ...(identity.workspace ? { workspace: identity.workspace.name } : {}),
    teams,
    teamsProbed: teams.length > 0,
    apiKeyRetired,
  }
}

/**
 * The client id and secret already on this machine, for a reconnect that should not send
 * anybody back to Linear's settings page.
 *
 * A `client_credentials` token expires every 30 days and a renewal is the same request the
 * connect made, so "connect again" has to be a command that asks for nothing when there is
 * nothing new to ask for. It also covers the retry after a failed token call, which is the
 * one case where an application is registered and no grant exists.
 */
export async function registeredApplication(
  projectSlug: string,
  provider: SecretName,
  path?: string,
): Promise<{ clientId: string; clientSecret: string; redirectUri: string } | undefined> {
  const app = await readOAuthApp(projectSlug, provider, path ?? localConfigPath())
  if (app.state !== 'present') return undefined
  return {
    clientId: app.app.clientId,
    // The one `expose()` on this path, and it is at a wire: the value goes straight back
    // into the form body of a token request and is held nowhere else.
    clientSecret: app.app.clientSecret.expose(),
    redirectUri: app.app.redirectUri,
  }
}

/**
 * Why a disconnect refused, when it did. A closed set, because two surfaces render it.
 */
export type DisconnectRefusal = 'keeps-a-live-credential'

export type Disconnection =
  | {
      ok: true
      /**
       * Anything at all was removed. `false` is "there was nothing here", which is a
       * different answer and must not be printed as success — it is the answer a
       * `disconnect` run one directory too high gets.
       */
      removed: boolean
      revoked: boolean
      apiKeyRemoved: boolean
      applicationForgotten: boolean
      grantType?: LinearGrantType
    }
  | { ok: false; reason: DisconnectRefusal; detail: string }

/**
 * Remove every credential a project has for one integration.
 *
 * ### Why the default takes the client id and secret with it
 *
 * ADR-0014's disconnect kept them, and was right to: under the authorization-code flow a
 * client secret alone authenticates nothing — it needs a browser, a consent screen and a
 * workspace admin behind it — so leaving one in place cost nothing and saved a reconnect
 * that a non-admin operator could not perform for themselves.
 *
 * **Under `client_credentials` the pair *is* the credential.** Anyone holding it can mint a
 * live token, and the very next poll would. A disconnect that left them behind is a
 * disconnect the machine undoes by itself, which is not one. ADR-0012 had already written
 * the rule this falls under — *"a superseded key is gone from the file rather than kept,
 * because one that is still accepted is a live credential nobody is watching, and it would
 * be in every backup of the machine"* — and this is that rule reaching a value that only
 * just became a credential.
 *
 * `keepApplication` is therefore **refused** rather than warned about for that grant. A
 * warning about a state that reverts itself within one poll interval is a warning nobody
 * can act on. It stays available for the consent grant, where keeping the pair is the
 * difference between reconnecting with one command and a trip back to Linear's settings
 * page.
 *
 * ### And it takes the personal API key too
 *
 * Because `ogun connect linear --api-key` is how one is stored, so this is the inverse of
 * the same command. A disconnect that removed a grant and silently left a key behind would
 * leave the project **still connected**, by the credential the operator was least likely to
 * be thinking about — `readProjectSecret` falls straight through to it.
 *
 * ### The revoke is best-effort, on purpose
 *
 * The local credential goes either way. A disconnect that depended on Linear being
 * reachable would leave an operator unable to remove a credential from their own machine
 * during an outage, which is precisely when they most want to. Whether Linear was told is
 * reported as its own fact, because it is one an operator may need to follow up by hand.
 */
export async function disconnectProject(
  projectSlug: string,
  provider: SecretName,
  options: { keepApplication?: boolean } = {},
  deps: ConnectDeps & { revokeUrl?: string } = {},
): Promise<Disconnection> {
  const path = deps.path ?? localConfigPath()
  const app = await readOAuthApp(projectSlug, provider, path)
  const grantType = app.state === 'present' ? app.app.grant?.grantType : undefined

  if (options.keepApplication && grantType === 'client_credentials') {
    return {
      ok: false,
      reason: 'keeps-a-live-credential',
      detail:
        `"${projectSlug}" is connected with its own client credentials, so the client id ` +
        'and secret are what mints the token. Keeping them is not a disconnection — the ' +
        'next poll would connect again. Disconnect without keeping the application, or, if ' +
        'what you want is to invalidate what Ogun holds, rotate the secret in Linear.',
    }
  }

  let revoked = false
  if (app.state === 'present' && app.app.grant) {
    revoked = (
      await revokeToken({
        // The one `expose()` here, and it is at a wire: the value goes into a form body
        // and is held nowhere else.
        token: app.app.grant.access.expose(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.revokeUrl ? { revokeUrl: deps.revokeUrl } : {}),
      })
    ).revoked
  }

  const oauthRemoved = options.keepApplication
    ? await clearOAuthGrant(projectSlug, provider, path)
    : await clearOAuthApp(projectSlug, provider, path)
  const apiKeyRemoved = await clearProjectSecret(projectSlug, provider, path)

  return {
    ok: true,
    removed: oauthRemoved || apiKeyRemoved,
    revoked,
    apiKeyRemoved,
    applicationForgotten: oauthRemoved && options.keepApplication !== true,
    ...(grantType ? { grantType } : {}),
  }
}
