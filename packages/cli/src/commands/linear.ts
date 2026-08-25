import { describeGrant, listOAuthApps, localConfigPath, type ProjectGrantPresence } from '@ogun/core'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'
import { bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import { promptHidden } from './secrets.ts'

/**
 * `ogun project linear` — connect a project to Linear as an application (ADR-0014).
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
 * `ogun secret set` deliberately reaches no server: it writes config.json directly,
 * so it works before `ogun init`, with the database down, and over SSH. This one cannot
 * make that promise and does not pretend to. The `state` nonce that protects the flow lives
 * in the control-plane process, and the callback is delivered to the control-plane process
 * — so a connect performed by a CLI writing files behind the server's back would be a
 * second implementation of the CSRF check, in a process that never sees the callback.
 *
 * The one thing it *does* do locally is `status`, which reads the store — so "what is
 * connected" is answerable on a machine whose control plane is down, which is when the
 * question is usually asked.
 */
export async function projectLinear(args: string[], serverUrl: string): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'app') return linearApp(rest, serverUrl)
  if (sub === 'connect') return linearConnect(rest, serverUrl)
  if (sub === 'disconnect') return linearDisconnect(rest, serverUrl)
  if (sub === 'status' || sub === undefined) return linearStatus(rest)
  fail(
    `unknown: ogun project linear ${sub}\n` +
      '  usage: ogun project linear app | connect | status | disconnect',
  )
}

// ── registering the application ────────────────────────────────────────────

const REGISTER_URL = 'https://linear.app/settings/api/applications/new'

/**
 * `ogun project linear app <project>` — store the client id and secret.
 *
 * The client id is prompted for visibly and the secret is not, which is the honest split:
 * the id is in every authorization URL a browser visits and on Linear's own settings page,
 * and hiding it would mean an operator cannot check they pasted the right one. The secret
 * goes through the same hidden prompt `ogun secret set` uses, and for the same
 * reason — this command gets run over SSH into a terminal that scrolls back.
 *
 * Neither is accepted as a positional argument. `/proc/<pid>/cmdline` is world-readable
 * while the command runs and the shell writes its history to a file nobody audits; the
 * refusal is the same one `secret set` gives, because it is the same hazard.
 */
async function linearApp(args: string[], serverUrl: string): Promise<void> {
  const { positionals } = parse(args, {}, 'ogun project linear app <project>')
  const [project, extra] = positionals
  if (!project) fail('usage: ogun project linear app <project>')
  if (extra !== undefined) {
    fail(
      'the client secret does not go on the command line.\n' +
        '  Anything in argv is readable by `ps` for every user on this box while the ' +
        'command runs,\n' +
        '  and your shell writes it into its history file, where nothing cleans it up.\n' +
        '  Nothing was stored. Run it with just the project and answer the prompts.\n\n' +
        '  Treat the secret you just typed as compromised: rotate it in Linear, and remove ' +
        'the line\n  from your shell history.',
    )
  }

  console.log(bold(`\nA Linear OAuth application for ${cyan(project)}\n`))
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

  const result = await send(serverUrl, `/api/oauth/linear/app/${project}`, 'PUT', {
    clientId,
    clientSecret,
  })

  console.log(green(`\n  stored for ${project}`))
  console.log(dim(`  ${localConfigPath()}, mode 0600, on this machine only`))
  if (result.grantKept === true) {
    // Worth saying: rotating only the secret keeps a live connection, and an operator who
    // expected to have to reconnect would otherwise go and do it for no reason.
    console.log(dim('  the existing connection was kept — only the client secret changed'))
  }
  console.log(`\n  Next: ${cyan(`ogun project linear connect ${project}`)}`)
}

// ── the flow ───────────────────────────────────────────────────────────────

/**
 * `ogun project linear connect <project>` — print the URL, and finish the job if the
 * browser could not.
 *
 * The happy path is: open the URL, approve, Linear redirects the browser to the control
 * plane, done. The path this command exists for is the other one — a control plane the
 * operator's browser cannot reach, where the redirect fails and the code is sitting in the
 * address bar. Pasting that URL back here completes the exchange from a machine that *can*
 * reach the control plane.
 *
 * The paste goes through a hidden prompt. A redirect URL is not a credential in the way an
 * API key is — the code inside it is single-use and worthless without the client secret,
 * which never leaves this machine — but it is a live code in a terminal that scrolls back
 * and gets pasted into support threads, and there is no cost to not echoing it.
 */
async function linearConnect(args: string[], serverUrl: string): Promise<void> {
  const { first } = parse(args, {}, 'ogun project linear connect <project>')
  if (!first) fail('usage: ogun project linear connect <project>')

  const start = await send(serverUrl, `/api/oauth/linear/start/${first}`, 'POST', {})

  console.log(bold(`\nConnect ${cyan(first)} to Linear\n`))
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
        `     \`ogun project linear status ${first}\`.\n`,
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
    console.log(dim(`\n  left to the browser. \`ogun project linear status ${first}\``))
    return
  }

  const done = await send(serverUrl, '/api/oauth/linear/exchange', 'POST', { redirectUrl: pasted })
  const summary = done.connected as { workspace?: string; scopes: string[]; actor: string }
  console.log(
    green(`\n  connected${summary.workspace ? ` to ${summary.workspace}` : ''}`) +
      dim(` — ${summary.scopes.join(', ')}, as ${summary.actor}`),
  )
}

/**
 * `ogun project linear disconnect <project>` — forget the tokens.
 *
 * Two levels, because they undo two different acts. By default the application stays
 * registered, so reconnecting is one command; `--forget-app` removes the client id and
 * secret as well, which is what "this project no longer uses Linear" means.
 *
 * The revoke at Linear is attempted by the server and its failure is reported rather than
 * hidden — the local credential is gone either way, and whether Linear was told is
 * something an operator may want to follow up on by hand.
 */
async function linearDisconnect(args: string[], serverUrl: string): Promise<void> {
  const { first, flags } = parse(
    args,
    { '--forget-app': 'boolean' },
    'ogun project linear disconnect <project> [--forget-app]',
  )
  if (!first) fail('usage: ogun project linear disconnect <project> [--forget-app]')

  const query = flags['forget-app'] ? '?app=true' : ''
  const result = await send(serverUrl, `/api/oauth/linear/${first}${query}`, 'DELETE')

  // "removed" and "there was nothing here" are different answers. Printing the first for
  // both is how you learn it worked after disconnecting the wrong project.
  if (result.removed !== true) {
    console.log(dim(`${first} had no linear connection on this machine — nothing changed`))
    return
  }
  console.log(green(`${first} disconnected from linear`))
  console.log(
    result.revoked === true
      ? dim('  the access token was revoked at Linear as well')
      : yellow('  Linear could not be told — revoke the token by hand if it matters'),
  )
  if (result.appForgotten === true) {
    console.log(dim('  the application registration was removed too'))
  } else {
    console.log(dim(`  the application is still registered — \`ogun project linear connect ${first}\``))
  }
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * `ogun project linear status [project]` — read the store, not the server.
 *
 * Deliberately local. The question "is this connected" is most often asked when something
 * is not working, and a status command that needs the control plane up cannot answer it
 * then. It reads the same `listOAuthApps` the server reads, so the two cannot disagree.
 *
 * There is no field here a token would fit in, and that is structural rather than
 * remembered: `ProjectGrantPresence` carries a client id, a workspace, scopes and an
 * expiry, and nothing else.
 */
async function linearStatus(args: string[]): Promise<void> {
  const { first } = parse(args, {}, 'ogun project linear status [project]')
  const all = (await listOAuthApps()).filter((a) => a.provider === 'linear')
  const rows = first ? all.filter((a) => a.project === first) : all

  if (rows.length === 0) {
    console.log(
      dim(
        first
          ? `no linear application registered for ${first} on this machine`
          : 'no linear applications on this machine',
      ),
    )
    console.log(dim('  ogun project linear app <project>'))
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
