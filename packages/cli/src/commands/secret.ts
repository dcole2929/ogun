import {
  clearProjectSecret,
  isSecretName,
  listOAuthApps,
  listProjectSecrets,
  loadLocalConfig,
  localConfigPath,
  readOAuthApp,
  SECRET_NAMES,
  setProjectSecret,
  type DisplacedSecret,
} from '@ogun/core'
import { parse } from '../args.ts'
import { bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import {
  projectFlag,
  requireKnownProject,
  resolveProject,
  type ResolvedProject,
} from '../project-slug.ts'
import { confirm, promptHidden, readSecretValue } from '../prompt.ts'

/**
 * `ogun secret set | list | rm` — a value a project needs, kept on the machine that polls.
 *
 * ### Why this exists again after being deleted
 *
 * It was removed one commit ago and folded into `ogun connect`, on this reasoning:
 *
 * > *"Every name in `SECRET_NAMES` today is an integration credential, so the `secret`
 * > namespace was holding exactly one kind of thing and calling it something else. If a
 * > secret ever appears that is not a connection — a webhook signing key, say — `ogun
 * > secret` comes back for it."*
 *
 * The observation was true and the inference from it was not. **A secret is not guaranteed
 * to be an integration**, and building the general store only once a non-integration
 * secret exists gets the order backwards: the reason there is nothing but integrations in
 * `SECRET_NAMES` is that the closed set refuses everything else, so "no counter-example
 * exists" was a fact about the validator rather than about the world. A per-project value
 * that is not a connection — an HMAC a webhook is verified with, a token a skill is handed
 * — has nowhere else to live, and its absence today is not evidence it will not arrive.
 *
 * So both exist, and they are not two spellings of one act:
 *
 *  - **`ogun connect <integration>`** is *access*: which product, and how Ogun gets in. It
 *    knows about grants, it knows a client id from a client secret, and it validates the
 *    integration against `SECRET_NAMES` because a name Ogun polls under, misspelled, is a
 *    credential nothing reads.
 *  - **`ogun secret set <name> <key>`** is *storage*: one value under one name, free-form,
 *    for anything at all.
 *
 * ### They overlap on exactly one slot, and it is the same slot
 *
 * `ogun connect linear --api-key` and `ogun secret set linear <key>` both write
 * `secrets.<project>.linear` in `~/.ogun/config.json`, through `setProjectSecret`, under
 * `updateLocalConfig`'s lock. **One store, one row, one answer** — two maps that could each
 * hold a `linear` key is the "two stores that can disagree" shape ADR-0012 rejected when it
 * refused a second secrets file, and it would be worse here because the disagreement would
 * be between two commands the same operator runs.
 *
 * What that costs is that `secret set linear` inherits `connect`'s rules about that slot,
 * and it does inherit them rather than reimplementing them: `refuseShadowedKey`,
 * `settleReplacement` and `writeProjectKey` below are called by both, so a key cannot be
 * stored behind a working grant through one door and refused through the other, and one
 * door cannot overwrite a value in silence that the other asks about. The two listings
 * then answer consistently by construction: `connect list` shows what a project can
 * *reach* — grants, plus keys whose name is an integration — and `secret list` shows what
 * is *stored* under a name, integration or not, marking any row a grant has taken over
 * with the same red "NOT used" the other one prints.
 *
 * Neither command reaches a server. The store is this machine's `config.json` (ADR-0012),
 * which is what lets both work before `ogun init`, with the database down, and over SSH.
 */

const USAGE_SET = 'ogun secret set <name> <key> [--replace] [--project <slug>]'
const USAGE_LIST = 'ogun secret list [--project <slug>]'
const USAGE_RM = 'ogun secret rm <name> [--project <slug>]'

// ── setting ────────────────────────────────────────────────────────────────

export async function secretSet(args: string[]): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { '--project': 'string', '--allow-unregistered': 'boolean', '--replace': 'boolean' },
    USAGE_SET,
  )
  const name = requireSecretName(positionals[0])
  const inline = positionals[1]
  if (positionals[2] !== undefined) {
    // Not echoed: the third positional on this command is most plausibly the second half
    // of a key somebody pasted without quoting it.
    fail(
      `usage: ${USAGE_SET}\n` +
        '  A secret is one value. If what you passed was one key with a space in it, quote\n' +
        '  it — or leave it off entirely and let it be prompted for, which is better anyway.',
    )
  }

  const config = await loadLocalConfig()
  const project = await resolveProject(flags.project, config)
  /**
   * Checked before the prompt, for the reason `connect` checks before its own: a command
   * that collects a credential and then says the project was misspelled has had a value
   * typed into a terminal that scrolls back, for nothing.
   */
  requireKnownProject(project, config, flags['allow-unregistered'] === true)
  await refuseShadowedKey(project, name)
  await settleReplacement(project, name, {
    replace: flags.replace === true,
    what: 'secret',
    usage: USAGE_SET,
  })

  const value = await readSecretValue(inline, 'a secret', () =>
    promptHidden(`  ${name} for ${project.slug} (not echoed): `),
  )
  const displaced = await setProjectSecret(project.slug, name, value)

  await writeProjectKey(project, name, value.length, displaced, {
    stored: `  ${name} stored for ${project.slug}`,
    replaced: `  ${name} replaced for ${project.slug}`,
  })

  /**
   * What replaces the closed set: say so, now, when nothing reads it.
   *
   * `SECRET_NAMES` used to refuse this outright, and the sentence it was refusing for is
   * still true — *"a secret nothing reads looks exactly like one that works, right up
   * until the night it mattered"*. A free-form store cannot refuse, so it moves the fact
   * from a refusal to a statement at the one moment somebody is looking: `linaer`, typed
   * at 1am, prints this line instead of silence.
   *
   * The known names are listed rather than a spelling distance being computed, and while
   * there is one integration that *is* the whole of a "did you mean". If the set ever grows
   * past what fits on a line, a nearest-match is worth the twelve lines; it is not worth
   * them for a list of one.
   *
   * ### It echoes the name, and now that is the only thing standing where the shape was
   *
   * This used to be justified by the shape rule — the branch was only reachable for a name
   * `NAME_SHAPE` had passed, which a pasted API key could not be. That rule is gone, so a
   * key pasted into the name slot reaches this line and is printed. Echoing it is still
   * right, and the reason is that **a name is not a secret**: it is a key in a 0600 JSON
   * file, a row in `ogun secret list`, and the word you type at `ogun secret rm`. It is
   * already visible everywhere a name is visible. Withholding it *here* would remove the
   * one sentence that makes the accident noticeable — `Nothing in this build reads a
   * secret named lin_api_9f3…` is exactly what somebody who put the key in the wrong
   * position needs to read — while changing nothing about where the string ended up.
   *
   * A refusal is the other way round, and `requireSecretName` still withholds: a refusal
   * has stored nothing, so the string is not yet a name and quoting it back would be the
   * only place it appears.
   */
  if (!isSecretName(name)) {
    console.log(
      yellow(`  Nothing in this build reads a secret named ${name}.`) +
        dim(
          `\n  Ogun polls under: ${SECRET_NAMES.join(', ')} — \`ogun connect <integration>\`` +
            ' configures those.\n  It is stored either way. This line exists so that ' +
            '"nothing reads it" is something\n  you are told now, rather than something ' +
            'you infer from an unauthenticated poll.',
        ),
    )
  }
}

/**
 * A secret name is whatever the project calls it, and only what cannot work is refused.
 *
 * ### The format rule is gone, and it was refusing the normal case
 *
 * For two days a name had to match `[a-z0-9][a-z0-9.-]{0,63}`. That was aimed at one
 * accident — `ogun secret set lin_api_9f3…`, from somebody who remembered that the key
 * does not belong in argv and forgot that the *name* does — and the shape was chosen
 * because a Linear key is long, mixed case and full of underscores where a kebab name is
 * none of those. Kebab and not snake was the deliberate part of it.
 *
 * It cost more than it bought, on two counts, and the second one is fatal:
 *
 *  - **It refused the conventional spelling of a secret name.** `DATABASE_URL`,
 *    `STRIPE_SECRET_KEY`, `my_api_key` — every `.env` file, `flyctl`, Heroku, Kubernetes.
 *    A store whose whole purpose is arbitrary per-project values refused the names those
 *    values actually have, and it did so to prevent something rarer than what it broke.
 *  - **The accident it guarded against is not an error.** `ogun secret set lin_api_nVD6…`
 *    is a legal invocation: the name is `lin_api_nVD6…`, and the command then prompts for
 *    the value. Odd, and not a thing to refuse. There is no rule that admits
 *    `AWS_SECRET_ACCESS_KEY` and refuses `lin_api_nVD6…` — they are the same shape, which
 *    is what killed the snake-case half of the rule and, followed through, kills all of
 *    it. What is left of the protection is the line `secretSet` prints afterwards, which
 *    names the mistake without refusing anything.
 *
 * `flyctl`, which the product owner named as the model, validates **nothing** client-side:
 * *"Names are case sensitive and stored as-is, so ensure names are appropriate for the
 * application and vm environment."* It states the consequence and stores what you typed.
 *
 * ### What survives, and why each one is structural rather than tidy
 *
 * Every rule below names something that *breaks* — a value that cannot be addressed, a
 * value that vanishes, or output that lies. None of them is about what a name should look
 * like.
 *
 *  - **Empty.** There is no name to store it under; `secrets.<project>` would grow a `""`
 *    key that `secret list` renders as a blank cell.
 *  - **Whitespace anywhere.** The name has to survive a round trip through a shell —
 *    `ogun secret rm <name>` is the only way to undo a set, and it takes exactly one
 *    positional, so a name with a space in it is refused by the command that removes it.
 *    It also has to survive `secret list`, whose columns are separated by spaces.
 *  - **Control characters.** Names are printed back to a terminal. A carriage return, or
 *    an ESC starting a CSI sequence, rewrites the line it is printed on — so a name could
 *    forge the confirmation line that follows it, or erase it. A control character
 *    arriving here is also the signature of a value pasted with its newline attached,
 *    which is the accident `normalizeSecretInput` refuses on the value side for its own
 *    reasons.
 *  - **`__proto__`.** It does not survive the file. `localConfigSchema` parses `secrets`
 *    through `z.record`, which does not carry that key onto the parsed object, so the
 *    value would be written to `config.json` now and silently dropped by the next command
 *    that writes it — a secret that works today and is gone on Tuesday, with nothing
 *    anywhere connecting the two. `constructor` and `toString` are fine and are stored:
 *    the hazard there was `entries[name]` walking the prototype chain, which is fixed in
 *    `setProjectSecret` and `clearProjectSecret` where it belongs.
 *
 * Considered and rejected: a **length cap**. Every number was arbitrary — 64 refused
 * nothing a person types and admitted every API key anyway — and nothing downstream has a
 * limit, since a JSON key and an argv word both hold far more than a terminal will ever
 * show. Considered and rejected: **sniffing for a pasted credential** and warning. Any
 * test that catches `lin_api_9f3…` catches `AWS_SECRET_ACCESS_KEY`, which is the whole
 * reason the format rule died; a warning that fires on the normal case is one people learn
 * to scroll past.
 *
 * ### The refusal still does not repeat what was typed
 *
 * ADR-0012's rule outlives the shape rule that shared its paragraph. A key really can end
 * up in this position — the invocation above is legal, so a *mistyped* one is reachable —
 * and quoting the argument back would write a live credential to stderr on top of the
 * shell history and the `ps` window it is already in. The message names the rule that was
 * broken and never the string that broke it, exactly as `normalizeSecretInput` does.
 */
function requireSecretName(name: string | undefined): string {
  if (name === undefined) fail(`usage: ${USAGE_SET}`)
  const broken = whyNotAName(name)
  if (broken === undefined) return name
  return fail(
    `${broken} Nothing was stored.\n` +
      `    ${USAGE_SET}\n` +
      '  What you typed is not repeated back, because a key can end up in that position.\n' +
      '  If one did: treat it as compromised, and clear your shell history.',
  )
}

/** Written as escapes rather than literal bytes: a source file holding a real NUL is one
 *  that editors, diffs and terminals each mangle differently. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const WHITESPACE = /\s/

/**
 * Whitespace is tested before the control characters it overlaps with, so that a tab or a
 * newline is reported as the thing a person can picture rather than as a byte range.
 */
function whyNotAName(name: string): string | undefined {
  if (name === '') return 'a secret name cannot be empty.'
  if (WHITESPACE.test(name)) {
    return (
      'a secret name cannot contain whitespace.\n' +
      '  `ogun secret rm` takes exactly one word, so a name with a space in it could be\n' +
      '  stored and never removed, and `ogun secret list` separates its columns with\n' +
      '  spaces. A newline or a tab in an argument is usually a value that arrived with\n' +
      '  its line ending still attached. Dashes and underscores are both fine —\n' +
      '  `stripe-webhook`, `DATABASE_URL`.'
    )
  }
  if (CONTROL.test(name)) {
    return (
      'a secret name cannot contain a control character.\n' +
      '  Names are printed back to this terminal, where an escape sequence rewrites or\n' +
      '  erases the line it lands on — including the confirmation printed after it.'
    )
  }
  if (name === '__proto__') {
    return (
      'a secret cannot be named `__proto__`.\n' +
      '  It is the one name that does not survive this file: the config is read back\n' +
      '  through a schema that drops that key, so the value would be stored now and gone\n' +
      '  the next time any command writes config.json.'
    )
  }
  return undefined
}

// ── listing ────────────────────────────────────────────────────────────────

/**
 * `ogun secret list` — every value stored under a name on this machine, and what reads it.
 *
 * It lists the whole machine unless `--project` narrows it, for the reason `connect list`
 * does: `set` and `rm` act on exactly one project so naming the wrong one is their whole
 * failure mode, while a listing that narrowed to wherever the shell was standing would
 * report "nothing stored" on a machine holding four projects' credentials.
 *
 * The READ BY column is the one that earns the command. A stored value that nothing reads
 * is the failure the closed set of names used to prevent by refusing; with free-form names
 * the listing is where it has to be visible instead.
 */
export async function secretList(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--project': 'string' }, USAGE_LIST)
  const only = flags.project

  const stored = (await listProjectSecrets()).filter((s) => (only ? s.project === only : true))
  const shadowed = await shadowedKeys()

  if (stored.length === 0) {
    console.log(
      dim(
        only
          ? `${only} has no secrets stored on this machine`
          : 'no secrets are stored on this machine',
      ),
    )
    console.log(dim(`  ${USAGE_SET}`))
    return
  }

  console.log(
    table([
      [bold('PROJECT'), bold('NAME'), bold('STATE'), bold('READ BY')],
      ...stored.map((s) => [
        cyan(s.project),
        s.name,
        s.state === 'empty' ? yellow('empty') : green('set'),
        readBy(s.project, s.name, shadowed),
      ]),
    ]),
  )
  console.log(dim(`\nvalues are never printed. ${localConfigPath()}, mode 0600`))
  console.log(dim('grants are not secrets and are not listed here — `ogun connect list`'))
}

const readBy = (project: string, name: string, shadowed: Set<string>): string => {
  if (shadowed.has(`${project}/${name}`)) {
    // The same sentence `ogun connect list` prints for the same row, deliberately: two
    // commands that disagreed about whether a stored key is live would cost an evening.
    return red(`nothing — the ${name} grant wins`)
  }
  if (isSecretName(name)) return green(`the ${name} poll`)
  return yellow('nothing in this build')
}

/**
 * Which stored keys a live OAuth grant has taken over, as `project/name`.
 *
 * Shared by both listings so they cannot drift. `readProjectSecret` decides precedence —
 * a grant wins over a key — and this is that same fact asked of the whole store at once,
 * from the same functions, without ever holding a value.
 */
export async function shadowedKeys(): Promise<Set<string>> {
  const apps = await listOAuthApps().catch(() => [])
  return new Set(apps.filter((a) => a.connected).map((a) => `${a.project}/${a.provider}`))
}

// ── removing ───────────────────────────────────────────────────────────────

/**
 * `ogun secret rm <name>` — forget one value.
 *
 * **Nothing here is checked** — not the name, not the project — and that is the same
 * exemption `ogun disconnect` has. §4.5 says `~/.ogun/config.json` gets hand-edited and
 * `list` prints whatever it finds, so a row an operator can see has to be a row they can
 * remove; refusing would strand a live credential in the file with the listing still
 * advertising it. Validation guards writes, where an unknown name creates a credential
 * nothing reads. A removal creates nothing.
 */
export async function secretRm(args: string[]): Promise<void> {
  const { flags, positionals } = parse(args, { '--project': 'string' }, USAGE_RM)
  const name = positionals[0]
  if (name === undefined) fail(`usage: ${USAGE_RM}`)
  if (positionals[1] !== undefined) fail(`usage: ${USAGE_RM}`)

  const project = await resolveProject(flags.project, await loadLocalConfig())
  const existed = await clearProjectSecret(project.slug, name)

  if (!existed) {
    /**
     * "removed" and "there was nothing here" are different answers, and the second is the
     * more interesting one: the project is inferred from the directory, so an `rm` run one
     * level too high is a plausible way to reach it, and "nothing changed" whispered in
     * grey reads like success to somebody who is scanning.
     */
    console.log(yellow(`${project.slug} has no ${name} secret on this machine — nothing changed`))
    if (project.from !== 'flag') {
      console.log(dim(`  project taken from ${project.from} — \`ogun secret list\` has the rest`))
    }
    // Still exit 0: a removal that finds nothing has reached the state it was asked for.
    return
  }

  console.log(green(`${name} removed for ${project.slug}`))
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}`))
  console.log(dim('  there is no history — the value cannot be recovered from this machine'))

  /**
   * A grant is not a secret and this command cannot touch one, so a project that is still
   * connected has to be told it is still connected. Otherwise `secret rm linear` reads as
   * "Ogun can no longer reach Linear", which is false, and the operator finds out when a
   * poll they meant to stop keeps working.
   */
  if (isSecretName(name)) {
    const app = await readOAuthApp(project.slug, name)
    if (app.state === 'present' && app.app.grant) {
      console.log(
        yellow(`  ${project.slug} is still connected to ${name} as an application.`) +
          dim(
            `\n  That grant is what a poll was using anyway. \`ogun disconnect ${name}` +
              `${projectFlag(project)}\`\n  removes it.`,
          ),
      )
    }
  }
}

// ── what both doors do to the same slot ────────────────────────────────────

/**
 * A key is refused behind a working grant rather than stored under it.
 *
 * `readProjectSecret` prefers a grant over a key (ADR-0014), so storing one here would put
 * a live credential in the file that nothing reads — the precise failure a closed set of
 * names exists to prevent, arriving through the other half of a credential's address. And
 * the operator's next move when a poll fails is to rotate the key they just set, which
 * changes nothing, twice.
 *
 * Called by `ogun connect --api-key` **and** by `ogun secret set`, because they write the
 * same slot. A rule enforced at one of two doors is not a rule.
 */
export async function refuseShadowedKey(
  project: ResolvedProject,
  name: string,
): Promise<void> {
  if (!isSecretName(name)) return
  const existing = await readOAuthApp(project.slug, name)
  if (existing.state !== 'present' || !existing.app.grant) return
  fail(
    `"${project.slug}" is already connected to ${name} as an application, and a\n` +
      '  personal key would sit behind that grant being read by nothing. Nothing was ' +
      'stored.\n' +
      `  \`ogun disconnect ${name}${projectFlag(project)}\` first if you mean to swap.`,
  )
}

/**
 * A name that is already taken is settled **before** the value is collected: asked about
 * at a terminal, refused without `--replace` anywhere else.
 *
 * ### One rule, two places, and what each of them is for
 *
 * Overwriting is unrecoverable. ADR-0012 chose that deliberately — a rotation window
 * belongs to whoever issued the value, and two live values in one store means a 401 cannot
 * be attributed — so there is no history and no second slot, and the previous value is
 * simply gone. The question this function answers is who is allowed to do that silently,
 * and the answer is nobody:
 *
 *  - **At a terminal there is somebody to ask**, so it asks, and it asks before the key is
 *    prompted for. Declining costs nothing and leaves the working value in place.
 *  - **Off a terminal there is nobody to ask**, so it refuses and names the flag. A script
 *    that destroys a credential it did not know was there fails loudly instead, and the
 *    author adds `--replace` when they mean it — which is a sentence about intent that
 *    reads correctly in a diff a year later.
 *
 * The two behaviours are one rule seen from two rooms, which is why they are in one
 * function called by both `ogun secret set` and `ogun connect <integration> --api-key`.
 * Two doors onto one row that disagreed about overwriting would be worse than either rule
 * alone.
 *
 * ### This reverses ADR-0012, which considered a gate and rejected it
 *
 * > *"Considered and rejected: a `[y/N]` gate on a replace. It needs a `--yes` for the
 * > non-interactive path; every script would set that flag once and never remove it; the
 * > gate would then guard nobody while costing everybody a keystroke — on the operation
 * > this record settled as the intended one."*
 *
 * That was right about the world it was written in and the world changed underneath it.
 * When it was written, `secret set` took a name from a **closed set of one**, on a project
 * that had to already exist — so every replace *was* the intended operation, a rotation of
 * a credential the operator was holding a new copy of. A name collision was not
 * expressible. It is now: names are free-form, and free-form names collide. `token`,
 * `api-key` and `DATABASE_URL` are names two different values both plausibly want, and the
 * store answers to whichever was written last with no way to notice.
 *
 * The rest of the objection survives and is answered rather than dismissed. `--replace` in
 * a rotation script does become permanent furniture — but it is furniture that says what
 * the script does, where `--yes` would only say that somebody was tired of being asked.
 * And the gate is not on the happy path: it fires only when there is a value to destroy.
 *
 * `flyctl` is the same shape read twice. `fly secrets set` silently replaces, with no
 * confirmation and no `--force`, and there is an open pull request against it from an
 * operator who overwrote production's secrets because they forgot `--app` — which is
 * exactly this command's `--project` inference. Meanwhile `fly secrets keys set`, for the
 * values Fly treats as unrecoverable, refuses with *"refusing to overwrite existing key"*
 * unless `--force` is given. The tool models both answers and disagrees with itself; the
 * half it applies to values that cannot be got back again is the half taken here.
 *
 * ### What it does not do
 *
 * It does not fire on an `empty` entry. A blank is only reachable by hand-editing the
 * file, `writeProjectKey` calls filling one in a repair rather than a replace, and there
 * is no value there to protect.
 *
 * It is **advisory with respect to the lock**: this is a second read of the store, and
 * what it saw could change before `setProjectSecret` takes `updateLocalConfig`'s lock. It
 * is not trying to be a mutex — it is trying to stop a person, and a person is not racing
 * themselves. The `stored`/`replaced` line printed afterwards is the authoritative one and
 * is decided inside the lock.
 */
export async function settleReplacement(
  project: ResolvedProject,
  name: string,
  { replace, what, usage }: { replace: boolean; what: string; usage: string },
): Promise<void> {
  // Said on the command line: there is nothing to ask about, at a terminal or anywhere
  // else. `--replace` with nothing there is a no-op rather than an error, for the reason
  // `rm -f` is: a script that has to know the answer in advance is a script with a race
  // in it, and the confirmation still says `stored` rather than `replaced`.
  if (replace) return

  const stored = await listProjectSecrets().catch(() => [])
  const held = stored.some(
    (e) => e.project === project.slug && e.name === name && e.state === 'present',
  )
  if (!held) return

  const gone =
    '  There is no history and no second slot: the value there now cannot be\n' +
    '  recovered from this machine once it is gone.'

  if (!process.stdin.isTTY) {
    fail(
      `${project.slug} already has a ${name} ${what} on this machine, and stdin is not a\n` +
        '  terminal, so there is nobody to ask. Nothing was stored.\n' +
        `${gone}\n` +
        '  Say it on the command line if that is what you mean:\n' +
        `    ${usage}`,
    )
  }

  console.log(yellow(`  ${project.slug} already has a ${name} ${what} on this machine.`))
  console.log(dim(gone))
  if (!(await confirm(dim('  Replace it? [y/N] ')))) {
    // Exit 1: nothing was stored, and a caller who asked for a set and did not get one
    // should hear about it in `$?` as well as on the screen.
    fail(`nothing was stored — ${project.slug} keeps the ${name} ${what} it already had.`)
  }
}

/**
 * What a completed write says, for both doors.
 *
 * The confirmation carries the length and nothing else about the value. Not even the last
 * four characters: a suffix is the standard reassurance and it is a disclosure, and these
 * commands are run over SSH into a terminal that scrolls back. The length catches the two
 * mistakes a set can make — a truncated paste, and a value that picked up something it
 * should not have — and narrows a random key by nothing.
 *
 * `displaced` comes back from inside `updateLocalConfig`'s lock, in the same
 * read-modify-write that performed the change. A caller that checked and then wrote would
 * report something that was true a moment ago, and would be wrong in exactly the case the
 * lock exists for.
 */
export async function writeProjectKey(
  project: ResolvedProject,
  name: string,
  length: number,
  displaced: DisplacedSecret,
  voice: { stored: string; replaced: string },
): Promise<void> {
  console.log(
    green(`\n${displaced === 'absent' ? voice.stored : voice.replaced}`) +
      dim(` (${length} characters)`),
  )
  if (project.from !== 'flag') console.log(dim(`  project taken from ${project.from}`))
  if (displaced === 'present') {
    console.log(dim('  The previous value is gone: there is no history and no second slot.'))
    console.log(dim('  If the new one is wrong, mint another — the old value cannot be'))
    console.log(dim('  recovered from this machine.'))
  } else if (displaced === 'empty') {
    // Only reachable by hand-editing config.json, and worth naming: a blank entry is what
    // a reader treats as a value that exists and does not work, so this is a repair.
    console.log(dim(`  ${project.slug} had a blank ${name} entry here, which a reader`))
    console.log(dim('  treats as a value that exists and does not work. It is filled in now.'))
  }
  console.log(dim(`  stored in ${localConfigPath()}, mode 0600, on this machine only`))
}
