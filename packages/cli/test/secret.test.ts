import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectSecrets } from '../src/commands/doctor.ts'

/**
 * `ogun secret` — the input path, which is most of what this command is.
 *
 * Storing a string is trivial; getting it off a person's machine and into the file
 * without leaving a copy somewhere is the part with failure modes, and every one of them
 * is outside this program: `ps`, shell history, and a terminal's scrollback. The other
 * half is *where* it lands, which is the pair (project, name) — a key filed under the
 * wrong half of that pair is stored, reported as set, and read by nothing.
 *
 * Driven as a subprocess rather than by importing the command, because the three
 * properties that matter — what argv contains, what stdin does when it is a pipe, and
 * which directory the process is standing in — only exist for a real process. The CLI path
 * is derived from this file rather than from `process.cwd()` or a module-level constant,
 * because the tests gate runs inside the project container where the checkout is not where
 * it is on the host.
 */
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts')

const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

type Result = { code: number; stdout: string; stderr: string }

const ogun = (
  args: string[],
  configPath: string,
  stdin?: string,
  cwd?: string,
): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, OGUN_CONFIG: configPath }, ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) =>
        done({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    )
    // Closed rather than left open even when there is nothing to send: `secretSet` reads
    // all of stdin when stdin is not a terminal, so a pipe nobody ends is a hung test.
    child.stdin?.end(stdin ?? '')
  })

type Ctx = { after: (fn: () => unknown) => void }

const box = async (t: Ctx): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secret-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const scratch = async (t: Ctx): Promise<string> => join(await box(t), 'config.json')

/**
 * A machine that has been told where a repo is — the projects map `ogun project add` and
 * `ogun project sync` write, and the only local evidence this command has that a slug is
 * real.
 */
const machineKnowing = async (
  configPath: string,
  projects: Record<string, string>,
): Promise<void> => {
  await writeFile(configPath, JSON.stringify({ projects }), { mode: 0o600 })
}

/** A repository that names itself, which is the other kind of evidence. */
const repoCalled = async (root: string, slug: string): Promise<string> => {
  await mkdir(join(root, '.ogun'), { recursive: true })
  await writeFile(join(root, '.ogun', 'config.yaml'), `project:\n  name: ${slug}\n`)
  return root
}

const storedIn = async (configPath: string): Promise<Record<string, Record<string, string>>> =>
  JSON.parse(await readFile(configPath, 'utf8')).secrets ?? {}

// ── getting the value in without leaving a copy of it ──────────────────────

test('a piped key is stored, and the command never prints it back', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  // The trailing newline is not incidental — it is what `< key.txt` and every password
  // manager's `read` actually deliver.
  const set = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)
  assert.equal(set.code, 0, set.stderr)

  assert.match((await storedIn(config)).ogun!.linear!, /^lin_api_Z+$/)
  assert.equal(((await stat(config)).mode & 0o777).toString(8), '600')

  /**
   * The confirmation carries a length and no part of the value — not even a suffix. The
   * conventional "…ending in ZZZZ" reassurance is a disclosure into a terminal that
   * scrolls back and into whatever the operator screenshots.
   */
  assert.ok(!`${set.stdout}${set.stderr}`.includes(KEY), set.stdout)
  assert.match(set.stdout, new RegExp(`${KEY.length} characters`))
})

test('the value is refused on the command line rather than accepted', async (t) => {
  /**
   * The property: `ogun secret set linear <value>` must fail.
   *
   * The naive command takes the value as a positional, and it is the one input path that
   * leaks before the program has done anything wrong. On Linux `/proc/<pid>/cmdline` is
   * world-readable, so every account on the box can `ps` the key while the command runs;
   * and the shell writes the whole line into `~/.zsh_history`, a file nobody audits and
   * everybody backs up.
   *
   * Refused rather than ignored: silently dropping it would leave the operator believing
   * the secret was stored, having leaked it anyway.
   */
  const config = await scratch(t)
  const set = await ogun(['secret', 'set', 'linear', KEY, '--project', 'ogun'], config)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /ps/)
  assert.match(set.stderr, /history/)
  // Nothing stored — and no config.json created either, which is what "nothing was
  // stored" has to mean for a machine that had none.
  await assert.rejects(() => readFile(config, 'utf8'))
  // The refusal must not echo the argument it is refusing; it would land in the same
  // terminal the operator is about to screenshot.
  assert.ok(!set.stderr.includes(KEY))
})

test('the usage this command prints says where the value comes from', async (t) => {
  /**
   * The property: no usage line for `set` reads as complete without the key in it.
   *
   * `ogun secret set <name>` is a whole sentence and a lie — the value is the entire point
   * of the command and nothing in that line says one is needed, let alone that it arrives
   * on stdin. The failure is not theoretical in the direction people assume: a person at a
   * terminal gets an unexpected prompt, which is survivable, and a *script* gets a process
   * that blocks on an empty stdin with nothing on screen explaining why.
   *
   * Checked against `--help` and against the usage printed on a bad invocation, because
   * those are two different strings and only one of them is ever read deliberately.
   */
  const config = await scratch(t)

  const help = await ogun(['secret', '--help'], config)
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /ogun secret set <name> < key\.txt/)
  // And why it cannot be an argument, where somebody reading `--help` will see it. The
  // reasoning was already in the source and invisible from outside it.
  assert.match(help.stdout, /ps/)
  assert.match(help.stdout, /history/)

  const bare = await ogun(['secret', 'set'], config)
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /< key\.txt/)
})

test('an empty pipe is refused, not stored as a key that does not work', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })
  const set = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, '\n')
  assert.equal(set.code, 1)
  assert.match(set.stderr, /empty/)
})

// ── which name, and which project ─────────────────────────────────────────

test('a name Ogun does not read is refused before anything is written', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })
  const set = await ogun(['secret', 'set', 'linaer', '--project', 'ogun'], config, `${KEY}\n`)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /linear/)
  // A stored typo is a secret that exists, reports as set, and is read by nothing — the
  // failure only shows up hours later as an unauthenticated poller.
  assert.deepEqual(await storedIn(config), {})
})

test('a rejected name is not quoted back, because it may be the key', async (t) => {
  /**
   * The property: the refusal for an unknown secret name says what is known and does not
   * repeat what was given.
   *
   * This became load-bearing when the command lost its `<project>` positional. Under `set
   * <project> <name>` there were two words and quoting the bad one said which; under `set
   * <name>` there is one, so quoting adds nothing to disambiguate — and the plausible
   * mistake is now `ogun secret set lin_api_…`, from someone who remembered that the key
   * does not go in argv and forgot that the name does. A naive implementation interpolates
   * the argument into the error, which writes the key to stderr on top of the shell history
   * and the `ps` window it is already in. The route in `system.ts` withheld it first and
   * said why; this is the CLI catching up.
   */
  const config = await scratch(t)
  const set = await ogun(['secret', 'set', KEY, '--project', 'ogun'], config)

  assert.equal(set.code, 1)
  assert.ok(!set.stderr.includes(KEY), set.stderr)
  assert.ok(!set.stdout.includes(KEY), set.stdout)
  // It still has to be usable: the closed set is named, and so is the recovery for the
  // mistake that most likely landed here.
  assert.match(set.stderr, /Known: linear/)
  assert.match(set.stderr, /compromised/)
  await assert.rejects(() => readFile(config, 'utf8'))
})

test('a project this machine has never heard of is refused, and nothing is stored', async (t) => {
  /**
   * The property: an unknown slug fails loudly instead of being filed away.
   *
   * The bug this test exists for, verbatim: `ogun project secret set heirchive-api linear`
   * on a machine whose only project is `ogun` printed `linear set for heirchive-api (23
   * characters)` and wrote a live key into `~/.ogun/config.json` under a slug nothing would
   * ever poll. That is exactly what `SECRET_NAMES` is a closed set to prevent — "a secret
   * nothing reads looks exactly like one that works, right up until the night it mattered"
   * — applied to the name and never to the project.
   *
   * The naive defence is "the CLI has no database, so it cannot check". It does not need
   * one: `~/.ogun/config.json` carries the projects map that `project add` and `project
   * sync` write, and it is on this machine, readable with nothing running.
   *
   * The refusal has to *list* what is known, because the whole class of mistake here is a
   * name that is nearly right, and a bare "unknown project" leaves the operator guessing
   * at the spelling of the thing they just failed to spell.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(
    ['secret', 'set', 'linear', '--project', 'heirchive-api'],
    config,
    `${KEY}\n`,
  )

  assert.equal(set.code, 1)
  assert.match(set.stderr, /heirchive-api/)
  assert.match(set.stderr, /Known here: ogun/)
  assert.deepEqual(await storedIn(config), {})
  // The key was on stdin the whole time and must not have been echoed on the way out.
  assert.ok(!`${set.stdout}${set.stderr}`.includes(KEY))
})

test('an unknown project can be stored on purpose, and says so', async (t) => {
  /**
   * The property: the refusal above has a door, and using it is visible.
   *
   * A hosted control plane is the legitimate case and it is not exotic. `project sync` runs
   * where the repo is checked out; the machine that polls may never have held a copy, so
   * its projects map is empty while it polls four projects — and the key still works there,
   * because `readProjectSecret` looks a secret up by slug and never consults that map. A
   * refusal with no way through would lock the correct operator out of the only path that
   * works with the database down.
   *
   * What was wrong with the old behaviour was the silence, not the storing. So the escape
   * is a flag somebody had to type, it is named for what it permits rather than `--force`,
   * and it warns.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(
    ['secret', 'set', 'linear', '--project', 'heirchive-api', '--allow-unregistered'],
    config,
    `${KEY}\n`,
  )

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await storedIn(config))['heirchive-api']!.linear, KEY)
  assert.match(set.stdout, /not a project this machine knows/)
  assert.ok(!set.stdout.includes(KEY))
})

// ── the project you are standing in ───────────────────────────────────────

test('the project comes from the repository you are in', async (t) => {
  /**
   * The property: inside a repo, `ogun secret set linear` needs no slug — and the
   * repository's own `.ogun/config.yaml` is enough on its own.
   *
   * `ogun project add` and `ogun project sync` have always resolved a project this way and
   * this command demanded the slug be spelled out, which is what made `project` a namespace
   * with a positional in it rather than a namespace with commands in it.
   *
   * Accepted with no `--allow-unregistered` even though this machine's projects map is
   * empty, and that is the point: a repository declaring its own name is stronger evidence
   * than a machine's cache of that declaration. Demanding `project add` first would make
   * "set the key, then sync" impossible for no gain.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')

  const set = await ogun(['secret', 'set', 'linear'], config, `${KEY}\n`, repo)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await storedIn(config))['heirchive-api']!.linear, KEY)
  // Where the slug came from is printed, because an inferred project is the one thing
  // about this command that can be quietly wrong, and this is the last moment to catch it.
  assert.match(set.stdout, /\.ogun\/config\.yaml/)
})

test('a subdirectory of a registered repo still resolves to the repo', async (t) => {
  /**
   * The property: `ogun secret set linear` works from `packages/cli/`, not only from the
   * repository root.
   *
   * `project add` does not need this rung because it takes a `[dir]` and its entire job is
   * to be told one. This command has no positional to spare — the one it has is the secret
   * name — so without the projects map being consulted as a *path* map, an operator two
   * directories into a repo the machine has known for months gets `"cli" is not a project
   * this machine knows`, which is true and useless.
   *
   * Containment, not prefix: `/srv/repo-old` must not resolve as being inside `/srv/repo`.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = join(dir, 'checkout')
  const nested = join(repo, 'packages', 'cli')
  await mkdir(nested, { recursive: true })
  await mkdir(join(dir, 'checkout-old'), { recursive: true })
  await machineKnowing(config, { ogun: repo, 'ogun-old': join(dir, 'checkout-old') })

  const set = await ogun(['secret', 'set', 'linear'], config, `${KEY}\n`, nested)

  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual(Object.keys(await storedIn(config)), ['ogun'])
})

test('--project wins over the directory, for a repo that is not on this machine', async (t) => {
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'ogun')
  await machineKnowing(config, { ogun: repo, other: join(dir, 'elsewhere') })

  const set = await ogun(['secret', 'set', 'linear', '--project', 'other'], config, `${KEY}\n`, repo)

  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual(Object.keys(await storedIn(config)), ['other'])
})

test('a directory that is no repository at all does not become a project', async (t) => {
  /**
   * The property: the weakest rung — the directory's own name — is only ever accepted
   * because the projects map confirms it.
   *
   * `project add` falls back to `basename(root)` and *says* it guessed, which is fine when
   * the consequence is a path registered under a slightly wrong name. Here the consequence
   * is a live credential filed where nothing polls, so the same guess has to be refused —
   * and the refusal has to say that this directory is not a repository, because "run it
   * somewhere else" is the actual fix and no list of known slugs implies it.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const nowhere = join(dir, 'Downloads')
  await mkdir(nowhere, { recursive: true })
  await machineKnowing(config, { ogun: join(dir, 'checkout') })

  const set = await ogun(['secret', 'set', 'linear'], config, `${KEY}\n`, nowhere)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /no \.ogun\/config\.yaml/)
  assert.match(set.stderr, /--project/)
  assert.deepEqual(await storedIn(config), {})
})

// ── the rest of the surface ───────────────────────────────────────────────

test('listing prints presence and never a value', async (t) => {
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineKnowing(config, { ogun: '/does/not/matter' })
  await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)

  const listed = await ogun(['secret', 'list'], config)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /ogun/)
  assert.match(listed.stdout, /linear/)
  assert.ok(!listed.stdout.includes(KEY), listed.stdout)
})

test('listing is the machine inventory and does not narrow to the current directory', async (t) => {
  /**
   * The property: `ogun secret list` answers for the machine wherever it is run from.
   *
   * `set` and `rm` infer a project from the directory because they act on exactly one and
   * naming the wrong one is the whole failure. `list` acts on none. Giving it the same
   * default for symmetry's sake would make it print "no project secrets on this machine" —
   * from a home directory, over SSH, on a machine holding four — which is the worst answer
   * a presence check can give, and the one an operator is least equipped to disbelieve.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'ogun')
  await ogun(['secret', 'set', 'linear'], config, `${KEY}\n`, repo)

  const elsewhere = join(dir, 'Downloads')
  await mkdir(elsewhere, { recursive: true })
  const listed = await ogun(['secret', 'list'], config, '', elsewhere)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /ogun/)

  // And the filter is a flag rather than a positional, so it cannot be confused with a
  // secret name the way `rm`'s positional could.
  const filtered = await ogun(['secret', 'list', '--project', 'nobody'], config, '', elsewhere)
  assert.match(filtered.stdout, /no secrets stored for nobody/)
})

test('setting again rotates in place', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })
  await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, 'lin_api_OLDOLDOLD\n')
  await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)

  const stored = await readFile(config, 'utf8')
  assert.ok(stored.includes(KEY))
  // No history and no second slot (ADR-0012). A superseded key still in the file is a live
  // credential nobody is watching, and it goes into every backup of this machine.
  assert.ok(!stored.includes('OLDOLDOLD'))
})

test('a set that destroyed a key says so, and a set that did not says that', async (t) => {
  /**
   * The property: the success line reports **what just happened**, not what the command
   * generally does.
   *
   * The two outputs used to be byte-identical apart from a character count — `linear set
   * for ogun (24 characters)` whether it was the first key this project ever had or the
   * overwrite of a working one. The only sentence mentioning replacement was boilerplate
   * printed either way, which is another way of saying it carried no information. The
   * asymmetry was the giveaway: the Settings page turns its helper text red when a key is
   * already stored, so the surface with a confirmation step warned and the surface where a
   * piped one-liner destroys a credential in silence did not.
   *
   * Overwriting stays — ADR-0012 settled that rotation is in place with no history, because
   * two live keys means nobody can say which one a 401 came from. This is only about
   * saying so, and about saying it accurately: the naive fix reads the store, then writes,
   * and reports a fact from before the lock. `setProjectSecret` answers from inside its own
   * read-modify-write instead.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const first = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, 'lin_api_A\n')
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /stored for ogun/)
  assert.doesNotMatch(first.stdout, /previous key is gone/)

  const again = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /replaced for ogun/)
  // And what "replaced" costs, said as a fact about this run rather than as the general
  // note underneath it. There is nowhere on this machine the old value can be read back
  // from, so an operator who needs it has to go to Linear.
  assert.match(again.stdout, /previous key is gone/)
  // The displaced value is not what gets reported. Neither key appears anywhere.
  assert.ok(!`${again.stdout}${again.stderr}`.includes(KEY))
  assert.ok(!`${again.stdout}${again.stderr}`.includes('lin_api_A'))
})

test('a blank entry being filled in is neither "stored" nor a destroyed key', async (t) => {
  /**
   * The property: `empty` is kept apart from `absent` on the way in, as it already is on
   * the way out.
   *
   * Only reachable by hand-editing config.json, which §4.5 says people do, and it is the
   * state a poller reads as a key that exists and does not work. Folding it into "stored"
   * loses that this set was a repair; folding it into "replaced" says a working credential
   * was destroyed, which is the one sentence guaranteed to send somebody looking for a
   * value that never worked.
   */
  const config = await scratch(t)
  await writeFile(
    config,
    JSON.stringify({ projects: { ogun: '/does/not/matter' }, secrets: { ogun: { linear: '' } } }),
    { mode: 0o600 },
  )

  const set = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)
  assert.equal(set.code, 0, set.stderr)
  assert.match(set.stdout, /blank linear entry/)
  assert.doesNotMatch(set.stdout, /previous key is gone/)
})

test('rm checks neither the name nor the project, because a visible row must be removable', async (t) => {
  /**
   * The property: `rm` will remove what `list` shows, including rows `set` would refuse to
   * create.
   *
   * §4.5 says `~/.ogun/config.json` gets hand-edited and `listProjectSecrets` reports
   * whatever it finds, so a `linaer` under a `heirchive-api` this machine has never heard
   * of is a row an operator can see. The naive symmetry — validate the same things `set`
   * validates — strands a live credential in the file that the listing keeps advertising,
   * which is the validator protecting the value from its owner. Validation guards writes,
   * where an unknown name or slug creates a key nothing reads; a removal creates nothing.
   */
  const config = await scratch(t)
  await writeFile(
    config,
    JSON.stringify({ projects: {}, secrets: { 'heirchive-api': { linaer: KEY } } }),
    { mode: 0o600 },
  )

  const removed = await ogun(['secret', 'rm', 'linaer', '--project', 'heirchive-api'], config)
  assert.equal(removed.code, 0, removed.stderr)
  assert.deepEqual(await storedIn(config), {})

  // "removed" and "there was nothing here" are different answers, and printing the first
  // for both is how you learn it worked after removing it from the wrong project.
  const again = await ogun(['secret', 'rm', 'linaer', '--project', 'heirchive-api'], config)
  assert.match(again.stdout, /nothing changed/)
  // Still exit 0: a removal that finds nothing has reached the state it was asked for, and
  // `ogun secret rm … || true` is not a line anybody should have to write.
  assert.equal(again.code, 0)
})

test('a removal that found nothing names the project it looked in', async (t) => {
  /**
   * The property: the no-op case says which project it searched and where that name came
   * from.
   *
   * It always distinguished "removed" from "nothing here", and that was enough while the
   * project was a positional the operator had typed. Now it is inferred from the directory,
   * so `ogun secret rm linear` run one level too high is a plausible way to reach this
   * branch — and the answer has to point at the thing that was actually wrong, which is the
   * project, not the name.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')

  const removed = await ogun(['secret', 'rm', 'linear'], config, '', repo)
  assert.equal(removed.code, 0, removed.stderr)
  assert.match(removed.stdout, /heirchive-api had no linear secret/)
  assert.match(removed.stdout, /\.ogun\/config\.yaml/)
})

test('`ogun project secret` is a signpost, not a dead end', async (t) => {
  /**
   * The property: the old spelling names the new one.
   *
   * The path is dropped rather than aliased — nothing outside this repo calls it and an
   * alias is a second shape to keep working forever — but muscle memory outlives a
   * release, and `unknown: ogun project secret` followed by a page that no longer mentions
   * secrets is a worse answer than the command not existing at all.
   */
  const config = await scratch(t)
  const old = await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, `${KEY}\n`)

  assert.equal(old.code, 1)
  assert.match(old.stderr, /ogun secret/)
  await assert.rejects(() => readFile(config, 'utf8'))
})

// ── what `doctor` says about it ────────────────────────────────────────────

test('doctor names the secrets this machine holds and none of their values', async (t) => {
  const config = await scratch(t)
  await writeFile(config, JSON.stringify({ secrets: { ogun: { linear: KEY } } }))

  const check = await projectSecrets(config)
  assert.equal(check.ok, true)
  assert.match(check.detail, /ogun\/linear/)
  assert.ok(!check.detail.includes(KEY), check.detail)
  /**
   * And it says what it cannot answer. Which projects *need* a Linear key lives in each
   * repository's `.ogun/config.yaml`, which `doctor` does not read — so a machine with no
   * line here has told you nothing, and the line has to say so rather than let a green
   * check imply coverage it never had (principle 6).
   */
  assert.match(check.detail, /not checked here/)
})

test('a stored-but-blank secret degrades the check', async (t) => {
  // Reachable only by hand-editing config.json, which §4.5 says people do. A poller reads
  // it as a key that exists and does not work, and the 401 that follows looks like a
  // revoked key rather than a blank one — so `present` is not the question here either.
  const config = await scratch(t)
  await writeFile(config, JSON.stringify({ secrets: { ogun: { linear: '' } } }))

  const check = await projectSecrets(config)
  assert.equal(check.ok, false)
  assert.equal(check.fatal, false)
  assert.match(check.detail, /empty/)
})

test('a machine with no secrets is not a failing check', async (t) => {
  // A runner-only box holds none of these and is not broken: polling is not something it
  // does. Making this a warning would put a permanent yellow line on every such machine,
  // which is how people learn to stop reading the output.
  const check = await projectSecrets(await scratch(t))
  assert.equal(check.ok, true)
  assert.match(check.detail, /none stored here/)
})
