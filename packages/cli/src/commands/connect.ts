import {
  connectWithAppToken,
  describeGrant,
  disconnectProject,
  isSecretName,
  LinearOAuthError,
  listOAuthApps,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
  readOAuthApp,
  registeredApplication,
  SECRET_NAMES,
  setProjectSecret,
  type LinearConnection,
  type ProjectGrantPresence,
  type SecretName,
} from '@ogun/core'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'
import { bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import {
  projectFlag,
  requireKnownProject,
  resolveProject,
  type ResolvedProject,
} from '../project-slug.ts'
import { prompt, promptHidden, readSecretValue } from '../prompt.ts'
import {
  refuseShadowedKey,
  settleReplacement,
  shadowedKeys,
  writeProjectKey,
} from './secret.ts'

/**
 * `ogun connect`, `ogun connect list`, `ogun disconnect` — one vocabulary for *access*
 * (ADR-0012 and ADR-0014, both amended).
 *
 * ### What this replaces, and why it is not two commands wearing one hat
 *
 * There were three ways to give Ogun access to Linear and they came from two unrelated
 * grammars:
 *
 * ```
 * ogun secret set linear          # a personal API key
 * ogun linear app                 # register the OAuth application
 * ogun linear connect             # …then authorize it
 * ```
 *
 * `linear` sat in the *command path*, which made a GitHub or Jira integration a whole new
 * command tree rather than a new value. So the integration is a **value**: `ogun connect
 * <integration>`. `github` and `jira` become arguments rather than command trees.
 *
 * ### Why `ogun secret` sits beside this rather than inside it
 *
 * The previous shape deleted `ogun secret` on the grounds that every name in
 * `SECRET_NAMES` was an integration credential, so the namespace held one kind of thing
 * and called it something else. The observation was right; the conclusion was not, and the
 * product owner reversed it: **a secret is not guaranteed to be an integration.** The
 * reason nothing but integrations was in that set is that the set refused everything else,
 * so "no counter-example exists" was a fact about the validator rather than about the
 * world.
 *
 * So there are two commands with two jobs, overlapping on one slot:
 *
 *  - `connect` is *access*. Which product, and how Ogun gets in — a grant, a client id and
 *    a secret, an expiry, a workspace. The integration is checked against `SECRET_NAMES`,
 *    because here a misspelling is a credential nothing polls.
 *  - `secret set` is *storage*. One free-form name, one value, for anything at all.
 *
 * `connect <integration> --api-key` and `secret set <integration> <key>` write the same
 * row through the same function under the same lock, and share `refuseShadowedKey`,
 * `settleReplacement` and `writeProjectKey` so neither door can enforce a rule the other
 * does not — including the one about overwriting, which is asked about at a terminal and
 * refused without `--replace` off one, identically here and there. `commands/secret.ts`
 * carries the full argument.
 *
 * ### Which of these need the control plane
 *
 * `connect`, `connect list` and `disconnect` reach **no server**. That is a
 * promise ADR-0012 made about the credential this replaces — *"it works before `ogun
 * init`, with the database down, and over SSH"* — and it had to be kept, because a
 * preferred mechanism that is *less* available than the discouraged one teaches operators
 * to reach for the discouraged one on exactly the bad night. `client_credentials` makes it
 * possible: a client id, a client secret and one POST to Linear, with nothing in the flow
 * that a running control plane has to hold.
 *
 * `--consent` is the exception and cannot be otherwise. Its `state` nonce lives in the
 * control-plane process and its callback is delivered to the control-plane process, so a
 * CLI doing it alone would be a second implementation of the CSRF check in a process that
 * never sees the callback.
 */

// ── the vocabulary ─────────────────────────────────────────────────────────

/**
 * The usage lines name **every** input, including the ones that are not arguments.
 *
 * This is the fourth time the point has been made and it is the acceptance bar for the
 * change: `ogun linear app [--project <slug>]` read as a complete command that takes
 * nothing, and the only way to discover that it prompts for a Client ID and a Client
 * Secret was to run it. A usage line that hides the input a command exists to collect is a
 * usage line that is wrong.
 *
 * ### Why the credentials are named flags and not positionals
 *
 * They were positionals for one commit — `ogun connect <integration> <client-id>
 * <client-secret>` — which does put them in the signature, and is still wrong. **Two
 * values of the same shape in a fixed order is a coin flip at the keyboard.** A client id
 * and a client secret are both opaque strings from the same page of Linear's settings;
 * nothing about either one tells you which slot it belongs in, and getting them the wrong
 * way round produces a token request that fails with a message about the *client*, not
 * about the order.
 *
 * So they are named: `--client-id <id> --client-secret <secret>`, in any order, each
 * unmistakable. The rule this expresses, and the one the rest of the CLI is now held to:
 * **a lone value can be positional; several credential values of the same shape must be
 * named.** That is why `ogun secret set <name> <key>` keeps `<key>` positional — it is the
 * only value there, and `<name>` is not a credential — and why `--api-key [<key>]` carries
 * its own.
 *
 * Nothing about *how* the values arrive changed: omit a flag and it is prompted for (the
 * Client ID visibly, the secret with the echo off) or read from stdin when stdin is a
 * pipe, and passing one inline works and warns. See `warnInlineSecret` for why that last
 * one is a warning rather than the refusal it briefly was.
 */
const USAGE_OAUTH =
  'ogun connect <integration> --client-id <id> --client-secret <secret> [--project <slug>]'
const USAGE_CONSENT =
  'ogun connect <integration> --consent --client-id <id> --client-secret <secret>'
const USAGE_KEY =
  'ogun connect <integration> --api-key [<key>] [--replace] [--project <slug>]'
const USAGE_LIST = 'ogun connect list [--project <slug>]'
const USAGE_DISCONNECT = 'ogun disconnect <integration> [--project <slug>] [--keep-application]'

const REGISTER_URL = 'https://linear.app/settings/api/applications/new'

/**
 * The flag names **what kind of thing you are connecting**, and the kind decides which
 * inputs are required.
 *
 * ### `--oauth` is back, and the reason it was rejected stopped being true
 *
 * The previous shape had three flags treated as peers — `--app-token`, `--consent`,
 * `--api-key` — and rejected `--oauth` in as many words:
 *
 * > *"The names describe what the credential is, because that is what an operator is
 * > choosing between, and none of them is `--oauth`: two of the three are OAuth, so a flag
 * > by that name would be the ambiguity this change exists to remove, one level down."*
 *
 * That was a correct description of the triple, and the triple was the mistake. The three
 * are not peers. **Two of them name a kind of integration and the third names a grant
 * inside one of those kinds**, and flattening that put a fork in the road where there is
 * no fork: somebody choosing between `--app-token` and `--consent` has already decided
 * they are connecting an OAuth application, and somebody choosing `--api-key` has decided
 * something else entirely. Once `--consent` is a modifier, "two of the three are OAuth" is
 * no longer a sentence about the kinds — both kinds are exactly one thing each.
 *
 * The two kinds are the two things that differ in what an operator has to *have*:
 *
 *  - `--oauth` — an application registered in the provider, which always means a client id
 *    and a client secret. The default, because it is the one that does not act as a
 *    person; the explicit spelling exists for the reason `LINEAR_SCOPES` is sent even
 *    though Linear says `read` is implied — a script that relies on a default is a script
 *    whose meaning changes when the default does.
 *  - `--api-key` — one key, and nothing else. There is no client id anywhere in it.
 *
 * ### `--consent` is a modifier inside the OAuth kind, and it implies it
 *
 * It selects the *grant*: authorization-code instead of client-credentials. It exists
 * because a client-credentials token reaches the workspace's public teams and no others,
 * so consent is the only path to a private one — and because some workspaces want
 * user-scoped access rather than an app installed at the workspace level.
 *
 * **`--consent` implies `--oauth`**, so nobody has to type both; `--oauth --consent` is
 * accepted and redundant rather than required, which is what makes it a modifier rather
 * than a second word to remember. `--api-key --consent` is refused, because there is no
 * such thing as an api key somebody approves in a browser.
 *
 * Considered and rejected: `--grant <client-credentials|authorization-code>`, which names
 * exactly what is being selected and matches the stored `grantType` and RFC 6749's own
 * words. It loses on what an operator is actually deciding. Nobody reaches for this flag
 * because they want a different grant; they reach for it because their teams are private,
 * and `--consent` is the word for the step that makes that work. The grant is the
 * mechanism, not the reason, and two long values to spell would be a second thing to look
 * up at the moment somebody is already lost.
 */
const KIND_FLAGS = {
  '--oauth': 'boolean',
  '--api-key': 'optional-string',
} as const

const CONNECT_FLAGS = {
  ...KIND_FLAGS,
  '--consent': 'boolean',
  '--client-id': 'string',
  '--client-secret': 'string',
  '--project': 'string',
  '--allow-unregistered': 'boolean',
  /**
   * The same flag `ogun secret set` takes, for the same row, meaning the same thing:
   * there is already a key stored under this name and destroying it is intended. Both
   * doors go through `settleReplacement`, so a rule enforced at one is enforced at both.
   */
  '--replace': 'boolean',
  /**
   * Declared so it can be refused by name. It was the explicit spelling of the default for
   * one commit and `--oauth` replaces it; "Unknown option '--app-token'" is a dead end for
   * anybody who copied a line out of that commit's help.
   */
  '--app-token': 'boolean',
} as const

type Kind = 'oauth' | 'api-key'

type ConnectFlags = {
  oauth?: boolean
  'api-key'?: string
  consent?: boolean
  'client-id'?: string
  'client-secret'?: string
  project?: string
  'allow-unregistered'?: boolean
  replace?: boolean
  'app-token'?: boolean
}

export async function connect(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(args, CONNECT_FLAGS, USAGE_OAUTH)
  const kind = chooseKind(flags)
  const integration = requireIntegration(positionals[0])
  refuseStrayPositional(positionals[1])

  const config = await loadLocalConfig()
  const project = await resolveProject(flags.project, config)
  /**
   * The slug is checked **before anything is prompted for or read**, in every kind.
   *
   * A command that collects a Client Secret and then says the project was misspelled has
   * already had a credential typed into a terminal that scrolls back, for nothing — and
   * has taught the operator that a rejected connect is harmless.
   */
  requireKnownProject(project, config, flags['allow-unregistered'] === true)

  if (kind === 'api-key') {
    return connectApiKey(integration, project, flags['api-key'] ?? '', flags.replace === true)
  }
  if (flags.consent === true) return connectConsent(integration, project, flags, serverUrl)
  return connectAppToken(integration, project, flags)
}

/**
 * Which kind of thing is being connected, or a refusal naming what was asked for.
 *
 * Refused rather than resolved by precedence. `--oauth --api-key` is not a preference to
 * be arbitrated; it is somebody who believes one of those two words means something other
 * than what it does, and silently honouring the winner would store a credential of a kind
 * they did not ask for — with a different attribution in Linear — and tell them it worked.
 *
 * The three refusals are three different mistakes and are worded separately, because "pick
 * one" is useless advice to somebody who wrote `--api-key --client-id abc`: they did pick
 * one, and then described an application to it.
 */
function chooseKind(flags: ConnectFlags): Kind {
  if (flags['app-token'] === true) {
    fail(
      '`--app-token` is now `--oauth`. The flag names what you are connecting rather than\n' +
        '  which token comes back, because an OAuth application always means a client id and\n' +
        '  a client secret and an api key never does. Nothing was stored.\n' +
        `    ${USAGE_OAUTH}`,
    )
  }

  const key = flags['api-key'] !== undefined
  if (key && flags.oauth === true) {
    fail(
      '--oauth and --api-key are different kinds of integration, and a project connects\n' +
        '  through one of them:\n' +
        '    --oauth       an application you registered. Needs --client-id and ' +
        '--client-secret.\n' +
        '    --api-key     one key, issued to you. Everything Ogun does appears as you.\n' +
        '  Nothing was stored.',
    )
  }
  if (key && flags.consent === true) {
    fail(
      '--consent is an OAuth grant, not a kind of connection: it is how somebody approves\n' +
        '  an application in a browser, and an api key has nobody to approve it. Drop one.\n' +
        `    reach private teams:  ${USAGE_CONSENT}\n` +
        `    use a personal key:   ${USAGE_KEY}\n` +
        '  Nothing was stored.',
    )
  }
  if (key && (flags['client-id'] !== undefined || flags['client-secret'] !== undefined)) {
    fail(
      '--api-key takes one key and no application: a client id and a client secret belong\n' +
        '  to an OAuth application, which is what --oauth connects. Nothing was stored.\n' +
        `    ${USAGE_OAUTH}\n` +
        `    ${USAGE_KEY}`,
    )
  }
  /**
   * `--replace` is about the stored key, so it is refused rather than ignored beside the
   * OAuth kind — an operator who typed it there believes a reconnect is gated, and finding
   * out that it never was is the kind of thing found out afterwards.
   *
   * And it is not gated, deliberately. The line `settleReplacement` draws is *what cannot
   * be got back*: an api key is minted once and this store is the only copy Ogun has, while
   * an OAuth reconnect spends a client id and secret that stay registered in the provider
   * to fetch a token that was going to expire in thirty days anyway. Asking somebody to
   * confirm the renewal that fixes their expired connection, on the night it expired, would
   * be a gate on the repair.
   */
  if (!key && flags.replace === true) {
    fail(
      '--replace is about a stored api key, and an OAuth connection has none to destroy:\n' +
        '  reconnecting reuses the application registered here and takes a fresh token, and\n' +
        '  the token it replaces was going to expire on its own. Nothing was changed.\n' +
        `    replace a stored key:  ${USAGE_KEY}\n` +
        `    reconnect:             ${USAGE_OAUTH}`,
    )
  }
  return key ? 'api-key' : 'oauth'
}

/**
 * The positional credentials are gone, and a leftover one is refused without being echoed.
 *
 * `ogun connect linear <client-id> <client-secret>` was the shape for one commit, so the
 * plausible second positional here is a **client secret** — and the next most plausible is
 * an api key from somebody who read `--api-key <key>` and dropped the flag. Quoting either
 * back would write a live credential to stderr on top of the shell history and the `ps`
 * window it is already in, which is the rule `requireIntegration` states below and the
 * same one the route in `system.ts` states.
 */
function refuseStrayPositional(extra: string | undefined): void {
  if (extra === undefined) return
  fail(
    'the client id and the client secret are flags now, not positionals — two opaque\n' +
      '  strings from the same page, in a fixed order, is a coin flip. Nothing was stored.\n' +
      `    ${USAGE_OAUTH}\n` +
      `    ${USAGE_KEY}\n` +
      '  What you typed is not repeated back, because the thing most likely to be in that\n' +
      '  position is a credential. If it was: treat it as compromised, and clear your shell\n' +
      '  history.',
  )
}

// ── the default: a token in Ogun's own name ────────────────────────────────

/**
 * `ogun connect linear` — register the application and take a token, in one sitting.
 *
 * This used to be two commands, and the reason it was two is gone. `ogun linear app`
 * existed because the authorization step needed a browser and a person, so there had to be
 * a place to stop between "here are the credentials" and "go and approve this".
 * `client_credentials` has nothing for a person to do, so there is nothing to stop for.
 *
 * ### It asks for nothing when there is nothing new to ask for
 *
 * With no `--client-id` and an application already registered, the stored client id and
 * secret are reused. That covers the reconnect after a 30-day token lapses, the retry
 * after a token request that failed on the network, and rotating nothing at all — three
 * paths that would otherwise each send somebody back to Linear's settings page for a value
 * this machine is already holding. A value re-pasted is a value re-typed, and that is how
 * a trailing space gets into a credential.
 */
async function connectAppToken(
  integration: SecretName,
  project: ResolvedProject,
  flags: ConnectFlags,
): Promise<void> {
  const existing = await readOAuthApp(project.slug, integration)

  /**
   * Switching a consent connection to a client-credentials one is refused, not performed.
   *
   * It looks like a reconnect and it is a **reduction in reach**: an authorization-code
   * grant sees the teams whoever approved it could see, private ones included, and a
   * client-credentials token sees public teams only. Performing it silently would leave a
   * poll that authenticates perfectly and returns nothing, which is the worst failure shape
   * there is — no error anywhere, just a source that stops finding tickets. So the refusal
   * names both ways forward and lets the operator say which they meant.
   */
  if (existing.state === 'present' && existing.app.grant?.grantType === 'authorization_code') {
    fail(
      `"${project.slug}" is connected to ${integration} through the consent flow, which ` +
        'reaches teams a\n' +
        '  client-credentials token cannot — it sees public teams only. Nothing was ' +
        'changed.\n' +
        `    renew what you have:  ogun connect ${integration} --consent` +
        `${projectFlag(project)}\n` +
        `    switch anyway:        ogun disconnect ${integration}${projectFlag(project)} ` +
        `&& ogun connect ${integration}${projectFlag(project)}`,
    )
  }

  const credentials = await collectApplication(integration, project, flags, existing.state)

  let connection: LinearConnection
  try {
    connection = await connectWithAppToken(project.slug, integration, credentials)
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    /**
     * `err.message` has already been through `scrubSecrets` where it was built, so it
     * cannot carry the client secret even if Linear echoed one back — which is the whole
     * reason that scrubbing happens at construction rather than here.
     */
    fail(
      `${err.message}.\n` +
        `  The application is registered, so retrying is \`ogun connect ${integration}` +
        `${projectFlag(project)}\`\n  with no arguments — it will not ask you to paste ` +
        'anything again.',
    )
  }
  announce(connection, integration, project)
}

/**
 * The client id and secret, from the command line, a prompt, a pipe, or the store.
 *
 * The client id is treated as **not a secret** throughout, which is ADR-0014's finding and
 * not a shortcut: it is in every authorization URL a browser visits and on Linear's own
 * settings page. So it is prompted for *visibly* — an operator has to be able to check
 * they pasted the right one — and passing it inline draws no warning. Warning about a
 * value that is not a secret is how an operator learns to scroll past warnings.
 *
 * ### Each half falls back to the store on its own, and the secret only with its id
 *
 * Separate flags made a rotation expressible that two positionals could not carry:
 * `ogun connect linear --client-secret <new>` is "I rotated the secret in Linear's
 * settings and the application is otherwise the same". So a missing `--client-id` takes
 * the registered one rather than sending somebody back for a value this machine holds.
 *
 * The reverse fallback is **conditional on the id matching**, and that is the important
 * half. A stored client secret belongs to a stored client id; reusing it under a client id
 * the operator just typed would pair a secret with an application it was never issued for,
 * and the token request fails with a message about the *client* that names neither. So a
 * new id asks for its own secret.
 */
async function collectApplication(
  integration: SecretName,
  project: ResolvedProject,
  flags: ConnectFlags,
  storedState: string,
): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  const inlineId = flags['client-id']
  const inlineSecret = flags['client-secret']
  const stored =
    storedState === 'present'
      ? await registeredApplication(project.slug, integration)
      : undefined

  // Neither given and an application on file: the reconnect, which asks for nothing.
  if (inlineId === undefined && inlineSecret === undefined && stored) {
    console.log(
      dim(
        `  using the ${integration} application already registered here (client ` +
          `${stored.clientId})`,
      ),
    )
    return stored
  }

  const clientId = (inlineId ?? stored?.clientId ?? '').trim()
  /** Only usable while it still belongs to the client id actually being registered. */
  const reusableSecret =
    stored !== undefined && clientId === stored.clientId ? stored.clientSecret : undefined
  const asksForId = clientId === ''
  const asksForSecret = inlineSecret === undefined && reusableSecret === undefined

  console.log(bold(`\nConnect ${cyan(project.slug)} to ${cyan(integration)}\n`))
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
  if (asksForId || asksForSecret) {
    console.log(`  Create an application at ${cyan(REGISTER_URL)}`)
    console.log(
      dim(
        '  Linear recommends creating it in a workspace you use for managing ' +
          'applications,\n  because every admin of that workspace can see it. You need ' +
          'the Client ID and\n  the Client Secret from that page; there is no callback URL ' +
          'to register, because\n  this connection does not use a browser.\n',
      ),
    )
  }

  const resolvedId = asksForId ? (await prompt('  Client ID: ')).trim() : clientId
  if (resolvedId === '') fail('nothing was stored — a client id is required')
  // Said out loud: binding a rotated secret to an id the operator cannot see is how the
  // wrong application ends up authenticating a poll nobody is watching.
  if (inlineId === undefined && stored && !asksForId) {
    console.log(dim(`  keeping the registered client id (${resolvedId})\n`))
  }

  const clientSecret =
    inlineSecret === undefined && reusableSecret !== undefined
      ? reusableSecret
      : await readSecretValue(inlineSecret, 'a client secret', () =>
          promptHidden('  Client secret (not echoed): '),
        )

  /**
   * Empty rather than a plausible-looking `http://localhost:7777/…`.
   *
   * There is no browser in this flow, so there is no redirect URI — and inventing one would
   * put a string in the store that Linear has never been told about, which is exactly the
   * mismatch that field exists to make visible. `--consent` writes a real one, through the
   * server, because the server that receives the callback is the only thing that knows what
   * address a browser can reach it at.
   */
  return { clientId, clientSecret, redirectUri: '' }
}

// ── the consent flow, for private teams and user-scoped access ─────────────

/**
 * `ogun connect linear --consent` — the authorization-code flow, kept and made reachable.
 *
 * It is not the default any more and it is not deprecated either. Two things need it, and
 * both are real:
 *
 *  - **Private teams.** A client-credentials token reaches the workspace's *public* teams
 *    and no others. A workspace that keeps its teams private cannot be polled any other
 *    way.
 *  - **User-scoped access**, where what Ogun should see is what one person can see rather
 *    than what the workspace publishes.
 *
 * The cost it carries is the one ADR-0014 named: `actor=app` is a workspace-level install
 * and Linear requires an admin to approve it.
 *
 * This is the one mechanism that needs the control plane, and the reason is structural
 * rather than incidental — the `state` nonce lives in that process and the callback is
 * delivered to it.
 */
async function connectConsent(
  integration: SecretName,
  project: ResolvedProject,
  flags: ConnectFlags,
  serverUrl: string,
): Promise<void> {
  const inlineId = flags['client-id']
  const inlineSecret = flags['client-secret']

  await requireProjectOnControlPlane(project, serverUrl)
  const here = projectFlag(project)

  const status = await get(serverUrl, '/api/oauth/linear')
  const redirectUri = String(status.redirectUri)

  const stored = await registeredApplication(project.slug, integration)
  const reuse =
    inlineId === undefined &&
    inlineSecret === undefined &&
    stored !== undefined &&
    stored.redirectUri === redirectUri

  if (!reuse) {
    console.log(bold(`\nConnect ${cyan(project.slug)} to ${cyan(integration)}, with consent\n`))
    if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
    console.log(`  Create an application at ${cyan(REGISTER_URL)}`)
    console.log(`  Redirect callback URL to register: ${cyan(redirectUri)}`)
    console.log(
      dim(
        '  Linear matches this exactly — scheme, host, port and trailing slash. A ' +
          'mismatch\n  is the classic failure of this flow and the error it gives says ' +
          'nothing useful.\n',
      ),
    )

    // The same per-field fallback `collectApplication` documents: a rotated secret keeps
    // the registered client id, and a new client id never inherits the old one's secret.
    const known = (inlineId ?? stored?.clientId ?? '').trim()
    const clientId = known === '' ? (await prompt('  Client ID: ')).trim() : known
    if (clientId === '') fail('nothing was stored — a client id is required')
    const reusableSecret =
      stored !== undefined && clientId === stored.clientId ? stored.clientSecret : undefined
    const clientSecret =
      inlineSecret === undefined && reusableSecret !== undefined
        ? reusableSecret
        : await readSecretValue(inlineSecret, 'a client secret', () =>
            promptHidden('  Client secret (not echoed): '),
          )
    await send(serverUrl, `/api/oauth/linear/app/${project.slug}`, 'PUT', {
      clientId,
      clientSecret,
    })
  }

  const start = await send(serverUrl, `/api/oauth/linear/start/${project.slug}`, 'POST', {})
  if (start.authorizeUrl === undefined) {
    fail('the control plane did not return an authorization URL — upgrade it')
  }

  console.log('\n  1. Open this URL and approve the installation:\n')
  console.log(`     ${cyan(String(start.authorizeUrl))}\n`)
  console.log(
    dim(
      `     Requesting: ${(start.scopes as string[]).join(', ')}, as \`actor=${start.actor}\`.\n` +
        '     `actor=app` makes Ogun act as the application rather than as you — but it\n' +
        '     installs at the workspace level, so Linear needs a workspace admin to\n' +
        '     approve it. If you are not one and your teams are public, the default\n' +
        `     \`ogun connect ${integration}\` needs no approval at all.\n`,
    ),
  )
  console.log('  2. Linear sends your browser back to:\n')
  console.log(`     ${dim(String(start.redirectUri))}\n`)
  console.log(
    dim(`     If your browser can reach that, you are done — \`ogun connect list${here}\`.\n`),
  )

  if (!process.stdin.isTTY) {
    // Said out loud rather than silently skipped: a scripted `--consent` that printed a URL
    // and exited 0 reads like it finished.
    console.log(
      yellow('  stdin is not a terminal, so there is nothing to paste into.') +
        dim('\n  Run this from a terminal to finish a connect the browser could not.'),
    )
    return
  }

  console.log(
    '  3. If the browser could not reach it, paste the whole URL it ended up on\n' +
      dim('     (or press enter to leave it to the browser):\n'),
  )
  const pasted = (await promptHidden('     URL (not echoed): ')).trim()
  if (pasted === '') {
    console.log(dim(`\n  left to the browser. \`ogun connect list${here}\``))
    return
  }
  const done = await send(serverUrl, '/api/oauth/linear/exchange', 'POST', { redirectUrl: pasted })
  announce(done.connected as LinearConnection, integration, project)
}

// ── the personal API key ───────────────────────────────────────────────────

/**
 * `ogun connect linear --api-key` — the credential that is a person.
 *
 * Kept, documented, and no longer a separate command. ADR-0014 keeps it because
 * `actor=app` is a workspace-level install needing an admin's approval, so removing it
 * would strand an operator who is not one; that argument is weaker now that the default
 * grant needs no approval either, and it is not gone — a personal key is still the only
 * thing that works when somebody cannot register an application in their workspace at all.
 *
 * What it costs is stated wherever it is offered, because it is invisible at the moment of
 * typing and permanent afterwards: everything Ogun reads it does as **you**, and the
 * moment write-back lands every comment it posts appears under your name on a board other
 * people make decisions from.
 *
 * ### It is `ogun secret set <integration>` wearing this command's vocabulary
 *
 * The same slot, the same lock, the same three shared rules — `refuseShadowedKey`,
 * `settleReplacement`, `writeProjectKey` are called from both doors rather than copied
 * into each. What is different is what surrounds them: this one knows the name is an
 * integration, so it can say what connecting by key *means* for attribution and name the
 * application flow that avoids it. `ogun secret set linear <key>` reaches the identical
 * state and says the storage half.
 *
 * Two doors onto one slot is a cost, and it is a smaller cost than the alternative was:
 * folding the store into `connect` meant a project could not hold a secret that is not a
 * connection, and separating the stores would mean two places a `linear` key can be and
 * two answers to whether one is live.
 */
async function connectApiKey(
  integration: SecretName,
  project: ResolvedProject,
  inline: string,
  replace: boolean,
): Promise<void> {
  // `''` is `--api-key` with no value: prompt at a terminal, read the pipe otherwise.
  const inlineKey = inline === '' ? undefined : inline

  await refuseShadowedKey(project, integration)
  await settleReplacement(project, integration, {
    replace,
    what: 'api key',
    usage: USAGE_KEY,
  })

  const value = await readSecretValue(inlineKey, 'an api key', () =>
    promptHidden(`  ${integration} key for ${project.slug} (not echoed): `),
  )
  const displaced = await setProjectSecret(project.slug, integration, value)

  await writeProjectKey(project, integration, value.length, displaced, {
    stored: `  ${project.slug} connected to ${integration} with a personal api key`,
    replaced: `  ${project.slug} reconnected to ${integration} with a personal api key`,
  })

  console.log(
    yellow('  Everything Ogun reads, it reads as you.') +
      dim(
        ' Once write-back lands, every comment it\n  posts appears under your name. ' +
          `\`ogun connect ${integration} --oauth\` connects as an\n  application instead, ` +
          'and needs no approval when your teams are public.',
      ),
  )
}

/** What a finished connection looks like, from whichever mechanism finished it. */
function announce(
  connection: LinearConnection,
  integration: SecretName,
  project: ResolvedProject,
): void {
  const where = connection.workspace ? ` to ${connection.workspace}` : ''
  console.log(green(`\n  ${project.slug} connected${where}`))
  console.log(
    dim(
      `  as ${connection.actor}, scopes ${connection.scopes.join(' ')}, ` +
        `${describeGrant(connection.expiresAt).detail}`,
    ),
  )

  /**
   * The teams this token can see, printed because the alternative is finding out in a
   * fortnight.
   *
   * A `client_credentials` token reaches the workspace's **public** teams and no others,
   * and a token that reaches none of the teams somebody wanted polled does not fail — it
   * succeeds, and returns nothing, forever. This is the one moment a person is watching, so
   * it is the one moment worth spending a query on.
   *
   * A failed probe and a token that genuinely sees nothing are printed differently, because
   * the first is a display problem on a working connection and the second is a connection
   * that will never do anything.
   */
  if (connection.teams.length > 0) {
    console.log(
      dim(`  teams it can read: ${connection.teams.map((t) => t.key).join(', ')}`) +
        (connection.grantType === 'client_credentials'
          ? dim(' — public teams only')
          : ''),
    )
  } else if (connection.grantType === 'client_credentials') {
    console.log(
      yellow('  it can read no teams.') +
        dim(
          ' A client-credentials token reaches public teams only, so a\n' +
            '  workspace whose teams are private polls successfully and finds nothing. ' +
            `\`ogun connect\n  ${integration} --consent\` is the flow that reaches private ` +
            'teams.',
        ),
    )
  }

  if (connection.apiKeyRetired) {
    console.log(
      dim('  the personal api key stored for this project was removed — a grant wins over'),
    )
    console.log(dim('  a key, so leaving it would have left a credential nothing reads'))
  }
  console.log(dim(`  ${localConfigPath()}, mode 0600, on this machine only`))
  console.log(dim(`  \`ogun connect list${projectFlag(project)}\``))
}

// ── the listing ────────────────────────────────────────────────────────────

/**
 * `ogun connect list [--project <slug>]` — what this machine can reach, and how healthy.
 *
 * ### A subcommand, not a second top-level noun
 *
 * It was `ogun connections`, which put a *listing* at the same level as the three verbs
 * that act — and then `ogun secret list` came back beside it, so the CLI would have had
 * two conventions for "show me what is stored" depending on which noun you started from.
 * `connect list` mirrors `secret list`, and the top level keeps the verbs. `ogun
 * connections` is dropped rather than aliased and answers with a line naming this.
 *
 * `disconnect` stays a top-level verb, deliberately. It is an act rather than a view, it
 * is the one somebody reaches for during an incident, and `ogun connect rm` would read as
 * removing a listing row rather than revoking a token at Linear.
 *
 * ### One table, where there were two
 *
 * `ogun linear status` showed grants and `ogun secret list` showed keys, and neither could
 * see the other — so the answer to "is this project connected" depended on which of two
 * commands you happened to run, and a project with both showed up twice with no indication
 * that only one of them was being read. This shows every credential a project has for an
 * integration in one row, and says which one a poll would actually use.
 *
 * ### It shows keys, but only the ones that are integrations
 *
 * `secrets` may now hold anything (`ogun secret set <name>`), and a webhook signing key is
 * not a connection: listing one here would answer "what can this project reach" with a
 * value nothing reaches anything with. So key rows are filtered to `SECRET_NAMES`, and the
 * footer says how many were left out and where they are, because a listing that silently
 * omits rows is how the two commands start disagreeing about what is stored.
 *
 * ### It reads the store, not the server
 *
 * Deliberately. "Is this connected" is asked most often when something is not working, and
 * a listing that needs the control plane up cannot answer it then. It reads the same
 * functions the server reads, so the two cannot disagree.
 *
 * ### It does not narrow to the current directory
 *
 * `connect` and `disconnect` infer a project because they act on exactly one and naming the
 * wrong one is their whole failure mode. This acts on none. A listing that silently
 * narrowed to wherever the shell was standing would print "nothing connected on this
 * machine" on a machine holding four — the worst answer a presence check can give, and the
 * one an operator debugging an outage is least equipped to disbelieve.
 *
 * There is no field here a token would fit in, and that is structural rather than
 * remembered: `ProjectGrantPresence` carries a client id, a workspace, scopes and an
 * expiry, and `ProjectSecretPresence` carries a name and a state.
 */
export async function connectList(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--project': 'string' }, USAGE_LIST)
  const only = flags.project

  const apps = (await listOAuthApps()).filter((a) => (only ? a.project === only : true))
  const secrets = (await listProjectSecrets().catch(() => [])).filter((s) =>
    only ? s.project === only : true,
  )
  const keys = secrets.filter((s) => isSecretName(s.name))
  const otherSecrets = secrets.length - keys.length

  const shadowed = await shadowedKeys()
  const keyRows = keys.map((k) => ({
    project: k.project,
    integration: k.name,
    via: 'api key',
    state:
      k.state === 'empty'
        ? yellow('empty — connect it again')
        : shadowed.has(`${k.project}/${k.name}`)
          ? // The line that earns this listing. A grant wins over a key, so an operator
            // rotating this one would be changing something nothing reads.
            red('stored, NOT used — the application grant wins')
          : green('in use'),
    workspace: dim('—'),
  }))

  const appRows = apps.map((a) => ({
    project: a.project,
    integration: a.provider,
    via: via(a),
    state: stateOf(a),
    workspace: a.workspace?.name ?? dim('—'),
  }))

  const rows = [...appRows, ...keyRows].sort(
    (x, y) => x.project.localeCompare(y.project) || x.integration.localeCompare(y.integration),
  )

  if (rows.length === 0) {
    console.log(
      dim(
        only
          ? `${only} is not connected to anything on this machine`
          : 'nothing is connected on this machine',
      ),
    )
    console.log(dim(`  ${USAGE_OAUTH}`))
    if (otherSecrets > 0) console.log(dim(`  ${storedElsewhere(otherSecrets)}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('INTEGRATION'), bold('VIA'), bold('WORKSPACE'), bold('')],
      ...rows.map((r) => [cyan(r.project), r.integration, r.via, r.workspace, r.state]),
    ]),
  )
  console.log(dim(`\ntokens and keys are never printed. ${localConfigPath()}`))
  if (otherSecrets > 0) console.log(dim(storedElsewhere(otherSecrets)))
}

/**
 * Said whenever this listing has left something out, because "nothing is connected" on a
 * machine that is holding four stored values is the answer an operator is least equipped
 * to disbelieve.
 */
const storedElsewhere = (count: number): string =>
  `${count} other stored ${count === 1 ? 'secret is' : 'secrets are'} not an integration ` +
  'and not listed here — `ogun secret list`'

/**
 * How a project is connected, in one column, because the two grants differ in what they
 * can *see* and "connected" alone cannot explain a source that finds no tickets.
 */
const via = (app: ProjectGrantPresence): string => {
  if (app.malformed !== undefined) return dim('—')
  if (!app.connected) return dim('application only')
  return app.grantType === 'client_credentials' ? 'app token' : 'consent'
}

const stateOf = (app: ProjectGrantPresence): string => {
  if (app.malformed !== undefined) return red(`unreadable — ${app.malformed}`)
  if (!app.connected) return yellow('registered, not connected')
  // Green even when expired: the next poll renews it, and colouring that red would train
  // an operator to act on the one state that needs no action.
  return green(describeGrant(app.expiresAt).detail)
}

// ── disconnecting ──────────────────────────────────────────────────────────

/**
 * `ogun disconnect <integration> [--keep-application]` — remove every credential this
 * project has for it.
 *
 * The work is `disconnectProject` in core, which is also what the Settings page's button
 * calls; see it for why the default now removes the client id and secret and why
 * `--keep-application` is refused on a client-credentials connection.
 *
 * **Nothing here checks the slug**, where `connect` checks it — and the exemption is the
 * same one `ogun secret rm` had. `connections` prints whatever is in the file, and §4.5
 * says the file gets hand-edited, so an entry left behind by a project that has since been
 * removed is a row an operator can *see*. Refusing to remove it would strand a live
 * credential in the store with the listing still advertising it: the validator protecting
 * a value from its owner. Validation guards writes, where an unknown slug creates a
 * credential nothing reads; a removal creates nothing.
 *
 * It reaches no server, which matters here more than anywhere: the moment you most want to
 * remove a credential is during an incident, and an incident is when the control plane is
 * least likely to be answering.
 */
export async function disconnect(args: string[]): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { '--project': 'string', '--keep-application': 'boolean' },
    USAGE_DISCONNECT,
  )
  const integration = requireIntegration(positionals[0])
  if (positionals[1] !== undefined) fail(`usage: ${USAGE_DISCONNECT}`)

  const project = await resolveProject(flags.project, await loadLocalConfig())
  const outcome = await disconnectProject(project.slug, integration, {
    keepApplication: flags['keep-application'] === true,
  })
  if (!outcome.ok) fail(outcome.detail)

  /**
   * "removed" and "there was nothing here" are different answers, and the second is the
   * more interesting one: the project is inferred from the directory, so a `disconnect` run
   * one level too high is a plausible way to reach it — and "nothing changed" whispered in
   * grey reads like success to somebody who is scanning.
   */
  if (!outcome.removed) {
    console.log(
      yellow(`${project.slug} had no ${integration} credential on this machine — nothing changed`),
    )
    if (project.from !== 'flag') {
      console.log(dim(`  project taken from ${project.from} — \`ogun connect list\` has the rest`))
    }
    return
  }

  console.log(green(`${project.slug} disconnected from ${integration}`))
  /**
   * Said only when there was a token to revoke.
   *
   * A project holding only a personal API key has nothing at Linear for this command to
   * revoke — the key is the person's, minted in Linear's own UI, and Ogun could not revoke
   * it if it wanted to. Printing "Linear could not be told" there is a warning about a
   * failure that did not happen, on the run where nothing was ever going to be sent, and
   * it is the kind of line that teaches an operator to stop reading them.
   */
  if (outcome.grantType !== undefined) {
    console.log(
      outcome.revoked
        ? dim('  the access token was revoked at Linear as well')
        : yellow('  Linear could not be told — revoke the token by hand if it matters'),
    )
  }
  if (outcome.apiKeyRemoved) {
    // "too" only when something else went with it. A project that held nothing but a key
    // reads that word as evidence of a grant it never had.
    console.log(
      dim(`  the personal api key was removed${outcome.grantType !== undefined ? ' too' : ''}`),
    )
  }
  if (outcome.applicationForgotten) {
    console.log(
      dim('  the client id and secret went with it: under the default grant they are what'),
    )
    console.log(dim('  mints the token, so leaving them would not have been a disconnection'))
  } else if (flags['keep-application']) {
    console.log(
      dim(
        `  the application is still registered — \`ogun connect ${integration} --consent` +
          `${projectFlag(project)}\``,
      ),
    )
  }
  console.log(
    dim(`  ${project.slug} has nothing to poll ${integration} with now; a poll will refuse.`),
  )
}

// ── which integration, which project ───────────────────────────────────────

/**
 * An integration Ogun cannot read is refused at the moment it is typed.
 *
 * The alternative is a store that accepts anything, which means a typo is a credential that
 * exists, reports as connected, and is read by nothing — the same silent hole
 * `inertPolicies` warns about elsewhere, except the symptom here is an unauthenticated
 * poller hours later.
 *
 * **The rejected word is not echoed back.** The plausible way to arrive here is
 * `ogun connect lin_api_…` — somebody who reached for the credential where the integration
 * goes. Quoting it would put the key into stderr, on top of the shell history and the `ps`
 * window it is already in. `system.ts`'s route withholds a rejected secret name for exactly
 * this reason and said so first.
 */
function requireIntegration(name: string | undefined): SecretName {
  if (name !== undefined && isSecretName(name)) return name
  if (name === undefined) {
    fail(
      `usage: ${USAGE_OAUTH}\n` +
        `       ${USAGE_CONSENT}\n` +
        `       ${USAGE_KEY}\n` +
        `       ${USAGE_LIST}`,
    )
  }
  return fail(
    `that is not an integration Ogun connects to. Known: ${SECRET_NAMES.join(', ')}.\n` +
      '  Nothing was stored — a credential nothing reads looks exactly like one that ' +
      'works.\n' +
      '  What you typed is not repeated back, because the thing most likely to be there ' +
      'by\n  mistake is the credential itself. If it was: treat it as compromised, and ' +
      'clear your\n  shell history.',
  )
}

/**
 * The control plane's own view of which slugs it polls, for the one mechanism that reaches
 * it anyway.
 *
 * Not a second rule (see `requireKnownProject`) — it is the same refusal arriving from the
 * oracle that decides the answer, at a point where asking is free because the command is
 * about to talk to that server regardless. What it adds is *when*: before the two prompts,
 * one of which collects a Client Secret.
 */
async function requireProjectOnControlPlane(
  project: ResolvedProject,
  serverUrl: string,
): Promise<void> {
  const body = await get(serverUrl, '/api/projects')
  const known = ((body.projects ?? []) as Array<{ slug: string }>).map((p) => p.slug).sort()
  if (known.includes(project.slug)) return

  fail(
    `"${project.slug}" is not a project this control plane knows.\n` +
      '  ' +
      (known.length > 0 ? `Known: ${known.join(', ')}.` : 'It knows no projects yet.') +
      '\n' +
      '  Nothing was stored. `ogun project sync` in the repository is what registers it.',
  )
}

// ── talking to the control plane ───────────────────────────────────────────

/**
 * One request helper, and it never puts a response body it could not parse into an error.
 *
 * The server's failures here are already sentences meant for a person — a redirect-URI
 * mismatch, a project it does not know, a transport refusal naming the CLI — so `error` is
 * forwarded as it stands. Anything else is reported by status code alone: an unparseable
 * body from these endpoints is a proxy in the way, and pasting its HTML into a terminal
 * helps nobody.
 */
async function request(
  serverUrl: string,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(await authHeaders()) },
  }).catch((err: Error) => {
    fail(`could not reach the control plane at ${serverUrl}: ${err.message}`)
  })

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    fail(`${response.status} from ${path}, and the body was not JSON`)
  }
  const record = (body ?? {}) as Record<string, unknown>
  if (!response.ok) {
    fail(typeof record.error === 'string' ? record.error : `${response.status} from ${path}`)
  }
  return record
}

const get = (serverUrl: string, path: string): Promise<Record<string, unknown>> =>
  request(serverUrl, path, { method: 'GET' })

const send = (
  serverUrl: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<Record<string, unknown>> =>
  request(serverUrl, path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
