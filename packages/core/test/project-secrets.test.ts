import { strict as assert } from 'node:assert'
import { inspect } from 'node:util'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadLocalConfig, updateLocalConfig } from '../src/config/machine.ts'
import {
  clearProjectSecret,
  InvalidSecret,
  isSecretName,
  listProjectSecrets,
  normalizeSecretInput,
  readProjectSecret,
  sealSecret,
  setProjectSecret,
} from '../src/config/secrets.ts'

/**
 * The first secret Ogun *stores* rather than borrows (ADR-0012).
 *
 * Everything else it authenticates with is on the machine because a human logged in with
 * it, so ADR-0010 only had to decide who reads the file. A Linear key is issued per
 * workspace and has to be typed in, which makes containment this subsystem's problem
 * rather than the operating system's — and containment is what all of these are about.
 */

const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'

const withStore = async (t: { after: (fn: () => unknown) => void }, contents?: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secrets-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.json')
  if (contents !== undefined) await writeFile(path, JSON.stringify(contents))
  return path
}

// ── the four read states ───────────────────────────────────────────────────

/**
 * The property: a read has four answers, and a naive implementation has two.
 *
 * `string | undefined` is what this wants to be, and it collapses "nobody set one",
 * "something wrote a blank over the one you set", and "I could not read the store" into
 * one value. Principle 6 exists for exactly that: those three have three different fixes,
 * and a poller that reports all of them as "no Linear key" sends whoever reads the log to
 * re-enter a key that is already there.
 */
test('a store that does not exist is absent, not an error', async (t) => {
  const path = await withStore(t)
  assert.deepEqual(await readProjectSecret('ogun', 'linear', path), { state: 'absent' })
})

test('a store with no entry for this project is absent', async (t) => {
  const path = await withStore(t, { projects: { ogun: '/srv/ogun' } })
  assert.deepEqual(await readProjectSecret('ogun', 'linear', path), { state: 'absent' })
})

test('a blank value is empty, which is not absent', async (t) => {
  /**
   * Only reachable by hand-editing config.json — the write path refuses it — and §4.5
   * says that file gets hand-edited. Kept apart from `absent` because the two mean
   * different things happened: one is "you have not set it yet", the other is "something
   * overwrote the one you set with nothing", and only the second is a destructive event
   * worth noticing.
   */
  const path = await withStore(t, { secrets: { ogun: { linear: '   ' } } })
  assert.deepEqual(await readProjectSecret('ogun', 'linear', path), { state: 'empty' })
})

test('a store that exists and cannot be read is unreadable, never absent', async (t) => {
  const path = await withStore(t, { secrets: { ogun: { linear: KEY } } })
  await chmod(path, 0o000)
  t.after(() => chmod(path, 0o600).catch(() => {}))

  const read = await readProjectSecret('ogun', 'linear', path)
  // Root ignores the mode, so on a container running as uid 0 this is simply readable and
  // there is nothing to assert. The property is about a machine where the read fails.
  if (read.state === 'present') return

  assert.equal(read.state, 'unreadable')
  /**
   * The naive implementation is `loadLocalConfig`, which catches every read failure and
   * returns an empty config — right for the projects map, where the consequence is
   * cloning from a remote instead of from disk, and wrong for a credential, where it
   * turns "I could not look" into "there is nothing there".
   */
  assert.notEqual(read.state, 'absent')
})

test('a stored secret comes back sealed, and is the value that was written', async (t) => {
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', KEY, path)

  const read = await readProjectSecret('ogun', 'linear', path)
  assert.equal(read.state, 'present')
  assert.equal(read.state === 'present' && read.secret.expose(), KEY)
})

// ── the value does not turn itself into text ───────────────────────────────

/**
 * The property: a secret survives every accidental route to a string as `[redacted]`.
 *
 * A naive implementation returns a bare `string`, and a string goes everywhere its holder
 * goes. Nobody writes `console.error('poll failed', { key })` while thinking about
 * credentials; they write it while debugging a 500 at midnight. That is the same class of
 * leak `redactUrlCredentials` was merged for — not a disclosure to a new audience, a loss
 * of containment into logs, transcripts and pasted output that nothing ever cleans.
 */
test('a sealed secret does not leak through interpolation, JSON, or the inspector', () => {
  const secret = sealSecret(KEY)

  assert.ok(!`${secret}`.includes(KEY), 'template interpolation exposed it')
  assert.ok(!JSON.stringify({ secret }).includes(KEY), 'JSON.stringify exposed it')
  assert.ok(!inspect({ secret }, { depth: 5 }).includes(KEY), 'util.inspect exposed it')
  // How it reaches a console, an assertion diff, and a thrown error's own formatting.
  assert.ok(!inspect(secret).includes(KEY))
  assert.ok(!String(new Error(`failed with ${secret}`)).includes(KEY))
})

test('the value is not an own property, so it does not survive a spread', () => {
  /**
   * Why the value lives in a closure rather than in a field. A class with a private `#`
   * field would also pass the tests above, and would still show the value under a
   * debugger's property list and in `Object.entries` on some transpiled shapes. Nothing
   * enumerable holds it here.
   */
  const secret = sealSecret(KEY)
  assert.ok(!Object.keys(secret).includes('value'))
  assert.ok(!JSON.stringify({ ...secret }).includes(KEY))
  assert.ok(!inspect(Object.getOwnPropertyDescriptors(secret)).includes(KEY))
})

// ── living in a file other writers rewrite ─────────────────────────────────

test('a project secret survives an unrelated write to config.json', async (t) => {
  /**
   * The property that decides whether this design works at all, and the one a reviewer
   * would never think to check.
   *
   * `updateLocalConfig` is a read-modify-write through `localConfigSchema`, and zod strips
   * what a schema does not name. A `secrets` block that was not declared in that schema
   * would therefore be silently deleted by the very next `ogun project add`, `ogun runner
   * join`, or admin-token rotation — and the symptom would be a Linear key that stopped
   * working on the day someone registered an unrelated repository, with nothing anywhere
   * connecting the two.
   */
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', KEY, path)

  await updateLocalConfig((c) => ({ ...c, projects: { ...c.projects, other: '/srv/other' } }), path)
  await updateLocalConfig((c) => ({ ...c, server: { token: 'ogun_rotated' } }), path)

  const read = await readProjectSecret('ogun', 'linear', path)
  assert.equal(read.state === 'present' && read.secret.expose(), KEY)
})

test('the file a secret lands in is 0600 even if it was not before', async (t) => {
  // `writeFile`'s mode applies only on create, which is how a config.json restored from a
  // backup stayed 0644 while a token was written into it. Inherited from
  // `updateLocalConfig` rather than reimplemented — which is most of why this lives in the
  // machine file and not in a file of its own.
  const path = await withStore(t, { projects: {} })
  await chmod(path, 0o644)

  await setProjectSecret('ogun', 'linear', KEY, path)

  assert.equal(((await stat(path)).mode & 0o777).toString(8), '600')
})

// ── rotation and removal ───────────────────────────────────────────────────

test('setting again replaces, and the old value is not left in the file', async (t) => {
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', 'lin_api_OLDOLDOLDOLD', path)
  await setProjectSecret('ogun', 'linear', KEY, path)

  const read = await readProjectSecret('ogun', 'linear', path)
  assert.equal(read.state === 'present' && read.secret.expose(), KEY)
  // Rotation with no history is the decision (ADR-0012); this is the half of it that is
  // testable. A superseded key still sitting in the file is a live credential nobody is
  // watching, and it would still be there in every backup of this machine.
  assert.ok(!(await readFile(path, 'utf8')).includes('OLDOLDOLDOLD'))
})

test('removing says whether there was anything to remove', async (t) => {
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', KEY, path)

  assert.equal(await clearProjectSecret('ogun', 'linear', path), true)
  // Different answers for different facts: a command that prints "removed" for both is how
  // you come to believe you cleared a key you actually cleared on the wrong project.
  assert.equal(await clearProjectSecret('ogun', 'linear', path), false)
  assert.deepEqual(await readProjectSecret('ogun', 'linear', path), { state: 'absent' })
  assert.ok(!(await readFile(path, 'utf8')).includes(KEY))
})

test('a project with nothing left drops out rather than lingering as an empty object', async (t) => {
  // So a later read is `absent` — nobody set one — rather than a project that exists in
  // the store holding nothing, which is the shape `empty` is reserved for.
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', KEY, path)
  await clearProjectSecret('ogun', 'linear', path)
  assert.deepEqual((await loadLocalConfig(path)).secrets, {})
})

// ── listing ────────────────────────────────────────────────────────────────

test('listing reports names and states and has nowhere to put a value', async (t) => {
  /**
   * A list endpoint is where secrets leak. The defence is not care at the call site — it
   * is that `ProjectSecretPresence` has no field a value fits in, so `doctor`,
   * `GET /api/system` and the UI cannot start leaking one by someone adding a column.
   */
  const path = await withStore(t)
  await setProjectSecret('ogun', 'linear', KEY, path)

  const listed = await listProjectSecrets(path)
  assert.deepEqual(listed, [{ project: 'ogun', name: 'linear', state: 'present' }])
  assert.ok(!JSON.stringify(listed).includes(KEY))
})

test('listing a machine with no store is empty, not a throw', async (t) => {
  assert.deepEqual(await listProjectSecrets(await withStore(t)), [])
})

// ── the value never enters an error message ────────────────────────────────

test('a config.json broken next to a secret does not quote the secret back', async (t) => {
  /**
   * The leak this repo has already had once, in a different costume.
   *
   * `bbaa036` found a credential in a rejected `execFile`'s message, because Node builds
   * that message out of the whole command line. `JSON.parse` has the same habit: for a
   * whole class of syntax errors V8 quotes a window of the offending source into its own
   * message — `Unexpected token 'l', ..."{"linear":lin_api_ZZ"... is not valid JSON` —
   * roughly ten characters either side of the fault. A long key leaks its prefix; a short
   * one leaks entirely.
   *
   * That matters because `~/.ogun/config.json` is parsed by the runner on startup and
   * forwarded through `fail()` by every CLI command. A hand-edit that drops a quote
   * therefore printed part of the key to a terminal, to a systemd journal, and into
   * whatever the operator pasted when asking why `ogun runner start` would not come up.
   *
   * The fix keeps the fault's *location* and throws the parser's own words away, because
   * the location is the half that helps and the only half that is safe. The fixture below
   * is deliberately the unquoted-value shape rather than a stray comma: a stray comma
   * produces a positional message that never quoted anything, so a test written against
   * one would have passed before the fix and proved nothing.
   */
  const path = await withStore(t)
  await writeFile(path, `{ "secrets": { "ogun": { "linear": ${KEY} } } }\n`)

  const read = await readProjectSecret('ogun', 'linear', path)
  assert.equal(read.state, 'unreadable')
  // The prefix, not the whole key: what V8 quotes is a window, so a check for the whole
  // value would pass while ten characters of it sat in the message.
  assert.ok(read.state === 'unreadable' && !read.reason.includes('lin_api_'), read.state)
  // Redacting must not cost the reader the reason, the same rule the clone redaction kept.
  assert.ok(read.state === 'unreadable' && read.reason.includes(path))

  await assert.rejects(
    () => loadLocalConfig(path),
    (err: Error) => {
      assert.ok(!err.message.includes('lin_api_'), `secret in error: ${err.message}`)
      assert.match(err.message, /is not valid JSON/)
      return true
    },
  )
})

test('a type error deep in the secrets block names the key, never the value', async (t) => {
  // Zod's issue path is `secrets.ogun.linear` — a name — and its message states expected
  // and received *types*. Asserted rather than assumed, because a validator that started
  // echoing received values would leak through every config error this CLI prints.
  const path = await withStore(t, { secrets: { ogun: { linear: { token: KEY } } } })
  await assert.rejects(
    () => loadLocalConfig(path),
    (err: Error) => {
      assert.ok(!err.message.includes(KEY), `secret in error: ${err.message}`)
      assert.match(err.message, /secrets\.ogun\.linear/)
      return true
    },
  )
})

// ── what arrives from a person ─────────────────────────────────────────────

test('a trailing newline is stripped, because every way of piping a key adds one', () => {
  /**
   * The naive implementation stores what stdin gave it. `… set ogun linear < key.txt` and
   * `op read … | ogun …` both deliver a trailing `\n`, and the value later becomes an
   * `authorization` header — where undici rejects a control character with
   * `ERR_INVALID_CHAR`, an error naming neither Linear nor the key.
   *
   * The variant that does not throw is worse: a leading space is accepted by `fetch` and
   * rejected by the provider, so a correct key reads as a wrong one and gets re-entered.
   */
  assert.equal(normalizeSecretInput(`${KEY}\n`), KEY)
  assert.equal(normalizeSecretInput(`  ${KEY}  \r\n`), KEY)
})

test('an empty input is refused rather than stored as an empty secret', () => {
  // Storing it would manufacture the `empty` state on purpose — a key that exists and does
  // not work — and would make "set it to nothing" a second, undocumented way to remove one.
  assert.throws(() => normalizeSecretInput('   \n'), InvalidSecret)
})

test('a refusal does not quote the value it refused', () => {
  // The tempting message names the offending character and its offset. The whole input is
  // the secret, and a message that narrows it is a message that leaked part of it.
  const two = `${KEY}\nlin_api_SECONDLINE`
  assert.throws(
    () => normalizeSecretInput(two),
    (err: Error) => err instanceof InvalidSecret && !err.message.includes('SECONDLINE'),
  )
})

test('only names Ogun actually reads are accepted', () => {
  // A typo'd name would otherwise be a secret that is stored, reports as set, and is read
  // by nothing — the same silent hole `inertPolicies` warns about, surfacing hours later
  // as an unauthenticated poller.
  assert.equal(isSecretName('linear'), true)
  assert.equal(isSecretName('linaer'), false)
})
