import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * `ogun secret set | list | rm` — the store beside `ogun connect`.
 *
 * ### What this file is for
 *
 * The command was deleted one commit ago and folded into `connect`, on the observation
 * that every name in `SECRET_NAMES` was an integration credential. The observation was
 * true and the inference was not: nothing else was in that set because the set refused
 * everything else, so it described the validator rather than the world. **A secret is not
 * guaranteed to be an integration.**
 *
 * So there are two commands, and the properties worth protecting are the ones about the
 * seam between them:
 *
 *  - a free-form name is **stored**, and the operator is **told** when nothing reads it —
 *    which is what replaces a closed set that could refuse;
 *  - a name is whatever the project calls it: `DATABASE_URL` and `my_api_key` are stored,
 *    and only what cannot work is refused — without the argument being echoed back;
 *  - a name that is already taken is **settled before the value is collected**: refused off
 *    a terminal unless `--replace` says so;
 *  - `secret set linear` and `connect linear --api-key` write **the same row** and enforce
 *    **the same rules** about it, so the two commands cannot disagree.
 *
 * Driven as a subprocess for the reason `connect.test.ts` gives: argv, whether stdin is a
 * pipe, and the working directory only exist for a real process.
 */
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/main.ts')

const KEY = 'lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'
const HMAC = 'whsec_QQQQQQQQQQQQQQQQQQQQQQQQ'

type Result = { code: number; stdout: string; stderr: string }
type Ctx = { after: (fn: () => unknown) => void }

const ogun = (args: string[], config: string, stdin?: string, cwd?: string): Promise<Result> =>
  new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, OGUN_CONFIG: config }, ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) =>
        done({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    )
    // Closed rather than left open even when there is nothing to send: a value is read from
    // all of stdin when stdin is not a terminal, so a pipe nobody ends is a hung test.
    child.stdin?.end(stdin ?? '')
  })

const box = async (t: Ctx): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-secret-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const machineKnowing = async (t: Ctx, projects: Record<string, string>): Promise<string> => {
  const path = join(await box(t), 'config.json')
  await writeFile(path, JSON.stringify({ projects }), { mode: 0o600 })
  return path
}

const secretsIn = async (config: string): Promise<Record<string, Record<string, string>>> =>
  JSON.parse(await readFile(config, 'utf8')).secrets ?? {}

// ── a name that is not an integration ─────────────────────────────────────

test('a free-form name is stored, and the command names who could read it', async (t) => {
  /**
   * The property: `ogun secret set stripe-webhook` **works**, and prints the readers.
   *
   * Both halves matter and they pull against each other. The store has to accept arbitrary
   * names or it is not a store — that is the whole reversal. But `SECRET_NAMES` was a
   * closed set for a reason that does not go away: *"a secret nothing reads looks exactly
   * like one that works, right up until the night it mattered."* A free-form store cannot
   * refuse, so the fact moves from a refusal to a sentence at the one moment somebody is
   * looking at the screen.
   *
   * It names the readers rather than asserting there are none. `env: { secret: <name> }`
   * reads whatever a project's config asks for, and this command has never seen that file
   * — the old wording, *"nothing in this build reads a secret named …"*, was a confident
   * claim about a repository on some branch somewhere. Listing both readers keeps the
   * did-you-mean (the polled set is right above the name you typed) without the claim.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, HMAC)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
  assert.equal(((await stat(config)).mode & 0o777).toString(8), '600')

  assert.match(set.stdout, /Check that stripe-webhook is one of them/)
  assert.match(set.stdout, /a poll Ogun runs itself — linear/)
  assert.match(set.stdout, /env: \{ secret: stripe-webhook \}.* in a project's \.ogun\/config\.yaml/)
  // And no claim about a file this command has not read.
  assert.ok(!/[Nn]othing in this build reads/.test(set.stdout), set.stdout)
  // The value itself never comes back — only a count.
  assert.ok(!`${set.stdout}${set.stderr}`.includes(HMAC), set.stdout)
  assert.match(set.stdout, new RegExp(`${HMAC.length} characters`))
})

test('a name Ogun does poll under draws no such warning', async (t) => {
  /**
   * The property: the "nothing reads this" line is about the *name*, not about the
   * command — so `ogun secret set linear` does not print it.
   *
   * A warning that fires on the correct invocation as well as the mistaken one is a
   * warning people learn to scroll past, which is the same argument that keeps the inline
   * warning off the Client ID.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!.linear, KEY)
  assert.ok(!/Check that .* is one of them/.test(set.stdout), set.stdout)
})

test('a name is whatever the project calls it, including SCREAMING_SNAKE_CASE', async (t) => {
  /**
   * The property: the names secrets actually have are stored.
   *
   * A format rule stood here for two days — `[a-z0-9][a-z0-9.-]{0,63}` — and it refused
   * `DATABASE_URL`, `STRIPE_SECRET_KEY` and `my_api_key`, which is how every `.env` file,
   * `flyctl`, Heroku and Kubernetes spell a secret's name. It was aimed at somebody pasting
   * a key into the name slot, and it refused the normal case to prevent an abnormal one.
   *
   * This test is the reversal, and it is deliberately three names rather than one: the rule
   * that died refused each of them for a different reason (case, underscores, both), so a
   * single example would leave two thirds of it able to come back.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  for (const name of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'my_api_key', 'stripe-webhook']) {
    const set = await ogun(['secret', 'set', name, '--project', 'ogun'], config, HMAC)
    assert.equal(set.code, 0, `${name}: ${set.stderr}`)
    assert.equal((await secretsIn(config)).ogun![name], HMAC, name)
    // Case is kept exactly: `DATABASE_URL` and `database_url` are two names.
    assert.match(set.stdout, new RegExp(`Check that ${name} is one of them`))
  }
})

test('a name that is a pasted key is stored, and the line that says so is the warning', async (t) => {
  /**
   * The property: `ogun secret set lin_api_…` **works**, and prints the sentence that makes
   * the mistake visible if it was one.
   *
   * The old shape rule refused this on the theory that the likeliest thing in that position
   * is the key. It is a legal invocation — the name is `lin_api_…` and the command then
   * prompts for the value — and there is no rule that admits `AWS_SECRET_ACCESS_KEY` and
   * refuses `lin_api_…`, because they are the same shape. So the refusal is replaced by the
   * information it was standing in front of: *nothing in this build reads a secret named
   * `lin_api_…`* is exactly what somebody who mis-positioned their key needs to read.
   *
   * The name is echoed here where a refusal would not echo it, and the asymmetry is the
   * point: the store accepted it, so it is now a row in `secret list` and a word to type at
   * `secret rm`. A refusal has stored nothing, so quoting it back would be the only place
   * it appeared.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', KEY, '--project', 'ogun'], config, `${HMAC}\n`)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun![KEY], HMAC)
  assert.match(set.stdout, /Check that lin_api_[^ ]* is one of them/)
  // The VALUE is still never echoed, whatever the name is.
  assert.ok(!`${set.stdout}${set.stderr}`.includes(HMAC), set.stdout)
})

test('only what cannot work is refused, and the refusal never repeats the argument', async (t) => {
  /**
   * The property: each surviving rule refuses something that genuinely breaks, and none of
   * them quotes what was typed.
   *
   * Every case here is a failure rather than an untidiness:
   *  - **empty** has no name to be addressed by;
   *  - **whitespace** cannot be typed back at `ogun secret rm`, which takes one positional,
   *    and cannot be read out of `secret list`, whose columns are separated by spaces;
   *  - **a control character** is printed back to a terminal, where `\r` and a CSI sequence
   *    rewrite the line they land on — and is the signature of a value pasted with its
   *    newline attached;
   *  - **`__proto__`** does not survive `config.json`: `z.record` does not carry that key
   *    onto the parsed object, so the value would be written now and silently dropped by
   *    the next command that writes the file. That one is asserted rather than argued.
   *
   * Not echoing is ADR-0012's rule, and it outlives the shape rule it used to share a
   * paragraph with: a key can still end up in this position, and quoting the argument back
   * would write a live credential to stderr on top of the shell history and the `ps` window
   * it is already in.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  for (const [name, why] of [
    ['', /cannot be empty/],
    ['two words', /whitespace/],
    ['tab\tname', /whitespace/],
    ['line\nname', /whitespace/],
    ['esc\u001b[2Kname', /control character/],
    ['__proto__', /__proto__/],
  ] as [string, RegExp][]) {
    const set = await ogun(['secret', 'set', name, '--project', 'ogun'], config, `${HMAC}\n`)
    assert.equal(set.code, 1, `${JSON.stringify(name)} was not refused`)
    assert.match(set.stderr, why)
    assert.deepEqual(await secretsIn(config), {}, JSON.stringify(name))
  }

  // And the argument is not repeated back, whatever it was.
  const pasted = await ogun(['secret', 'set', `${KEY} ${KEY}`, '--project', 'ogun'], config, HMAC)
  assert.equal(pasted.code, 1)
  assert.ok(!`${pasted.stdout}${pasted.stderr}`.includes(KEY), pasted.stderr)
  assert.match(pasted.stderr, /compromised/)
})

test('a name inherited from Object.prototype is a name like any other', async (t) => {
  /**
   * The property: `constructor` can be stored, and removing one that is not there says so.
   *
   * `entries[name]` walks the prototype chain, so before this was fixed `ogun secret set
   * constructor` read a *function* out of an object holding no such secret and died with
   * `previous.trim is not a function` — a stack trace, on a name the validator of the day
   * accepted. `name in entries` had the matching bug on the way out: `ogun secret rm
   * constructor` reported a removal that never happened, which is the one distinction that
   * function exists to make.
   *
   * It is fixed with `Object.hasOwn` in the store rather than by refusing the name, because
   * the store's own lookups have to be honest about what the store contains whatever the
   * callers let through — and because `constructor` is a perfectly ordinary word for a
   * project to have a secret about.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const missing = await ogun(['secret', 'rm', 'constructor', '--project', 'ogun'], config)
  assert.equal(missing.code, 0, missing.stderr)
  assert.match(missing.stdout, /has no constructor secret/)

  const set = await ogun(['secret', 'set', 'constructor', '--project', 'ogun'], config, HMAC)
  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!.constructor, HMAC)
  assert.match(set.stdout, /stored for ogun/)

  const removed = await ogun(['secret', 'rm', 'constructor', '--project', 'ogun'], config)
  assert.equal(removed.code, 0, removed.stderr)
  assert.deepEqual(await secretsIn(config), {})
})

// ── how the value arrives ─────────────────────────────────────────────────

test('an inline value is stored, warns loudly, and is never repeated back', async (t) => {
  /**
   * The property: the same three arrival paths `connect` offers, from the same function.
   *
   * `readSecretValue` moved out of `connect.ts` into `prompt.ts` precisely so this is not a
   * second implementation: two commands that each decide where a credential comes from is
   * how one of them ends up echoing, or accepting a trailing newline the other strips.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', 'stripe-webhook', HMAC, '--project', 'ogun'], config)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
  assert.match(set.stderr, /WARNING!/)
  assert.match(set.stderr, /proc/)
  assert.match(set.stderr, /history/)
  assert.match(set.stderr, /compromised/)
  assert.ok(!set.stderr.includes(HMAC), set.stderr)
  assert.ok(!set.stdout.includes(HMAC), set.stdout)
})

test('a piped value keeps its trailing newline out of the store', async (t) => {
  // `< key.txt` and every password manager's `read` deliver one, and an `authorization`
  // header containing a control character fails with an error naming neither the value nor
  // the provider.
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })
  const set = await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, `${HMAC}\n`)
  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
})

test('an empty pipe is refused, not stored as a value that does not work', async (t) => {
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })
  const set = await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, '\n')
  assert.equal(set.code, 1)
  assert.match(set.stderr, /empty/)
  assert.deepEqual(await secretsIn(config), {})
})

// ── the same slot as `connect --api-key` ──────────────────────────────────

test('secret set and connect --api-key write the same row', async (t) => {
  /**
   * The property: a key stored by one is the key the other reports, byte for byte, in the
   * same place — and the second write is gated by the same rule the first would have been.
   *
   * Two maps that could each hold a `linear` key is the "two stores that can disagree"
   * shape ADR-0012 rejected when it refused a second secrets file — and it would be worse
   * here, because the disagreement would be between two commands the same operator runs on
   * the same afternoon. So the overlap is real, acknowledged, and resolved by there being
   * exactly one row.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)
  assert.equal((await secretsIn(config)).ogun!.linear, KEY)

  const replaced = 'lin_api_YYYYYYYYYYYYYYYYYYYYYYYYYYYY'
  const connected = await ogun(
    ['connect', 'linear', '--api-key', '--replace', '--project', 'ogun'],
    config,
    `${replaced}\n`,
  )
  assert.equal(connected.code, 0, connected.stderr)
  // One row, replaced — not a second one beside it.
  assert.deepEqual(await secretsIn(config), { ogun: { linear: replaced } })
  assert.match(connected.stdout, /reconnected/)

  const listed = await ogun(['secret', 'list'], config)
  assert.match(listed.stdout, /linear/)
  assert.match(listed.stdout, /the linear poll/)
  assert.ok(!listed.stdout.includes(replaced), listed.stdout)
})

// ── a name that is already taken ──────────────────────────────────────────

test('an overwrite off a terminal is refused, and --replace is how a script means it', async (t) => {
  /**
   * The property: a piped `secret set` onto a name that already holds a value **fails**,
   * changes nothing, and names the flag — and with the flag it goes through.
   *
   * Overwriting is unrecoverable by ADR-0012's deliberate choice: no history, no second
   * slot, and a rotation window belongs to whoever issued the value. The question is who
   * may do that in silence, and off a terminal the answer is nobody, because there is
   * nobody to ask. A script that destroys a credential it did not know was there should
   * fail loudly once and gain a `--replace` that says what it does, rather than succeed
   * quietly every night.
   *
   * ADR-0012 considered a gate and rejected it, on the grounds that a `--yes` would be set
   * once in every script and never removed. That was written when this command took a name
   * from a closed set of one, on a project that had to already exist, so every replace
   * *was* the intended rotation. Free-form names collide; that is the premise that changed.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, HMAC)

  const second = 'whsec_ZZZZZZZZZZZZZZZZZZZZZZZZ'
  const refused = await ogun(
    ['secret', 'set', 'stripe-webhook', '--project', 'ogun'],
    config,
    second,
  )

  assert.equal(refused.code, 1, refused.stdout)
  assert.match(refused.stderr, /already has a stripe-webhook secret/)
  assert.match(refused.stderr, /--replace/)
  // The value that was there is untouched, and neither value is echoed.
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(second), refused.stderr)
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(HMAC), refused.stderr)

  const forced = await ogun(
    ['secret', 'set', 'stripe-webhook', '--replace', '--project', 'ogun'],
    config,
    second,
  )
  assert.equal(forced.code, 0, forced.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], second)
  assert.match(forced.stdout, /replaced for ogun/)
})

test('the gate is about a value, so a first set and a blank entry pass it', async (t) => {
  /**
   * The property: it fires on a value that would be destroyed and on nothing else.
   *
   * A first set has nothing to displace. A blank entry — only reachable by hand-editing the
   * file — is what a poller reads as a key that exists and does not work, so filling one in
   * is the repair `writeProjectKey` calls it rather than a replace, and asking permission
   * to perform a repair would be a gate on the fix. `--replace` where nothing is stored is
   * a no-op for the reason `rm -f` is: a script that has to know the answer in advance is a
   * script with a race in it.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter' },
      secrets: { ogun: { blank: '' } },
    }),
    { mode: 0o600 },
  )

  const first = await ogun(['secret', 'set', 'fresh', '--project', 'ogun'], config, HMAC)
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /fresh stored for ogun/)

  const repair = await ogun(['secret', 'set', 'blank', '--project', 'ogun'], config, HMAC)
  assert.equal(repair.code, 0, repair.stderr)
  assert.match(repair.stdout, /blank/)

  // And the flag on a name nothing holds is accepted, and still reports a plain store.
  const eager = await ogun(
    ['secret', 'set', 'brand-new', '--replace', '--project', 'ogun'],
    config,
    HMAC,
  )
  assert.equal(eager.code, 0, eager.stderr)
  assert.match(eager.stdout, /brand-new stored for ogun/)
})

test('both doors onto the row are gated identically, and --oauth is exempt on purpose', async (t) => {
  /**
   * The property: `ogun connect linear --api-key` gets the same refusal `ogun secret set
   * linear` gets, from the same function — and `--replace` is refused beside `--oauth`,
   * where there is no stored key to destroy.
   *
   * A rule enforced at one of two doors is not a rule, and this is the one place two
   * commands the same operator runs could disagree about destroying a credential. The OAuth
   * exemption is the line the rule is drawn on: a reconnect spends a client id and secret
   * that stay registered in the provider and replaces a token that was going to expire
   * anyway, so gating it would put a confirmation in front of the repair for a connection
   * that has just lapsed.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)

  const refused = await ogun(
    ['connect', 'linear', '--api-key', '--project', 'ogun'],
    config,
    'lin_api_WWWWWWWWWWWWWWWWWWWWWWWWWWWW\n',
  )
  assert.equal(refused.code, 1, refused.stdout)
  assert.match(refused.stderr, /already has a linear api key/)
  assert.match(refused.stderr, /--replace/)
  assert.equal((await secretsIn(config)).ogun!.linear, KEY)

  const wrongKind = await ogun(['connect', 'linear', '--replace', '--project', 'ogun'], config, '')
  assert.equal(wrongKind.code, 1)
  assert.match(wrongKind.stderr, /--replace is about a stored api key/)
})

test('a key behind a working grant is refused through this door too', async (t) => {
  /**
   * The property: `ogun secret set linear` gets the **same refusal** `ogun connect linear
   * --api-key` gets, from the same function, and names the same way out.
   *
   * A rule enforced at one of two doors is not a rule. `readProjectSecret` prefers a grant
   * over a key, so a key stored here would be a live credential in the file that nothing
   * reads — and the operator's next move when a poll fails is to rotate the key they just
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
            clientSecret: 'lin_secret_QQQQQQQQQQQQQQQQQQQQ',
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

  const set = await ogun(['secret', 'set', 'linear', '--project', 'ogun'], config, `${KEY}\n`)

  assert.equal(set.code, 1)
  assert.match(set.stderr, /already connected/)
  assert.match(set.stderr, /ogun disconnect linear/)
  assert.deepEqual(await secretsIn(config), {})

  // And a name that is *not* an integration is unaffected by the grant beside it.
  const other = await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, HMAC)
  assert.equal(other.code, 0, other.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
})

// ── which project ─────────────────────────────────────────────────────────

test('a project this machine has never heard of is refused, and nothing is stored', async (t) => {
  /**
   * The property: `secret set` checks the slug against the same oracle `connect` checks it
   * against, with the same escape.
   *
   * The bug, verbatim, from ADR-0012: `ogun project secret set heirchive-api linear` on a
   * machine whose only project is `ogun` printed a success line and wrote a live key under
   * a slug nothing would ever poll. The check lives in `requireKnownProject`, shared, so
   * that a rule cannot exist at one door and not the other.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(
    ['secret', 'set', 'stripe-webhook', '--project', 'heirchive-api'],
    config,
    HMAC,
  )
  assert.equal(set.code, 1)
  assert.match(set.stderr, /Known here: ogun/)
  assert.deepEqual(await secretsIn(config), {})

  const forced = await ogun(
    ['secret', 'set', 'stripe-webhook', '--project', 'heirchive-api', '--allow-unregistered'],
    config,
    HMAC,
  )
  assert.equal(forced.code, 0, forced.stderr)
  assert.equal((await secretsIn(config))['heirchive-api']!['stripe-webhook'], HMAC)
  assert.match(forced.stdout, /not a project this machine knows/)
})

// ── listing ───────────────────────────────────────────────────────────────

test('the listing says what reads each value, and never what it is', async (t) => {
  /**
   * The property: `READ BY` distinguishes three states that look identical in the file —
   * a value something polls with, a value nothing in this build reads, and a value an
   * OAuth grant has taken over — and no column anywhere could hold the value itself.
   *
   * The third one is the same sentence `ogun connect list` prints for the same row. Two
   * listings that disagreed about whether a stored key is live would cost an evening,
   * which is exactly what having two listings cost before they were merged.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      projects: { ogun: '/does/not/matter', other: '/nor/this' },
      secrets: {
        ogun: { linear: KEY, 'stripe-webhook': HMAC },
        other: { linear: 'lin_api_OTHEROTHEROTHEROTHEROTHER' },
      },
      oauth: {
        other: {
          linear: {
            clientId: 'client-1',
            clientSecret: 'lin_secret_QQQQQQQQQQQQQQQQQQQQ',
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

  const listed = await ogun(['secret', 'list'], config)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /stripe-webhook\s+set\s+a project's env: \{ secret: … \}/)
  assert.match(listed.stdout, /ogun\s+linear\s+set\s+the linear poll/)
  assert.match(listed.stdout, /other\s+linear\s+set\s+nothing — the linear grant wins/)
  assert.ok(!listed.stdout.includes(KEY), listed.stdout)
  assert.ok(!listed.stdout.includes(HMAC), listed.stdout)

  // It answers for the machine wherever it is run from, and narrows only on request.
  const filtered = await ogun(['secret', 'list', '--project', 'other'], config)
  assert.ok(!filtered.stdout.includes('stripe-webhook'), filtered.stdout)

  // `ogun secret --project x` is a filter, not a subcommand called "--project".
  const bare = await ogun(['secret', '--project', 'other'], config)
  assert.equal(bare.code, 0, bare.stderr)
  assert.ok(!bare.stdout.includes('stripe-webhook'), bare.stdout)
})

// ── removing ──────────────────────────────────────────────────────────────

test('rm checks nothing, and says when it found nothing', async (t) => {
  /**
   * The property: `rm` will remove what `list` shows — including rows `set` would refuse to
   * create — and a removal that found nothing is a *different* answer, said in a colour,
   * naming the project it looked in.
   *
   * §4.5 says `~/.ogun/config.json` gets hand-edited and the listing reports whatever it
   * finds, so a row an operator can see has to be a row they can remove; refusing would
   * strand a live credential in the file with the listing still advertising it. The no-op
   * matters because the project is inferred from the directory, so an `rm` run one level
   * too high is a plausible way to reach it.
   */
  const dir = await box(t)
  const config = join(dir, 'config.json')
  await writeFile(
    config,
    // A name `set` would refuse today, put there by a hand-edit or an older build.
    JSON.stringify({ projects: {}, secrets: { 'heirchive-api': { LEGACY_NAME: HMAC } } }),
    { mode: 0o600 },
  )

  const removed = await ogun(
    ['secret', 'rm', 'LEGACY_NAME', '--project', 'heirchive-api'],
    config,
  )
  assert.equal(removed.code, 0, removed.stderr)
  assert.deepEqual(await secretsIn(config), {})

  const again = await ogun(['secret', 'rm', 'LEGACY_NAME', '--project', 'heirchive-api'], config)
  assert.match(again.stdout, /has no LEGACY_NAME secret/)
  // Still exit 0: a removal that finds nothing has reached the state it was asked for, and
  // `ogun secret rm x || true` is not a line anybody should have to write.
  assert.equal(again.code, 0)
})

test('removing a key does not disconnect, and says so', async (t) => {
  /**
   * The property: `secret rm linear` on a project with a live OAuth grant reports that the
   * project is **still connected**.
   *
   * Otherwise the command reads as "Ogun can no longer reach Linear", which is false — the
   * grant is what a poll was using anyway — and the operator finds out when a poll they
   * meant to stop keeps working. A grant is not a secret and this command cannot touch one;
   * naming `ogun disconnect` is the only honest thing it can do.
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
            clientSecret: 'lin_secret_QQQQQQQQQQQQQQQQQQQQ',
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

  const removed = await ogun(['secret', 'rm', 'linear', '--project', 'ogun'], config)
  assert.equal(removed.code, 0, removed.stderr)
  assert.deepEqual(await secretsIn(config), {})
  assert.match(removed.stdout, /still connected to linear as an application/)
  assert.match(removed.stdout, /ogun disconnect linear/)
})

// ── the help page is the acceptance bar ───────────────────────────────────

test('the usage lines name every input, including the ones that are not arguments', async (t) => {
  /**
   * The property: `<key>` is in the signature, and the page says where it comes from when
   * it is left out.
   *
   * `<key>` is a positional where `connect`'s credentials are flags, and the rule behind
   * both is one sentence: **a lone value can be positional; several credential values of
   * the same shape must be named.** There is nothing here for it to be confused with —
   * `<name>` is not a credential and does not look like one.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const help = await ogun(['secret', 'set', '--help'], config)
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /ogun secret set <name> <key> \[--replace\]/)
  assert.match(help.stdout, /prompt/)
  assert.match(help.stdout, /stdin/)
  assert.match(help.stdout, /proc/)
  assert.match(help.stdout, /history/)
  // `--replace` is an input this command needs in the case it needs it, so it is in the
  // signature and not only in the flag list — the bar that has been missed four times.
  assert.match(help.stdout, /--replace/)

  // The other door onto the same row names it in its own signature, for the same reason.
  const connectHelp = await ogun(['connect', '--help'], config)
  assert.match(connectHelp.stdout, /--api-key \[<key>\] \[--replace\]/)

  // And the overlap with `connect` is stated where somebody choosing between them looks.
  const page = await ogun(['secret', '--help'], config)
  assert.match(page.stdout, /ogun connect linear --api-key/)
  assert.match(page.stdout, /same slot/)

  const bare = await ogun(['secret', 'set'], config)
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /ogun secret set <name> <key> \[--replace\]/)
})
