import {
  applicationIdentifier,
  connectGithubApp,
  connectWithAppToken,
  describeGrant,
  disconnectGithub,
  disconnectProject,
  GithubAppError,
  isSecretName,
  LinearOAuthError,
  linkApplication,
  linkedApplication,
  linkedGithubApplication,
  linkGithubApplication,
  listApplications,
  listGrants,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
  SECRET_NAMES,
  setProjectSecret,
  type ApplicationListing,
  type GithubConnection,
  type GrantPresence,
  type LinearConnection,
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
import { prompt, promptHidden, readAllStdin, readSecretValue, warnInlineSecret } from '../prompt.ts'
import {
  refuseShadowedKey,
  settleReplacement,
  shadowedKeys,
  writeProjectKey,
} from './secret.ts'
import { readFile } from 'node:fs/promises'

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
 *  - `connect` is *access*. Which product, and how Ogun gets in — a grant, an application,
 *    an expiry, an account. The integration is checked against `SECRET_NAMES`, because here
 *    a misspelling is a credential nothing polls.
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
 * `connect`, `connect list` and `disconnect` reach **no server**. That is a promise
 * ADR-0012 made about the credential this replaces — *"it works before `ogun init`, with
 * the database down, and over SSH"* — and it had to be kept, because a preferred mechanism
 * that is *less* available than the discouraged one teaches operators to reach for the
 * discouraged one on exactly the bad night. Both application kinds make it possible:
 * Linear's `client_credentials` is one POST, and a GitHub App signs a JWT with a key on
 * this disk. Neither has anything in it a running control plane has to hold.
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
 * ### The credentials are `key=value` positionals, and the three shapes before this one
 *
 * They were two positionals (`<client-id> <client-secret>`), then two named flags
 * (`--client-id`, `--client-secret`). The flags fixed the real fault with the positionals,
 * which is worth keeping in view: **two values of the same shape in a fixed order is a
 * coin flip at the keyboard**, and getting a client id and a client secret the wrong way
 * round produces a token request that fails with a message about the *client* rather than
 * about the order.
 *
 * What the flags got wrong is the next provider. `--client-id` and `--client-secret` are
 * Linear's words; a GitHub App has an app id, an installation id and a private key, and
 * none of them is a client anything. Per-provider flags would mean `--app-id` and
 * `--installation-id` and `--private-key` declared on one command, each valid for exactly
 * one value of `<integration>` and an "unknown option" for every other, and the help page
 * growing a column per provider. **There are no per-provider flags, ever.**
 *
 * `field=value` keeps everything the named flags bought — each value is labelled, order is
 * irrelevant, nothing is a coin flip — and makes the set of labels a fact about the
 * provider rather than about the command. An unknown key is an error that *lists the valid
 * ones*, so the discoverability a declared flag would have given is delivered at the
 * moment it is needed instead of on a help page nobody opened.
 *
 * Nothing about how the values arrive changed: omit a field and it is prompted for (the
 * public ones visibly, the secrets with the echo off) or read from stdin when stdin is a
 * pipe, and passing one inline works and warns. See `warnInlineSecret` for why that last
 * one is a warning rather than the refusal it briefly was.
 */
const USAGE_APP =
  'ogun connect <integration> --app [--as <name>] [--project <slug>] [field=value …]'
const USAGE_LINK =
  'ogun connect <integration> --app --link <name> [--project <slug>]'
const USAGE_CONSENT = 'ogun connect <integration> --consent [field=value …]'
const USAGE_KEY =
  'ogun connect <integration> --api-key [<key>] [--replace] [--project <slug>]'
const USAGE_LIST = 'ogun connect list [--project <slug>]'
const USAGE_DISCONNECT = 'ogun disconnect <integration> [--project <slug>] [--keep-application]'

/** Where each provider's application is registered, for the line that says to go there. */
const REGISTER_URL: Record<SecretName, string> = {
  linear: 'https://linear.app/settings/api/applications/new',
  github: 'https://github.com/settings/apps/new',
}

/**
 * The flag names **what kind of thing you are connecting**, and the kind decides which
 * fields are required.
 *
 * ### `--app`, and why it is not `--oauth`
 *
 * `--oauth` was the name for one iteration, and it justified itself like this:
 *
 * > *"an application registered in the provider, which **always means a client id and a
 * > client secret**"*
 *
 * **That sentence is false**, and it was false when it was written — it was a description
 * of the one provider that existed. RFC 6749 §2.1 defines *public* clients, which have a
 * client id and **no secret at all**; RFC 7591 §2 names five client authentication methods
 * of which a shared secret is one. And the provider that forced the issue is not even in
 * that list: a **GitHub App authenticating as itself signs a JWT with a private key and
 * exchanges it for an installation token**, which is not an OAuth grant type — it is not
 * an OAuth flow at all, so a flag called `--oauth` would be a lie about what it connects.
 *
 * `--app` names the thing the operator *has*: an application registered in the provider,
 * whatever that provider makes an application prove with. The per-provider field schema
 * below is the same correction one level down, and `Application`'s `method` is it one level
 * further down again — recorded rather than inferred from which fields happen to be
 * present, because two providers could both carry a `clientId` and differ in what they do
 * with it.
 *
 * The two kinds are the two things that differ in what an operator has to *have*:
 *
 *  - `--app` — an application registered in the provider. The default, because it is the
 *    one that does not act as a person; the explicit spelling exists for the reason
 *    `LINEAR_SCOPES` is sent even though Linear says `read` is implied — a script that
 *    relies on a default is a script whose meaning changes when the default does.
 *  - `--api-key` — one key, and nothing else. There is no application anywhere in it.
 *
 * ### `--consent` is a modifier inside the application kind, and it implies it
 *
 * It selects the *grant*: authorization-code instead of client-credentials. It exists
 * because a client-credentials token reaches the workspace's public teams and no others,
 * so consent is the only path to a private one — and because some workspaces want
 * user-scoped access rather than an app installed at the workspace level.
 *
 * **`--consent` implies `--app`**, so nobody has to type both; `--app --consent` is
 * accepted and redundant rather than required, which is what makes it a modifier rather
 * than a second word to remember. `--api-key --consent` is refused, because there is no
 * such thing as an api key somebody approves in a browser.
 *
 * Considered and rejected: `--grant <client-credentials|authorization-code>`, which names
 * exactly what is being selected and matches the stored `method`. It loses on what an
 * operator is actually deciding. Nobody reaches for this flag because they want a
 * different grant; they reach for it because their teams are private, and `--consent` is
 * the word for the step that makes that work. The grant is the mechanism, not the reason.
 */
const KIND_FLAGS = {
  '--app': 'boolean',
  '--api-key': 'optional-string',
} as const

const CONNECT_FLAGS = {
  ...KIND_FLAGS,
  '--consent': 'boolean',
  /**
   * The name to store the application under, overriding the derived one.
   *
   * The default is derived from the account the credential **proved** it reaches —
   * `github:heirchive` — and never from the project slug, because naming a shared thing
   * after one of its users is a name that is wrong as soon as there are two. This override
   * exists for one shape, and it is a real one: an organisation with two applications in
   * the same account, which would otherwise both derive to the same name and replace each
   * other.
   */
  '--as': 'string',
  /**
   * Point this project at an application this machine already holds, by name.
   *
   * `optional-string` rather than `string` so that a bare `--link` is **this command's**
   * error — one that lists the applications that exist for that provider — instead of
   * node's *"option '--link' argument missing"*, which is the one moment the operator most
   * needs to be told what the valid values are.
   */
  '--link': 'optional-string',
  '--project': 'string',
  '--allow-unregistered': 'boolean',
  /**
   * The same flag `ogun secret set` takes, for the same row, meaning the same thing:
   * there is already a key stored under this name and destroying it is intended. Both
   * doors go through `settleReplacement`, so a rule enforced at one is enforced at both.
   */
  '--replace': 'boolean',
} as const

/**
 * `--oauth`, `--client-id` and `--client-secret` are **removed, not deprecated**, and no
 * deprecation stub is left behind for them.
 *
 * There was one for `--app-token` — a declared flag whose only job was to fail with a
 * sentence naming its replacement — and it is gone too. The product owner chose plain
 * removal, and the argument holds: a stub is a permanent entry in the flag table, it shows
 * up in the parser's own errors, and it has to be maintained past the point where anybody
 * remembers what it was for. `--client-id` is not a rename either; the values it carried
 * now arrive as `clientId=…` *and* are validated against a provider schema, so a stub
 * could not do anything useful with the value it was handed.
 *
 * What makes the removal cheap is that the unknown-option error names this command's
 * usage, which now carries `field=value` in the signature — so the reader of a failed
 * `--client-id abc123` is one line away from `clientId=abc123`. `args.ts` refuses unknown
 * flags rather than ignoring them precisely so that this is a loud failure.
 */

type Kind = 'app' | 'api-key'

type ConnectFlags = {
  app?: boolean
  'api-key'?: string
  consent?: boolean
  as?: string
  link?: string
  project?: string
  'allow-unregistered'?: boolean
  replace?: boolean
}

// ── the fields an application is made of, per provider ─────────────────────

/**
 * What a field *is*, which decides how it is collected and whether it is ever echoed.
 *
 *  - `public` — prompted visibly, no warning when passed inline. A client id is in every
 *    authorization URL a browser visits and on the provider's own settings page; an app id
 *    is in every JWT the App signs. Treating these as secrets would mean `connect list`
 *    and `doctor` could not say *which* application a project is connected as, which is
 *    the first question the moment two accounts are involved — and warning about a value
 *    that is not a secret is how an operator learns to scroll past warnings.
 *  - `secret` — prompted with the echo off, warns when passed inline, never echoed back.
 *  - `pem` — a secret with one extra rule, below.
 */
type FieldKind = 'public' | 'secret' | 'pem'

type Field = {
  key: string
  kind: FieldKind
  /** What to call it at a prompt — the provider's own words, so a settings page matches. */
  label: string
}

/**
 * The schema, per provider, in the order fields are prompted for.
 *
 * Order matters for exactly one reason and it is not aesthetics: **a pipe feeds these
 * prompts in order**, one line each. There is no `--from` flag and no second mechanism —
 * `readAllStdin` is read once and handed out a line at a time, so
 * `printf 'id\\nsecret\\n' | ogun connect linear --app` works and is the documented way to
 * script this. A separate flag would be a second path to the same place, and the two would
 * disagree about trimming the first time somebody fixed one of them.
 */
const FIELDS: Record<SecretName, Field[]> = {
  linear: [
    { key: 'clientId', kind: 'public', label: 'Client ID' },
    { key: 'clientSecret', kind: 'secret', label: 'Client secret' },
  ],
  github: [
    { key: 'appId', kind: 'public', label: 'App ID' },
    { key: 'installationId', kind: 'public', label: 'Installation ID' },
    { key: 'privateKey', kind: 'pem', label: 'Private key (PEM, or a path to one)' },
  ],
}

/**
 * Which public fields a provider's secret belongs to.
 *
 * The rule this expresses, which was `collectApplication`'s and is now general: **a stored
 * secret is only reusable while it still belongs to the application actually being
 * registered.** Pairing a stored client secret with a client id the operator just typed
 * would authenticate an application it was never issued for, and the provider's answer to
 * that names the *client* rather than the mismatch. So a new identifier asks for its own
 * secret.
 *
 * It is per provider because the binding is. A Linear client secret belongs to a client
 * id. A GitHub private key belongs to the **App** and not to the installation — the same
 * key signs a JWT for every installation of it — so changing `installationId` keeps the
 * key, which is the difference between pointing Ogun at a second installation with one
 * argument and being asked to find a .pem GitHub will never show again.
 */
const SECRET_BOUND_TO: Record<SecretName, string[]> = {
  linear: ['clientId'],
  github: ['appId'],
}

/**
 * A PEM field: **a value containing a newline is the key itself; anything else is a path
 * to read.**
 *
 * This must not read as magic, so here is the whole of it: **a PEM always has newlines and
 * a path never does.** A PEM is `-----BEGIN …-----`, base64 in 64-column lines, `-----END
 * …-----`; it cannot be one line and still be a PEM. A filesystem path cannot contain a
 * newline in any shell anybody will type this in. So the two are distinguishable with
 * certainty rather than by heuristic, and there is no third thing a private key field can
 * be handed.
 *
 * The alternative was a second field name (`privateKeyPath=`), which is a worse version of
 * the per-provider-flags mistake: two spellings of one input, one of which is always
 * wrong, and an error message that has to explain which. The alternative *to that* was
 * taking only a path, which refuses `privateKey="$(cat key.pem)"` — a shell idiom that
 * works, was tested, and is what somebody with the key in a password manager will reach
 * for. A multi-line argv element is perfectly ordinary.
 *
 * A path that cannot be read fails with the path named and **nothing from the file**, for
 * the obvious reason.
 */
async function resolvePem(value: string, field: Field): Promise<string> {
  if (value.includes('\n')) return value
  const contents = await readFile(value, 'utf8').catch((err: NodeJS.ErrnoException) => {
    fail(
      `could not read ${value} (${err.code ?? 'unknown'}). A value for ${field.key} with no\n` +
        '  newline in it is read as a path to the PEM file, because a PEM always has ' +
        'newlines\n  and a path never does. Nothing was stored.',
    )
    return ''
  })
  if (contents.trim() === '') {
    fail(`${value} is empty, so there is no key in it. Nothing was stored.`)
  }
  return contents
}

export async function connect(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(args, CONNECT_FLAGS, USAGE_APP)
  const kind = chooseKind(flags)
  const integration = requireIntegration(positionals[0])

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
    refuseStrayPositional(integration, positionals[1])
    return connectApiKey(integration, project, flags['api-key'] ?? '', flags.replace === true)
  }

  const fields = parseFields(integration, positionals.slice(1))

  if (flags.link !== undefined) {
    /**
     * `--consent --link` is refused rather than arbitrated, and the two orders it could be
     * resolved in are both wrong. Honouring `--link` would mint a client-credentials token
     * from an application the operator asked to connect *with consent* — a silent
     * reduction in reach, from what an approver could see to public teams only, which is
     * the failure `reuseLinked` refuses one function over. Honouring `--consent` would
     * ignore the name they typed and start a browser flow for credentials they did not
     * mean to re-enter.
     */
    if (flags.consent === true) {
      fail(
        '--consent and --link are two different ways to get a token and they cannot both\n' +
          '  happen: --link spends credentials this machine already holds, and --consent asks\n' +
          '  somebody to approve an installation in a browser. A consent token sees what the\n' +
          '  approver sees; a linked one sees public teams only. Nothing was stored.\n' +
          `    ${USAGE_LINK}\n` +
          `    ${USAGE_CONSENT}`,
      )
    }
    if (Object.keys(fields).length > 0) {
      fail(
        '--link points this project at an application that is already registered here, so\n' +
          '  there is nothing to type. Drop the fields to link, or drop --link to register a\n' +
          '  new application. Nothing was stored.\n' +
          `    ${USAGE_LINK}\n` +
          `    ${USAGE_APP}`,
      )
    }
    return connectLink(integration, project, flags)
  }

  if (flags.consent === true) return connectConsent(integration, project, fields, serverUrl)
  return connectApp(integration, project, fields, flags)
}

/**
 * Which kind of thing is being connected, or a refusal naming what was asked for.
 *
 * Refused rather than resolved by precedence. `--app --api-key` is not a preference to be
 * arbitrated; it is somebody who believes one of those two words means something other
 * than what it does, and silently honouring the winner would store a credential of a kind
 * they did not ask for — with a different attribution in the provider — and tell them it
 * worked.
 *
 * The refusals are separate mistakes and are worded separately, because "pick one" is
 * useless advice to somebody who wrote `--api-key --as thing`: they did pick one, and then
 * described an application to it.
 */
function chooseKind(flags: ConnectFlags): Kind {
  const key = flags['api-key'] !== undefined
  if (key && flags.app === true) {
    fail(
      '--app and --api-key are different kinds of integration, and a project connects\n' +
        '  through one of them:\n' +
        '    --app         an application you registered in the provider.\n' +
        '    --api-key     one key, issued to you. Everything Ogun does appears as you.\n' +
        '  Nothing was stored.',
    )
  }
  if (key && flags.consent === true) {
    fail(
      '--consent is a grant an application obtains, not a kind of connection: it is how\n' +
        '  somebody approves an application in a browser, and an api key has nobody to\n' +
        '  approve it. Drop one.\n' +
        `    reach private teams:  ${USAGE_CONSENT}\n` +
        `    use a personal key:   ${USAGE_KEY}\n` +
        '  Nothing was stored.',
    )
  }
  if (key && (flags.as !== undefined || flags.link !== undefined)) {
    fail(
      '--as and --link are about a stored application, and an api key is not one: it has no\n' +
        '  name, nothing else can share it, and it is filed under this project alone.\n' +
        '  Nothing was stored.\n' +
        `    ${USAGE_APP}\n` +
        `    ${USAGE_KEY}`,
    )
  }
  /**
   * `--replace` is about the stored key, so it is refused rather than ignored beside the
   * application kind — an operator who typed it there believes a reconnect is gated, and
   * finding out that it never was is the kind of thing found out afterwards.
   *
   * And it is not gated, deliberately. The line `settleReplacement` draws is *what cannot
   * be got back*: an api key is minted once and this store is the only copy Ogun has, while
   * reconnecting an application spends credentials that stay registered in the provider to
   * fetch a token that was going to expire anyway. Asking somebody to confirm the renewal
   * that fixes their expired connection, on the night it expired, would be a gate on the
   * repair.
   */
  if (!key && flags.replace === true) {
    fail(
      '--replace is about a stored api key, and an application connection has none to\n' +
        '  destroy: reconnecting reuses what is registered here and takes a fresh token, and\n' +
        '  the token it replaces was going to expire on its own. Nothing was changed.\n' +
        `    replace a stored key:  ${USAGE_KEY}\n` +
        `    reconnect:             ${USAGE_APP}`,
    )
  }
  return key ? 'api-key' : 'app'
}

/**
 * `field=value` positionals, checked against the provider's schema.
 *
 * ### An unknown key is an error that names the valid ones, and stores nothing
 *
 * This is where the discoverability a declared flag would have given actually gets
 * delivered. Somebody who types `client-id=abc` or `app_id=123` is told the four
 * characters they got wrong and the exact spellings that work, at the moment they are
 * looking — which is better than a help page, and strictly better than the silent
 * acceptance a free-form map would give: a field nothing reads is a credential nothing
 * reads, and this repository has one sentence about those.
 *
 * ### The value is never echoed back
 *
 * Not in the unknown-key error, not in the duplicate error, not in the "that is not
 * `key=value`" error. The plausible way to get here wrongly is a credential in the
 * position of a key — `ogun connect linear lin_api_…` — and quoting it would put the value
 * into stderr on top of the shell history and the `ps` window it is already in.
 *
 * A bare positional with no `=` is refused rather than guessed at, for the reason the
 * positional credentials were removed in the first place: two opaque strings in a fixed
 * order is a coin flip.
 */
function parseFields(integration: SecretName, positionals: string[]): Record<string, string> {
  const schema = FIELDS[integration]
  const valid = schema.map((f) => f.key)
  const out: Record<string, string> = {}

  for (const raw of positionals) {
    const at = raw.indexOf('=')
    if (at <= 0) {
      fail(
        `the application's fields are given as \`key=value\`, and that is not one. For\n` +
          `  ${integration}: ${valid.join(', ')}.\n` +
          `    ${USAGE_APP}\n` +
          '  What you typed is not repeated back, because the thing most likely to be in ' +
          'that\n  position by mistake is the credential itself. If it was: treat it as ' +
          'compromised,\n  and clear your shell history.',
      )
    }
    const key = raw.slice(0, at)
    if (!valid.includes(key)) {
      fail(
        `"${key}" is not a field a ${integration} application has. Valid: ` +
          `${valid.join(', ')}.\n  Nothing was stored — a field nothing reads is a ` +
          'credential nothing reads.\n' +
          `    ${USAGE_APP}\n` +
          '  The value is not repeated back.',
      )
    }
    if (out[key] !== undefined) {
      fail(`${key} was given twice, and the two values differ in a way nothing here can ` +
        'arbitrate. Nothing was stored.')
    }
    out[key] = raw.slice(at + 1)
  }
  return out
}

/**
 * Every field, from the command line, a prompt, a pipe, or the application already linked
 * to this project.
 *
 * ### Any field not supplied is prompted for, one at a time
 *
 * One at a time rather than one blob, because the fields are not interchangeable and a
 * single prompt that asked for three of them would be a prompt somebody fills in the wrong
 * order. The public ones are visible so the operator can check what they pasted; the
 * secrets have the echo off.
 *
 * Off a terminal there is nobody to ask, so stdin is read once and consumed a line per
 * field, in schema order. That is the whole scripting story — see `FIELDS`.
 *
 * ### The reconnect asks for nothing
 *
 * With no fields given and a grant already on file, the application that grant came from
 * is reused whole. That covers the reconnect after a token lapses and rotating nothing at
 * all, which would otherwise send somebody back to a settings page for values this machine
 * is already holding — and a value re-pasted is a value re-typed, which is how a trailing
 * space gets into a credential.
 *
 * It does **not** cover the retry after a first connect whose token request failed. That
 * connect stored nothing, by design (see `connectWithAppToken`), so there is nothing here
 * to reuse and the fields are asked for again. Stated rather than hidden: it is the price
 * of never writing an unproven credential, and it is paid once, by the person who is
 * already standing at the terminal.
 */
async function collectFields(
  integration: SecretName,
  project: ResolvedProject,
  given: Record<string, string>,
  consent: boolean,
  stored: Record<string, string> = {},
): Promise<Record<string, string>> {
  const schema = FIELDS[integration]

  /**
   * Each half falls back to the store on its own, which is what makes a **rotation**
   * sayable: `ogun connect linear clientSecret=<new>` is "I rotated the secret in the
   * provider's settings and the application is otherwise the same". A build that asked for
   * everything whenever anything was given would send somebody back to a settings page for
   * a value this machine is holding — and a value re-pasted is a value re-typed, which is
   * how a trailing space gets into a credential.
   *
   * The public fields fall back unconditionally; the secrets fall back only while the
   * identity they are bound to is unchanged. See `SECRET_BOUND_TO`.
   */
  const identityHeld = SECRET_BOUND_TO[integration].every(
    (key) => given[key] === undefined || given[key] === stored[key],
  )
  const fallback: Record<string, string> = Object.fromEntries(
    schema.flatMap((field) => {
      const value = stored[field.key]
      if (value === undefined) return []
      if (field.kind !== 'public' && !identityHeld) return []
      return [[field.key, value]]
    }),
  )

  const missing = schema.filter(
    (f) => given[f.key] === undefined && fallback[f.key] === undefined,
  )

  /**
   * The warning is per *supplied* secret rather than per command, because that is what it
   * is about: a value that was in argv, and therefore in `/proc/<pid>/cmdline` and in the
   * shell history, whatever else the command did. A public field draws none — see
   * `FieldKind` for why warning about a value that is not a secret is how an operator
   * learns to scroll past warnings.
   */
  for (const field of schema) {
    const supplied = given[field.key]
    if (supplied === undefined || field.kind === 'public') continue
    /**
     * A PEM field given as a **path** draws no warning, and that is the one exception. The
     * warning is about a credential sitting in argv and in the shell history; a path is
     * neither — it is a filename, which is exactly why `privateKey=./key.pem` is the
     * recommended spelling. `privateKey="$(cat key.pem)"` puts the key itself there and
     * warns, correctly.
     */
    if (field.kind === 'pem' && !supplied.includes('\n')) continue
    warnInlineSecret(`a ${integration} ${field.key}`)
  }
  for (const field of schema) {
    if (given[field.key] !== undefined || fallback[field.key] === undefined) continue
    // Said out loud: binding a rotated secret to an identifier the operator cannot see is
    // how the wrong application ends up authenticating a poll nobody is watching.
    if (field.kind === 'public') {
      console.log(dim(`  keeping the registered ${field.key} (${fallback[field.key]})`))
    }
  }
  if (missing.length === 0) return resolveAll(schema, { ...fallback, ...given })

  console.log(
    bold(`\nConnect ${cyan(project.slug)} to ${cyan(integration)}${consent ? ', with consent' : ''}\n`),
  )
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
  console.log(`  Create an application at ${cyan(REGISTER_URL[integration])}`)
  console.log(dim(`  ${ADVICE[integration]}\n`))

  // Read once, not per field: stdin is a single stream and three separate reads of it is
  // three different answers to who got the first line.
  const piped = process.stdin.isTTY ? undefined : (await readAllStdin()).split('\n')
  let next = 0

  const collected = { ...fallback, ...given }
  for (const field of missing) {
    const value =
      piped !== undefined
        ? (piped[next++] ?? '')
        : field.kind === 'public'
          ? await prompt(`  ${field.label}: `)
          : await promptHidden(`  ${field.label} (not echoed): `)
    if (value.trim() === '') {
      fail(
        `nothing was stored — ${field.key} is required and ` +
          (piped !== undefined
            ? 'the pipe ran out of lines. One line per field, in this order: ' +
              `${schema.map((f) => f.key).join(', ')}`
            : 'nothing was typed'),
      )
    }
    collected[field.key] = value
  }
  return resolveAll(schema, collected)
}

const ADVICE: Record<SecretName, string> = {
  linear:
    'Linear recommends creating it in a workspace you use for managing applications,\n' +
    '  because every admin of that workspace can see it. You need the Client ID and the\n' +
    '  Client Secret from that page.',
  github:
    'You need the App ID from the App\'s settings page, the Installation ID from the URL\n' +
    '  of the installation you want Ogun to act as, and the private key — the .pem GitHub\n' +
    '  generated, which it shows you once and never again.',
}

/** PEM fields resolved last, so a bad path fails after everything is in hand and before
 *  anything is spent. */
async function resolveAll(
  schema: Field[],
  values: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const field of schema) {
    const raw = values[field.key] ?? ''
    out[field.key] =
      field.kind === 'pem' ? await resolvePem(raw, field) : raw.trim()
  }
  return out
}

// ── the default: a token in Ogun's own name ────────────────────────────────

/**
 * `ogun connect linear --app` — prove the application and store it, in one sitting.
 *
 * This used to be two commands, and the reason it was two is gone. `ogun linear app`
 * existed because the authorization step needed a browser and a person, so there had to be
 * a place to stop between "here are the credentials" and "go and approve this". Neither of
 * the two application kinds that need no browser has anything for a person to do, so there
 * is nothing to stop for.
 */
async function connectApp(
  integration: SecretName,
  project: ResolvedProject,
  fields: Record<string, string>,
  flags: ConnectFlags,
): Promise<void> {
  if (Object.keys(fields).length === 0) {
    const reconnect = await reuseLinked(integration, project, flags)
    if (reconnect) return announce(reconnect, integration, project)
  }

  const collected = await collectFields(
    integration,
    project,
    fields,
    false,
    await storedFields(integration, project.slug),
  )
  const as = flags.as

  if (integration === 'github') {
    return announce(
      await attemptGithub(integration, project, () =>
        connectGithubApp(
          project.slug,
          {
            appId: collected.appId as string,
            installationId: collected.installationId as string,
            privateKey: collected.privateKey as string,
          },
          as === undefined ? {} : { as },
        ),
      ),
      integration,
      project,
    )
  }

  return announce(
    await attemptLinear(integration, project, () =>
      connectWithAppToken(
        project.slug,
        integration,
        {
          clientId: collected.clientId as string,
          clientSecret: collected.clientSecret as string,
          /**
           * Empty rather than a plausible-looking `http://localhost:7777/…`.
           *
           * There is no browser in this flow, so there is no redirect URI — and inventing
           * one would put a string in the store that the provider has never been told
           * about, which is exactly the mismatch that field exists to make visible,
           * manufactured. `--consent` writes a real one, through the server, because the
           * server that receives the callback is the only thing that knows what address a
           * browser can reach it at.
           */
          redirectUri: '',
        },
        as === undefined ? {} : { as },
      ),
    ),
    integration,
    project,
  )
}

/**
 * The reconnect that asks for nothing, when there is an application to reconnect with.
 *
 * Returns `undefined` when there is not, so the caller falls through to collecting fields
 * — which is the first connect, and also the retry after a first connect that failed.
 */
async function reuseLinked(
  integration: SecretName,
  project: ResolvedProject,
  flags: ConnectFlags,
): Promise<LinearConnection | GithubConnection | undefined> {
  const name = flags.as
  if (integration === 'github') {
    const linked = await linkedGithubApplication(project.slug)
    if (!linked) return undefined
    console.log(dim(`  reusing the github application "${linked.name}" (app ${linked.appId})`))
    return attemptGithub(
      integration,
      project,
      () => linkGithubApplication(project.slug, linked.name, name === undefined ? {} : { as: name }),
      true,
    )
  }
  const linked = await linkedApplication(project.slug, integration)
  if (!linked) return undefined
  if (linked.method === 'authorization_code') {
    /**
     * Switching a consent connection to a client-credentials one is refused, not performed.
     *
     * It looks like a reconnect and it is a **reduction in reach**: an authorization-code
     * grant sees the teams whoever approved it could see, private ones included, and a
     * client-credentials token sees public teams only. Performing it silently would leave a
     * poll that authenticates perfectly and returns nothing, which is the worst failure
     * shape there is — no error anywhere, just a source that stops finding tickets. So the
     * refusal names both ways forward and lets the operator say which they meant.
     */
    fail(
      `"${project.slug}" is connected to ${integration} through the consent flow, which ` +
        'reaches teams a\n  client-credentials token cannot — it sees public teams only. ' +
        'Nothing was changed.\n' +
        `    renew what you have:  ogun connect ${integration} --consent` +
        `${projectFlag(project)}\n` +
        `    switch anyway:        ogun disconnect ${integration}${projectFlag(project)} ` +
        `&& ogun connect ${integration}${projectFlag(project)}`,
    )
  }
  console.log(
    dim(`  reusing the ${integration} application "${linked.name}" (client ${linked.clientId})`),
  )
  return attemptLinear(
    integration,
    project,
    () =>
      linkApplication(
        project.slug,
        integration,
        linked.name,
        name === undefined ? {} : { as: name },
      ),
    true,
  )
}

/**
 * The fields of the application this project's grant came from, for a rotation that should
 * only have to name what changed.
 *
 * Flattened to a `Record<string, string>` keyed by the same field names the command line
 * uses, so `collectFields` needs no per-provider branch to find a default — the schema
 * already says which keys exist and which of them are secrets.
 *
 * It is `{}` rather than `undefined` for a project with no grant, because "nothing to fall
 * back to" and "no application" are the same thing to every caller here.
 */
async function storedFields(
  integration: SecretName,
  slug: string,
): Promise<Record<string, string>> {
  if (integration === 'github') {
    const linked = await linkedGithubApplication(slug)
    return linked === undefined
      ? {}
      : {
          appId: linked.appId,
          installationId: linked.installationId,
          privateKey: linked.privateKey,
        }
  }
  const linked = await linkedApplication(slug, integration)
  return linked === undefined
    ? {}
    : { clientId: linked.clientId, clientSecret: linked.clientSecret }
}

// ── --link: a second project onto one application ──────────────────────────

/**
 * `ogun connect github --app --link github:heirchive` — point this project at an
 * application this machine already holds.
 *
 * ### It still mints a token, and that is the whole decision
 *
 * **"Connected" has to mean "proved", not "a pointer was written."** A link that only
 * recorded a name would report a project as connected on credentials that may have been
 * rotated in the provider's settings a month ago, and the first evidence would be a poll
 * at 3am. So it spends the application once, exactly as a first connect does, and writes a
 * grant only if a token comes back. The cost is one HTTP request on a command somebody is
 * watching, which is the cheapest place in the system to spend one.
 *
 * What it does *not* do is ask for credentials again. That is the point of `--link`: a
 * private key exists once on this machine, and a second copy of it under a second project
 * is two values that have to agree with nothing that makes them — which is the duplication
 * the `applications`/`grants` split exists to end.
 */
async function connectLink(
  integration: SecretName,
  project: ResolvedProject,
  flags: ConnectFlags,
): Promise<void> {
  const name = (flags.link ?? '').trim()
  if (name === '') {
    /**
     * A bare `--link` is an error that **lists the applications**, because the one thing
     * somebody who typed it does not know is what the valid values are. Printing a usage
     * line here would be answering "which ones are there?" with "give me one of them".
     */
    const known = (await listApplications()).filter(
      (a) => a.state === 'present' && a.app.provider === integration,
    )
    if (known.length === 0) {
      fail(
        `--link takes the name of a ${integration} application already registered on this\n` +
          '  machine, and there are none. Register one first — then a second project links to\n' +
          '  it without the credentials being typed again.\n' +
          `    ${USAGE_APP}`,
      )
    }
    fail(
      `--link takes the name of the application to point "${project.slug}" at. ` +
        `${integration} applications\n  on this machine:\n` +
        known.map((a) => `    ${a.name}${usedBySuffix(a)}`).join('\n') +
        // Dedented back to the prose level, so the usage line does not read as a fourth
        // application in the list above it.
        `\n  ${USAGE_LINK}`,
    )
  }

  if (integration === 'github') {
    return announce(
      await attemptGithub(
        integration,
        project,
        () =>
          linkGithubApplication(project.slug, name, flags.as === undefined ? {} : { as: flags.as }),
        true,
      ),
      integration,
      project,
    )
  }
  return announce(
    await attemptLinear(
      integration,
      project,
      () =>
        linkApplication(
          project.slug,
          integration,
          name,
          flags.as === undefined ? {} : { as: flags.as },
        ),
      true,
    ),
    integration,
    project,
  )
}

const usedBySuffix = (a: ApplicationListing): string =>
  a.usedBy.length === 0 ? dim(' — used by nothing yet') : dim(` — used by ${a.usedBy.join(', ')}`)

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
 *
 * **The credentials go to `/start` in one request now, and nothing is written before the
 * browser comes back.** It used to `PUT` them to a route that registered the application
 * immediately, because the callback had to find one in the store. See
 * `PendingAuthorization` in the server's oauth routes for where they live instead and why
 * that map's own reasoning is the argument for it.
 */
async function connectConsent(
  integration: SecretName,
  project: ResolvedProject,
  fields: Record<string, string>,
  serverUrl: string,
): Promise<void> {
  if (integration !== 'linear') {
    fail(
      `--consent is a browser flow in which somebody approves an application, and ` +
        `${integration} has none for\n  the way Ogun authenticates to it. A GitHub App ` +
        'authenticating as itself signs a JWT with\n  its private key — there is nobody to ' +
        'ask. Nothing was stored.\n' +
        `    ${USAGE_APP}`,
    )
  }

  await requireProjectOnControlPlane(project, serverUrl)
  const here = projectFlag(project)

  const status = await get(serverUrl, '/api/oauth/linear')
  const redirectUri = String(status.redirectUri)

  const linked = await linkedApplication(project.slug, integration)
  const reuse = Object.keys(fields).length === 0 && linked !== undefined

  let body: Record<string, string> = {}
  if (!reuse) {
    console.log(bold(`\nConnect ${cyan(project.slug)} to ${cyan(integration)}, with consent\n`))
    if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
    console.log(`  Create an application at ${cyan(REGISTER_URL[integration])}`)
    console.log(`  Redirect callback URL to register: ${cyan(redirectUri)}`)
    console.log(
      dim(
        '  Linear matches this exactly — scheme, host, port and trailing slash. A ' +
          'mismatch\n  is the classic failure of this flow and the error it gives says ' +
          'nothing useful.\n',
      ),
    )
    const collected = await collectFields(
      integration,
      project,
      fields,
      true,
      linked === undefined
        ? {}
        : { clientId: linked.clientId, clientSecret: linked.clientSecret },
    )
    body = {
      clientId: collected.clientId as string,
      clientSecret: collected.clientSecret as string,
    }
  } else {
    console.log(
      dim(`  reusing the ${integration} application "${linked.name}" (client ${linked.clientId})`),
    )
  }

  const start = await send(serverUrl, `/api/oauth/linear/start/${project.slug}`, 'POST', body)
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
        `     \`ogun connect ${integration}\` needs no approval at all.\n` +
        '     Nothing is stored on this machine until the authorization comes back.\n',
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
 * thing that works when somebody cannot register an application in their account at all.
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
          `\`ogun connect ${integration} --app\` connects as an\n  application instead, ` +
          'and needs no approval when your teams are public.',
      ),
  )
}

// ── reporting what happened ────────────────────────────────────────────────

/**
 * Both connects, behind one `catch`, so a provider's typed failure becomes a sentence with
 * a remedy rather than a stack trace.
 *
 * The remedy sentence is the part that changed with the reordering: it used to promise
 * that *"the application is registered, so retrying will not ask you to paste anything
 * again"*, and that is no longer true of a first connect — nothing was stored, so a retry
 * asks again. Saying otherwise would be the worst kind of wrong message, the one that
 * tells somebody their credentials are safely on the machine when they are not.
 */
async function attemptLinear(
  integration: SecretName,
  project: ResolvedProject,
  run: () => Promise<LinearConnection>,
  reused = false,
): Promise<LinearConnection> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof LinearOAuthError)) throw err
    /**
     * `err.message` has already been through `scrubSecrets` where it was built, so it
     * cannot carry the client secret even if Linear echoed one back — which is the whole
     * reason that scrubbing happens at construction rather than here.
     */
    return fail(`${err.message}.\n${retryAdvice(integration, project, reused)}`)
  }
}

async function attemptGithub(
  integration: SecretName,
  project: ResolvedProject,
  run: () => Promise<GithubConnection>,
  reused = false,
): Promise<GithubConnection> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof GithubAppError)) throw err
    // Scrubbed where it was built, for the same reason: the JWT is a bearer credential and
    // GitHub's error bodies are strings GitHub formatted out of what we sent.
    return fail(`${err.message}.\n${retryAdvice(integration, project, reused)}`)
  }
}

/**
 * What to do next, and the two cases say different things because they *are* different.
 *
 * `reused` is a connect that spent an application already on this machine — a reconnect or
 * a `--link`. Nothing was stored either way, because nothing here writes a credential it
 * has not spent; what differs is whether there is anything left to retry *with*. A first
 * connect has to ask for the fields again, and saying so is the honest half of the
 * reordering. A reconnect does not, and its old grant is untouched — so the project is
 * still connected, on whatever token it had, which is a fact an operator needs rather than
 * a detail: it means the poll keeps working if the token has not expired yet.
 */
const retryAdvice = (
  integration: SecretName,
  project: ResolvedProject,
  reused: boolean,
): string =>
  `  Nothing was stored, because nothing here writes a credential it has not spent.\n` +
  (reused
    ? "  Nothing was removed either — whatever grant this project already had is untouched,\n" +
      '  so a poll keeps working until that token expires. Retrying is the same command: it\n' +
      '  spends an application that is already on this machine and asks for nothing.'
    : `  Retrying is \`ogun connect ${integration} --app${projectFlag(project)}\` and it will\n` +
      '  ask for the fields again.')

/** What a finished connection looks like, from whichever mechanism finished it. */
function announce(
  connection: LinearConnection | GithubConnection,
  integration: SecretName,
  project: ResolvedProject,
): void {
  if ('account' in connection) return announceGithub(connection, project)
  const where = connection.workspace ? ` to ${connection.workspace}` : ''
  console.log(green(`\n  ${project.slug} connected${where}`))
  console.log(
    dim(
      `  as ${connection.actor}, scopes ${connection.scopes.join(' ')}, ` +
        `${describeGrant(connection.expiresAt).detail}`,
    ),
  )
  announceApplication(connection, integration)

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
        (connection.grantType === 'client_credentials' ? dim(' — public teams only') : ''),
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
  announceTail(connection, project)
}

function announceGithub(connection: GithubConnection, project: ResolvedProject): void {
  console.log(green(`\n  ${project.slug} connected to ${connection.account}`))
  console.log(
    dim(
      `  as ${connection.login}, installation ${connection.installationId}, ` +
        `${describeGrant(connection.expiresAt).detail}`,
    ),
  )
  announceApplication(connection, 'github')
  if (connection.permissions.length > 0) {
    console.log(dim(`  permissions: ${connection.permissions.join(', ')}`))
  }
  /**
   * `selected` is said out loud for the reason `visibleTeams` is printed for Linear: an
   * installation that does not include the repository a source polls authenticates
   * perfectly and 404s, and this is the one moment anybody is watching.
   */
  if (connection.repositorySelection === 'selected') {
    console.log(
      yellow('  this installation covers selected repositories only.') +
        dim(
          '\n  A repository outside the selection answers 404 to a token that is otherwise' +
            '\n  working, which reads as a repository that does not exist.',
        ),
    )
  }
  announceTail(connection, project)
}

/**
 * The name, and whether anything was displaced.
 *
 * Printed on every connect, because the name is the handle `--link` takes and an operator
 * who is never shown it has to go and look it up. `applicationReplaced` is the line that
 * earns this: an application of this name was already here and its credentials have been
 * overwritten, which is a thing somebody with two applications in one account needs to see
 * — it is exactly the case `--as` exists for.
 */
function announceApplication(
  connection: {
    application: string
    applicationReplaced: boolean
    displacedProjects: string[]
  },
  integration: SecretName,
): void {
  console.log(
    dim(`  application "${connection.application}"`) +
      (connection.applicationReplaced
        ? yellow(' — replaced the credentials stored under that name')
        : ''),
  )
  if (connection.displacedProjects.length > 0) {
    /**
     * The loudest line this command has, because it is the only way connecting one project
     * disconnects another — and the projects it happens to are, by construction, ones
     * nobody is looking at.
     */
    console.log(
      red(
        `  ${connection.displacedProjects.join(', ')} ` +
          `${connection.displacedProjects.length === 1 ? 'was' : 'were'} disconnected: ` +
          'that name held a',
      ),
    )
    console.log(
      red('  different application, and tokens it did not mint are dead on arrival.') +
        dim(
          `\n  Reconnect ${connection.displacedProjects.length === 1 ? 'it' : 'them'}, or ` +
            'give this one its own name with `--as <name>`.',
        ),
    )
  } else if (connection.applicationReplaced) {
    console.log(
      dim(
        '  the credentials under that name were rotated; nothing else using it was\n' +
          `  disconnected. A name is derived from the account, so two ${integration}\n` +
          '  applications in one account collide — `--as <name>` gives the second its own.',
      ),
    )
  }
}

function announceTail(
  connection: { apiKeyRetired: boolean },
  project: ResolvedProject,
): void {
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
 * `connect list` mirrors `secret list`, and the top level keeps the verbs.
 *
 * `disconnect` stays a top-level verb, deliberately. It is an act rather than a view, it
 * is the one somebody reaches for during an incident, and `ogun connect rm` would read as
 * removing a listing row rather than revoking a token at the provider.
 *
 * ### Two tables now, because there are two kinds of thing
 *
 * An **application** is shared: one GitHub App serves every project in the organisation,
 * and its private key exists once. A **grant** is one project's live token from one of
 * those. The old listing had one table keyed by project, which could only show an
 * application by repeating it per project — so the day somebody rotated one, the table
 * would have shown two rows that disagreed with nothing to say which one a poll used.
 *
 * So applications come first, with who shares each one, and the per-project rows follow.
 * **A GitHub credential would not have appeared in this listing at all** before this
 * change, which is the other half of why it grew a section: the only GitHub thing the old
 * table could show was an api key.
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
 * `--project` narrows the **grant** rows and deliberately leaves the applications table
 * whole: an application is not the project's, and hiding the one it shares would answer
 * "what is this project connected through" by concealing who else is using it.
 *
 * There is no field here a token would fit in, and that is structural rather than
 * remembered: `GrantPresence` carries an application name, an account, scopes and an
 * expiry; `ApplicationListing` carries a provider, a method and whatever identifiers are
 * not secrets; `ProjectSecretPresence` carries a name and a state.
 */
export async function connectList(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--project': 'string' }, USAGE_LIST)
  const only = flags.project

  const applications = await listApplications().catch(() => [])
  const grants = (await listGrants().catch(() => [])).filter((g) =>
    only ? g.project === only : true,
  )
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
    through: dim('—'),
    state:
      k.state === 'empty'
        ? yellow('empty — connect it again')
        : shadowed.has(`${k.project}/${k.name}`)
          ? // The line that earns this listing. A grant wins over a key, so an operator
            // rotating this one would be changing something nothing reads.
            red('stored, NOT used — the application grant wins')
          : green('in use'),
  }))

  const grantRows = grants.map((g) => ({
    project: g.project,
    integration: g.provider,
    via: via(g),
    through: g.app === '' ? dim('—') : g.app,
    state: stateOf(g),
  }))

  const rows = [...grantRows, ...keyRows].sort(
    (x, y) => x.project.localeCompare(y.project) || x.integration.localeCompare(y.integration),
  )

  if (applications.length > 0) {
    console.log(
      table([
        [bold('APPLICATION'), bold('PROVIDER'), bold('METHOD'), bold('IDENTIFIES AS'), bold('USED BY')],
        ...applications.map((a) =>
          a.state === 'present'
            ? [
                cyan(a.name),
                a.app.provider,
                a.app.method,
                identifiers(a),
                a.usedBy.length > 0 ? a.usedBy.join(', ') : dim('nothing'),
              ]
            : [
                cyan(a.name),
                dim('—'),
                dim('—'),
                red(`unreadable — ${a.reason}`),
                a.usedBy.length > 0 ? a.usedBy.join(', ') : dim('nothing'),
              ],
        ),
      ]),
    )
    /**
     * Said whenever an application is used by nothing, because that is a credential on the
     * disk that no poll will ever spend — the shape this whole slice exists to avoid, and
     * the one state the write path can still leave behind: a `disconnect --keep-application`
     * for the last project using it.
     */
    const idle = applications.filter((a) => a.usedBy.length === 0).map((a) => a.name)
    if (idle.length > 0) {
      console.log(
        dim(
          `\n${idle.join(', ')} ${idle.length === 1 ? 'is' : 'are'} used by no project — ` +
            'credentials nothing reads. `ogun connect <integration> --app --link <name>`',
        ),
      )
    }
    console.log('')
  }

  if (rows.length === 0) {
    console.log(
      dim(
        only
          ? `${only} is not connected to anything on this machine`
          : 'nothing is connected on this machine',
      ),
    )
    console.log(dim(`  ${USAGE_APP}`))
    if (otherSecrets > 0) console.log(dim(`  ${storedElsewhere(otherSecrets)}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('INTEGRATION'), bold('VIA'), bold('THROUGH'), bold('')],
      ...rows.map((r) => [cyan(r.project), r.integration, r.via, r.through, r.state]),
    ]),
  )
  console.log(dim(`\ntokens and keys are never printed. ${localConfigPath()}`))
  if (otherSecrets > 0) console.log(dim(storedElsewhere(otherSecrets)))
}

/**
 * The non-secret identifiers of an application, per provider.
 *
 * Per provider and not a shared set of columns, because the identifiers genuinely differ
 * and a table with `CLIENT ID` and `APP ID` and `INSTALLATION ID` as separate columns would
 * be two thirds empty on every row. What they have in common is that none of them is a
 * secret, which is the only property this column promises.
 */
const identifiers = (a: Extract<ApplicationListing, { state: 'present' }>): string =>
  a.app.provider === 'github'
    ? `app ${a.app.appId}, installation ${a.app.installationId}`
    : `client ${a.app.clientId}`

/**
 * Said whenever this listing has left something out, because "nothing is connected" on a
 * machine that is holding four stored values is the answer an operator is least equipped
 * to disbelieve.
 */
const storedElsewhere = (count: number): string =>
  `${count} other stored ${count === 1 ? 'secret is' : 'secrets are'} not an integration ` +
  'and not listed here — `ogun secret list`'

/**
 * How a project is connected, in one column, because the grants differ in what they can
 * *see* and "connected" alone cannot explain a source that finds no tickets.
 */
const via = (grant: GrantPresence): string => {
  if (grant.malformed !== undefined) return dim('—')
  switch (grant.grantType) {
    case 'client_credentials':
      return 'app token'
    case 'authorization_code':
      return 'consent'
    case 'installation':
      return 'app install'
    default:
      return dim('—')
  }
}

const stateOf = (grant: GrantPresence): string => {
  if (grant.malformed !== undefined) return red(`unreadable — ${grant.malformed}`)
  // Green even when expired: the next poll renews it, and colouring that red would train
  // an operator to act on the one state that needs no action.
  return green(describeGrant(grant.expiresAt).detail)
}

// ── disconnecting ──────────────────────────────────────────────────────────

/**
 * `ogun disconnect <integration> [--keep-application]` — remove every credential this
 * project has for it.
 *
 * The work is `disconnectProject` (or `disconnectGithub`) in core, which is also what the
 * Settings page's button calls; see them for why the default removes the application's
 * credentials and why `--keep-application` is refused on a client-credentials connection.
 *
 * **Which function is a fact about the provider, not a flag**, and the reason is a bug this
 * change had to avoid: `disconnectProject` POSTs the stored token to *Linear's* revocation
 * endpoint, and GitHub has no revocation endpoint for an installation token at all. Before
 * GitHub could hold a grant the question never arose; sending a GitHub installation token
 * to `api.linear.app/oauth/revoke` would have been a credential handed to the wrong third
 * party by a command whose whole job is to take credentials away.
 *
 * **Nothing here checks the slug**, where `connect` checks it — and the exemption is the
 * same one `ogun secret rm` had. `connect list` prints whatever is in the file, and §4.5
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
  const keepApplication = flags['keep-application'] === true
  const outcome =
    integration === 'github'
      ? await disconnectGithub(project.slug, { keepApplication })
      : await disconnectProject(project.slug, integration, { keepApplication })
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
   * Said only when there was a token there is somewhere to revoke.
   *
   * A project holding only a personal API key has nothing at the provider for this command
   * to revoke — the key is the person's, minted in their UI, and Ogun could not revoke it
   * if it wanted to. Printing "it could not be told" there is a warning about a failure
   * that did not happen, on the run where nothing was ever going to be sent, and it is the
   * kind of line that teaches an operator to stop reading them.
   *
   * GitHub is the other half of the same rule and it is the provider rather than the
   * credential that decides: there is **no endpoint** that ends an installation token
   * early. It has a one-hour life and that is the whole of its revocation story, so saying
   * so is more useful than reporting a revoke that was never attempted.
   */
  if (outcome.grantType !== undefined) {
    if (integration === 'github') {
      console.log(
        dim('  the installation token was not revoked, because github has no endpoint for'),
      )
      console.log(dim('  that — it expires on its own within the hour'))
    } else {
      console.log(
        outcome.revoked
          ? dim('  the access token was revoked at the provider as well')
          : yellow('  the provider could not be told — revoke the token by hand if it matters'),
      )
    }
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
      dim('  the application went with it: nothing else was using it, and credentials'),
    )
    console.log(dim('  nobody reads are credentials nobody is watching'))
    if (integration === 'github') {
      console.log(
        yellow('  that included the private key, and GitHub shows one only once.') +
          dim('\n  Reconnecting means generating a new key in the App\'s settings.'),
      )
    }
  } else if (outcome.applicationSharedWith !== undefined) {
    /**
     * The line the split made necessary. A disconnect that said only "disconnected" while
     * a client secret or a private key was still on the disk would be a half-truth, and the
     * half it omits is the one somebody removing a credential needs.
     */
    console.log(
      dim(
        `  the application is still registered — ${outcome.applicationSharedWith.join(', ')} ` +
          `${outcome.applicationSharedWith.length === 1 ? 'is' : 'are'} still using it`,
      ),
    )
  } else if (keepApplication) {
    console.log(
      dim(
        `  the application is still registered — \`ogun connect ${integration} --app ` +
          `--link <name>${projectFlag(project)}\``,
      ),
    )
  }
  console.log(
    dim(`  ${project.slug} has nothing to poll ${integration} with now; a poll will refuse.`),
  )
}

// ── which integration, which project ───────────────────────────────────────

/**
 * The positional credentials are gone, and a leftover one is refused without being echoed.
 *
 * Only reachable on the `--api-key` path now, where there are no `key=value` fields to be
 * mistaken for one — `parseFields` handles the application kind and says more, because it
 * knows what the valid keys are. The plausible arrival here is an api key from somebody who
 * read `--api-key <key>` and dropped the flag. Quoting it back would write a live
 * credential to stderr on top of the shell history and the `ps` window it is already in,
 * which is the rule `requireIntegration` states below and the same one the route in
 * `system.ts` states.
 */
function refuseStrayPositional(integration: SecretName, extra: string | undefined): void {
  if (extra === undefined) return
  fail(
    `--api-key carries its own value, so there is nothing for a second argument to be.\n` +
      `    ${USAGE_KEY}\n` +
      '  What you typed is not repeated back, because the thing most likely to be in that\n' +
      '  position is a credential. If it was: treat it as compromised, and clear your shell\n' +
      `  history. (An application's fields are \`key=value\` — \`ogun connect ${integration} ` +
      '--app\`.)',
  )
}

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
      `usage: ${USAGE_APP}\n` +
        `       ${USAGE_LINK}\n` +
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
