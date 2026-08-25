import { readFile } from 'node:fs/promises'
import {
  LocalConfigError,
  localConfigPath,
  parseLocalConfig,
  updateLocalConfig,
  type LocalConfig,
} from './machine.ts'

/**
 * A project's own API keys — the ones nobody's machine already has.
 *
 * `gh` and `claude` are on the host because a human logged in with them, so ADR-0010 only
 * had to decide *who reads the file*. A Linear key is not like that: it is issued per
 * workspace, nothing on the machine has one, and it has to be typed in once and kept.
 * That makes it the first secret Ogun is responsible for storing rather than borrowing.
 *
 * Where it is kept and why is ADR-0012. The short version, because it is the thing a
 * reader of this file needs: `~/.ogun/config.json`, beside the admin token and the runner
 * credential, on the machine that runs the control plane — because the control plane is
 * what polls (§4.13), and a value that never enters postgres cannot ride out on a row
 * that happens to be returned by an endpoint.
 *
 * Three rules hold everything here together, and each of them is a failure that has
 * already happened somewhere in this repo:
 *
 *  1. **Never in `.ogun/config.yaml`.** That file is committed. There is no code path
 *     from here to it — `projectConfigSchema` has no field a secret could land in, and
 *     the CLI command that writes one writes only to the machine file.
 *  2. **Never in a sandbox.** Nothing on the runner reads this module. The value is not on
 *     `claimedJobSchema`, so it cannot cross the wire to a runner; the runner is the only
 *     thing that builds `docker run`, so there is no route to a container's argv; and
 *     `~/.ogun/config.json` is not in `credentialMounts()`, which is an allowlist. The
 *     bundled CLI in the image *does* contain this code, and finds nothing, because the
 *     store is not mounted (`packages/runner/test/sandbox-secrets.test.ts`).
 *  3. **Never in a log line or an error message.** A read never hands back a bare string
 *     — `Secret` below survives `console.log`, `JSON.stringify` and string interpolation
 *     as `[redacted]` — and no error raised here quotes the value it is about. That
 *     second half is not hypothetical: `bbaa036` had to strip a credential out of a
 *     rejected `execFile`'s message, and `JSON.parse` has the same habit (see
 *     `machine.ts`'s note on why the parser's own message is now withheld).
 */

/**
 * The secrets Ogun knows how to use, as a closed set.
 *
 * Closed rather than free-form because of the failure `inertPolicies` exists for
 * elsewhere: a key that nothing reads is indistinguishable from a key that works, right
 * up until the night it mattered. `ogun project secret set ogun linaer` typed at 1am
 * would otherwise store a secret, print success, and leave the poller unauthenticated
 * with no evidence anywhere connecting the two.
 *
 * A name is added here when the code that reads it lands, not before.
 */
export const SECRET_NAMES = ['linear'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export const isSecretName = (name: string): name is SecretName =>
  (SECRET_NAMES as readonly string[]).includes(name)

const REDACTED = '[redacted]'

/** `util.inspect` looks this symbol up by registry name; importing `node:util` for it
 *  would pull a module into a path that only needs the key. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * A secret that has to be asked for by name before it is a string.
 *
 * The naive return type is `string`, and it is wrong for one reason: a string goes
 * everywhere its holder goes. `console.error('linear poll failed', { key })`, a Zod issue
 * that echoes its input, an `assert.deepEqual` diff in a test, a thrown error whose
 * `cause` chain is printed — none of those are written by anyone thinking about
 * credentials, and every one of them puts the value somewhere nothing cleans it. That is
 * exactly the shape of the leak `redactUrlCredentials` was merged for: not a disclosure
 * to a new audience, a loss of containment.
 *
 * So the value lives in a closure rather than in a field. It is not an own property, so
 * it does not survive a spread, does not appear under `Object.keys`, and is not visible
 * in a debugger's property list; and the three ways a value ordinarily turns itself into
 * text — `toString`, `toJSON`, and Node's inspector — all answer `[redacted]`.
 *
 * `expose()` is deliberately ugly to read at a call site. Reaching for it should look like
 * a decision, and there should be exactly one place per consumer that does.
 */
export type Secret = {
  /** The real value. Call this at the wire and nowhere else. */
  expose: () => string
  toString: () => string
  toJSON: () => string
}

export function sealSecret(value: string): Secret {
  const sealed: Secret = {
    expose: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  }
  // Non-enumerable, so the seal itself does not show up in the object it protects.
  Object.defineProperty(sealed, INSPECT, { value: () => REDACTED })
  return sealed
}

/**
 * What reading a project's secret can tell you, kept as four separate facts.
 *
 * Principle 6 in its narrowest form. A poller that cannot tell these apart has one
 * behaviour for all of them — stop, log "no Linear key" — and three of the four are then
 * misreported:
 *
 *  - `absent` — nobody has set one. The fix is `ogun project secret set`.
 *  - `empty` — an entry exists and holds nothing. Only reachable by hand-editing the
 *    file, which §4.5 says people do, and the write path here refuses to create it. It is
 *    kept apart from `absent` because the fixes differ: one is "set it", the other is
 *    "something wrote a blank over the one you set", and collapsing them hides a
 *    destructive write behind a routine-looking message.
 *  - `unreadable` — the store is there and could not be read or parsed. Reporting this as
 *    `absent` would tell an operator to set a secret they already set, and would let a
 *    config.json broken by an unrelated edit look like a project that was never
 *    configured.
 *  - `present` — and even then the value only arrives sealed.
 */
export type ProjectSecret =
  | { state: 'present'; secret: Secret }
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'unreadable'; reason: string }

/**
 * **The seam.** The one function the Linear source calls to authenticate a poll.
 *
 * ```ts
 * const key = await readProjectSecret(project.slug, 'linear')
 * if (key.state !== 'present') return skipped(key.state)   // never a throw, never a retry
 * headers.set('authorization', key.secret.expose())
 * ```
 *
 * Async and unmemoised on purpose. A rotation is a file write (`ogun project secret set`
 * again), and the whole point of rotating in place is that the next poll picks it up
 * without restarting the control plane. Against a poll interval of minutes, re-reading a
 * small file costs nothing; the gateway's five-second credential memo exists because it
 * is on a per-request path, and this is not.
 *
 * Total — it does not throw. A poller is a loop that must keep its own schedule, and an
 * exception out of the credential lookup is the one that gets caught by whatever `catch`
 * is nearest and reported as "Linear is unreachable", which names the wrong thing.
 */
export async function readProjectSecret(
  projectSlug: string,
  name: SecretName,
  path = localConfigPath(),
): Promise<ProjectSecret> {
  const store = await readStore(path)
  if (store.state === 'missing') return { state: 'absent' }
  if (store.state === 'unreadable') return { state: 'unreadable', reason: store.reason }

  const stored = store.config.secrets[projectSlug]?.[name]
  if (stored === undefined) return { state: 'absent' }
  if (stored.trim() === '') return { state: 'empty' }
  return { state: 'present', secret: sealSecret(stored) }
}

/**
 * Which secrets this machine holds, as names and states — never values.
 *
 * A list endpoint is where secrets leak, so the answer to "should anything list them" is
 * yes and the answer to "should a listing be able to return one" is no, structurally:
 * `ProjectSecretPresence` has no field a value fits in, so `doctor`, `GET /api/system`
 * and the UI cannot leak one by rendering what they were given. The value-returning
 * function above is reachable only from the control plane's own polling code, and from no
 * HTTP route at all.
 *
 * This one throws where `readProjectSecret` returns a state, and the asymmetry is
 * deliberate. Its callers are commands and requests — things with an operator in front of
 * them and a natural place to print an error. `readProjectSecret`'s caller is a loop at
 * 2am with no such place.
 */
export type ProjectSecretPresence = {
  project: string
  name: string
  /** No `absent`: a secret nobody set has no row here. Only what is actually stored. */
  state: 'present' | 'empty'
}

export async function listProjectSecrets(
  path = localConfigPath(),
): Promise<ProjectSecretPresence[]> {
  const store = await readStore(path)
  if (store.state === 'missing') return []
  if (store.state === 'unreadable') throw new LocalConfigError(store.reason)

  return Object.entries(store.config.secrets)
    .flatMap(([project, entries]) =>
      Object.entries(entries).map(([name, value]) => ({
        project,
        name,
        state: value.trim() === '' ? ('empty' as const) : ('present' as const),
      })),
    )
    .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name))
}

/**
 * Store a secret, replacing whatever was there.
 *
 * **Rotation is a plain overwrite, and there is no history.** The alternative — keeping
 * the previous value so both work for a window — was rejected on two counts. A rotation
 * window is the *provider's* to offer: Linear's answer is to mint a second key and revoke
 * the first, which needs nothing from us. And two live values in one store means that when
 * a poll 401s, nothing can say which of them it used, so the one question a rotation
 * actually raises becomes unanswerable. A superseded secret that is still accepted is also
 * a credential nobody is watching.
 *
 * The write goes through `updateLocalConfig`, which is the reason this lives in the
 * machine file rather than in a file of its own. That function already writes into a fresh
 * 0600 file and renames it — because `writeFile`'s `mode` applies only on create, which
 * left a restored config.json world-readable while a token was written into it — and it
 * already serialises writers under a lock, because concurrent read-modify-write silently
 * dropped whichever edit lost. A second secret file would be a second chance to get both
 * of those wrong, and they were not cheap to get right the first time.
 */
export async function setProjectSecret(
  projectSlug: string,
  name: SecretName,
  value: string,
  path = localConfigPath(),
): Promise<void> {
  // Returns void rather than the updated config. `updateLocalConfig` hands back the whole
  // `LocalConfig`, which now has live secrets in it, and a caller who logged the result of
  // "set" would be logging the thing it just set.
  await updateLocalConfig(
    (config) => ({
      ...config,
      secrets: {
        ...config.secrets,
        [projectSlug]: { ...config.secrets[projectSlug], [name]: value },
      },
    }),
    path,
  )
}

/**
 * Forget a secret. True if there was one to forget.
 *
 * The distinction is the point: "removed" and "there was nothing here" are different
 * answers, and a command that prints the first for both teaches its user that it worked
 * when they removed it from the wrong project.
 *
 * An emptied project drops out entirely rather than being left as `{}`, so that a
 * subsequent read is `absent` — the state that means nobody set one — rather than a
 * project that exists in the store holding nothing.
 */
export async function clearProjectSecret(
  projectSlug: string,
  name: SecretName,
  path = localConfigPath(),
): Promise<boolean> {
  let existed = false
  await updateLocalConfig((config) => {
    const entries = config.secrets[projectSlug]
    if (!entries || !(name in entries)) return config
    existed = true
    const { [name]: _removed, ...rest } = entries
    const { [projectSlug]: _project, ...others } = config.secrets
    return {
      ...config,
      secrets: Object.keys(rest).length > 0 ? { ...others, [projectSlug]: rest } : others,
    }
  }, path)
  return existed
}

export class InvalidSecret extends Error {}

/**
 * Clean up what arrived on stdin or out of a prompt, and refuse what cannot work.
 *
 * Whitespace goes first, and the trailing newline is why. `ogun project secret set ogun
 * linear < key.txt` and `pbpaste | ogun …` both deliver a value with `\n` on the end, and
 * an API key is not a whitespace-delimited token — so the naive implementation stores the
 * newline. What happens then is genuinely hard to diagnose: the value becomes an
 * `authorization` header, undici rejects a header containing a control character with
 * `ERR_INVALID_CHAR`, and the poll fails with an error naming neither Linear nor the key.
 * The variant that does not throw is worse — a leading space is accepted by `fetch` and
 * rejected by the provider, so a correct key reads as a wrong one.
 *
 * The refusals are the same rule applied where it can still be explained to a person.
 *
 * Neither error quotes the value, including the "contains a control character" one, which
 * is the tempting place to show what was found. The whole input is the secret; a message
 * naming the character and its offset is a message that has narrowed it.
 */
export function normalizeSecretInput(raw: string): string {
  const value = raw.trim()
  if (value === '') {
    throw new InvalidSecret(
      'that was empty. Nothing was stored — an empty secret is not a way to remove one, ' +
        'and it would be read as a key that exists and does not work',
    )
  }
  // Written as escapes rather than as literal bytes: a source file that contains a real
  // NUL is a source file that tooling mangles.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new InvalidSecret(
      'that contains a control character in the middle of it, so it is almost certainly ' +
        'two lines or a copy that picked up a stray byte. Nothing was stored',
    )
  }
  return value
}

// ── reading the store ──────────────────────────────────────────────────────

type Store =
  | { state: 'read'; config: LocalConfig }
  /** No config.json at all — a machine nobody has set up, which is not a failure. */
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }

/**
 * Read and parse the machine file, keeping "there is no file" apart from "I could not read
 * the file".
 *
 * `loadLocalConfig` cannot be used here, and the reason is worth stating rather than
 * working around silently: it catches *every* read failure and returns an empty config, so
 * a config.json that exists at 0600 owned by another user — or on a filesystem that just
 * went away — comes back looking exactly like a machine that was never set up. That is a
 * defensible default for the projects map, where the consequence is cloning from a remote
 * instead of from disk. It is not defensible for a credential, where it turns "I could not
 * look" into "there is nothing there" (principle 6).
 */
async function readStore(path: string): Promise<Store> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', reason: `${path} could not be read (${code ?? 'unknown'})` }
  }
  try {
    return { state: 'read', config: parseLocalConfig(text, path) }
  } catch (err) {
    // `parseLocalConfig` is already careful not to quote the file's contents back —
    // see the note there on what `JSON.parse` puts in its own message — so this can be
    // forwarded as it stands.
    return { state: 'unreadable', reason: (err as Error).message }
  }
}
