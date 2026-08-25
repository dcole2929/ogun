import {
  connectWithAppToken,
  describeGrant,
  disconnectProject,
  InvalidSecret,
  isSecretName,
  LinearOAuthError,
  listOAuthApps,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
  normalizeSecretInput,
  readOAuthApp,
  registeredApplication,
  SECRET_NAMES,
  setProjectSecret,
  type LinearConnection,
  type LocalConfig,
  type ProjectGrantPresence,
  type SecretName,
} from '@ogun/core'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'
import { bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import { projectFlag, resolveProject, type ResolvedProject } from '../project-slug.ts'
import { prompt, promptHidden, readAllStdin, warnInlineSecret } from '../prompt.ts'

/**
 * `ogun connect`, `ogun connections`, `ogun disconnect` — one vocabulary for giving a
 * project access to an integration (ADR-0012 and ADR-0014, both amended).
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
 * command tree rather than a new value — and `secret set linear` was a second, unrelated
 * spelling of "let Ogun into this workspace", filed under storage rather than under
 * access. An operator asking "how do I connect this project to Linear" had to already know
 * which of two grammars the answer lived in.
 *
 * So the integration is a **value**: `ogun connect <integration>`. `github` and `jira`
 * become arguments rather than command trees, and `--api-key` becomes one of the
 * mechanisms `connect` offers rather than a separate command with its own conventions.
 *
 * ### Why the API key is a mechanism here rather than a command beside this
 *
 * It is the question the brief asked to be argued rather than assumed, and the argument is
 * short: two vocabularies for one act is the thing being fixed, and leaving `ogun secret
 * set linear` in place would have landed on two again. Every name in `SECRET_NAMES` today
 * *is* an integration credential, so the `secret` namespace was holding exactly one kind
 * of thing and calling it something else. If a secret ever appears that is not a
 * connection — a webhook signing key, say — `ogun secret` comes back for it, and
 * `connect` keeps the connections. Building that namespace now, for nothing that exists,
 * is the mistake ADR-0014 refused to make about write scopes.
 *
 * The old spellings are dropped rather than aliased, and answer with a line naming the new
 * one. Muscle memory outlives a release; "unknown command" is a dead end.
 *
 * ### Which of these need the control plane
 *
 * `connect` (default), `connections` and `disconnect` reach **no server**. That is a
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
 * This is the third time the point has been made and it is the acceptance bar for the
 * change: `ogun linear app [--project <slug>]` read as a complete command that takes
 * nothing, and the only way to discover that it prompts for a Client ID and a Client
 * Secret was to run it. A usage line that hides the input a command exists to collect is a
 * usage line that is wrong.
 *
 * So the values are positionals in the signature — where a reader sees them — and the help
 * beneath says where each one comes from when it is left out. That they are *optional*
 * positionals is deliberate and is explained at `warnInlineSecret`: passing a credential
 * inline works and warns, rather than being refused.
 */
const USAGE_CONNECT = 'ogun connect <integration> <client-id> <client-secret> [--project <slug>]'
const USAGE_CONNECT_KEY = 'ogun connect <integration> --api-key <key> [--project <slug>]'
const USAGE_CONNECTIONS = 'ogun connections [--project <slug>]'
const USAGE_DISCONNECT = 'ogun disconnect <integration> [--project <slug>] [--keep-application]'

const REGISTER_URL = 'https://linear.app/settings/api/applications/new'

/**
 * The three mechanisms, as flags rather than as a `--via <word>` whose values have to be
 * remembered.
 *
 * They are mutually exclusive and the default needs no flag. `--app-token` exists anyway,
 * as the explicit spelling of the default, for the reason `LINEAR_SCOPES` is sent
 * explicitly even though Linear says `read` is always present: **a script that relies on a
 * default is a script whose meaning changes when the default does.** An automated connect
 * that must stay a client-credentials connect can say so.
 *
 * The names describe what the credential *is*, because that is what an operator is
 * choosing between, and none of them is `--oauth`: two of the three *are* OAuth, so a flag
 * by that name would be the ambiguity this change exists to remove, one level down.
 */
const MECHANISM_FLAGS = {
  '--app-token': 'boolean',
  '--consent': 'boolean',
  '--api-key': 'boolean',
} as const

const CONNECT_FLAGS = {
  ...MECHANISM_FLAGS,
  '--project': 'string',
  '--allow-unregistered': 'boolean',
} as const

type Mechanism = 'app-token' | 'consent' | 'api-key'

export async function connect(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(args, CONNECT_FLAGS, USAGE_CONNECT)
  const mechanism = chooseMechanism(flags)
  const integration = requireIntegration(positionals[0])

  const config = await loadLocalConfig()
  const project = await resolveProject(flags.project, config)
  /**
   * The slug is checked **before anything is prompted for or read**, in every mechanism.
   *
   * A command that collects a Client Secret and then says the project was misspelled has
   * already had a credential typed into a terminal that scrolls back, for nothing — and
   * has taught the operator that a rejected connect is harmless.
   */
  requireKnownProject(project, config, flags['allow-unregistered'] === true)

  if (mechanism === 'api-key') return connectApiKey(integration, project, positionals.slice(1))
  if (mechanism === 'consent') {
    return connectConsent(integration, project, positionals.slice(1), serverUrl)
  }
  return connectAppToken(integration, project, positionals.slice(1))
}

/**
 * One mechanism, or a refusal naming the ones that were asked for.
 *
 * Refused rather than resolved by precedence. `--api-key --consent` is not a preference to
 * be arbitrated; it is somebody who believes one of those two words means something other
 * than what it does, and silently honouring the winner would store a credential of a kind
 * they did not ask for and tell them it worked.
 */
function chooseMechanism(flags: {
  'app-token'?: boolean
  consent?: boolean
  'api-key'?: boolean
}): Mechanism {
  const chosen: Mechanism[] = [
    ...(flags['app-token'] ? (['app-token'] as const) : []),
    ...(flags.consent ? (['consent'] as const) : []),
    ...(flags['api-key'] ? (['api-key'] as const) : []),
  ]
  if (chosen.length > 1) {
    fail(
      `--${chosen.join(' and --')} ask for different credentials, and a project has one.\n` +
        '  Pick one:\n' +
        '    (nothing)     Ogun takes a token in its own name. No browser, no approval.\n' +
        '    --consent     somebody approves an install in a browser. Private teams.\n' +
        '    --api-key     a personal API key. Everything Ogun does appears as you.\n' +
        '  Nothing was stored.',
    )
  }
  return chosen[0] ?? 'app-token'
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
 * With no positionals and an application already registered, the stored client id and
 * secret are reused. That covers the reconnect after a 30-day token lapses, the retry
 * after a token request that failed on the network, and rotating nothing at all — three
 * paths that would otherwise each send somebody back to Linear's settings page for a value
 * this machine is already holding. A value re-pasted is a value re-typed, and that is how
 * a trailing space gets into a credential.
 */
async function connectAppToken(
  integration: SecretName,
  project: ResolvedProject,
  rest: string[],
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

  const credentials = await collectApplication(integration, project, rest, existing.state)

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
 */
async function collectApplication(
  integration: SecretName,
  project: ResolvedProject,
  rest: string[],
  storedState: string,
): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  const [inlineId, inlineSecret, extra] = rest
  if (extra !== undefined) fail(`usage: ${USAGE_CONNECT}`)

  if (inlineId === undefined && storedState === 'present') {
    const stored = await registeredApplication(project.slug, integration)
    if (stored) {
      console.log(
        dim(`  using the ${integration} application already registered here (client ` +
          `${stored.clientId})`),
      )
      return stored
    }
  }

  console.log(bold(`\nConnect ${cyan(project.slug)} to ${cyan(integration)}\n`))
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
  if (inlineId === undefined) {
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

  const clientId = (inlineId ?? (await prompt('  Client ID: '))).trim()
  if (clientId === '') fail('nothing was stored — a client id is required')

  const clientSecret = await readSecretValue(inlineSecret, 'a client secret', () =>
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
  rest: string[],
  serverUrl: string,
): Promise<void> {
  const [inlineId, inlineSecret, extra] = rest
  if (extra !== undefined) fail(`usage: ${USAGE_CONNECT} --consent`)

  await requireProjectOnControlPlane(project, serverUrl)
  const here = projectFlag(project)

  const status = await get(serverUrl, '/api/oauth/linear')
  const redirectUri = String(status.redirectUri)

  const stored = await registeredApplication(project.slug, integration)
  const reuse = inlineId === undefined && stored !== undefined && stored.redirectUri === redirectUri

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

    const clientId = (inlineId ?? (await prompt('  Client ID: '))).trim()
    if (clientId === '') fail('nothing was stored — a client id is required')
    const clientSecret = await readSecretValue(inlineSecret, 'a client secret', () =>
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
    dim(`     If your browser can reach that, you are done — \`ogun connections${here}\`.\n`),
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
    console.log(dim(`\n  left to the browser. \`ogun connections${here}\``))
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
 */
async function connectApiKey(
  integration: SecretName,
  project: ResolvedProject,
  rest: string[],
): Promise<void> {
  const [inlineKey, extra] = rest
  if (extra !== undefined) fail(`usage: ${USAGE_CONNECT_KEY}`)

  /**
   * Refused when the project is already connected as an application, rather than stored
   * behind it.
   *
   * `readProjectSecret` prefers a grant over a key (ADR-0014), so storing one here would
   * put a live credential in the file that nothing reads — the precise failure the closed
   * set of secret names exists to prevent, arriving through the other half of a key's
   * address. The refusal names the command that makes room for it.
   */
  const existing = await readOAuthApp(project.slug, integration)
  if (existing.state === 'present' && existing.app.grant) {
    fail(
      `"${project.slug}" is already connected to ${integration} as an application, and a\n` +
        '  personal key would sit behind that grant being read by nothing. Nothing was ' +
        'stored.\n' +
        `  \`ogun disconnect ${integration}${projectFlag(project)}\` first if you mean to ` +
        'swap.',
    )
  }

  /**
   * At a terminal, say there is already one there *before* asking for the new one.
   *
   * Advisory rather than authoritative — it is a second read of the store and the fact it
   * reports could change before the write takes the lock. That is fine for what it is for:
   * a person one keystroke from pasting a key over a working one who does not know it. The
   * line printed *afterwards* is the one taken under the lock.
   *
   * Only at a TTY, and only when the value was not already on the command line. A pipe is a
   * rotation somebody wrote down on purpose, and a warning it cannot act on is noise in a
   * script's output.
   */
  if (process.stdin.isTTY && inlineKey === undefined) {
    const stored = await listProjectSecrets().catch(() => [])
    if (stored.some((e) => e.project === project.slug && e.name === integration)) {
      console.log(yellow(`  ${project.slug} already has a ${integration} key on this machine.`))
      console.log(dim('  Storing replaces it, and there is no history. Ctrl-C to stop.'))
    }
  }

  const value = await readSecretValue(inlineKey, 'an api key', () =>
    promptHidden(`${integration} key for ${project.slug}: `),
  )
  const displaced = await setProjectSecret(project.slug, integration, value)

  /**
   * The confirmation says the length and nothing else about the value.
   *
   * Not even the last four characters: a suffix is the standard reassurance and it is a
   * disclosure, and this command is run over SSH into a terminal that scrolls back. The
   * length catches the two mistakes a set can make — a truncated paste, and a value that
   * picked up something it should not have — and narrows a random key by nothing.
   */
  const verb = displaced === 'absent' ? 'connected' : 'reconnected'
  console.log(
    green(`\n  ${project.slug} ${verb} to ${integration} with a personal api key`) +
      dim(` (${value.length} characters)`),
  )
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}`))
  if (displaced === 'present') {
    console.log(dim('  The previous key is gone: there is no history and no second slot.'))
    console.log(dim('  If the new one is wrong, mint another in Linear — the old value'))
    console.log(dim('  cannot be recovered from this machine.'))
  } else if (displaced === 'empty') {
    // Only reachable by hand-editing config.json, and worth naming: a blank entry is what
    // a poller reads as a key that exists and does not work, so this is a repair.
    console.log(dim(`  ${project.slug} had a blank ${integration} entry here, which a poller`))
    console.log(dim('  reads as a key that exists and does not work. It is filled in now.'))
  }
  console.log(dim(`  stored in ${localConfigPath()}, mode 0600, on this machine only`))
  console.log(
    yellow('  Everything Ogun reads, it reads as you.') +
      dim(
        ' Once write-back lands, every comment it\n  posts appears under your name. ' +
          `\`ogun connect ${integration}\` connects as an application\n  instead, and needs ` +
          'no approval when your teams are public.',
      ),
  )
}

/**
 * A credential, from argv, a pipe, or a prompt — in that order, and never echoed.
 *
 * The three sources are not a preference: the shape of the invocation has already chosen.
 * An inline value was chosen explicitly, a pipe means stdin is not a terminal, and a
 * terminal means there is somebody to ask. A `--stdin` flag that had to be remembered
 * would mostly be discovered by pasting a key into a hung command.
 *
 * `warnInlineSecret` carries the argument for accepting an inline value at all, and for
 * the refusal that used to be here instead.
 */
async function readSecretValue(
  inline: string | undefined,
  what: string,
  ask: () => Promise<string>,
): Promise<string> {
  const raw =
    inline !== undefined
      ? (warnInlineSecret(what), inline)
      : process.stdin.isTTY
        ? await ask()
        : await readAllStdin()
  try {
    return normalizeSecretInput(raw)
  } catch (err) {
    if (!(err instanceof InvalidSecret)) throw err
    // `err.message` names the rule that was broken and never the value that broke it.
    return fail(err.message)
  }
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
  console.log(dim(`  \`ogun connections${projectFlag(project)}\``))
}

// ── the listing ────────────────────────────────────────────────────────────

/**
 * `ogun connections [--project <slug>]` — what this machine can reach, and how healthy it
 * is.
 *
 * ### One table, where there were two
 *
 * `ogun linear status` showed grants and `ogun secret list` showed keys, and neither could
 * see the other — so the answer to "is this project connected" depended on which of two
 * commands you happened to run, and a project with both showed up twice with no indication
 * that only one of them was being read. This shows every credential a project has for an
 * integration in one row, and says which one a poll would actually use.
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
export async function connections(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--project': 'string' }, USAGE_CONNECTIONS)
  const only = flags.project

  const apps = (await listOAuthApps()).filter((a) => (only ? a.project === only : true))
  const keys = (await listProjectSecrets().catch(() => [])).filter((s) =>
    only ? s.project === only : true,
  )

  const shadowed = new Set(
    apps.filter((a) => a.connected).map((a) => `${a.project}/${a.provider}`),
  )
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
    console.log(dim(`  ${USAGE_CONNECT}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('INTEGRATION'), bold('VIA'), bold('WORKSPACE'), bold('')],
      ...rows.map((r) => [cyan(r.project), r.integration, r.via, r.workspace, r.state]),
    ]),
  )
  console.log(dim(`\ntokens and keys are never printed. ${localConfigPath()}`))
}

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
      console.log(dim(`  project taken from ${project.from} — \`ogun connections\` has the rest`))
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
  if (name === undefined) fail(`usage: ${USAGE_CONNECT}\n         ${USAGE_CONNECT_KEY}`)
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
 * A slug this machine has never heard of is refused, and nothing is stored.
 *
 * ### One oracle, and the asymmetry that used to exist is gone
 *
 * ADR-0014 had two rules: `ogun secret set` checked the slug against this machine's
 * projects map with an `--allow-unregistered` escape, while `ogun linear app` checked it
 * against the control plane's database with no escape. The stated principle — *"each
 * command checks the slug against the best oracle it already depends on"* — was sound while
 * they were two commands. Under one `connect` it would become "each *mechanism* checks
 * against a different oracle", which is an asymmetry an operator has no way to predict:
 * the same command, the same slug, two different refusals and one flag that works in one of
 * them.
 *
 * So there is one user-visible rule: **`connect` checks the slug against this machine's own
 * evidence, before it asks for anything.** Local evidence is available in every mechanism,
 * costs no network, and — the part that matters — arrives *before the prompts*, which is
 * the property that made the control-plane check worth having in the first place.
 *
 * The control plane still checks its database when a mechanism reaches one. That is not a
 * second rule for the operator to learn: it is the server refusing a write it should not
 * accept, in the same sentence it always did, and with a database present there is no case
 * where an unknown slug is the right answer.
 *
 * ### Why there is an escape at all
 *
 * A hosted control plane is the legitimate case and is not exotic. `project sync` runs
 * where the repo is checked out; the machine that polls may never have held a copy, so its
 * projects map is legitimately empty while it polls four projects. The credential still
 * works there — `readProjectSecret` looks one up by slug and never consults that map — so a
 * refusal with no way through would lock the *correct* operator out of the one path that
 * works with the database down.
 *
 * `--allow-unregistered`, spelled out rather than `--force`, because what is being
 * overridden should be legible in the line that overrode it. It warns on the way through:
 * silence was the bug, and a flag somebody had to type is not silence.
 *
 * A slug read out of a `.ogun/config.yaml` in the current directory is accepted with no
 * flag even when the map has never heard of it. A repository declaring its own name is
 * stronger evidence than this machine's cache of that declaration, and demanding a
 * `project add` first would make "connect it, then sync" impossible for no gain.
 */
function requireKnownProject(
  project: ResolvedProject,
  config: LocalConfig,
  allowUnregistered: boolean,
): void {
  if (Object.hasOwn(config.projects, project.slug) || project.from === '.ogun/config.yaml') return

  if (allowUnregistered) {
    console.log(
      yellow(`  "${project.slug}" is not a project this machine knows — connecting anyway.`),
    )
    console.log(
      dim(
        '  Nothing here can confirm the slug, so a typo stays a typo until a poll 401s.\n' +
          '  It has to match the name the control plane polls this project under, exactly.',
      ),
    )
    return
  }

  const known = Object.keys(config.projects).sort()
  fail(
    `"${project.slug}" is not a project this machine knows.\n` +
      '  ' +
      (known.length > 0
        ? `Known here: ${known.join(', ')}.`
        : `No projects are registered in ${localConfigPath()}.`) +
      '\n' +
      '  Nothing was stored. A credential filed under a slug nothing polls reports as\n' +
      '  connected and is read by nothing.\n' +
      (project.from === 'the directory name'
        ? '  This directory has no .ogun/config.yaml, so the name was guessed from it. Run\n' +
          '  this inside the repository instead, or pass --project <slug>.\n'
        : '') +
      '  Register it with `ogun project sync` (or `ogun project add`), or — if the repo is\n' +
      '  checked out on another machine entirely — repeat with --allow-unregistered.',
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
