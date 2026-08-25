import { basename, resolve as resolvePath, sep } from 'node:path'
import {
  clearProjectSecret,
  InvalidSecret,
  isSecretName,
  listProjectSecrets,
  loadLocalConfig,
  loadProjectConfig,
  localConfigPath,
  normalizeSecretInput,
  resolveProjectPath,
  SECRET_NAMES,
  setProjectSecret,
  type LocalConfig,
  type SecretName,
} from '@ogun/core'
import { parse } from '../args.ts'
import { bold, cyan, dim, fail, green, table, yellow } from '../output.ts'

/**
 * `ogun secret` — give a project an API key that nothing on this machine already has, and
 * that must never reach the repository (ADR-0012).
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
 *
 * ### Why this is not `ogun project secret`
 *
 * It was, for two days. The old shape took the slug as a positional — `ogun project secret
 * set <project> <name>` — and the `project` namespace existed to hold that positional.
 * Once the project is inferred from the directory you are standing in, as `ogun project
 * add` and `ogun project sync` have always inferred it, `project` is carrying nothing.
 * Machine-wide credentials are already `ogun token`, so `ogun secret` is unambiguous about
 * being the per-project one.
 *
 * The old path is gone rather than aliased. An alias is a second spelling that has to keep
 * working, and this command is two days old with nothing outside this repo calling it.
 * What `ogun project secret` gets instead is a refusal naming the new spelling, because
 * muscle memory outlives a release and "unknown subcommand" is a dead end.
 */
export async function secret(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'set') return secretSet(rest)
  if (sub === 'rm' || sub === 'remove') return secretRemove(rest)
  // A bare `ogun secret --project x` is a list with a filter, not a subcommand named
  // `--project`. The same reading `ogun skills --project x` gets.
  if (sub === undefined || sub === 'list') return secretList(rest)
  if (sub.startsWith('-')) return secretList(args)
  fail(`unknown: ogun secret ${sub}\n  usage: ogun secret set | list | rm`)
}

/**
 * The usage line names the key.
 *
 * `ogun secret set <name>` reads as complete, and it is not: the value is the whole point
 * of the command and the line says nothing about it arriving at all. Somebody who reads
 * that and types `ogun secret set linear` at a pipe-less shell gets a prompt they were not
 * expecting, which is the *good* outcome; the bad one is a script that runs it with no
 * stdin and hangs with no indication why. So the redirection is part of the usage string
 * everywhere the usage string is printed, and `--help` carries the reason it cannot be an
 * argument — the reason already existed in this file and was invisible from outside it.
 */
const USAGE_SET = 'ogun secret set <name> [--project <slug>] < key.txt'

const SET_FLAGS = { '--project': 'string', '--allow-unregistered': 'boolean' } as const

/**
 * `ogun secret set <name>` — with the value on stdin, or typed at a prompt, and never on
 * the command line.
 *
 * ### Why there is no `<value>` argument
 *
 * It is the obvious second positional and it is the wrong one, for two reasons that have
 * nothing to do with this program:
 *
 *  - **`ps` shows another user's argv.** On Linux `/proc/<pid>/cmdline` is world-readable
 *    by default, so for as long as the command runs, every account on the box can read the
 *    key. It is a short window and it is not a small one on a shared machine.
 *  - **The shell writes it down.** `~/.zsh_history` and `~/.bash_history` are files nobody
 *    audits and everybody backs up, and a key pasted once sits there indefinitely — which
 *    is the same containment failure `redactUrlCredentials` was merged for, one layer out.
 *
 * So a second positional is *refused* rather than accepted, and the refusal says both of
 * the above. Silently ignoring it would be worse than taking it: the operator would
 * believe the secret was stored and would still have leaked it.
 *
 * ### How the value gets in
 *
 * Piped, when stdin is not a terminal — `ogun secret set linear < key.txt`, or from a
 * password manager: `op read op://vault/linear/key | ogun secret set linear`. Typed at a
 * prompt with the echo off, when it is. No flag chooses between them; the shape of stdin
 * already says which one the operator meant, and a `--stdin` flag that had to be
 * remembered would mostly be discovered by pasting a key into a hung command.
 *
 * ### Everything is checked before stdin is read
 *
 * The argv shape, the name, and the project: each refuses before this function goes
 * looking for a value. A command that prompts, takes the key, and *then* says the project
 * was misspelled has already had the key typed into a terminal that scrolls back, for
 * nothing — and would have taught the operator that a rejected `set` is harmless.
 */
async function secretSet(args: string[]): Promise<void> {
  const { flags, positionals } = parse(args, SET_FLAGS, USAGE_SET)
  const [name, extra] = positionals

  if (extra !== undefined) {
    fail(
      'the value does not go on the command line.\n' +
        '  Anything in argv is visible to `ps` for every user on this box while the ' +
        'command runs,\n' +
        '  and your shell writes it into ~/.zsh_history or ~/.bash_history, where it stays.\n' +
        `  Nothing was stored. Pipe it instead:  ${USAGE_SET}\n` +
        '  or run it with no value and type it at the prompt.\n\n' +
        '  Treat the key you just typed as compromised: rotate it in Linear, and remove ' +
        'the line\n  from your shell history.',
    )
  }
  if (!name) fail(`usage: ${USAGE_SET}`)
  const secretName = requireSecretName(name)

  const config = await loadLocalConfig()
  const project = await resolveProject(flags.project, config)
  requireKnownProject(project, config, flags['allow-unregistered'] === true)

  /**
   * At a terminal, say that there is already one there *before* asking for the new one.
   *
   * Advisory rather than authoritative: it is a second read of the store, and the fact it
   * reports could in principle change before the write takes the lock. That is fine for
   * what it is for — a person who is one keystroke from pasting a key over a working one
   * and does not know it — and the line printed afterwards is the one taken under the lock.
   * `listProjectSecrets` is the read used rather than the config already in hand, because
   * it answers in presence and never hands this file a value to hold.
   *
   * Only at a TTY. A pipe is a rotation somebody wrote down on purpose, and a warning it
   * cannot act on is noise in a script's output.
   *
   * Considered and rejected: a `[y/N]` gate on a replace. It would need a `--yes` for the
   * non-interactive path, every script would set that flag once and forever, and the gate
   * would then guard nobody while costing everybody a keystroke — on the operation ADR-0012
   * settled as the *intended* one, since rotation is a plain overwrite by design. A prompt
   * on the happy path is a prompt people learn to answer without reading. Telling them
   * before they type, and telling them what happened after, is the whole of the information
   * a confirmation would have carried.
   */
  if (process.stdin.isTTY) {
    const existing = await listProjectSecrets().catch(() => [])
    if (existing.some((e) => e.project === project.slug && e.name === secretName)) {
      console.log(
        yellow(`  ${project.slug} already has a ${secretName} key on this machine.`),
      )
      console.log(dim('  Storing replaces it, and there is no history. Ctrl-C to stop.'))
    }
  }

  const raw = process.stdin.isTTY
    ? await promptHidden(`${secretName} key for ${project.slug}: `)
    : await readAllStdin()

  let value: string
  try {
    value = normalizeSecretInput(raw)
  } catch (err) {
    if (!(err instanceof InvalidSecret)) throw err
    fail(err.message)
  }

  const displaced = await setProjectSecret(project.slug, secretName, value)

  /**
   * The confirmation says the length and nothing else about the value.
   *
   * Not even the last four characters: a suffix is the standard reassurance and it is a
   * disclosure, and this command is run over SSH into a terminal that scrolls back. The
   * length is what actually catches the two mistakes a set can make — a truncated paste
   * and a value that picked up something it should not have — and it narrows a random key
   * by nothing.
   *
   * **It does say whether something was displaced**, which for two days it did not. The
   * first line was `linear set for ogun (23 characters)` whether that was the first key
   * this project had ever had or the destruction of a working one, and the only sentence
   * mentioning replacement was boilerplate printed either way — so it reported what the
   * command generally does rather than what it just did. `setProjectSecret` answers that
   * question from inside the lock, so this line is not a guess assembled from a read taken
   * before the write.
   */
  const verb = displaced === 'absent' ? 'stored for' : 'replaced for'
  console.log(
    green(`${secretName} ${verb} ${project.slug}`) + dim(` (${value.length} characters)`),
  )
  // Where the slug came from, whenever it was not typed. An inferred project is the one
  // thing about this command that can be quietly wrong, and the confirmation is the last
  // place it can be caught before a poll fails hours later with no mention of either.
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}`))
  if (displaced === 'present') {
    // Said only when a key was actually destroyed, and said as a fact rather than as the
    // general note below. ADR-0012 keeps no history on purpose — two live values means
    // nothing can say which of them a 401 came from — so the recovery is the provider's,
    // not ours, and an operator looking for the old value here needs to stop looking.
    console.log(
      dim('  The previous key is gone: there is no history and no second slot. If the new'),
    )
    console.log(dim('  one turns out to be wrong, mint another in Linear — the old value'))
    console.log(dim('  cannot be recovered from this machine.'))
  } else if (displaced === 'empty') {
    // Only reachable by hand-editing config.json, and worth naming: a blank entry is what
    // a poller reads as a key that exists and does not work, so this set is a repair.
    console.log(dim(`  ${project.slug} had a blank ${secretName} entry here, which a poller`))
    console.log(dim('  reads as a key that exists and does not work. It is filled in now.'))
  }
  console.log(dim(`  stored in ${localConfigPath()}, mode 0600, on this machine only`))
  console.log(
    dim(
      '  It never reaches a sandbox, the database, or an API response. Setting it again\n' +
        '  replaces it; the next poll picks the new one up with no restart.',
    ),
  )
}

/**
 * `ogun secret list [--project <slug>]` — which secrets this machine holds.
 *
 * Names and states. There is no command, flag or endpoint anywhere that prints a stored
 * value back, and the type this reads (`ProjectSecretPresence`) has no field one would
 * fit in — so this cannot start leaking one by someone adding a column.
 *
 * **It does not default to the current directory the way `set` and `rm` do**, and the
 * asymmetry is deliberate rather than an oversight. This is the machine's inventory, and
 * the question it answers — "what does this box hold" — is asked most often from a home
 * directory over SSH. A listing that silently narrowed to wherever the shell happened to
 * be standing would print "no project secrets on this machine" on a machine holding four,
 * which is the worst answer a presence check can give. `set` and `rm` infer because they
 * act on exactly one project and naming the wrong one is the whole failure; `list` acts on
 * none, so it has nothing to get wrong and everything to hide.
 *
 * It cannot say what is *missing*, and says so rather than implying otherwise: which
 * projects need a Linear key is a fact in each repository's `.ogun/config.yaml`, and this
 * command does not read repositories.
 */
async function secretList(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--project': 'string' }, 'ogun secret list [--project <slug>]')
  const all = await listProjectSecrets()
  const only = flags.project
  const rows = only ? all.filter((s) => s.project === only) : all

  if (rows.length === 0) {
    console.log(
      dim(
        only
          ? `no secrets stored for ${only} on this machine`
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
 * `ogun secret rm <name> [--project <slug>]` — forget one.
 *
 * Neither the name nor the project is checked against anything, where `set` checks both,
 * and the two exemptions are one argument made twice. §4.5 says `~/.ogun/config.json` gets
 * hand-edited and `list` prints whatever it finds there, so a `linaer` filed under a
 * `heirchive-api` this machine has never heard of is a row an operator can *see*. Refusing
 * to remove it would strand a live credential in the file that the listing keeps
 * advertising — the validator protecting the value from its owner. Validation guards
 * writes, where an unknown name or an unknown slug creates a key nothing reads; a removal
 * creates nothing.
 */
async function secretRemove(args: string[]): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { '--project': 'string' },
    'ogun secret rm <name> [--project <slug>]',
  )
  const [name] = positionals
  if (!name) fail('usage: ogun secret rm <name> [--project <slug>]')

  const config = await loadLocalConfig()
  const project = await resolveProject(flags.project, config)

  const removed = await clearProjectSecret(project.slug, name)
  /**
   * "removed" and "there was nothing here" are different answers, and the second one is
   * now the more interesting of the two.
   *
   * Printing the first for both is how you learn it worked after removing it from the
   * wrong project. That was always true; what changed is that the project is inferred from
   * the directory, so `ogun secret rm linear` run one directory too high is a plausible
   * way to get here — and "nothing changed" whispered in grey reads like success to
   * somebody who is scanning. It is yellow, it names the project it looked in, and it says
   * where that name came from, because that is the thing that was wrong.
   *
   * Still exit 0. A removal that finds nothing has reached the state that was asked for,
   * and `ogun secret rm … || true` is not a line anybody should have to write.
   */
  if (removed) {
    console.log(green(`${name} removed for ${project.slug}`))
    console.log(
      dim(`  ${project.slug} has nothing to poll ${name} with now; a poll will refuse`),
    )
    console.log(dim('  until one is set again. Nothing was sent anywhere.'))
    return
  }
  console.log(yellow(`${project.slug} had no ${name} secret on this machine — nothing changed`))
  if (project.from !== 'flag') {
    console.log(dim(`  project taken from ${project.from} — \`ogun secret list\` has the rest`))
  }
}

/**
 * A name Ogun does not read is refused at the moment it is typed.
 *
 * The alternative is a store that accepts anything, which means a typo is a secret that
 * exists, reports as set, and is read by nothing — the same silent hole `inertPolicies`
 * prints a warning for elsewhere, except here the symptom is an unauthenticated poller
 * hours later.
 *
 * **The rejected name is not echoed back**, and that changed with the shape of the
 * command. Under `set <project> <name>` there were two positionals, and quoting the bad
 * one said which of them it was. Under `set <name>` there is one, so there is nothing left
 * to disambiguate — and the plausible way to arrive here is now `ogun secret set
 * lin_api_…`, an operator who remembered that the key does not go in argv and forgot that
 * the name does. Quoting that back would put the key into stderr, on top of the shell
 * history and the `ps` window it is already in. `system.ts`'s route withholds the rejected
 * name for exactly this reason and said so first; the CLI was the surface still echoing.
 */
function requireSecretName(name: string): SecretName {
  if (isSecretName(name)) return name
  return fail(
    `that is not a secret Ogun reads. Known: ${SECRET_NAMES.join(', ')}.\n` +
      '  Nothing was stored — a secret nothing reads looks exactly like one that works.\n' +
      '  What you typed is not repeated back, because the thing most likely to be there ' +
      'by\n  mistake is the key itself. If it was: treat it as compromised, and clear ' +
      'your shell\n  history.',
  )
}

/**
 * Where the slug came from, carried beside the slug itself.
 *
 * Not a bare string, because every message this file prints about a project has to say how
 * it got the name. `"heirchive-api" is not a project this machine knows` is a different
 * sentence depending on whether the operator typed it or a directory name supplied it, and
 * only one of those two is fixed by `cd`.
 */
type ProjectSource =
  | 'flag'
  | '.ogun/config.yaml'
  | 'the registered path containing this directory'
  | 'the directory name'
type ResolvedProject = { slug: string; from: ProjectSource }

/**
 * The project this command acts on, defaulting to the one you are standing in.
 *
 * `ogun project add` and `ogun project sync` have always worked this way — the current
 * directory, then the `name:` in its `.ogun/config.yaml`, else the directory's own name —
 * and setting a secret was the one command in the namespace that made you spell the slug
 * out. These are their rungs, plus one:
 *
 *  1. `--project`, for a repo that is not checked out on this machine at all. That is the
 *     hosted control plane, and it is why the flag exists rather than being sugar.
 *  2. `.ogun/config.yaml` in the current directory. A repository naming itself is the best
 *     evidence available — better than this machine's projects map, which is a cache of
 *     that declaration made at whatever time somebody last ran `sync`.
 *  3. The registered project whose root contains the current directory. `project add` does
 *     not need this rung because it takes a `[dir]` and its entire job is to be told one;
 *     this command has no positional to spare, and without it an operator standing in
 *     `packages/cli/` of a repo this machine has known for months gets refused. Longest
 *     root wins, so a checkout vendored inside another resolves to the inner one.
 *  4. The directory's name, which is a guess and is only ever accepted because
 *     `requireKnownProject` then finds it in the map anyway.
 */
async function resolveProject(
  flag: string | undefined,
  config: LocalConfig,
): Promise<ResolvedProject> {
  if (flag !== undefined) return { slug: flag, from: 'flag' }
  const cwd = resolvePath(process.cwd())

  const configured = await loadProjectConfig(cwd)
    .then((l) => l.config.project.name)
    .catch(() => null)
  if (configured) return { slug: configured, from: '.ogun/config.yaml' }

  const registered = registeredContaining(config, cwd)
  if (registered) return { slug: registered, from: 'the registered path containing this directory' }

  return { slug: basename(cwd), from: 'the directory name' }
}

/** The registered project this directory sits inside, deepest root first. */
function registeredContaining(config: LocalConfig, cwd: string): string | undefined {
  return Object.keys(config.projects)
    .map((slug) => ({ slug, root: resolvePath(resolveProjectPath(config, slug) ?? '') }))
    // A bare `startsWith(root)` matches `/srv/repo-old` against `/srv/repo`; the separator
    // is what makes this a containment test rather than a prefix test.
    .filter(({ root }) => cwd === root || cwd.startsWith(root + sep))
    .sort((a, b) => b.root.length - a.root.length)[0]?.slug
}

/**
 * A slug this machine has never heard of is refused, and nothing is stored.
 *
 * This is the rule `SECRET_NAMES` is a closed set for, applied to the other half of a
 * key's address. `ogun project secret set heirchive-api linear` on a machine that knows
 * one project called `ogun` stored a real key, printed `linear set for heirchive-api (23
 * characters)`, and left it in `~/.ogun/config.json` where nothing would ever read it —
 * a secret that reports as set and authenticates nothing, which is precisely the failure
 * the closed set of *names* exists to prevent. The reasoning had been applied to the
 * secret's name and not to its project.
 *
 * The stated reason for not checking was that this command runs with no server and no
 * database. That is true and it does not follow: `~/.ogun/config.json` carries the
 * projects map that `project add` and `project sync` write and `resolveProjectPath` reads,
 * so the slug is checkable right here with nothing running. The database is the better
 * oracle — it is the one `system.ts`'s route uses — and it is unavailable, which is an
 * argument for using the local evidence rather than an argument for using none.
 *
 * ### Why there is an escape at all
 *
 * A hosted control plane is the legitimate case, and it is not exotic. `project sync` runs
 * where the repo is checked out; the machine that polls may never have held a copy, so its
 * projects map is legitimately empty while it polls four projects. The key still works
 * there — `readProjectSecret` looks a secret up by slug and never consults the projects
 * map — so a refusal with no way through would lock the *correct* operator out of the one
 * path that works with the database down and no browser on the box.
 *
 * So: `--allow-unregistered`, spelled out rather than `--force`, because what is being
 * overridden should be legible in the line that overrode it — and it warns on the way
 * through. Silence was the bug; a flag somebody had to type is not silence.
 *
 * A slug read out of a `.ogun/config.yaml` in the current directory is accepted with no
 * flag even when the map has never heard of it. The repository declaring its own name is
 * stronger evidence than this machine's cache of that declaration, and demanding a
 * `project add` first would make "set the key, then sync" impossible for no gain.
 */
function requireKnownProject(
  project: ResolvedProject,
  config: LocalConfig,
  allowUnregistered: boolean,
): void {
  const registered = Object.hasOwn(config.projects, project.slug)
  if (registered || project.from === '.ogun/config.yaml') return

  if (allowUnregistered) {
    console.log(
      yellow(`  "${project.slug}" is not a project this machine knows — storing anyway.`),
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
      '  Nothing was stored. A key filed under a slug nothing polls reports as set and is\n' +
      '  read by nothing — the same hole the closed set of secret names is here to close.\n' +
      (project.from === 'the directory name'
        ? '  This directory has no .ogun/config.yaml, so the name was guessed from it. Run\n' +
          '  this inside the repository instead, or pass --project <slug>.\n'
        : '') +
      '  Register it with `ogun project sync` (or `ogun project add`), or — if the repo is\n' +
      '  checked out on another machine entirely — repeat with --allow-unregistered.',
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
 * The prompt goes to stderr so that `ogun secret set …` stays composable in a pipeline
 * whose stdout is being captured.
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
