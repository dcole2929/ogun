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
import { promptHidden, readSecretValue } from '../prompt.ts'

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
 * and it does inherit them rather than reimplementing them: `refuseShadowedKey` and
 * `writeProjectKey` below are called by both, so a key cannot be stored behind a working
 * grant through one door and refused through the other. The two listings then answer
 * consistently by construction: `connect list` shows what a project can *reach* — grants,
 * plus keys whose name is an integration — and `secret list` shows what is *stored* under
 * a name, integration or not, marking any row a grant has taken over with the same red
 * "NOT used" the other one prints.
 *
 * Neither command reaches a server. The store is this machine's `config.json` (ADR-0012),
 * which is what lets both work before `ogun init`, with the database down, and over SSH.
 */

const USAGE_SET = 'ogun secret set <name> <key> [--project <slug>]'
const USAGE_LIST = 'ogun secret list [--project <slug>]'
const USAGE_RM = 'ogun secret rm <name> [--project <slug>]'

/**
 * What a name may look like: lowercase, starting with a letter or digit, then letters,
 * digits, dots and dashes, up to 64 characters.
 *
 * This is one of the two things that replace the protection the closed set used to give
 * `secret set`, and it is aimed at one specific accident. `ogun secret set <name> <key>`
 * prompts for the key when it is left off, so `ogun secret set lin_api_9f3…` — somebody
 * who remembered that the key does not go in argv and forgot that the *name* does — is a
 * command this can never distinguish from a deliberate one by counting arguments. It can
 * refuse it by shape: an API key is long, or mixed case, or has underscores, and Linear's
 * has all three. A name does not.
 *
 * Kebab and not snake for exactly that reason. `stripe_webhook` is a name somebody would
 * plausibly want and `lin_api_…` is a key somebody would plausibly paste, and there is no
 * rule that admits the first and refuses the second. Refusing both costs a dash.
 */
const NAME_SHAPE = /^[a-z0-9][a-z0-9.-]{0,63}$/

// ── setting ────────────────────────────────────────────────────────────────

export async function secretSet(args: string[]): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { '--project': 'string', '--allow-unregistered': 'boolean' },
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
  await warnAboutReplacing(project, name, inline)

  const value = await readSecretValue(inline, 'a secret', () =>
    promptHidden(`  ${name} for ${project.slug} (not echoed): `),
  )
  const displaced = await setProjectSecret(project.slug, name, value)

  await writeProjectKey(project, name, value.length, displaced, {
    stored: `  ${name} stored for ${project.slug}`,
    replaced: `  ${name} replaced for ${project.slug}`,
  })

  /**
   * The second thing that replaces the closed set: say so, now, when nothing reads it.
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
   * The name is echoed here where the shape refusal above withholds it, and the split is
   * the point: this branch is only reachable for a name that passed `NAME_SHAPE`, which a
   * pasted API key cannot. A refusal, by definition, has not proved that yet.
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
 * A name is refused before anything else, and is **not** repeated back.
 *
 * ADR-0012 settled this for the single-positional shape and the reasoning survives the
 * second positional: the plausible way to arrive here is somebody who put the key where
 * the name goes, and quoting the argument would write a live credential to stderr on top
 * of the shell history and the `ps` window it is already in.
 */
function requireSecretName(name: string | undefined): string {
  if (name === undefined) fail(`usage: ${USAGE_SET}`)
  if (NAME_SHAPE.test(name)) return name
  return fail(
    'that is not a secret name. Names are lowercase letters, digits, dots and dashes, up\n' +
      '  to 64 characters — `linear`, `stripe-webhook`. Nothing was stored.\n' +
      `    ${USAGE_SET}\n` +
      '  What you typed is not repeated back, because the thing most likely to be in that\n' +
      '  position by mistake is the key itself. If it was: treat it as compromised, and\n' +
      '  clear your shell history.',
  )
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
 * At a terminal, say there is already one there *before* asking for the new one.
 *
 * Advisory rather than authoritative — it is a second read of the store and the fact it
 * reports could change before the write takes the lock. That is fine for what it is for: a
 * person one keystroke from pasting a key over a working one who does not know it. The
 * line printed *afterwards* is the one taken under the lock.
 *
 * Only at a TTY, and only when the value was not already on the command line. A pipe is a
 * rotation somebody wrote down on purpose, and a warning it cannot act on is noise in a
 * script's output.
 */
export async function warnAboutReplacing(
  project: ResolvedProject,
  name: string,
  inline: string | undefined,
): Promise<void> {
  if (!process.stdin.isTTY || inline !== undefined) return
  const stored = await listProjectSecrets().catch(() => [])
  if (!stored.some((e) => e.project === project.slug && e.name === name)) return
  console.log(yellow(`  ${project.slug} already has a ${name} secret on this machine.`))
  console.log(dim('  Storing replaces it, and there is no history. Ctrl-C to stop.'))
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
