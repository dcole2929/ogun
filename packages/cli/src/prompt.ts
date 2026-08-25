import { InvalidSecret, normalizeSecretInput } from '@ogun/core'
import { fail } from './output.ts'

/**
 * Reading a value from a person, or from whatever is on the other end of stdin.
 *
 * Extracted from `commands/secrets.ts` when `ogun connect` took over the job of giving a
 * project a credential, because two commands prompting for secrets with two
 * implementations is how one of them ends up echoing. The raw-mode handling below is the
 * part that is easy to get subtly wrong on one platform and right on another, and it
 * should exist once.
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

/**
 * Read a line from a terminal without echoing it.
 *
 * Raw mode rather than `readline`, because `readline` echoes and the usual workaround —
 * a muted output stream — mutes the *interface's* writes and not the terminal's own, so
 * it is easy to get a version that looks right on one platform and prints the key on
 * another. In raw mode the terminal echoes nothing at all and this function decides what
 * appears.
 *
 * The prompt goes to stderr so that the command stays composable in a pipeline whose
 * stdout is being captured.
 *
 * Restoring the mode is in a `finally`, and it matters more than it looks: a process that
 * exits — including on Ctrl-C, which is delivered as a byte rather than a signal in raw
 * mode — leaves the operator's terminal with echo off and no prompt, which reads as a
 * hung shell.
 */
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

/**
 * A yes-or-no question, defaulting to **no**.
 *
 * Only `y` or `yes` agrees. Enter, anything else, and an empty line all decline, because
 * the one call site is a question about destroying a credential that cannot be recovered:
 * the answer somebody gives by holding Enter through a command they were not reading has
 * to be the one that changes nothing.
 *
 * The question goes to stderr beside the prompts above, so `ogun … > file` neither hides
 * it nor writes it into whatever is being captured. Callers must check `process.stdin.isTTY`
 * first — off a terminal this reads a line of the *pipe*, which is usually the credential.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = (await prompt(question)).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

/** A visible line, for the values that are not secrets — a client id, a project slug. */
export function prompt(label: string): Promise<string> {
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

/**
 * Everything on stdin, for the piped case.
 *
 * Read as a string rather than as a buffer that is later stringified, and nothing else
 * here holds onto it: the value goes straight to the caller, which normalises it and
 * seals it.
 */
export async function readAllStdin(): Promise<string> {
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) chunks.push(chunk as string)
  return chunks.join('')
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
 *
 * It lives here rather than in `connect.ts` because there are two doors onto the same
 * store — `ogun connect <integration> --api-key` and `ogun secret set <name>` — and a
 * second copy of "where does the value come from" is how one of them ends up echoing, or
 * accepting a trailing newline the other strips.
 */
export async function readSecretValue(
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

/**
 * The line printed when a credential arrives as a command-line argument.
 *
 * ### Refused for two days; warned about from now on, and the reversal is deliberate
 *
 * The first shape of this rule **refused** an inline value outright: nothing was stored,
 * and the message told the operator to treat what they had typed as compromised. The
 * reasoning was, and remains, entirely correct about the hazard — `/proc/<pid>/cmdline` is
 * world-readable on Linux for as long as the process runs, so every account on the box can
 * read the value, and the shell writes the whole line into a history file nobody audits
 * and everybody backs up.
 *
 * What that reasoning did not weigh is the cost of the refusal itself, which the product
 * owner did:
 *
 *  - **A usage line that hides an input is the fault this whole change is about.** Naming
 *    the value in the signature — `ogun connect linear --api-key <key>` — is the only way
 *    a reader learns from `--help` that a key is involved at all. Naming it and then
 *    refusing it teaches the reader that the documentation lies.
 *  - **Refusal does not un-leak anything.** By the time the process can refuse, argv has
 *    already been in `/proc` and the shell has already written its history. The refusal
 *    protects nothing that has not already happened; it only withholds the store.
 *  - **Every other tool warns.** `docker login -p` prints *"WARNING! Using --password via
 *    the CLI is insecure"* and proceeds. An operator who has met that convention reads a
 *    hard refusal as a bug and reaches for a workaround, which is usually worse than the
 *    thing being prevented.
 *
 * So: the value is accepted, the warning is loud and unconditional, and it carries the
 * same "treat it as compromised" advice the refusal used to. **Nothing else about
 * containment changed.** The value is normalised and sealed into a `Secret` exactly as a
 * prompted one is, it is never echoed, and it never appears in an error message.
 *
 * The prompt and the pipe remain the recommended paths and the help says so under every
 * usage line: omitting the value prompts at a terminal with the echo off, and reads stdin
 * when stdin is a pipe.
 */
export function warnInlineSecret(what: string): void {
  // stderr, not stdout: this must survive `ogun connect … > log` and must not land in the
  // middle of output somebody is parsing.
  process.stderr.write(
    `WARNING! Passing ${what} on the command line is insecure.\n` +
      '  While this command runs, every user on this box can read it out of\n' +
      '  /proc/<pid>/cmdline, and your shell has already written the whole line into\n' +
      '  ~/.zsh_history or ~/.bash_history, where nothing cleans it up.\n' +
      '  Treat it as compromised: rotate it in Linear afterwards, and remove the line from\n' +
      '  your shell history. Omit it to be prompted, or pipe it on stdin.\n\n',
  )
}
