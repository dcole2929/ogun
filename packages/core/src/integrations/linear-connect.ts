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
  type Grant,
  type SecretName,
} from '../config/secrets.ts'
import { localConfigPath } from '../config/machine.ts'
import {
  appTokenGrant,
  identify,
  LinearOAuthError,
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
 * **Exchange, identify, derive the name, write the application, write the grant.** Nothing
 * unproven reaches the store: an application in `~/.ogun/config.json` is one that has been
 * spent at least once, and a name on it describes an account the credential actually
 * reached.
 *
 * This reverses what this file did before, and the previous argument is worth quoting
 * because it was a real cost rather than an oversight:
 *
 * > *"The application is written **first**, before the token is asked for. That looks
 * > backwards — it stores a client secret for a connection that may not work — and it is
 * > the right way round … A token request that fails leaves the project in
 * > `unconnected` … The operator runs `ogun connect linear` again and is **not asked to
 * > paste anything**, because the application is there. Writing the application last would
 * > mean a network blip costing a second trip to Linear's settings page for a client secret
 * > that is shown on it."*
 *
 * What that weighed correctly was the retry. What it did not weigh is the rule this
 * repository keeps everywhere else: **a credential nothing reads looks exactly like one
 * that works.** An application written before the exchange is a client secret on disk that
 * no poll will ever spend, reported by `connect list` and `doctor` as a thing that exists,
 * with a name derived from a workspace nobody has confirmed. And the name is the half that
 * made the old order untenable rather than merely unfortunate: a name is derived from the
 * account the credential *proved* it reaches, and before the exchange there is no such
 * account — the old order would have had to name the application after the project, which
 * is the naming the split out of `oauth[project]` exists to end.
 *
 * So the cost is accepted and stated: **a first-ever connect whose token call fails stores
 * nothing, and the client id and secret are asked for again.** That is correct rather than
 * a regression. A reconnect is unaffected, because by then there is a proven application to
 * reuse and `linkedApplication` finds it without asking for anything.
 *
 * The two writes still happen in the order that never leaves a grant with no application
 * behind it — the one shape `storeGrant` refuses to create, because a grant whose
 * application is missing can never be renewed.
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
  /**
   * The application the grant came from, by the name it is stored under — `linear:acme`.
   *
   * On the connection because it is the handle the *next* command takes: `ogun connect
   * linear --link linear:acme` points a second project at this application without a
   * client secret being typed again. A connection that reported only "connected" would
   * leave the operator to guess it, and the whole value of a derived name is that nobody
   * has to.
   */
  application: string
  clientId: string
  grantType: LinearGrantType
  /** Absolute ms. What `connect list` and `doctor` turn into "29d left". */
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
  /** An application of this name was already here and its credentials were replaced. */
  applicationReplaced: boolean
  /**
   * Other projects whose grants were dropped because the application under this name is
   * now a *different* application — see `setApplication`.
   *
   * On the connection rather than left to be discovered, because this is the one way
   * connecting one project can disconnect another, and the projects it happens to are by
   * definition ones nobody is looking at.
   */
  displacedProjects: string[]
}

export type ConnectDeps = {
  fetch?: Fetch
  tokenUrl?: string
  graphqlEndpoint?: string
  now?: () => number
  path?: string
  /**
   * The name to store the application under, overriding the derived one — `--as`.
   *
   * It exists for one shape and it is a real one: an organisation with **two** Linear
   * applications in the same workspace. Both derive to `linear:acme`, so the second would
   * replace the first, and the only thing that can tell them apart is a person. Everything
   * else takes the derived name, because a name somebody typed is a name that can disagree
   * with the account it describes.
   */
  as?: string
}

/**
 * The credentials an application is registered with, as a caller holds them.
 *
 * `method` is carried rather than inferred, which is the whole of `Application` being a
 * union: `client_credentials` and `authorization_code` both have a client id and a client
 * secret and differ in everything about how they are spent. A shape-based guess is how one
 * of them half-works.
 */
export type LinearApplicationInput = {
  clientId: string
  clientSecret: string
  redirectUri: string
  method: 'client_credentials' | 'authorization_code'
}

/**
 * The default mechanism: Ogun's own client credentials, exchanged for an app-actor token.
 *
 * No browser, no redirect URI, no `state`, no authorization code in a query string — see
 * `appTokenGrant` for why removing that machinery is a smaller attack surface rather than
 * a shortcut, and ADR-0014's amendment for why it is the default despite reaching only the
 * workspace's public teams.
 *
 * Nothing is written before `appTokenGrant` answers. See the header for the cost of that
 * and why it is the right one.
 */
export async function connectWithAppToken(
  projectSlug: string,
  provider: SecretName,
  credentials: { clientId: string; clientSecret: string; redirectUri: string },
  deps: ConnectDeps = {},
): Promise<LinearConnection> {
  const tokens = await appTokenGrant({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.tokenUrl ? { tokenUrl: deps.tokenUrl } : {}),
  })

  return finishConnection(
    projectSlug,
    provider,
    { ...credentials, method: 'client_credentials' },
    tokens,
    deps,
  )
}

/**
 * Point a project at an application this machine already holds, and prove it still works.
 *
 * `--link`. The reason it is a connect rather than a pointer write is the sentence this
 * whole slice is built on: **"connected" has to mean "proved", not "a pointer was
 * written".** A link that only recorded a name would report a project as connected on
 * credentials that may have been rotated in Linear's settings a month ago, and the first
 * evidence would be a poll at 3am. So it spends the application once, exactly as a first
 * connect does, and writes a grant only if a token comes back.
 *
 * It refuses an `authorization_code` application, because minting from one needs a browser
 * and a person — `--consent` is that flow, and it is a different command for a reason that
 * is not cosmetic: the token it produces sees what the *approver* can see, so silently
 * substituting a client-credentials mint here would hand the project a narrower connection
 * than the application it was told to link to.
 */
export async function linkApplication(
  projectSlug: string,
  provider: SecretName,
  name: string,
  deps: ConnectDeps = {},
): Promise<LinearConnection> {
  const path = deps.path ?? localConfigPath()
  const stored = await readApplication(name, path)
  if (stored.state !== 'present') {
    throw new LinearOAuthError(
      'config',
      `no application named "${name}" is registered on this machine ` +
        `(${stored.state === 'malformed' ? stored.reason : stored.state})`,
    )
  }
  const app = stored.app
  if (app.provider !== 'linear') {
    throw new LinearOAuthError(
      'config',
      `"${name}" is a ${app.provider} application, and this is the linear connect`,
    )
  }
  if (app.method === 'authorization_code') {
    throw new LinearOAuthError(
      'config',
      `"${name}" was registered through the consent flow, so a token from it is minted in ` +
        'a browser by somebody who approves it. Linking cannot do that — connect this ' +
        `project with \`--consent\` instead`,
    )
  }

  return connectWithAppToken(
    projectSlug,
    provider,
    {
      clientId: app.clientId,
      // The one `expose()` on this path, and it is at a wire: the value goes straight into
      // the form body of a token request and is held nowhere else.
      clientSecret: app.clientSecret.expose(),
      redirectUri: app.redirectUri,
    },
    { ...deps, as: name },
  )
}

/**
 * The completion both mechanisms share: ask who this token is, name the application after
 * the answer, write both, and tidy up the credential it replaces.
 *
 * Exported because the consent flow's other half lives in the server — the `state` nonce
 * and the callback cannot leave the process that receives them — and the two must agree
 * about what a finished connection looks like down to the field.
 */
export async function finishConnection(
  projectSlug: string,
  provider: SecretName,
  application: LinearApplicationInput,
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

  /**
   * The name, from the account the credential just proved it reaches.
   *
   * `urlKey` rather than the workspace's display name, because a name is a handle somebody
   * types into `--link` and a display name has spaces, capitals and emoji in it. The
   * fallback is the **client id**, not the project slug: a project slug is the naming this
   * store was reorganised to get rid of, and a client id is at least a fact about the
   * application rather than about one of its users. It is reached only when `identify`
   * could not answer, which is a transport failure on a connection that otherwise worked.
   */
  const name =
    deps.as ?? deriveApplicationName(provider, identity.workspace?.urlKey ?? application.clientId)

  const { replaced, droppedGrants } = await setApplication(
    {
      name,
      provider: 'linear',
      method: application.method,
      clientId: application.clientId,
      clientSecret: application.clientSecret,
      redirectUri: application.redirectUri,
    },
    path,
  )

  await storeGrant(
    projectSlug,
    provider,
    {
      app: name,
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
      ...(identity.workspace ? { account: identity.workspace } : {}),
      ...(identity.appUserId ? { appUserId: identity.appUserId } : {}),
    },
    path,
  )

  // Last, after the grant is on disk. A key removed before the write would leave a project
  // with neither credential if the write failed — trading a shadowed key for no key at all.
  const apiKeyRetired = await clearProjectSecret(projectSlug, provider, path)

  return {
    project: projectSlug,
    application: name,
    clientId: application.clientId,
    grantType: tokens.grantType,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [...LINEAR_SCOPES],
    actor: identity.actorIsApp ? LINEAR_ACTOR : 'user',
    ...(identity.workspace ? { workspace: identity.workspace.name } : {}),
    teams,
    teamsProbed: teams.length > 0,
    apiKeyRetired,
    applicationReplaced: replaced,
    // Minus this project: its grant is written a few lines above and is the fresh one.
    displacedProjects: droppedGrants.filter((slug) => slug !== projectSlug),
  }
}

/**
 * The application a project's grant came from, with its secret, for a reconnect that
 * should not send anybody back to Linear's settings page.
 *
 * `registeredApplication` under the old shape, and the difference is the one the split
 * made: it reads the project's **grant** to find out which application to read, rather
 * than reading an application filed under the project. A project with no grant has no
 * application of its own — applications are shared now — so the answer is `undefined` and
 * the caller asks for credentials or takes `--link`.
 *
 * A `client_credentials` token expires every 30 days and a renewal is the same request the
 * connect made, so "connect again" has to be a command that asks for nothing when there is
 * nothing new to ask for.
 */
export async function linkedApplication(
  projectSlug: string,
  provider: SecretName,
  path?: string,
): Promise<(LinearApplicationInput & { name: string }) | undefined> {
  const at = path ?? localConfigPath()
  const grant = await readGrant(projectSlug, provider, at)
  if (grant.state !== 'present') return undefined
  const stored = await readApplication(grant.grant.app, at)
  if (stored.state !== 'present' || stored.app.provider !== 'linear') return undefined
  return {
    name: stored.app.name,
    clientId: stored.app.clientId,
    // The one `expose()` on this path, and it is at a wire: the value goes straight back
    // into the form body of a token request and is held nowhere else.
    clientSecret: stored.app.clientSecret.expose(),
    redirectUri: stored.app.redirectUri,
    method: stored.app.method,
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
      /**
       * The other projects still holding a grant from this application, which is why it
       * was left behind.
       *
       * The field the split made necessary. Before it, an application belonged to one
       * project and removing the grant could always remove the credentials with it; now
       * one application serves several, and a `disconnect` that cascaded would take four
       * working projects offline to satisfy one typed in the wrong directory. So the
       * application stays, and the operator is *told* — because "disconnected" while a
       * client secret is still on the disk is the half-truth that makes somebody believe a
       * credential is gone when it is not.
       */
      applicationSharedWith?: string[]
      grantType?: Grant['grantType']
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
 * ### What changed when an application became shared
 *
 * It can no longer always take the credentials with it, and it does not try. The grant
 * goes unconditionally; the application goes **only if nothing else points at it**, which
 * is `clearApplication`'s own rule rather than a second copy of it here — asked by
 * attempting the removal and reading the refusal, so there is no window between checking
 * and acting and no second implementation of "who is still using this".
 *
 * A kept-because-shared application is *not* the hazard the paragraph above describes. The
 * client id and secret stay live for the projects that are still using them, which is the
 * point; what would be wrong is leaving them behind for *nobody*, and that cannot happen.
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
  const stored = await readGrant(projectSlug, provider, path)
  const grant = stored.state === 'present' ? stored.grant : undefined

  if (options.keepApplication && grant?.grantType === 'client_credentials') {
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
  if (grant) {
    revoked = (
      await revokeToken({
        // The one `expose()` here, and it is at a wire: the value goes into a form body
        // and is held nowhere else.
        token: grant.access.expose(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.revokeUrl ? { revokeUrl: deps.revokeUrl } : {}),
      })
    ).revoked
  }

  const grantRemoved = await clearGrant(projectSlug, provider, path)

  /**
   * The application, attempted after the grant is gone so that *this* project is not
   * counted among its users. `ApplicationInUse` is the answer, not an error to report: it
   * names who is left, which is exactly what the operator is told.
   */
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

  const apiKeyRemoved = await clearProjectSecret(projectSlug, provider, path)

  return {
    ok: true,
    removed: grantRemoved || apiKeyRemoved,
    revoked,
    apiKeyRemoved,
    applicationForgotten,
    ...(sharedWith.length > 0 ? { applicationSharedWith: sharedWith } : {}),
    ...(grant ? { grantType: grant.grantType } : {}),
  }
}
