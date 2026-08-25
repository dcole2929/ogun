import {
  describeGrant,
  listOAuthApps,
  loadLocalConfig,
  localConfigPath,
  type ProjectGrantPresence,
} from '@ogun/core'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'
import { bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import { projectFlag, resolveProject, type ResolvedProject } from '../project-slug.ts'
import { promptHidden } from './secrets.ts'

/**
 * `ogun linear` — connect a project to Linear as an application (ADR-0014).
 *
 * ### Why this exists when the Settings page does the same thing
 *
 * Because the control plane may be headless, and this is the surface that works when there
 * is no browser on the box. That is not hypothetical: ADR-0012 already names "a control
 * plane on a VPS" as the deployment its own CLI-only path existed for, and an OAuth flow is
 * strictly harder — it needs a browser *somewhere* and a callback that reaches this
 * machine.
 *
 * What this command cannot do is remove the browser. Somebody has to visit Linear's consent
 * screen. What it can do is the other three quarters: register the application, print the
 * exact URL to open, and — when the browser could not reach the control plane at all —
 * accept the URL it landed on so the exchange happens from here.
 *
 * ### Why it talks to the server, where `ogun secret` does not
 *
 * `ogun secret set` deliberately reaches no server: it writes config.json directly, so it
 * works before `ogun init`, with the database down, and over SSH. This one cannot make that
 * promise and does not pretend to. The `state` nonce that protects the flow lives in the
 * control-plane process, and the callback is delivered to the control-plane process — so a
 * connect performed by a CLI writing files behind the server's back would be a second
 * implementation of the CSRF check, in a process that never sees the callback.
 *
 * The one thing it *does* do locally is `status`, which reads the store — so "what is
 * connected" is answerable on a machine whose control plane is down, which is when the
 * question is usually asked.
 *
 * ### Why it is not `ogun project linear`
 *
 * It was, and that was four words before a verb: `project` was a namespace whose only cargo
 * was the `<project>` positional, `linear` names the integration, `app` names the thing
 * being registered, and then the slug again. `ogun project linear app ogun` is a lot of
 * words for "register an application". Inferring the project from the directory — the way
 * `project add` and `project sync` always have — empties the outer level out, so the outer
 * level is gone.
 *
 * `linear` stays, and is the one noun in that chain worth keeping: it names *which*
 * integration, which is a real distinction the moment a `github` or `jira` source sits
 * beside it. The old spelling is dropped rather than aliased and answers with a line naming
 * the new one, for the same reasons `ogun project secret` did.
 */
export async function linear(args: string[], serverUrl: string): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'app') return linearApp(rest, serverUrl)
  if (sub === 'connect') return linearConnect(rest, serverUrl)
  if (sub === 'disconnect') return linearDisconnect(rest, serverUrl)
  // A bare `ogun linear --project x` is a status with a filter, not a subcommand named
  // `--project`. The same reading `ogun secret --project x` gets.
  if (sub === undefined || sub === 'status') return linearStatus(rest)
  if (sub.startsWith('-')) return linearStatus(args)
  fail(
    `unknown: ogun linear ${sub}\n` +
      '  usage: ogun linear app | connect | status | disconnect',
  )
}

const PROJECT_FLAG = { '--project': 'string' } as const

/**
 * The usage lines name what each command asks for.
 *
 * `ogun linear app <project>` read as a complete command and was not: the two things it
 * exists to collect — a Client ID and a Client Secret — appeared nowhere in it, so the only
 * way to discover that it prompts was to run it. That is the same fault `ogun secret set
 * <name>` had, and it lands harder here, because there are two values, one of them is a
 * credential, and the operator has to have created the application in Linear's web UI
 * *before* the first prompt is useful.
 */
const USAGE_APP = 'ogun linear app [--project <slug>]   — asks for a Client ID and Client Secret'
const USAGE_CONNECT = 'ogun linear connect [--project <slug>]   — prints a URL to approve'
const USAGE_DISCONNECT = 'ogun linear disconnect [--project <slug>] [--forget-app]'
const USAGE_STATUS = 'ogun linear status [--project <slug>]'

// ── registering the application ────────────────────────────────────────────

const REGISTER_URL = 'https://linear.app/settings/api/applications/new'

/**
 * `ogun linear app` — store the client id and secret for the project you are in.
 *
 * The client id is prompted for visibly and the secret is not, which is the honest split:
 * the id is in every authorization URL a browser visits and on Linear's own settings page,
 * and hiding it would mean an operator cannot check they pasted the right one. The secret
 * goes through the same hidden prompt `ogun secret set` uses, and for the same reason —
 * this command gets run over SSH into a terminal that scrolls back.
 *
 * Neither is accepted as a positional argument. `/proc/<pid>/cmdline` is world-readable
 * while the command runs and the shell writes its history to a file nobody audits; the
 * refusal is the same one `secret set` gives, because it is the same hazard. What changed
 * with the slug positional going away is that there is now no positional at all, so
 * *anything* extra on the line is refused — which is a wider net over the same fish.
 */
async function linearApp(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(args, PROJECT_FLAG, USAGE_APP)
  const [extra] = positionals
  if (extra !== undefined) {
    fail(
      'the client secret does not go on the command line.\n' +
        '  Anything in argv is readable by `ps` for every user on this box while the ' +
        'command runs,\n' +
        '  and your shell writes it into its history file, where nothing cleans it up.\n' +
        '  Nothing was stored. Run it with no arguments and answer the prompts.\n\n' +
        '  Treat the secret you just typed as compromised: rotate it in Linear, and remove ' +
        'the line\n  from your shell history.',
    )
  }

  const project = await resolveProject(flags.project, await loadLocalConfig())
  // Before the first prompt, not after. A command that collects a Client Secret and then
  // says the project was misspelled has already had a credential typed into a terminal that
  // scrolls back, for nothing.
  await requireProjectOnControlPlane(project, serverUrl)

  console.log(bold(`\nA Linear OAuth application for ${cyan(project.slug)}\n`))
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
  console.log(`  Create one at ${cyan(REGISTER_URL)}`)
  console.log(
    dim(
      '  Linear recommends creating it in a workspace you use for managing applications,\n' +
        '  because every admin of that workspace can see it.\n',
    ),
  )

  // Fetched before anything is typed, so the operator can paste the callback URL into
  // Linear's form in the same sitting. It comes from the control plane rather than being
  // built here, because the server that receives the callback is the only thing that knows
  // what address the browser will reach it on.
  const status = await get(serverUrl, '/api/oauth/linear')
  console.log(`  Redirect callback URL to register: ${cyan(String(status.redirectUri))}`)
  console.log(
    dim(
      '  Linear matches this exactly — scheme, host, port and trailing slash. A mismatch\n' +
        '  is the classic failure of this flow and the error it gives says nothing useful.\n',
    ),
  )

  const clientId = (await prompt('  Client ID: ')).trim()
  if (clientId === '') fail('nothing was stored — a client id is required')
  const clientSecret = await promptHidden('  Client secret (not echoed): ')

  const result = await send(serverUrl, `/api/oauth/linear/app/${project.slug}`, 'PUT', {
    clientId,
    clientSecret,
  })

  console.log(green(`\n  stored for ${project.slug}`))
  console.log(dim(`  ${localConfigPath()}, mode 0600, on this machine only`))
  if (result.grantKept === true) {
    // Worth saying: rotating only the secret keeps a live connection, and an operator who
    // expected to have to reconnect would otherwise go and do it for no reason.
    console.log(dim('  the existing connection was kept — only the client secret changed'))
  }
  console.log(`\n  Next: ${cyan(`ogun linear connect${projectFlag(project)}`)}`)
}

// ── the flow ───────────────────────────────────────────────────────────────

/**
 * `ogun linear connect` — obtain the grant, and finish the job if the browser could not.
 *
 * The happy path today is: open the URL, approve, Linear redirects the browser to the
 * control plane, done. The path this command exists for is the other one — a control plane
 * the operator's browser cannot reach, where the redirect fails and the code is sitting in
 * the address bar. Pasting that URL back here completes the exchange from a machine that
 * *can* reach the control plane.
 *
 * The paste goes through a hidden prompt. A redirect URL is not a credential in the way an
 * API key is — the code inside it is single-use and worthless without the client secret,
 * which never leaves this machine — but it is a live code in a terminal that scrolls back
 * and gets pasted into support threads, and there is no cost to not echoing it.
 *
 * ### The browser is what `/start` answered, not what this command is
 *
 * Nothing in the name, the flags or the shape of this command says "open a browser", and
 * that is deliberate: which grant Ogun asks for is the server's decision, and a
 * `client_credentials` default would remove the browser step entirely without changing what
 * an operator types. So the browser instructions are printed *because the server returned
 * an `authorizeUrl`*, and a start that returns a finished connection instead is reported as
 * one rather than printing `undefined` at step 1. That branch is the whole cost of not
 * hard-coding the assumption, and it is cheaper than the alternative — discovering, on the
 * day the grant changes, that the CLI has to change too.
 */
async function linearConnect(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(args, PROJECT_FLAG, USAGE_CONNECT)
  if (positionals[0] !== undefined) fail(`usage: ${USAGE_CONNECT}`)

  const project = await resolveProject(flags.project, await loadLocalConfig())
  await requireProjectOnControlPlane(project, serverUrl)
  const here = projectFlag(project)

  const start = await send(serverUrl, `/api/oauth/linear/start/${project.slug}`, 'POST', {})

  if (start.authorizeUrl === undefined) {
    // A grant that needed no consent screen. Nothing produces this today; it is what a
    // `client_credentials` start would look like, and printing the summary is the same
    // three lines the exchange below prints.
    if (start.connected === undefined) {
      fail('the control plane started a flow this CLI does not understand — upgrade it')
    }
    return announceConnected(start.connected, here)
  }

  console.log(bold(`\nConnect ${cyan(project.slug)} to Linear\n`))
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}\n`))
  console.log('  1. Open this URL and approve the installation:\n')
  console.log(`     ${cyan(String(start.authorizeUrl))}\n`)
  console.log(
    dim(
      `     Requesting: ${(start.scopes as string[]).join(', ')}, as \`actor=${start.actor}\`.\n` +
        '     `actor=app` makes Ogun act as the application rather than as you, which is\n' +
        '     the whole point — but it installs at the workspace level, so Linear needs a\n' +
        '     workspace admin to approve it. If you are not one, the personal API key\n' +
        '     (`ogun secret set linear`) is still supported.\n',
    ),
  )
  console.log('  2. Linear sends your browser back to:\n')
  console.log(`     ${dim(String(start.redirectUri))}\n`)
  console.log(
    dim(
      '     If your browser can reach that address, you are done — check with\n' +
        `     \`ogun linear status${here}\`.\n`,
    ),
  )

  if (!process.stdin.isTTY) {
    // Nothing to prompt with. Said out loud rather than silently skipped, because a
    // scripted `connect` that printed a URL and exited 0 reads like it finished.
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
    console.log(dim(`\n  left to the browser. \`ogun linear status${here}\``))
    return
  }

  const done = await send(serverUrl, '/api/oauth/linear/exchange', 'POST', { redirectUrl: pasted })
  announceConnected(done.connected, here)
}

/** What a finished connect looks like, from whichever half of the flow finished it. */
function announceConnected(connected: unknown, here: string): void {
  const summary = connected as { workspace?: string; scopes: string[]; actor: string }
  console.log(
    green(`\n  connected${summary.workspace ? ` to ${summary.workspace}` : ''}`) +
      dim(` — ${summary.scopes.join(', ')}, as ${summary.actor}`),
  )
  console.log(dim(`  \`ogun linear status${here}\``))
}

/**
 * `ogun linear disconnect` — forget the tokens.
 *
 * Two levels, because they undo two different acts. By default the application stays
 * registered, so reconnecting is one command; `--forget-app` removes the client id and
 * secret as well, which is what "this project no longer uses Linear" means.
 *
 * The revoke at Linear is attempted by the server and its failure is reported rather than
 * hidden — the local credential is gone either way, and whether Linear was told is
 * something an operator may want to follow up on by hand.
 *
 * **The slug is not checked against the control plane here**, where `app` and `connect`
 * check it. Same rule as `ogun secret rm`, and the same reason: `status` prints whatever
 * the store holds, so an entry left behind by a project that has since been removed from
 * the database is a row an operator can *see*, and refusing to remove it would strand a
 * live refresh token in the file with the listing still advertising it. Validation guards
 * the two commands that create something; a removal creates nothing.
 */
async function linearDisconnect(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { ...PROJECT_FLAG, '--forget-app': 'boolean' },
    USAGE_DISCONNECT,
  )
  if (positionals[0] !== undefined) fail(`usage: ${USAGE_DISCONNECT}`)

  const project = await resolveProject(flags.project, await loadLocalConfig())
  const query = flags['forget-app'] ? '?app=true' : ''
  const result = await send(serverUrl, `/api/oauth/linear/${project.slug}${query}`, 'DELETE')

  /**
   * "removed" and "there was nothing here" are different answers, and the second one is now
   * the more interesting of the two.
   *
   * That was always true; what changed is that the project is inferred from the directory,
   * so `ogun linear disconnect` run one level too high is a plausible way to reach this
   * branch — and "nothing changed" whispered in grey reads like success to somebody who is
   * scanning. It is yellow, it names the project it looked in, and it says where that name
   * came from, because that is the thing that was actually wrong.
   */
  if (result.removed !== true) {
    console.log(
      yellow(`${project.slug} had no linear connection on this machine — nothing changed`),
    )
    if (project.from !== 'flag') {
      console.log(dim(`  project taken from ${project.from} — \`ogun linear status\` has the rest`))
    }
    return
  }
  console.log(green(`${project.slug} disconnected from linear`))
  console.log(
    result.revoked === true
      ? dim('  the access token was revoked at Linear as well')
      : yellow('  Linear could not be told — revoke the token by hand if it matters'),
  )
  if (result.appForgotten === true) {
    console.log(dim('  the application registration was removed too'))
  } else {
    console.log(
      dim(`  the application is still registered — \`ogun linear connect${projectFlag(project)}\``),
    )
  }
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * `ogun linear status [--project <slug>]` — read the store, not the server.
 *
 * Deliberately local. The question "is this connected" is most often asked when something
 * is not working, and a status command that needs the control plane up cannot answer it
 * then. It reads the same `listOAuthApps` the server reads, so the two cannot disagree.
 *
 * **It does not default to the current directory the way the other three do.** This is the
 * machine's inventory, and it is the same call `ogun secret list` makes for the same
 * reason: the three commands that act each act on exactly one project, so naming the wrong
 * one is their whole failure mode, while this one acts on none. A status that silently
 * narrowed to wherever the shell was standing would print "no linear applications on this
 * machine" on a machine holding four, which is the worst answer a presence check can give
 * — and the one an operator debugging an outage is least equipped to disbelieve.
 *
 * There is no field here a token would fit in, and that is structural rather than
 * remembered: `ProjectGrantPresence` carries a client id, a workspace, scopes and an
 * expiry, and nothing else.
 */
async function linearStatus(args: string[]): Promise<void> {
  const { flags } = parse(args, PROJECT_FLAG, USAGE_STATUS)
  const only = flags.project
  const all = (await listOAuthApps()).filter((a) => a.provider === 'linear')
  const rows = only ? all.filter((a) => a.project === only) : all

  if (rows.length === 0) {
    console.log(
      dim(
        only
          ? `no linear application registered for ${only} on this machine`
          : 'no linear applications on this machine',
      ),
    )
    console.log(dim(`  ${USAGE_APP}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('WORKSPACE'), bold('ACTOR'), bold('SCOPES'), bold('')],
      ...rows.map((a) => [
        cyan(a.project),
        a.workspace?.name ?? dim('—'),
        a.actor === '' ? dim('—') : a.actor,
        a.scopes.length > 0 ? a.scopes.join(' ') : dim('—'),
        stateOf(a),
      ]),
    ]),
  )
  console.log(dim(`\ntokens are never printed. ${localConfigPath()}`))
}

const stateOf = (app: ProjectGrantPresence): string => {
  if (app.malformed !== undefined) return red(`unreadable — ${app.malformed}`)
  if (!app.connected) return yellow('registered, not connected')
  // Green even when expired: the next poll renews it from the refresh token, and colouring
  // that red would train an operator to act on the one state that needs no action.
  return green(describeGrant(app.expiresAt).detail)
}

// ── which project ──────────────────────────────────────────────────────────

/**
 * A slug the control plane does not know is refused, and nothing is stored.
 *
 * The same hole `ogun secret set` had: a credential filed under a project nothing polls
 * reports as configured and is read by nothing. What differs is the oracle, and the rule
 * behind that difference is worth stating once — **each command checks against the best
 * evidence it already depends on.**
 *
 * `ogun secret set` reaches no server by design, so its evidence is local: this machine's
 * projects map, or a `.ogun/config.yaml` in the directory it was run from. That is weaker
 * than the database, which is why it carries an `--allow-unregistered` escape for the
 * hosted control plane whose repositories live elsewhere and whose projects map is
 * therefore legitimately empty.
 *
 * These commands cannot work without the control plane at all — the `state` nonce and the
 * callback both live in that process — so the database is available, and the database is
 * the thing that decides which slugs get polled. Checking against it needs no escape hatch,
 * because there is no case where the right answer is a project the control plane has never
 * heard of: `PUT /api/oauth/linear/app/:project` would refuse the write a moment later
 * anyway. What this adds is *when* the refusal arrives — before two prompts, one of which
 * collects a Client Secret — and *what it says*, which is the list of slugs that would have
 * worked.
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
      '  Nothing was stored. An application filed under a slug nothing polls reports as\n' +
      '  configured and is read by nothing.\n' +
      (project.from === 'the directory name'
        ? '  This directory has no .ogun/config.yaml, so the name was guessed from it. Run\n' +
          '  this inside the repository instead, or pass --project <slug>.\n'
        : '') +
      '  `ogun project sync` in the repository is what registers it.',
  )
}

// ── talking to the control plane ───────────────────────────────────────────

/**
 * One request helper, and it never puts a response body it could not parse into an error.
 *
 * The server's failures here are already sentences meant for a person — a redirect-URI
 * mismatch, a project it does not know, a transport refusal naming the CLI — so `error` is
 * forwarded as it stands. Anything else is reported by status code alone: an unparseable
 * body from this endpoint is a proxy in the way, and pasting its HTML into a terminal
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

/** A visible line, for the values that are not secrets. */
function prompt(label: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stderr.write(label)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    const onData = (chunk: string): void => {
      process.stdin.removeListener('data', onData)
      process.stdin.pause()
      resolve(chunk.split('\n')[0] ?? '')
    }
    process.stdin.on('data', onData)
  })
}
