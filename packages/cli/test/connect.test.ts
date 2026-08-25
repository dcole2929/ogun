import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectSecrets } from '../src/commands/doctor.ts'

/**
 * `ogun connect | connect list | disconnect` — the one vocabulary for giving a project
 * *access* to an integration. `ogun secret` is the store beside it, in `secret.test.ts`.
 *
 * ### What is tested here, and what is not
 *
 * Not the wire. `packages/core/test/linear-oauth-client.test.ts` owns the request shapes,
 * the delimiters and the redaction, and `linear-connect.test.ts` owns what a successful
 * connection writes. What lives only in the CLI is the half that is invisible from either:
 * **which project a command decides it is acting on**, **what it does when that decision is
 * wrong**, and **how a credential is allowed to arrive**.
 *
 * Driven as a subprocess rather than by importing the commands, because the four things
 * that matter — argv, whether stdin is a pipe, the working directory, and *which requests
 * happened before the first prompt* — only exist for a real process.
 */
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts')

const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
const SECRET = 'lin_secret_QQQQQQQQQQQQQQQQQQQQQQQQ'

type Result = { code: number; stdout: string; stderr: string }
type Ctx = { after: (fn: () => unknown) => void }

/** What the stub control plane was asked for, in order. */
type Seen = string[]

/**
 * What was *sent*, keyed by route, for the tests about which credential arrived.
 *
 * `seen` answers ordering questions — "was anything registered before the refusal" — and
 * cannot answer "which client id did it register", which is the whole of the per-field
 * fallback. Bodies are parsed here rather than in each test so nothing has to remember to
 * drain the request.
 */
type Sent = Record<string, Record<string, unknown>>

const stub = async (
  t: Ctx,
  routes: Record<string, (seen: Seen) => [number, unknown]>,
): Promise<{ url: string; seen: Seen; sent: Sent }> => {
  const seen: Seen = []
  const sent: Sent = {}
  const server: Server = createServer((req, res) => {
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`
    seen.push(key)
    const handler = routes[key]
    const [status, body] = handler ? handler(seen) : [404, { error: `no stub for ${key}` }]
    res.writeHead(status, { 'content-type': 'application/json' })
    // The body is drained first: an unconsumed request body makes the client see a socket
    // hang up rather than the status this test is about.
    let raw = ''
    req.on('data', (chunk) => (raw += String(chunk)))
    req.on('end', () => {
      if (raw !== '') {
        try {
          sent[key] = JSON.parse(raw) as Record<string, unknown>
        } catch {
          // A body this suite does not send as JSON is not a body it asserts on.
        }
      }
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, seen, sent }
}

const ogun = (
  args: string[],
  env: { config: string; server?: string },
  stdin?: string,
  cwd?: string,
): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      {
        env: {
          ...process.env,
          OGUN_CONFIG: env.config,
          ...(env.server ? { OGUN_SERVER_URL: env.server } : {}),
        },
        ...(cwd ? { cwd } : {}),
      },
      (err, stdout, stderr) =>
        done({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    )
    // Closed rather than left open even when there is nothing to send: a credential is read
    // from all of stdin when stdin is not a terminal, so a pipe nobody ends is a hung test
    // rather than a failing one.
    child.stdin?.end(stdin ?? '')
  })

const box = async (t: Ctx): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-connect-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const scratch = async (t: Ctx): Promise<string> => join(await box(t), 'config.json')

/**
 * A machine that has been told where a repo is — the projects map `ogun project add` and
 * `ogun project sync` write, and the only local evidence `connect` has that a slug is real.
 */
const machineKnowing = (configPath: string, projects: Record<string, string>): Promise<void> =>
  writeFile(configPath, JSON.stringify({ projects }), { mode: 0o600 })

/** A repository that names itself, which is the other kind of evidence. */
const repoCalled = async (root: string, slug: string): Promise<string> => {
  await mkdir(join(root, '.ogun'), { recursive: true })
  await writeFile(join(root, '.ogun', 'config.yaml'), `project:\n  name: ${slug}\n`)
  return root
}

const secretsIn = async (configPath: string): Promise<Record<string, Record<string, string>>> =>
  JSON.parse(await readFile(configPath, 'utf8')).secrets ?? {}

const projectsAre =
  (...slugs: string[]) =>
  (): [number, unknown] =>
    [200, { projects: slugs.map((slug) => ({ slug, defaultBranch: 'main', remoteUrl: null })) }]

// ── how a credential is allowed to arrive ─────────────────────────────────

test('a piped key is stored, and the command never prints it back', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  // The trailing newline is not incidental — it is what `< key.txt` and every password
  // manager's `read` actually deliver.
  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(set.code, 0, set.stderr)

  assert.match((await secretsIn(config)).ogun!.linear!, /^lin_api_Z+$/)
  assert.equal(((await stat(config)).mode & 0o777).toString(8), '600')

  /**
   * The confirmation carries a length and no part of the value — not even a suffix. The
   * conventional "…ending in ZZZZ" reassurance is a disclosure into a terminal that scrolls
   * back and into whatever the operator screenshots.
   */
  assert.ok(!`${set.stdout}${set.stderr}`.includes(KEY), set.stdout)
  assert.match(set.stdout, new RegExp(`${KEY.length} characters`))
})

test('a key on the command line is stored, and warns loudly about it', async (t) => {
  /**
   * The property: `ogun connect linear --api-key <key>` **works**, and prints a prominent
   * warning naming both ways the value has already leaked.
   *
   * ### This reverses a deliberate decision, and the reversal is the point
   *
   * The previous build **refused** an inline value: nothing was stored, and the message
   * told the operator to treat what they had typed as compromised. That reasoning was
   * right about the hazard and it is unchanged — on Linux `/proc/<pid>/cmdline` is
   * world-readable, so every account on the box can read the key while the command runs,
   * and the shell writes the whole line into a history file nobody audits.
   *
   * What it did not weigh is the cost of the refusal:
   *
   *  - **A usage line that hides an input is the fault this whole command exists to fix.**
   *    Naming `<key>` in the signature is the only way a reader of `--help` learns a key is
   *    involved. Naming it and then refusing it teaches them the documentation lies.
   *  - **Refusing does not un-leak anything.** By the time the process can refuse, argv has
   *    been in `/proc` and the history file has been written. The refusal withholds the
   *    store and nothing else.
   *  - **The convention is to warn.** `docker login -p` prints *"WARNING! Using --password
   *    via the CLI is insecure"* and proceeds. An operator who has met that reads a hard
   *    refusal as a bug and works around it, usually worse.
   *
   * Everything else about containment is asserted here unchanged: the value is sealed and
   * stored, and **it is never echoed back**, not in the warning and not in the confirmation.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(['connect', 'linear', '--api-key', KEY, '--project', 'ogun'], { config })

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!.linear, KEY)

  // Loud, and on stderr so it survives `ogun connect … > log`.
  assert.match(set.stderr, /WARNING!/)
  assert.match(set.stderr, /proc/)
  assert.match(set.stderr, /history/)
  // The advice the refusal used to carry has to survive into the warning: the value is
  // already out, and the only remaining action is to rotate it.
  assert.match(set.stderr, /compromised/)
  // And the warning must not quote the thing it is warning about.
  assert.ok(!set.stderr.includes(KEY), set.stderr)
  assert.ok(!set.stdout.includes(KEY), set.stdout)
})

test('the usage lines name every input, including the ones that are not arguments', async (t) => {
  /**
   * The property: **no usage line for `connect` reads as complete without its credentials
   * in it**, and the line says where each one comes from when it is left out.
   *
   * This has been raised four times about this CLI and it is the acceptance bar. `ogun
   * linear app [--project <slug>]` was a whole sentence and a lie: the two values it
   * existed to collect appeared nowhere, so the only way to learn that it prompts was to
   * run it — and a *script* that ran it got a process blocking on an empty stdin with
   * nothing on screen explaining why.
   *
   * The credentials are **named flags** here, where the previous build had them as
   * positionals. That version did put them in the usage line and still got it wrong: a
   * client id and a client secret are two opaque strings from the same page of Linear's
   * settings, and a fixed order between two values of the same shape is a coin flip at the
   * keyboard. So the assertion is on the flag names, not merely on the presence of two
   * angle-bracketed words.
   *
   * Checked against `--help` and against the usage printed on a bad invocation, because
   * those are two different strings and only one of them is ever read deliberately.
   */
  const config = await scratch(t)

  const help = await ogun(['connect', '--help'], { config })
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /ogun connect <integration> --client-id <id> --client-secret <secret>/)
  assert.match(help.stdout, /ogun connect <integration> --consent --client-id <id>/)
  assert.match(help.stdout, /ogun connect <integration> --api-key \[<key>\]/)
  assert.match(help.stdout, /ogun connect list/)
  // And where each value comes from when it is omitted, which is the recommended path.
  assert.match(help.stdout, /prompt/)
  assert.match(help.stdout, /stdin/)
  // And why passing one inline is worse, where somebody reading `--help` will see it.
  assert.match(help.stdout, /proc/)
  assert.match(help.stdout, /history/)
  // The kind flag, and the fact that consent is not a third kind but a grant inside one.
  assert.match(help.stdout, /--oauth/)
  assert.match(help.stdout, /which OAuth grant/)

  const bare = await ogun(['connect'], { config })
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /--client-id <id> --client-secret <secret>/)
  assert.match(bare.stderr, /--api-key \[<key>\]/)
})

test('the credentials are flags, and a leftover positional is refused unspoken', async (t) => {
  /**
   * The property: `ogun connect linear <secret>` fails, names the flags, and **does not
   * echo what it was given**.
   *
   * The positional shape existed for one commit, so the plausible second positional here
   * is a client secret. Quoting it back would write a live credential to stderr on top of
   * the shell history and the `ps` window it is already in — the same rule that stops the
   * integration name being echoed one function over, arriving through the other argument.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(['connect', 'linear', SECRET, '--project', 'ogun'], { config })

  assert.equal(set.code, 1)
  assert.ok(!`${set.stdout}${set.stderr}`.includes(SECRET), set.stderr)
  assert.match(set.stderr, /--client-secret <secret>/)
  assert.match(set.stderr, /compromised/)
  assert.deepEqual(await secretsIn(config), {})
})

test('--app-token is dropped, and says which flag replaced it', async (t) => {
  /**
   * The property: a flag that existed for one commit answers with its replacement rather
   * than with "Unknown option".
   *
   * `--app-token` named the token that came back; `--oauth` names what is being connected,
   * which is the distinction the whole reshape turns on. Muscle memory outlives a commit
   * even when nothing outside this repository ever ran it, and a parser error naming an
   * option is a dead end where one sentence is not.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(['connect', 'linear', '--app-token', '--project', 'ogun'], { config })

  assert.equal(set.code, 1)
  assert.match(set.stderr, /--oauth/)
  assert.ok(!/Unknown option/.test(set.stderr), set.stderr)
  assert.deepEqual(await secretsIn(config), {})
})

test('an empty pipe is refused, not stored as a credential that does not work', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })
  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'ogun'],
    { config },
    '\n',
  )
  assert.equal(set.code, 1)
  assert.match(set.stderr, /empty/)
})

// ── which integration, and which project ──────────────────────────────────

test('an integration Ogun does not read is refused before anything is written', async (t) => {
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })
  const set = await ogun(
    ['connect', 'linaer', '--api-key', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )

  assert.equal(set.code, 1)
  assert.match(set.stderr, /Known: linear/)
  // A stored typo is a credential that exists, reports as connected, and is read by
  // nothing — the failure only shows up hours later as an unauthenticated poller.
  assert.deepEqual(await secretsIn(config), {})
})

test('a rejected integration is not quoted back, because it may be the credential', async (t) => {
  /**
   * The property: the refusal says what is known and does not repeat what was given.
   *
   * The plausible way to arrive here is `ogun connect lin_api_…` — somebody who reached for
   * the credential where the integration goes. A naive implementation interpolates the
   * argument into the error, which writes the key to stderr on top of the shell history and
   * the `ps` window it is already in. The route in `system.ts` withheld a rejected secret
   * name first and said why; this is the same rule on the surface a person actually types
   * at.
   */
  const config = await scratch(t)
  const set = await ogun(['connect', KEY, '--project', 'ogun'], { config })

  assert.equal(set.code, 1)
  assert.ok(!set.stderr.includes(KEY), set.stderr)
  assert.ok(!set.stdout.includes(KEY), set.stdout)
  assert.match(set.stderr, /Known: linear/)
  assert.match(set.stderr, /compromised/)
  await assert.rejects(() => readFile(config, 'utf8'))
})

test('two kinds at once are refused, and consent is not a third kind', async (t) => {
  /**
   * The property: `--oauth --api-key` fails naming both kinds, and `--api-key --consent`
   * fails with a *different* sentence, because it is a different mistake.
   *
   * Not a preference to be resolved by precedence. Somebody who typed both believes one of
   * those words means something other than what it does, and silently honouring the winner
   * would store a credential of a kind they did not ask for — with a different attribution
   * in Linear — and tell them it worked.
   *
   * The second half is the one this shape exists for. `--consent` is a **modifier inside
   * the OAuth kind**: it selects the authorization-code grant, implies `--oauth`, and has
   * no meaning beside an api key, which has nobody to approve it. The previous build made
   * all three peers, which put a fork in the road where there is none — and then had to
   * reject `--oauth` on the grounds that two of its three flags were OAuth.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const kinds = await ogun(
    ['connect', 'linear', '--api-key', '--oauth', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(kinds.code, 1)
  assert.match(kinds.stderr, /--oauth and --api-key are different kinds/)

  const grant = await ogun(
    ['connect', 'linear', '--api-key', '--consent', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(grant.code, 1)
  assert.match(grant.stderr, /--consent is an OAuth grant, not a kind/)

  // And an application's credentials handed to the kind that has no application.
  const mixed = await ogun(
    ['connect', 'linear', '--api-key', '--client-id', 'abc123', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(mixed.code, 1)
  assert.match(mixed.stderr, /--api-key takes one key and no application/)

  assert.deepEqual(await secretsIn(config), {})
})

test('--consent needs no --oauth beside it, and both together is not an error', async (t) => {
  /**
   * The property: `--consent` alone reaches the consent flow, and `--oauth --consent` does
   * the same thing rather than being refused as two kinds.
   *
   * That is what makes `--consent` a modifier rather than a peer. `--oauth --consent` was
   * the clunky spelling the brief asked to be improved on; the improvement is that the
   * implication runs one way, so the redundant form is accepted and nobody has to type it.
   *
   * Both invocations are checked by where they *stop* — the control plane is asked which
   * projects it knows, which only the consent path does.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineKnowing(config, { 'heirchive-api': '/does/not/matter' })
  const server = await stub(t, { 'GET /api/projects': projectsAre('ogun') })

  for (const argv of [
    ['connect', 'linear', '--consent', '--project', 'heirchive-api'],
    ['connect', 'linear', '--oauth', '--consent', '--project', 'heirchive-api'],
  ]) {
    const set = await ogun(argv, { config, server: server.url }, '')
    assert.equal(set.code, 1, argv.join(' '))
    assert.match(set.stderr, /not a project this control plane knows/, argv.join(' '))
  }
})

test('a project this machine has never heard of is refused, and nothing is stored', async (t) => {
  /**
   * The property: an unknown slug fails loudly instead of being filed away.
   *
   * The bug this test exists for, verbatim: `ogun project secret set heirchive-api linear`
   * on a machine whose only project is `ogun` printed a success line and wrote a live key
   * into `~/.ogun/config.json` under a slug nothing would ever poll. That is what
   * `SECRET_NAMES` is a closed set to prevent — "a secret nothing reads looks exactly like
   * one that works, right up until the night it mattered" — reasoned about the name and
   * never about the project.
   *
   * The naive defence is "the CLI has no database, so it cannot check". It does not need
   * one: `~/.ogun/config.json` carries the projects map, on this machine, readable with
   * nothing running. **And it is now the only oracle `connect` uses**, because with one
   * command covering three mechanisms, checking the database on some of them and this map
   * on others would be an asymmetry an operator has no way to predict.
   *
   * The refusal has to *list* what is known, because the whole class of mistake here is a
   * name that is nearly right.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'heirchive-api'],
    { config },
    `${KEY}\n`,
  )

  assert.equal(set.code, 1)
  assert.match(set.stderr, /heirchive-api/)
  assert.match(set.stderr, /Known here: ogun/)
  assert.deepEqual(await secretsIn(config), {})
  assert.ok(!`${set.stdout}${set.stderr}`.includes(KEY))
})

test('an unknown project can be connected on purpose, and says so', async (t) => {
  /**
   * The property: the refusal above has a door, and using it is visible.
   *
   * A hosted control plane is the legitimate case and is not exotic. `project sync` runs
   * where the repo is checked out; the machine that polls may never have held a copy, so
   * its projects map is empty while it polls four projects — and the credential still works
   * there, because `readProjectSecret` looks one up by slug and never consults that map. A
   * refusal with no way through would lock the correct operator out of the only path that
   * works with the database down.
   *
   * What was wrong with the old behaviour was the silence, not the storing. So the escape
   * is a flag somebody had to type, named for what it permits rather than `--force`, and it
   * warns.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'heirchive-api', '--allow-unregistered'],
    { config },
    `${KEY}\n`,
  )

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config))['heirchive-api']!.linear, KEY)
  assert.match(set.stdout, /not a project this machine knows/)
  assert.ok(!set.stdout.includes(KEY))
})

test('the project comes from the repository you are in', async (t) => {
  /**
   * The property: inside a repo, `ogun connect linear --api-key` needs no slug — and the
   * repository's own `.ogun/config.yaml` is enough on its own.
   *
   * Accepted with no `--allow-unregistered` even though this machine's projects map is
   * empty, and that is the point: a repository declaring its own name is stronger evidence
   * than a machine's cache of that declaration. Demanding `project add` first would make
   * "connect it, then sync" impossible for no gain.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')

  const set = await ogun(['connect', 'linear', '--api-key'], { config }, `${KEY}\n`, repo)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config))['heirchive-api']!.linear, KEY)
  // Where the slug came from is printed, because an inferred project is the one thing about
  // this command that can be quietly wrong, and this is the last moment to catch it.
  assert.match(set.stdout, /\.ogun\/config\.yaml/)
})

test('a subdirectory of a registered repo still resolves to the repo', async (t) => {
  /**
   * The property: `ogun connect linear` works from `packages/cli/`, not only from the
   * repository root.
   *
   * Without the projects map being consulted as a *path* map, an operator two directories
   * into a repo the machine has known for months gets `"cli" is not a project this machine
   * knows`, which is true and useless.
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

  const set = await ogun(['connect', 'linear', '--api-key'], { config }, `${KEY}\n`, nested)

  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual(Object.keys(await secretsIn(config)), ['ogun'])
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

  const set = await ogun(['connect', 'linear', '--api-key'], { config }, `${KEY}\n`, nowhere)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /no \.ogun\/config\.yaml/)
  assert.match(set.stderr, /--project/)
  assert.deepEqual(await secretsIn(config), {})
})

test('--project wins over the directory, for a repo that is not on this machine', async (t) => {
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'ogun')
  await machineKnowing(config, { ogun: repo, other: join(dir, 'elsewhere') })

  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'other'],
    { config },
    `${KEY}\n`,
    repo,
  )

  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual(Object.keys(await secretsIn(config)), ['other'])
})

// ── the mechanisms cannot silently replace each other ─────────────────────

test('a personal key is refused behind a working grant rather than stored under it', async (t) => {
  /**
   * The property: `--api-key` on a project that is already connected as an application
   * fails, and names the command that makes room.
   *
   * `readProjectSecret` prefers a grant over a key, so storing one here writes a live
   * credential into the file that nothing will read — the exact failure the closed set of
   * secret names exists to prevent, arriving through the other half of a credential's
   * address. And the operator's next move when a poll fails is to rotate the key they just
   * set, which changes nothing, twice.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      oauth: {
        ogun: {
          linear: {
            clientId: 'client-1',
            clientSecret: SECRET,
            redirectUri: '',
            grant: {
              accessToken: 'access-abcdefghijkl',
              grantType: 'client_credentials',
              expiresAt: Date.now() + 2_591_999_000,
              scopes: ['read'],
              actor: 'app',
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  const set = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )

  assert.equal(set.code, 1)
  assert.match(set.stderr, /already connected/)
  assert.match(set.stderr, /ogun disconnect linear/)
  assert.deepEqual(await secretsIn(config), {})
})

test('the default grant refuses to silently replace a consent connection', async (t) => {
  /**
   * The property: `ogun connect linear` on a project connected through the consent flow
   * fails, and offers both ways forward.
   *
   * It looks like a reconnect and it is a **reduction in reach**: an authorization-code
   * grant sees whatever the approver could see, private teams included, and a
   * client-credentials token sees public teams only. Performing it silently leaves a poll
   * that authenticates perfectly and returns nothing — no error anywhere, just a source
   * that stops finding tickets, on a workspace where somebody once had to fetch an admin to
   * get this working.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      oauth: {
        ogun: {
          linear: {
            clientId: 'client-1',
            clientSecret: SECRET,
            redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
            grant: {
              accessToken: 'access-abcdefghijkl',
              refreshToken: 'refresh-abcdefghijkl',
              grantType: 'authorization_code',
              expiresAt: Date.now() + 86_399_000,
              scopes: ['read'],
              actor: 'app',
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  const set = await ogun(['connect', 'linear', '--project', 'ogun'], { config })

  assert.equal(set.code, 1)
  assert.match(set.stderr, /public teams only/)
  assert.match(set.stderr, /--consent/)
  assert.match(set.stderr, /ogun disconnect linear/)
})

// ── the consent flow's own refusals ───────────────────────────────────────

test('--consent refuses an unknown slug before it asks for anything', async (t) => {
  /**
   * The property: the control plane is asked which projects it knows **before** the first
   * prompt, and the refusal lists the slugs that would have worked.
   *
   * A command that collects a Client Secret and then says the project was misspelled has
   * already had a credential typed into a terminal that scrolls back, for nothing — and has
   * taught the operator that a rejected connect is harmless.
   *
   * The stub records every request, so the assertion is about *ordering*: nothing was
   * registered, because the refusal came first.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineKnowing(config, { 'heirchive-api': '/does/not/matter' })
  const server = await stub(t, { 'GET /api/projects': projectsAre('ogun', 'other') })

  const set = await ogun(
    ['connect', 'linear', '--consent', '--project', 'heirchive-api'],
    { config, server: server.url },
    '',
  )

  assert.equal(set.code, 1)
  assert.match(set.stderr, /not a project this control plane knows/)
  assert.match(set.stderr, /Known: ogun, other/)
  assert.deepEqual(server.seen, ['GET /api/projects'])
})

test('a rotated client secret keeps the registered client id, and a new one does not', async (t) => {
  /**
   * The property: `--client-secret <new>` on an application already registered here sends
   * the **stored** client id back with it, and `--client-id <other>` never inherits the
   * stored secret.
   *
   * Two positionals could not express a rotation at all — you had to re-paste both, and a
   * value re-pasted is a value re-typed, which is how a trailing space gets into a
   * credential. Named flags make "the secret changed and nothing else did" sayable, so
   * each half falls back to the store on its own.
   *
   * The asymmetry is the load-bearing part. A stored client secret belongs to a stored
   * client id: pairing it with an id the operator just typed would authenticate an
   * application it was never issued for, and Linear's answer to that names the *client*
   * rather than the mismatch. So a new id asks for its own secret — which, with stdin a
   * pipe, is the value on stdin.
   *
   * Driven through `--consent`, because that is the one shape where the registration
   * crosses a wire this test can watch. The default grant posts straight to Linear.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      oauth: {
        ogun: {
          linear: {
            clientId: 'client-1',
            clientSecret: 'lin_secret_ORIGINALORIGINALORIG',
            redirectUri: 'http://127.0.0.1:1/api/oauth/linear/callback',
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  const routes = {
    'GET /api/projects': projectsAre('ogun'),
    'GET /api/oauth/linear': (): [number, unknown] => [
      200,
      { redirectUri: 'http://127.0.0.1:1/api/oauth/linear/callback' },
    ],
    'PUT /api/oauth/linear/app/ogun': (): [number, unknown] => [200, { ok: true }],
    'POST /api/oauth/linear/start/ogun': (): [number, unknown] => [
      200,
      {
        authorizeUrl: 'https://linear.app/oauth/authorize?x=1',
        redirectUri: 'http://127.0.0.1:1/api/oauth/linear/callback',
        scopes: ['read'],
        actor: 'app',
      },
    ],
  }

  const rotated = await stub(t, routes)
  const one = await ogun(
    ['connect', 'linear', '--consent', '--client-secret', SECRET, '--project', 'ogun'],
    { config, server: rotated.url },
    '',
  )
  assert.equal(one.code, 0, one.stderr)
  assert.deepEqual(rotated.sent['PUT /api/oauth/linear/app/ogun'], {
    clientId: 'client-1',
    clientSecret: SECRET,
  })

  const replaced = await stub(t, routes)
  const two = await ogun(
    ['connect', 'linear', '--consent', '--client-id', 'client-2', '--project', 'ogun'],
    { config, server: replaced.url },
    // stdin is a pipe, so the secret this application needs is read from it rather than
    // taken from the one belonging to client-1.
    `${KEY}\n`,
  )
  assert.equal(two.code, 0, two.stderr)
  assert.deepEqual(replaced.sent['PUT /api/oauth/linear/app/ogun'], {
    clientId: 'client-2',
    clientSecret: KEY,
  })
  assert.ok(!`${two.stdout}${two.stderr}`.includes('ORIGINAL'), two.stdout)
})

// ── the listing ───────────────────────────────────────────────────────────

test('connect list is the machine inventory and does not narrow to the directory', async (t) => {
  /**
   * The property: `ogun connect list` answers for the machine wherever it is run from, and
   * shows keys and grants in one table.
   *
   * `connect` and `disconnect` infer a project from the directory because they act on
   * exactly one and naming the wrong one is their whole failure mode. This acts on none.
   * Giving it the same default for symmetry's sake would make it print "nothing is
   * connected on this machine" — from a home directory, over SSH, on a machine holding
   * four — which is the worst answer a presence check can give.
   *
   * One table rather than two is the other half. `ogun linear status` showed grants and
   * `ogun secret list` showed keys, and neither could see the other, so the answer to "is
   * this connected" depended on which command you happened to run.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'ogun')
  await ogun(['connect', 'linear', '--api-key'], { config }, `${KEY}\n`, repo)

  const elsewhere = join(dir, 'Downloads')
  await mkdir(elsewhere, { recursive: true })
  const listed = await ogun(['connect', 'list'], { config }, '', elsewhere)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /ogun/)
  assert.match(listed.stdout, /api key/)
  assert.ok(!listed.stdout.includes(KEY), listed.stdout)

  // And the filter is a flag rather than a positional, so it cannot be confused with an
  // integration name.
  const filtered = await ogun(['connect', 'list', '--project', 'nobody'], { config }, '', elsewhere)
  assert.match(filtered.stdout, /nobody is not connected/)
})

test('connect list omits secrets that are not integrations, and says how many', async (t) => {
  /**
   * The property: a webhook signing key does not appear as a *connection*, and the listing
   * says out loud that it left something out.
   *
   * `ogun secret set` stores free-form names now, and "what can this project reach" is not
   * a question a shared HMAC answers — listing one under INTEGRATION would be inventing a
   * connection that does not exist. The counted footer is the other half and is the part
   * that keeps the two commands honest: a listing that silently drops rows is how `connect
   * list` and `secret list` start disagreeing about what is stored.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      secrets: { ogun: { linear: KEY, 'stripe-webhook': 'whsec_QQQQQQQQQQQQ' } },
    }),
    { mode: 0o600 },
  )

  const listed = await ogun(['connect', 'list'], { config })
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /linear/)
  assert.ok(!listed.stdout.includes('stripe-webhook'), listed.stdout)
  assert.match(listed.stdout, /1 other stored secret is not an integration/)
  assert.match(listed.stdout, /ogun secret list/)
})

test('a key sitting behind a grant is reported as not being used', async (t) => {
  /**
   * The property: the listing says, in as many words, that a stored key is **not** the
   * credential a poll would use — and `ogun secret list` says it about the same row.
   *
   * This is the line that earns the command. A grant wins over a key, so an operator
   * debugging a poll failure by rotating that key is changing something nothing reads —
   * and nothing else in the system is in a position to tell them. Two listings that
   * disagreed about it would be worse than one, which is why both read the same function.
   *
   * The state should not arise from the ordinary path any more, since connecting removes
   * the key; it survives a hand-edited config.json and an entry written by an older build,
   * which §4.5 says is a real thing rather than a hypothetical.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      secrets: { ogun: { linear: KEY } },
      oauth: {
        ogun: {
          linear: {
            clientId: 'client-1',
            clientSecret: SECRET,
            redirectUri: '',
            grant: {
              accessToken: 'access-abcdefghijkl',
              grantType: 'client_credentials',
              expiresAt: Date.now() + 2_591_999_000,
              scopes: ['read'],
              actor: 'app',
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  const listed = await ogun(['connect', 'list'], { config })
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /NOT used/)
  // And which grant, because the two differ in what they can see.
  assert.match(listed.stdout, /app token/)
  assert.ok(!listed.stdout.includes(KEY), listed.stdout)

  const secrets = await ogun(['secret', 'list'], { config })
  assert.equal(secrets.code, 0, secrets.stderr)
  assert.match(secrets.stdout, /the linear grant wins/)
  assert.ok(!secrets.stdout.includes(KEY), secrets.stdout)
})

// ── disconnecting ─────────────────────────────────────────────────────────

test('disconnect removes every credential, and keeping the application is refused', async (t) => {
  /**
   * The property: a disconnect from a client-credentials connection takes the **client id
   * and secret** with it, and `--keep-application` is refused rather than honoured.
   *
   * ADR-0014's disconnect kept them by default, and was right to while the only grant had a
   * browser in it: a client secret alone authenticated nothing without a consent screen and
   * a workspace admin, so keeping it saved a reconnect that a non-admin could not perform.
   *
   * Under the default grant the pair *is* the credential. Anyone holding it can mint a live
   * token and the next poll would, so a disconnect that left them behind is one the machine
   * undoes by itself. ADR-0012 wrote this rule for keys already — "one that is still
   * accepted is a live credential nobody is watching" — and this is that rule reaching a
   * value that only just became one.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const entry = {
    projects: { ogun: '/does/not/matter' },
    secrets: { ogun: { linear: KEY } },
    oauth: {
      ogun: {
        linear: {
          clientId: 'client-1',
          clientSecret: SECRET,
          redirectUri: '',
          grant: {
            accessToken: 'access-abcdefghijkl',
            grantType: 'client_credentials',
            expiresAt: Date.now() + 2_591_999_000,
            scopes: ['read'],
            actor: 'app',
          },
        },
      },
    },
  }
  await writeFile(config, JSON.stringify(entry), { mode: 0o600 })

  const kept = await ogun(
    ['disconnect', 'linear', '--project', 'ogun', '--keep-application'],
    { config },
  )
  assert.equal(kept.code, 1)
  assert.match(kept.stderr, /not a disconnection/)
  // Refused means nothing moved.
  assert.equal((await secretsIn(config)).ogun!.linear, KEY)

  const gone = await ogun(['disconnect', 'linear', '--project', 'ogun'], { config })
  assert.equal(gone.code, 0, gone.stderr)
  const after = JSON.parse(await readFile(config, 'utf8'))
  assert.deepEqual(after.oauth ?? {}, {})
  assert.deepEqual(after.secrets?.ogun ?? {}, {})
  // The personal key going too is its own line: a disconnect that removed a grant and left
  // a key behind would leave the project still connected, by the credential the operator
  // was least likely to be thinking about.
  assert.match(gone.stdout, /personal api key was removed/)
  assert.ok(!`${gone.stdout}${gone.stderr}`.includes(SECRET))
})

test('disconnect checks nothing, and a no-op says which project it looked in', async (t) => {
  /**
   * The property: `disconnect` will remove what `connections` shows, including rows
   * `connect` would refuse to create — and when there is nothing to remove it says so, in
   * a colour, naming the project and where that name came from.
   *
   * §4.5 says `~/.ogun/config.json` gets hand-edited and the listing reports whatever it
   * finds, so a credential under a slug this machine has never heard of is a row an
   * operator can see. The naive symmetry — validate what `connect` validates — strands a
   * live credential in the file that the listing keeps advertising: the validator
   * protecting the value from its owner.
   *
   * The no-op case matters more than it used to because the project is inferred from the
   * directory, so a `disconnect` run one level too high is a plausible way to reach it —
   * and "nothing changed" whispered in grey reads like success to somebody scanning.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({ projects: {}, secrets: { 'heirchive-api': { linear: KEY } } }),
    { mode: 0o600 },
  )

  const removed = await ogun(['disconnect', 'linear', '--project', 'heirchive-api'], { config })
  assert.equal(removed.code, 0, removed.stderr)
  assert.deepEqual(await secretsIn(config), {})

  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')
  const again = await ogun(['disconnect', 'linear'], { config }, '', repo)
  assert.match(again.stdout, /had no linear credential/)
  assert.match(again.stdout, /\.ogun\/config\.yaml/)
  // Still exit 0: a removal that finds nothing has reached the state it was asked for, and
  // `ogun disconnect linear || true` is not a line anybody should have to write.
  assert.equal(again.code, 0)
})

// ── the spellings that are gone ───────────────────────────────────────────

test('the dropped spellings are signposts, not dead ends', async (t) => {
  /**
   * The property: `ogun linear`, `ogun project linear`, `ogun project secret` and `ogun
   * connections` each answer with a line naming what replaced them, and store nothing.
   *
   * They are dropped rather than aliased: an alias is a second shape that has to keep
   * working forever. But muscle memory outlives a release, and "unknown command" followed
   * by a listing that no longer mentions the word is a worse answer than the command not
   * existing at all.
   *
   * `ogun secret` is deliberately **not** in this list any more. It was here for one
   * commit, on the reasoning that every name in `SECRET_NAMES` was an integration
   * credential — which described the validator rather than the world. A secret is not
   * guaranteed to be an integration, so the namespace came back; `secret.test.ts` owns it.
   */
  const config = await scratch(t)

  for (const [argv, expected] of [
    [['linear', 'app'], /ogun connect/],
    [['project', 'linear', 'connect'], /ogun connect/],
    [['project', 'secret', 'set', 'ogun', 'linear'], /ogun secret set/],
    [['connections'], /ogun connect list/],
    [['connection', '--project', 'ogun'], /ogun connect list/],
  ] as Array<[string[], RegExp]>) {
    const old = await ogun(argv, { config }, `${KEY}\n`)
    assert.equal(old.code, 1, `${argv.join(' ')} should have failed`)
    assert.match(old.stderr, expected, argv.join(' '))
    assert.ok(!old.stderr.includes(KEY), argv.join(' '))
  }
  await assert.rejects(() => readFile(config, 'utf8'))
})

test('the dropped spellings still answer --help, with the page that replaced them', async (t) => {
  /**
   * The property: `ogun connections --help` prints the `connect list` page rather than "no
   * help for: connections".
   *
   * The refusal above covers somebody who ran the old command. It does not cover somebody
   * who read an older README and reached for `--help` first, whose reward would otherwise
   * be a sentence that reads as "that does not exist" rather than "that moved".
   */
  const config = await scratch(t)
  for (const [word, expected] of [
    ['connections', /ogun connect list/],
    ['connection', /ogun connect list/],
    ['linear', /ogun connect <integration>/],
  ] as Array<[string, RegExp]>) {
    const help = await ogun([word, '--help'], { config })
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, expected, word)
  }
})

// ── what `doctor` says about it ───────────────────────────────────────────

test('doctor names the credentials this machine holds and none of their values', async (t) => {
  const config = await scratch(t)
  await writeFile(config, JSON.stringify({ secrets: { ogun: { linear: KEY } } }))

  const check = await projectSecrets(config)
  assert.equal(check.ok, true)
  assert.match(check.detail, /ogun\/linear/)
  assert.ok(!check.detail.includes(KEY), check.detail)
})
