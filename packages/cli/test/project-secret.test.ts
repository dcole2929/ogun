import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { projectSecrets } from '../src/commands/doctor.ts'

/**
 * `ogun project secret` — the input path, which is most of what this command is.
 *
 * Storing a string is trivial; getting it off a person's machine and into the file
 * without leaving a copy somewhere is the part with failure modes, and every one of them
 * is outside this program: `ps`, shell history, and a terminal's scrollback.
 *
 * Driven as a subprocess rather than by importing the command, because the two properties
 * that matter — what argv contains, and what stdin does when it is a pipe — only exist for
 * a real process. The CLI path is derived from this file rather than from `process.cwd()`
 * or a module-level constant, because the tests gate runs inside the project container
 * where the checkout is not where it is on the host.
 */
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts')

const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

type Result = { code: number; stdout: string; stderr: string }

const ogun = (args: string[], configPath: string, stdin?: string): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, OGUN_CONFIG: configPath } },
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

const scratch = async (t: { after: (fn: () => unknown) => void }): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secret-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'config.json')
}

test('a piped key is stored, and the command never prints it back', async (t) => {
  const config = await scratch(t)

  // The trailing newline is not incidental — it is what `< key.txt` and every password
  // manager's `read` actually deliver.
  const set = await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, `${KEY}\n`)
  assert.equal(set.code, 0, set.stderr)

  assert.match(JSON.parse(await readFile(config, 'utf8')).secrets.ogun.linear, /^lin_api_Z+$/)
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
   * The property: `ogun project secret set ogun linear <value>` must fail.
   *
   * The naive command takes a third positional, and it is the one input path that leaks
   * before the program has done anything wrong. On Linux `/proc/<pid>/cmdline` is
   * world-readable, so every account on the box can `ps` the key while the command runs;
   * and the shell writes the whole line into `~/.zsh_history`, a file nobody audits and
   * everybody backs up.
   *
   * Refused rather than ignored: silently dropping it would leave the operator believing
   * the secret was stored, having leaked it anyway.
   */
  const config = await scratch(t)
  const set = await ogun(['project', 'secret', 'set', 'ogun', 'linear', KEY], config)

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

test('a name Ogun does not read is refused before anything is written', async (t) => {
  const config = await scratch(t)
  const set = await ogun(['project', 'secret', 'set', 'ogun', 'linaer'], config, `${KEY}\n`)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /linear/)
  // A stored typo is a secret that exists, reports as set, and is read by nothing — the
  // failure only shows up hours later as an unauthenticated poller.
  await assert.rejects(() => readFile(config, 'utf8'))
})

test('an empty pipe is refused, not stored as a key that does not work', async (t) => {
  const config = await scratch(t)
  const set = await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, '\n')
  assert.equal(set.code, 1)
  assert.match(set.stderr, /empty/)
})

test('listing prints presence and never a value', async (t) => {
  const config = await scratch(t)
  await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, `${KEY}\n`)

  const listed = await ogun(['project', 'secret', 'list'], config)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /ogun/)
  assert.match(listed.stdout, /linear/)
  assert.ok(!listed.stdout.includes(KEY), listed.stdout)
})

test('setting again rotates in place', async (t) => {
  const config = await scratch(t)
  await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, 'lin_api_OLDOLDOLD\n')
  await ogun(['project', 'secret', 'set', 'ogun', 'linear'], config, `${KEY}\n`)

  const stored = await readFile(config, 'utf8')
  assert.ok(stored.includes(KEY))
  // No history and no second slot (ADR-0012). A superseded key still in the file is a live
  // credential nobody is watching, and it goes into every backup of this machine.
  assert.ok(!stored.includes('OLDOLDOLD'))
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
