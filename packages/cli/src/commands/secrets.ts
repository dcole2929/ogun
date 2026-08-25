import {
  clearProjectSecret,
  InvalidSecret,
  isSecretName,
  listProjectSecrets,
  localConfigPath,
  normalizeSecretInput,
  SECRET_NAMES,
  setProjectSecret,
  type SecretName,
} from '@ogun/core'
import { parse } from '../args.ts'
import { bold, cyan, dim, fail, green, table, yellow } from '../output.ts'

/**
 * `ogun project secret` — give a project an API key that nothing on this machine already
 * has, and that must never reach the repository (ADR-0012).
 *
 * Runs on the machine with the control plane on it, because the control plane is what
 * polls. It writes `~/.ogun/config.json` and talks to no server at all, which is what
 * makes it the path that always works: before `ogun init`, with the database down, and
 * over SSH into a box with no browser.
 *
 * There is now also `PUT /api/system/secrets/:project/:name`, which the Settings page
 * uses. It calls the same functions this file calls — one writer, one lockfile, one set of
 * validation rules — and refuses outright unless the transport can carry a key, which is a
 * loopback bind or an operator who has declared a TLS terminator in front. The comment
 * here used to say no such route existed, on the grounds that a request body is a value in
 * an access log and a browser's network panel; `secretWriteTransport` in the server has
 * why only the cleartext-on-the-wire half of that survived being checked.
 */
export async function projectSecret(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'set') return secretSet(rest)
  if (sub === 'rm' || sub === 'remove') return secretRemove(rest)
  if (sub === 'list' || sub === undefined) return secretList(rest)
  fail(`unknown: ogun project secret ${sub}\n  usage: ogun project secret set | list | rm`)
}

const USAGE_SET = 'ogun project secret set <project> <name>'

/**
 * `ogun project secret set <project> <name>` — with the value on stdin, or typed at a
 * prompt, and never on the command line.
 *
 * ### Why there is no `<value>` argument
 *
 * It is the obvious third positional and it is the wrong one, for two reasons that have
 * nothing to do with this program:
 *
 *  - **`ps` shows another user's argv.** On Linux `/proc/<pid>/cmdline` is world-readable
 *    by default, so for as long as the command runs, every account on the box can read the
 *    key. It is a short window and it is not a small one on a shared machine.
 *  - **The shell writes it down.** `~/.zsh_history` and `~/.bash_history` are files nobody
 *    audits and everybody backs up, and a key pasted once sits there indefinitely — which
 *    is the same containment failure `redactUrlCredentials` was merged for, one layer out.
 *
 * So a third positional is *refused* rather than accepted, and the refusal says both of
 * the above. Silently ignoring it would be worse than taking it: the operator would
 * believe the secret was stored and would still have leaked it.
 *
 * ### How the value gets in
 *
 * Piped, when stdin is not a terminal — `ogun project secret set ogun linear < key.txt`,
 * or from a password manager: `op read op://vault/linear/key | ogun project secret set …`.
 * Typed at a prompt with the echo off, when it is. No flag chooses between them; the
 * shape of stdin already says which one the operator meant, and a `--stdin` flag that had
 * to be remembered would mostly be discovered by pasting a key into a hung command.
 */
async function secretSet(args: string[]): Promise<void> {
  const { positionals } = parse(args, {}, USAGE_SET)
  const [project, name, extra] = positionals

  if (extra !== undefined) {
    fail(
      'the value does not go on the command line.\n' +
        '  Anything in argv is visible to `ps` for every user on this box while the ' +
        'command runs,\n' +
        '  and your shell writes it into ~/.zsh_history or ~/.bash_history, where it stays.\n' +
        `  Nothing was stored. Pipe it instead:  ${USAGE_SET} < key.txt\n` +
        '  or run it with no value and type it at the prompt.\n\n' +
        '  Treat the key you just typed as compromised: rotate it in Linear, and remove ' +
        'the line\n  from your shell history.',
    )
  }
  if (!project || !name) fail(`usage: ${USAGE_SET}`)
  const secretName = requireSecretName(name)

  const raw = process.stdin.isTTY
    ? await promptHidden(`${name} key for ${project}: `)
    : await readAllStdin()

  let value: string
  try {
    value = normalizeSecretInput(raw)
  } catch (err) {
    if (!(err instanceof InvalidSecret)) throw err
    fail(err.message)
  }

  await setProjectSecret(project, secretName, value)

  /**
   * The confirmation says the length and nothing else.
   *
   * Not even the last four characters: a suffix is the standard reassurance and it is a
   * disclosure, and this command is run over SSH into a terminal that scrolls back. The
   * length is what actually catches the two mistakes a set can make — a truncated paste
   * and a value that picked up something it should not have — and it narrows a random key
   * by nothing.
   */
  console.log(green(`${secretName} set for ${project}`) + dim(` (${value.length} characters)`))
  console.log(dim(`  stored in ${localConfigPath()}, mode 0600, on this machine only`))
  console.log(
    dim(
      '  It never reaches a sandbox, the database, or an API response. Setting it again\n' +
        '  replaces it; the next poll picks the new one up with no restart.',
    ),
  )
}

/**
 * `ogun project secret list [project]` — which secrets this machine holds.
 *
 * Names and states. There is no command, flag or endpoint anywhere that prints a stored
 * value back, and the type this reads (`ProjectSecretPresence`) has no field one would
 * fit in — so this cannot start leaking one by someone adding a column.
 *
 * It cannot say what is *missing*, and says so rather than implying otherwise: which
 * projects need a Linear key is a fact in each repository's `.ogun/config.yaml`, and this
 * command does not read repositories.
 */
async function secretList(args: string[]): Promise<void> {
  const { first } = parse(args, {}, 'ogun project secret list [project]')
  const all = await listProjectSecrets()
  const rows = first ? all.filter((s) => s.project === first) : all

  if (rows.length === 0) {
    console.log(
      dim(
        first
          ? `no secrets stored for ${first} on this machine`
          : 'no project secrets on this machine',
      ),
    )
    console.log(dim(`  ${USAGE_SET}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('SECRET'), bold('')],
      ...rows.map((s) => [
        cyan(s.project),
        s.name,
        // `empty` is only reachable by hand-editing config.json, and it is the state
        // worth colouring: a poller reads it as a key that exists and does not work.
        s.state === 'present' ? green('set') : yellow('empty — set it again'),
      ]),
    ]),
  )
  console.log(dim(`\nvalues are never printed. ${localConfigPath()}`))
}

/**
 * Any name, not only a known one — unlike `set`, which refuses what Ogun does not read.
 *
 * `list` prints whatever the store holds, and §4.5 says that file gets hand-edited, so a
 * `linaer` somebody typed into config.json by hand shows up in the table. Refusing to
 * remove it would leave a live credential in the file that the listing keeps advertising,
 * which is the closed set protecting the value from its owner. The set guards writes,
 * where an unknown name creates a key nothing reads; there is nothing to guard here.
 */
async function secretRemove(args: string[]): Promise<void> {
  const { positionals } = parse(args, {}, 'ogun project secret rm <project> <name>')
  const [project, name] = positionals
  if (!project || !name) fail('usage: ogun project secret rm <project> <name>')

  const removed = await clearProjectSecret(project, name)
  // "removed" and "there was nothing here" are different answers. Printing the first for
  // both is how you learn it worked after removing it from the wrong project.
  if (removed) console.log(green(`${name} removed for ${project}`))
  else console.log(dim(`${project} had no ${name} secret on this machine — nothing changed`))
}

/**
 * A name Ogun does not read is refused at the moment it is typed.
 *
 * The alternative is a store that accepts anything, which means a typo is a secret that
 * exists, reports as set, and is read by nothing — the same silent hole `inertPolicies`
 * prints a warning for elsewhere, except here the symptom is an unauthenticated poller
 * hours later.
 */
function requireSecretName(name: string): SecretName {
  if (isSecretName(name)) return name
  return fail(
    `"${name}" is not a secret Ogun reads. Known: ${SECRET_NAMES.join(', ')}.\n` +
      '  Nothing was stored — a secret nothing reads looks exactly like one that works.',
  )
}

/**
 * Everything on stdin, for the piped case.
 *
 * Read as a string rather than as a buffer we later stringify, and nothing else here holds
 * onto it: the value goes straight into `normalizeSecretInput` and then into the write.
 */
async function readAllStdin(): Promise<string> {
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) chunks.push(chunk as string)
  return chunks.join('')
}

/**
 * Read a line from a terminal without echoing it.
 *
 * Raw mode rather than `readline`, because `readline` echoes and the usual workaround —
 * a muted output stream — mutes the *interface's* writes and not the terminal's own, so
 * it is easy to get a version that looks right on one platform and prints the key on
 * another. In raw mode the terminal echoes nothing at all and this function decides what
 * appears.
 *
 * The prompt goes to stderr so that `ogun project secret set …` stays composable in a
 * pipeline whose stdout is being captured.
 *
 * Restoring the mode is in a `finally`, and it matters more than it looks: a process that
 * exits — including on Ctrl-C, which is delivered as a byte rather than a signal in raw
 * mode — leaves the operator's terminal with echo off and no prompt, which reads as a
 * hung shell.
 */
/**
 * The control bytes a terminal in raw mode delivers as ordinary data.
 *
 * Named and written as escapes rather than as literal bytes in a string literal, because
 * a source file containing a real NUL-adjacent control character is a source file that
 * editors, diffs and terminals each mangle differently.
 */
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const DELETE = '\u007f'
const BACKSPACE = '\u0008'

export function promptHidden(label: string): Promise<string> {
  const input = process.stdin
  return new Promise<string>((resolve, reject) => {
    process.stderr.write(label)
    const wasRaw = input.isRaw === true
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')

    let buffer = ''
    const done = (finish: () => void): void => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      process.stderr.write('\n')
      finish()
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buffer))
        // Ctrl-C and Ctrl-D. In raw mode the terminal does not turn these into signals or
        // EOF, so an operator who changes their mind would otherwise be stuck typing into
        // a prompt with no way out.
        if (ch === CTRL_C || ch === CTRL_D) {
          return done(() => reject(new InvalidSecret('cancelled — nothing was stored')))
        }
        if (ch === DELETE || ch === BACKSPACE) buffer = buffer.slice(0, -1)
        else buffer += ch
      }
    }
    input.on('data', onData)
  }).catch((err: unknown) => {
    if (err instanceof InvalidSecret) fail(err.message)
    throw err
  })
}
