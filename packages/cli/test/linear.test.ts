import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * `ogun linear` — the shape of the command, and what it refuses before it prompts.
 *
 * The OAuth flow itself is covered by the server's tests and by
 * `test/linear-oauth-fixtures.ts`. What is tested here is the half that lives in the CLI
 * and is invisible from either: which project a command decides it is acting on, what it
 * does when that decision is wrong, and whether the two values this command exists to
 * collect are ever allowed onto a command line.
 *
 * Driven as a subprocess against a stub control plane, because the three things that
 * matter — argv, the working directory, and *which requests were made before the first
 * prompt* — only exist for a real process. The stub records every request it received, so
 * a test can assert that a refusal happened before anything was asked for.
 */
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts')

type Result = { code: number; stdout: string; stderr: string }
type Ctx = { after: (fn: () => unknown) => void }

/** What the stub control plane was asked for, in order. */
type Seen = string[]

const stub = async (
  t: Ctx,
  routes: Record<string, (seen: Seen) => [number, unknown]>,
): Promise<{ url: string; seen: Seen }> => {
  const seen: Seen = []
  const server: Server = createServer((req, res) => {
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`
    seen.push(key)
    const handler = routes[key]
    const [status, body] = handler ? handler(seen) : [404, { error: `no stub for ${key}` }]
    res.writeHead(status, { 'content-type': 'application/json' })
    // The body is drained first: an unconsumed request body makes the client see a socket
    // hang up rather than the status this test is about.
    req.resume()
    req.on('end', () => res.end(JSON.stringify(body)))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, seen }
}

const ogun = (
  args: string[],
  env: { config: string; server?: string },
  cwd?: string,
  stdin?: string,
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
    // `connect` reads stdin when it is a terminal and not otherwise; closing it keeps a
    // future change from hanging the suite instead of failing it.
    child.stdin?.end(stdin ?? '')
  })

const box = async (t: Ctx): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-linear-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const repoCalled = async (root: string, slug: string): Promise<string> => {
  await mkdir(join(root, '.ogun'), { recursive: true })
  await writeFile(join(root, '.ogun', 'config.yaml'), `project:\n  name: ${slug}\n`)
  return root
}

const projectsAre = (...slugs: string[]) => (): [number, unknown] =>
  [200, { projects: slugs.map((slug) => ({ slug, defaultBranch: 'main', remoteUrl: null })) }]

// ── the two values it exists to collect ───────────────────────────────────

test('the client secret is refused on the command line rather than accepted', async (t) => {
  /**
   * The property: nothing extra on the line is stored, and the refusal names both hazards.
   *
   * The old shape took `<project>` as a positional, so the refusal had to guess that a
   * *second* positional was a credential. With the slug gone there is no positional at all,
   * which makes the net wider over the same fish: anything left on that line is something
   * the operator meant to hand the command, and the only two things this command takes are
   * a Client ID and a Client Secret.
   *
   * `/proc/<pid>/cmdline` is world-readable while the process runs, and the shell writes
   * the line into a history file nobody audits. Refused rather than ignored: silently
   * dropping it would leave the operator believing it was stored, having leaked it anyway.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const app = await ogun(['linear', 'app', 'lin_secret_XXXXXXXXXXXX'], { config })

  assert.equal(app.code, 1)
  assert.match(app.stderr, /ps/)
  assert.match(app.stderr, /history/)
  // Not echoed. The refusal lands in the terminal the operator is about to screenshot.
  assert.ok(!app.stderr.includes('lin_secret_XXXXXXXXXXXX'), app.stderr)
  // And nothing was written, which is what "nothing was stored" has to mean for a machine
  // that had no config.json at all.
  await assert.rejects(() => readFile(config, 'utf8'))
})

test('the usage says what the command asks for, which its name does not', async (t) => {
  /**
   * The property: no line describing `app` reads as a complete command that takes nothing.
   *
   * `ogun linear app` names the noun and not the inputs. The two things it exists to
   * collect are a Client ID and a Client Secret — one of them a credential — and the only
   * way to discover that from the old `ogun project linear app <project>` was to run it,
   * having first guessed that an application had to be created in Linear's web UI
   * beforehand. Checked on `--help` and on the usage a bad invocation prints, because those
   * are two different strings and only one of them is ever read on purpose.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')

  const help = await ogun(['linear', '--help'], { config })
  assert.equal(help.code, 0, help.stderr)
  // On the usage line itself, not only in prose further down: the usage block is the part
  // of a help page people read, and it was the part that was lying.
  assert.match(help.stdout, /ogun linear app \[--project <slug>\] +— asks for a Client ID/)
  assert.match(help.stdout, /Client Secret/)
  // And why neither can be an argument, where somebody reading `--help` will see it.
  assert.match(help.stdout, /shell history/)

  // The same string on a bad invocation, which is the other place a usage line is read.
  const flagged = await ogun(['linear', 'app', '--bogus'], { config })
  assert.equal(flagged.code, 1)
  assert.match(flagged.stderr, /asks for a Client ID and Client Secret/)

  const bad = await ogun(['linear', 'frobnicate'], { config })
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /app \| connect \| status \| disconnect/)
})

// ── which project ─────────────────────────────────────────────────────────

test('the project comes from the repository you are in', async (t) => {
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')
  const { url, seen } = await stub(t, {
    'GET /api/projects': projectsAre('heirchive-api'),
    'POST /api/oauth/linear/start/heirchive-api': () => [
      200,
      {
        authorizeUrl: 'https://linear.app/oauth/authorize?client_id=abc',
        redirectUri: 'http://127.0.0.1:7777/api/oauth/linear/callback',
        scopes: ['read'],
        actor: 'app',
      },
    ],
  })

  const connect = await ogun(['linear', 'connect'], { config, server: url }, repo)
  assert.equal(connect.code, 0, connect.stderr)
  assert.match(connect.stdout, /Connect heirchive-api to Linear/)
  // Where the slug came from is printed. An inferred project is the one thing about these
  // commands that can be quietly wrong, and this is the last place to catch it.
  assert.match(connect.stdout, /\.ogun\/config\.yaml/)
  assert.deepEqual(seen, ['GET /api/projects', 'POST /api/oauth/linear/start/heirchive-api'])
})

test('an unknown slug is refused before the command asks for anything', async (t) => {
  /**
   * The property: the refusal arrives **before** the first prompt and before any other
   * request, and it lists the slugs that would have worked.
   *
   * This is the hole `ogun secret set` had, in the place where it costs more. `app` prompts
   * for a Client ID and then a Client Secret; a version that validated afterwards — or that
   * left the check to `PUT /api/oauth/linear/app/:project`, which does refuse — would have
   * had a credential typed into a terminal that scrolls back before saying the project was
   * misspelled. Asserting on what the stub *received* is the only way to state that:
   * `GET /api/projects` and nothing else, so the callback URL was never even fetched.
   *
   * There is no `--allow-unregistered` here, unlike `ogun secret set`. The escape exists
   * there because that command reaches no server by design and its evidence is this
   * machine's projects map, which a hosted control plane legitimately leaves empty. This
   * one cannot work without the control plane at all, so the oracle is the database — the
   * same thing that decides which slugs get polled — and there is no case where the right
   * answer is a project it has never heard of.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'heirchive-api')
  const { url, seen } = await stub(t, { 'GET /api/projects': projectsAre('ogun', 'sources') })

  const app = await ogun(['linear', 'app'], { config, server: url }, repo)
  assert.equal(app.code, 1)
  assert.match(app.stderr, /"heirchive-api" is not a project this control plane knows/)
  assert.match(app.stderr, /Known: ogun, sources/)
  assert.match(app.stderr, /ogun project sync/)
  assert.deepEqual(seen, ['GET /api/projects'])
})

test('--project wins over the directory, and a guessed directory name says so', async (t) => {
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const nowhere = join(dir, 'Downloads')
  await mkdir(nowhere, { recursive: true })
  const { url } = await stub(t, { 'GET /api/projects': projectsAre('ogun') })

  // A directory that is no repository at all. `project add` accepts this guess and says it
  // guessed; here the consequence is a credential filed where nothing reads it, so it is
  // refused — and the refusal has to say the directory is the problem, because "run it
  // somewhere else" is the fix and no list of known slugs implies it.
  const guessed = await ogun(['linear', 'app'], { config, server: url }, nowhere)
  assert.equal(guessed.code, 1)
  assert.match(guessed.stderr, /no \.ogun\/config\.yaml/)
  assert.match(guessed.stderr, /--project/)

  // And the flag reaches a project this machine has no copy of.
  const flagged = await ogun(['linear', 'disconnect', '--project', 'ogun'], {
    config,
    server: (
      await stub(t, {
        'GET /api/projects': projectsAre('ogun'),
        'DELETE /api/oauth/linear/ogun': () => [200, { removed: true, revoked: true }],
      })
    ).url,
  })
  assert.equal(flagged.code, 0, flagged.stderr)
  assert.match(flagged.stdout, /ogun disconnected from linear/)
})

test('disconnect checks no slug, and says which project it looked in', async (t) => {
  /**
   * The property: `disconnect` refuses nothing and reports a no-op loudly.
   *
   * Same rule as `ogun secret rm`, and the same reason. `status` prints whatever the store
   * holds, so an entry left behind by a project since removed from the database is a row an
   * operator can see — and refusing to remove it would strand a live refresh token in the
   * file with the listing still advertising it. Validation guards the commands that create
   * something; a removal creates nothing, so the stub is not even asked for the project
   * list.
   *
   * The no-op branch is the one that changed. It was always distinguished from a real
   * removal, which was enough while the slug was a positional somebody typed; now it is
   * inferred, so a `disconnect` run one directory too high is a plausible way to land here
   * and the answer has to point at the project rather than at Linear.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const repo = await repoCalled(join(dir, 'checkout'), 'never-registered')
  const { url, seen } = await stub(t, {
    'DELETE /api/oauth/linear/never-registered': () => [200, { removed: false, revoked: false }],
  })

  const gone = await ogun(['linear', 'disconnect'], { config, server: url }, repo)
  assert.equal(gone.code, 0, gone.stderr)
  assert.match(gone.stdout, /never-registered had no linear connection/)
  assert.match(gone.stdout, /\.ogun\/config\.yaml/)
  assert.deepEqual(seen, ['DELETE /api/oauth/linear/never-registered'])
})

// ── status ────────────────────────────────────────────────────────────────

test('status reads this machine and does not narrow to the current directory', async (t) => {
  /**
   * The property: `ogun linear status` answers for the machine, from anywhere, with no
   * control plane running.
   *
   * Two halves, both deliberate. It reads `~/.ogun/config.json` rather than the server,
   * because "is this connected" is asked when something is broken and a status that needs
   * the broken thing up cannot answer it — the stub here is given no routes at all, and the
   * command still works. And it does not take the directory default the other three take:
   * this one acts on no project, so it has nothing to name wrongly and everything to hide,
   * and a status that silently narrowed would print "no linear applications on this
   * machine" on a machine holding two.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      oauth: {
        ogun: { linear: { clientId: 'c1', clientSecret: 's1', redirectUri: 'http://x/cb' } },
        sources: { linear: { clientId: 'c2', clientSecret: 's2', redirectUri: 'http://x/cb' } },
      },
    }),
    { mode: 0o600 },
  )
  const elsewhere = join(dir, 'Downloads')
  await mkdir(elsewhere, { recursive: true })

  const status = await ogun(['linear', 'status'], { config, server: 'http://127.0.0.1:1' }, elsewhere)
  assert.equal(status.code, 0, status.stderr)
  assert.match(status.stdout, /ogun/)
  assert.match(status.stdout, /sources/)
  // No token, client secret or refresh token anywhere in it — `ProjectGrantPresence` has no
  // field one fits in, and this asserts the rendering did not find another way.
  assert.ok(!status.stdout.includes('s1'), status.stdout)
  assert.ok(!status.stdout.includes('s2'), status.stdout)

  const one = await ogun(['linear', 'status', '--project', 'sources'], { config }, elsewhere)
  assert.match(one.stdout, /sources/)
  assert.doesNotMatch(one.stdout, /ogun\s/)
})

// ── the old spelling ──────────────────────────────────────────────────────

test('`ogun project linear` is a signpost, not a dead end', async (t) => {
  /**
   * The property: the old spelling names the new one.
   *
   * Dropped rather than aliased — an alias is a second shape to keep working forever — but
   * muscle memory outlives a release, and `unknown: ogun project linear` followed by a page
   * that no longer mentions Linear is a worse answer than the command not existing at all.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  const old = await ogun(['project', 'linear', 'app', 'ogun'], { config })

  assert.equal(old.code, 1)
  assert.match(old.stderr, /ogun linear/)
  await assert.rejects(() => readFile(config, 'utf8'))
})
