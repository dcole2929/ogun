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
 *  - a name that could be a pasted API key is refused **by shape**, without being echoed;
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

test('a free-form name is stored, and the command says nothing reads it', async (t) => {
  /**
   * The property: `ogun secret set stripe-webhook` **works**, and prints a line saying
   * that nothing in this build reads that name.
   *
   * Both halves matter and they pull against each other. The store has to accept arbitrary
   * names or it is not a store — that is the whole reversal. But `SECRET_NAMES` was a
   * closed set for a reason that does not go away: *"a secret nothing reads looks exactly
   * like one that works, right up until the night it mattered."* A free-form store cannot
   * refuse, so the fact moves from a refusal to a sentence at the one moment somebody is
   * looking at the screen — and it names the set Ogun *does* poll under, which for a set
   * of one is also the did-you-mean.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', 'stripe-webhook', '--project', 'ogun'], config, HMAC)

  assert.equal(set.code, 0, set.stderr)
  assert.equal((await secretsIn(config)).ogun!['stripe-webhook'], HMAC)
  assert.equal(((await stat(config)).mode & 0o777).toString(8), '600')

  assert.match(set.stdout, /Nothing in this build reads a secret named stripe-webhook/)
  assert.match(set.stdout, /linear/)
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
  assert.ok(!/Nothing in this build reads/.test(set.stdout), set.stdout)
})

test('a name that could be a pasted key is refused by shape, and not echoed', async (t) => {
  /**
   * The property: `ogun secret set lin_api_…` fails, and the failure does not contain what
   * was typed.
   *
   * This is the accident the shape rule exists for and it cannot be caught by counting
   * arguments: leaving `<key>` off is the *recommended* invocation, so somebody who
   * remembered that the key does not belong in argv and forgot that the name does looks
   * identical to somebody asking to be prompted. It can be caught by shape — an API key is
   * long, or mixed case, or has underscores, and Linear's has all three — and a name is
   * none of those.
   *
   * Not echoing is ADR-0012's rule arriving at a second door: quoting the argument back
   * would write a live credential to stderr on top of the shell history and the `ps`
   * window it is already in.
   */
  const config = await machineKnowing(t, { ogun: '/does/not/matter' })

  const set = await ogun(['secret', 'set', KEY, '--project', 'ogun'], config, 'x\n')

  assert.equal(set.code, 1)
  assert.ok(!`${set.stdout}${set.stderr}`.includes(KEY), set.stderr)
  assert.match(set.stderr, /not a secret name/)
  assert.match(set.stderr, /compromised/)
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
   * same place.
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
    ['connect', 'linear', '--api-key', '--project', 'ogun'],
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
  assert.match(listed.stdout, /stripe-webhook\s+set\s+nothing in this build/)
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
  assert.match(help.stdout, /ogun secret set <name> <key>/)
  assert.match(help.stdout, /prompt/)
  assert.match(help.stdout, /stdin/)
  assert.match(help.stdout, /proc/)
  assert.match(help.stdout, /history/)

  // And the overlap with `connect` is stated where somebody choosing between them looks.
  const page = await ogun(['secret', '--help'], config)
  assert.match(page.stdout, /ogun connect linear --api-key/)
  assert.match(page.stdout, /same slot/)

  const bare = await ogun(['secret', 'set'], config)
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /ogun secret set <name> <key>/)
})
