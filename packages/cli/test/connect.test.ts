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
   * in it**, and the page says where each one comes from when it is left out.
   *
   * This has been raised four times about this CLI and it is the acceptance bar. `ogun
   * linear app [--project <slug>]` was a whole sentence and a lie: the two values it
   * existed to collect appeared nowhere, so the only way to learn that it prompts was to
   * run it — and a *script* that ran it got a process blocking on an empty stdin with
   * nothing on screen explaining why.
   *
   * The credentials have had three shapes and this is the third. Positionals put them in
   * the line and still got it wrong, because two opaque strings from one page in a fixed
   * order is a coin flip. Named flags fixed that and broke on the second provider: a
   * GitHub App has an app id, an installation id and a private key, and declaring
   * `--app-id` on a command where it is valid for one value of `<integration>` is a flag
   * table that grows a column per provider. So the line carries `field=value`, and **the
   * valid keys are asserted on the page** — because that is where the discoverability a
   * declared flag would have given now has to come from.
   *
   * Checked against `--help` and against the usage printed on a bad invocation, because
   * those are two different strings and only one of them is ever read deliberately.
   */
  const config = await scratch(t)

  const help = await ogun(['connect', '--help'], { config })
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /ogun connect <integration> --app \[--as <name>\]/)
  assert.match(help.stdout, /ogun connect <integration> --app --link <name>/)
  assert.match(help.stdout, /ogun connect <integration> --consent \[field=value …\]/)
  assert.match(help.stdout, /ogun connect <integration> --api-key \[<key>\]/)
  assert.match(help.stdout, /ogun connect list/)
  // The fields themselves, per provider, because no flag names them any more.
  assert.match(help.stdout, /linear\s+clientId, clientSecret/)
  assert.match(help.stdout, /github\s+appId, installationId, privateKey/)
  // And where each value comes from when it is omitted, which is the recommended path.
  assert.match(help.stdout, /prompt/)
  assert.match(help.stdout, /pipe/)
  // And why passing one inline is worse, where somebody reading `--help` will see it.
  assert.match(help.stdout, /proc/)
  assert.match(help.stdout, /history/)
  // The kind flag, and the fact that consent is not a third kind but a grant inside one.
  assert.match(help.stdout, /--app\b/)
  assert.match(help.stdout, /which grant/)
  // The PEM rule, stated rather than left to be discovered.
  assert.match(help.stdout, /a PEM always has/)

  const bare = await ogun(['connect'], { config })
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /--app \[--as <name>\]/)
  assert.match(bare.stderr, /--api-key \[<key>\]/)
  assert.match(bare.stderr, /field=value/)
})

test('a field is key=value, and an unknown or bare one is refused unspoken', async (t) => {
  /**
   * The property: `ogun connect linear <secret>` fails, says what the shape is, lists the
   * keys that would have worked, and **does not echo what it was given**.
   *
   * Both halves are the point. The listing is where the discoverability of a declared flag
   * went: somebody who typed `client-id=abc` is told the spelling that works at the moment
   * they are looking, which is better than a help page. And the silence is the rule that
   * stops the integration name being echoed one function over, arriving through the other
   * argument — the plausible thing in this position is a client secret, and quoting it
   * would write a live credential to stderr on top of the shell history and the `ps` window
   * it is already in.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const bare = await ogun(['connect', 'linear', SECRET, '--project', 'ogun'], { config })
  assert.equal(bare.code, 1)
  assert.ok(!`${bare.stdout}${bare.stderr}`.includes(SECRET), bare.stderr)
  assert.match(bare.stderr, /`key=value`/)
  assert.match(bare.stderr, /clientId, clientSecret/)
  assert.match(bare.stderr, /compromised/)

  // A key the provider does not have, with the value still unquoted.
  const wrong = await ogun(
    ['connect', 'linear', `client-id=${SECRET}`, '--project', 'ogun'],
    { config },
  )
  assert.equal(wrong.code, 1)
  assert.ok(!`${wrong.stdout}${wrong.stderr}`.includes(SECRET), wrong.stderr)
  assert.match(wrong.stderr, /"client-id" is not a field a linear application has/)
  assert.match(wrong.stderr, /Valid: clientId, clientSecret/)

  // And a github key offered to linear is just as wrong, which is the whole reason the
  // schema is per provider rather than a union of every provider's fields.
  const foreign = await ogun(['connect', 'linear', 'appId=123', '--project', 'ogun'], { config })
  assert.equal(foreign.code, 1)
  assert.match(foreign.stderr, /"appId" is not a field a linear application has/)

  assert.deepEqual(await secretsIn(config), {})
})

test('the removed flags are removed, not deprecated, and the usage carries the answer', async (t) => {
  /**
   * The property: `--oauth`, `--client-id`, `--client-secret` and `--app-token` are gone
   * from the flag table entirely, and the parser's refusal carries a usage line with
   * `field=value` in it.
   *
   * This reverses a decision rather than extending one. `--app-token` had a **deprecation
   * stub** — a declared flag whose only job was to fail with a sentence naming its
   * replacement — on the reasoning that *"muscle memory outlives a commit even when
   * nothing outside this repository ever ran it, and a parser error naming an option is a
   * dead end where one sentence is not"*. The product owner chose plain removal, and the
   * argument holds against the stub rather than against that reasoning: a stub is a
   * permanent row in the flag table, it appears in the parser's own errors, and it has to
   * be maintained past the point where anybody remembers what it was for. `--client-id`
   * could not have had a useful one anyway — the value it carried now arrives as
   * `clientId=…` *and* is validated against a provider schema, so there is nothing a stub
   * could do with the string it was handed.
   *
   * What makes the removal cheap is asserted here: `args.ts` refuses an unknown flag rather
   * than ignoring it, and prints this command's usage beside the refusal — so the reader of
   * a failed `--client-id abc123` is one line away from `clientId=abc123`.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  for (const flag of [
    ['--oauth'],
    ['--app-token'],
    ['--client-id', 'abc123'],
    ['--client-secret', SECRET],
  ]) {
    const set = await ogun(['connect', 'linear', ...flag, '--project', 'ogun'], { config })
    assert.equal(set.code, 1, flag.join(' '))
    assert.match(set.stderr, /Unknown option/, flag.join(' '))
    assert.match(set.stderr, /field=value/, flag.join(' '))
    assert.ok(!set.stderr.includes(SECRET), 'the parser error quoted the secret')
  }
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
   * The property: `--app --api-key` fails naming both kinds, and `--api-key --consent`
   * fails with a *different* sentence, because it is a different mistake.
   *
   * Not a preference to be resolved by precedence. Somebody who typed both believes one of
   * those words means something other than what it does, and silently honouring the winner
   * would store a credential of a kind they did not ask for — with a different attribution
   * in the provider — and tell them it worked.
   *
   * The second half is the one this shape exists for. `--consent` is a **modifier inside
   * the application kind**: it selects the authorization-code grant, implies `--app`, and
   * has no meaning beside an api key, which has nobody to approve it. The previous build
   * made all three peers, which put a fork in the road where there is none.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const kinds = await ogun(
    ['connect', 'linear', '--api-key', '--app', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(kinds.code, 1)
  assert.match(kinds.stderr, /--app and --api-key are different kinds/)

  const grant = await ogun(
    ['connect', 'linear', '--api-key', '--consent', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(grant.code, 1)
  assert.match(grant.stderr, /--consent is a grant an application obtains, not a kind/)

  /**
   * And an application's *name* handed to the kind that has no application. `--as` and
   * `--link` are both about the shared `applications` map; an api key is filed under one
   * project, has no name and cannot be shared, so neither flag has anything to refer to.
   * This replaces the old `--api-key --client-id` case, which stopped existing when the
   * credentials became `field=value` — and the fields are refused by `parseFields`, which
   * says more because it knows the schema.
   */
  const named = await ogun(
    ['connect', 'linear', '--api-key', '--as', 'linear:acme', '--project', 'ogun'],
    { config },
    `${KEY}\n`,
  )
  assert.equal(named.code, 1)
  assert.match(named.stderr, /--as and --link are about a stored application/)

  assert.deepEqual(await secretsIn(config), {})
})

test('--consent needs no --app beside it, and both together is not an error', async (t) => {
  /**
   * The property: `--consent` alone reaches the consent flow, and `--app --consent` does
   * the same thing rather than being refused as two kinds.
   *
   * That is what makes `--consent` a modifier rather than a peer: the implication runs one
   * way, so the redundant form is accepted and nobody has to type it.
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
    ['connect', 'linear', '--app', '--consent', '--project', 'heirchive-api'],
  ]) {
    const set = await ogun(argv, { config, server: server.url }, '')
    assert.equal(set.code, 1, argv.join(' '))
    assert.match(set.stderr, /not a project this control plane knows/, argv.join(' '))
  }
})

test('--consent is refused for github, where nobody approves anything', async (t) => {
  /**
   * The property: a grant a provider does not offer is refused by name, before anything is
   * collected or any server is asked.
   *
   * `--consent` is a browser round trip in which a person approves an application. A
   * GitHub App authenticating as itself signs a JWT with its private key and exchanges it
   * for an installation token — there is nobody to ask, and the approval that *did* happen
   * was whoever installed the App, in GitHub's UI, before Ogun was involved. Accepting the
   * flag and quietly doing the ordinary thing would be the worse answer: an operator who
   * typed it believes they are getting something they are not.
   */
  const config = await scratch(t)
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const set = await ogun(['connect', 'github', '--consent', '--project', 'ogun'], { config })
  assert.equal(set.code, 1)
  assert.match(set.stderr, /signs a JWT/)
  assert.match(set.stderr, /Nothing was stored/)
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
      /**
       * Written in the **old** `oauth[project][provider]` shape on purpose, so this covers
       * the migration as well as the refusal. A legacy entry has no `method` field — it did
       * not exist — and defaulting it to `client_credentials` would have let a consent
       * connection be silently reconnected as an ordinary one: the refusal below defeated
       * by the migration underneath it. `migrateLegacyOAuth` reads the method off the
       * grant for exactly this.
       */
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

test('a rotated secret keeps the registered client id, and a new id does not inherit it', async (t) => {
  /**
   * The property: `clientSecret=<new>` on an application this project already has a grant
   * from sends the **stored** client id back with it, and `clientId=<other>` never inherits
   * the stored secret.
   *
   * Two positionals could not express a rotation at all — you had to re-paste both, and a
   * value re-pasted is a value re-typed, which is how a trailing space gets into a
   * credential. Named fields make "the secret changed and nothing else did" sayable, so
   * each half falls back to the store on its own.
   *
   * The asymmetry is the load-bearing part, and it is now a per-provider fact rather than a
   * Linear one: a stored secret is reusable only while the identity it is **bound to** is
   * unchanged (`SECRET_BOUND_TO`). Pairing it with an id the operator just typed would
   * authenticate an application it was never issued for, and the provider's answer to that
   * names the *client* rather than the mismatch. So a new id asks for its own secret —
   * which, with stdin a pipe, is the value on stdin.
   *
   * Driven through `--consent`, because that is the one shape where the credentials cross a
   * wire this test can watch. The default grant posts straight to Linear.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const callback = 'http://127.0.0.1:1/api/oauth/linear/callback'
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      applications: {
        'linear:acme': {
          provider: 'linear',
          method: 'authorization_code',
          clientId: 'client-1',
          clientSecret: 'lin_secret_ORIGINALORIGINALORIG',
          redirectUri: callback,
        },
      },
      /**
       * The grant is what points this project at the application now — an application is
       * shared, so there is nothing filed under the project itself. `linkedApplication`
       * reads the grant to find the credentials, which is why one has to be here for a
       * rotation to have anything to fall back to.
       */
      grants: {
        ogun: {
          linear: {
            app: 'linear:acme',
            accessToken: 'access-abcdefghijkl',
            refreshToken: 'refresh-abcdefghijkl',
            grantType: 'authorization_code',
            expiresAt: Date.now() + 86_399_000,
            obtainedAt: Date.now(),
            scopes: ['read'],
            actor: 'app',
          },
        },
      },
    }),
    { mode: 0o600 },
  )

  const routes = {
    'GET /api/projects': projectsAre('ogun'),
    'GET /api/oauth/linear': (): [number, unknown] => [200, { redirectUri: callback }],
    'POST /api/oauth/linear/start/ogun': (): [number, unknown] => [
      200,
      {
        authorizeUrl: 'https://linear.app/oauth/authorize?x=1',
        redirectUri: callback,
        scopes: ['read'],
        actor: 'app',
      },
    ],
  }

  /**
   * The credentials go to `start` now rather than to `PUT …/app/:project`, and that is the
   * reordering rather than a renamed endpoint: they ride in the server's
   * `PendingAuthorization` across the browser round trip, so nothing is written until the
   * authorization comes back. The route that used to register them is still there for the
   * web UI and no longer writes.
   */
  const rotated = await stub(t, routes)
  const one = await ogun(
    ['connect', 'linear', '--consent', `clientSecret=${SECRET}`, '--project', 'ogun'],
    { config, server: rotated.url },
    '',
  )
  assert.equal(one.code, 0, one.stderr)
  assert.deepEqual(rotated.sent['POST /api/oauth/linear/start/ogun'], {
    clientId: 'client-1',
    clientSecret: SECRET,
  })

  const replaced = await stub(t, routes)
  const two = await ogun(
    ['connect', 'linear', '--consent', 'clientId=client-2', '--project', 'ogun'],
    { config, server: replaced.url },
    // stdin is a pipe, so the secret this application needs is read from it rather than
    // taken from the one belonging to client-1.
    `${KEY}\n`,
  )
  assert.equal(two.code, 0, two.stderr)
  assert.deepEqual(replaced.sent['POST /api/oauth/linear/start/ogun'], {
    clientId: 'client-2',
    clientSecret: KEY,
  })
  assert.ok(!`${two.stdout}${two.stderr}`.includes('ORIGINAL'), two.stdout)
})

// ── an application is shared, and a grant is not ──────────────────────────

/**
 * A machine holding one GitHub App that two projects use, written directly.
 *
 * Written rather than connected, because connecting a GitHub App signs a JWT and talks to
 * `api.github.com` — there is no App and no key here, and `github-app-fixtures.ts` records
 * that at length. What these tests are about is the store and the surfaces over it, which
 * need no network.
 */
const machineWithASharedApp = (configPath: string): Promise<void> =>
  writeFile(
    configPath,
    JSON.stringify({
      projects: { 'heirchive-api': '/srv/api', 'heirchive-web': '/srv/web' },
      applications: {
        'github:heirchive': {
          provider: 'github',
          method: 'private_key_jwt',
          appId: '1234567',
          installationId: '98765432',
          privateKey: '-----BEGIN PRIVATE KEY-----\nSECRETKEYBYTES\n-----END PRIVATE KEY-----',
        },
        'github:other-org': {
          provider: 'github',
          method: 'private_key_jwt',
          appId: '7654321',
          installationId: '11111111',
          privateKey: '-----BEGIN PRIVATE KEY-----\nIDLEKEYBYTES\n-----END PRIVATE KEY-----',
        },
      },
      grants: {
        'heirchive-api': {
          github: {
            app: 'github:heirchive',
            accessToken: 'ghs_AAAAAAAAAAAAAAAAAAAA',
            grantType: 'installation',
            expiresAt: Date.now() + 36e5,
            obtainedAt: Date.now(),
            scopes: ['pull_requests:read'],
            actor: 'ogun[bot]',
            account: { id: '42', name: 'Heirchive', urlKey: 'Heirchive' },
          },
        },
        'heirchive-web': {
          github: {
            app: 'github:heirchive',
            accessToken: 'ghs_BBBBBBBBBBBBBBBBBBBB',
            grantType: 'installation',
            expiresAt: Date.now() + 36e5,
            obtainedAt: Date.now(),
            scopes: ['pull_requests:read'],
            actor: 'ogun[bot]',
            account: { id: '42', name: 'Heirchive', urlKey: 'Heirchive' },
          },
        },
      },
    }),
    { mode: 0o600 },
  )

test('a bare --link lists the applications, because that is what you do not know', async (t) => {
  /**
   * The property: `--link` with no value is **this command's** error and it **lists the
   * applications for that provider**, with who is using each.
   *
   * Declared as `optional-string` purely so that this is reachable: as a plain `string`
   * flag the parser answers *"option '--link' argument missing"*, which is correct and
   * useless. The one thing somebody who typed a bare `--link` does not know is what the
   * valid values are, and a usage line answers that question with "give me one of them".
   *
   * The names are the whole point of a derived name: nobody has to invent or remember one,
   * so the command has to be able to show them.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineWithASharedApp(config)

  const bare = await ogun(
    ['connect', 'github', '--app', '--link', '--project', 'heirchive-api'],
    { config },
  )
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /github:heirchive/)
  assert.match(bare.stderr, /used by heirchive-api, heirchive-web/)
  assert.match(bare.stderr, /github:other-org/)
  assert.match(bare.stderr, /used by nothing yet/)
  // And never the key, from the one error that prints an application's details.
  assert.ok(!bare.stderr.includes('SECRETKEYBYTES'), bare.stderr)

  // A provider with no applications says so and names the command that registers one,
  // rather than listing another provider's.
  const none = await ogun(
    ['connect', 'linear', '--app', '--link', '--project', 'heirchive-api'],
    { config },
  )
  assert.equal(none.code, 1)
  assert.match(none.stderr, /there are none/)
  assert.match(none.stderr, /ogun connect <integration> --app/)
})

test('--consent and --link together are refused rather than arbitrated', async (t) => {
  /**
   * The property: the two ways of getting a token cannot both happen, and the refusal says
   * what each one would have produced.
   *
   * Both resolutions are wrong and in opposite directions. Honouring `--link` mints a
   * client-credentials token from an application the operator asked to connect *with
   * consent* — a silent reduction in reach, from what an approver could see to public teams
   * only, which is the one failure shape with no error anywhere. Honouring `--consent`
   * ignores the name they typed and starts a browser flow for credentials they did not mean
   * to re-enter.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineKnowing(config, { ogun: '/does/not/matter' })

  const both = await ogun(
    ['connect', 'linear', '--consent', '--link', 'linear:acme', '--project', 'ogun'],
    { config },
  )
  assert.equal(both.code, 1)
  assert.match(both.stderr, /two different ways to get a token/)
  assert.match(both.stderr, /public teams only/)
})

test('--link and typed fields together are refused rather than arbitrated', async (t) => {
  /**
   * The property: `--link <name> clientId=…` fails naming both ways forward.
   *
   * Not a preference to resolve. `--link` means "use the credentials already here" and a
   * field means "here are credentials"; honouring either silently would store something
   * other than what was asked for, under a name the operator chose for the other thing.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineWithASharedApp(config)

  const both = await ogun(
    ['connect', 'github', '--link', 'github:heirchive', 'appId=9', '--project', 'heirchive-api'],
    { config },
  )
  assert.equal(both.code, 1)
  assert.match(both.stderr, /there is nothing to type/)
  assert.match(both.stderr, /--link <name>/)
})

test('a private key path that cannot be read fails naming the path and nothing of the file', async (t) => {
  /**
   * The property: a PEM field with **no newline** is read as a path, and an unreadable one
   * fails with the path named, the rule stated, and nothing stored.
   *
   * The rule has to not read as magic, so the message carries its own justification: a PEM
   * always has newlines and a path never does, which makes the two distinguishable with
   * certainty rather than by heuristic. Somebody who mistyped a filename gets told what
   * the field accepts in the same breath.
   *
   * It fails **before** any network call, which is also why this is testable at all: there
   * is no GitHub App here, so every path that reaches `api.github.com` is out of reach of
   * this suite.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineKnowing(config, { 'heirchive-api': '/srv/api' })

  const missing = await ogun(
    [
      'connect',
      'github',
      'appId=1234567',
      'installationId=98765432',
      `privateKey=${join(dir, 'not-here.pem')}`,
      '--project',
      'heirchive-api',
    ],
    { config },
  )
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /not-here\.pem/)
  assert.match(missing.stderr, /ENOENT/)
  assert.match(missing.stderr, /a PEM always has newlines\n\s+and a path never does/)
  assert.match(missing.stderr, /Nothing was stored/)

  // An empty file is a path that reads and holds no key, which is its own sentence: "it
  // read fine and there is nothing in it" is not the same problem as "I could not read it".
  const empty = join(dir, 'empty.pem')
  await writeFile(empty, '')
  const blank = await ogun(
    [
      'connect',
      'github',
      'appId=1234567',
      'installationId=98765432',
      `privateKey=${empty}`,
      '--project',
      'heirchive-api',
    ],
    { config },
  )
  assert.equal(blank.code, 1)
  assert.match(blank.stderr, /is empty, so there is no key in it/)
})

test('disconnecting a shared app keeps it and names who is still using it', async (t) => {
  /**
   * The property: `ogun disconnect github` removes this project's token, **leaves the App**
   * because another project holds a grant from it, and says which project that is.
   *
   * The cascade is the thing being refused: one App serves every project in the
   * organisation, so taking its private key would take them all offline to satisfy one
   * `disconnect` typed in the wrong directory. And GitHub shows a private key once, so a
   * cascade here is unrecoverable rather than inconvenient.
   *
   * The revoke line is the other half and it is a fact about the provider rather than
   * about the credential: **GitHub has no endpoint that ends an installation token early.**
   * Reporting "the provider could not be told" — which is what the Linear path says when a
   * revoke fails — would be a warning about a request that was never going to be made.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineWithASharedApp(config)

  const first = await ogun(['disconnect', 'github', '--project', 'heirchive-api'], { config })
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /heirchive-api disconnected from github/)
  assert.match(first.stdout, /still registered — heirchive-web is still using it/)
  assert.match(first.stdout, /no endpoint for/)

  // And the last one takes it, with the sentence that matters about a GitHub key.
  const last = await ogun(['disconnect', 'github', '--project', 'heirchive-web'], { config })
  assert.equal(last.code, 0, last.stderr)
  assert.match(last.stdout, /the application went with it/)
  assert.match(last.stdout, /GitHub shows one only once/)

  const file = JSON.parse(await readFile(config, 'utf8')) as {
    applications?: Record<string, unknown>
    grants?: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(file.grants ?? {}), [])
  assert.deepEqual(Object.keys(file.applications ?? {}), ['github:other-org'])
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

test('connect list has an applications table, says who shares each, and flags idle ones', async (t) => {
  /**
   * The property: the listing has **two tables**, because there are two kinds of thing —
   * and a GitHub credential appears in it at all, which it could not before.
   *
   * One table keyed by project could only show a shared application by repeating it per
   * project, so the day somebody rotated one it would have shown rows that disagreed with
   * nothing to say which one a poll used. The applications table says the name (which is
   * the handle `--link` takes), the method (recorded rather than inferred), the identifiers
   * that are **not** secrets, and who is using it.
   *
   * The idle line is the one that earns the section. An application no project holds a
   * grant from is a private key on this disk that nothing reads — reachable through
   * `disconnect --keep-application` for the last project using it — and it is the exact
   * shape this repository has one sentence about. Nothing else would ever mention it again.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await machineWithASharedApp(config)

  const listed = await ogun(['connect', 'list'], { config })
  assert.equal(listed.code, 0, listed.stderr)

  // The applications table: name, provider, method, non-secret identifiers, and users.
  assert.match(listed.stdout, /APPLICATION/)
  assert.match(listed.stdout, /github:heirchive/)
  assert.match(listed.stdout, /private_key_jwt/)
  assert.match(listed.stdout, /app 1234567, installation 98765432/)
  assert.match(listed.stdout, /heirchive-api, heirchive-web/)

  // The per-project rows, with the application each one goes THROUGH.
  assert.match(listed.stdout, /THROUGH/)
  assert.match(listed.stdout, /app install/)

  // The idle application, called out by name.
  assert.match(listed.stdout, /github:other-org is used by no project/)
  assert.match(listed.stdout, /--app --link <name>/)

  // And neither key, from either table. There is no field on the types this reads that one
  // would fit in, which is structural rather than remembered.
  for (const secret of ['SECRETKEYBYTES', 'IDLEKEYBYTES', 'ghs_AAAA', 'ghs_BBBB']) {
    assert.ok(!listed.stdout.includes(secret), `the listing carried ${secret}`)
  }
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
