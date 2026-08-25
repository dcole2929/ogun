import { readFile } from 'node:fs/promises'
import {
  LocalConfigError,
  localConfigPath,
  parseLocalConfig,
  updateLocalConfig,
  type LocalConfig,
} from './machine.ts'
/**
 * Type-only, and therefore not an edge at runtime: `import type` is erased, so `config/`
 * still pulls nothing from `integrations/` when this module loads. The alternative was a
 * second declaration of the same two string literals here, and two spellings of a value
 * that is written into a credential file is exactly the drift that makes an old build read
 * a new build's grant as malformed.
 */
import type { LinearGrantType } from '../integrations/linear-oauth.ts'

/**
 * A project's own credentials — the ones nobody's machine already has.
 *
 * Two shapes now, in two blocks of one file: a personal API key a person typed
 * (`secrets`, ADR-0012), and an OAuth grant Ogun obtained for itself (`oauth`, ADR-0014).
 * One module reads and writes both, and one function — `readProjectSecret` — decides which
 * of them a poll authenticates with, so precedence exists in exactly one place.
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
 *     from here to it — `projectConfigSchema` has no field a secret could land in, and the
 *     two things that write one, `ogun secret set` and the Settings page's route, both
 *     go through this module and therefore only into the machine file.
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
 * up until the night it mattered. `ogun secret set linaer` typed at 1am would otherwise
 * store a secret, print success, and leave the poller unauthenticated with no evidence
 * anywhere connecting the two.
 *
 * A name is added here when the code that reads it lands, not before.
 *
 * ### Why the OAuth client secret is *not* a name here
 *
 * It is the obvious candidate — a value a human types, stored on this machine, used to
 * authenticate — and adding `linear-oauth-client-secret` was the first shape tried. It is
 * wrong, and it fails through the exact door this closed set was built to close.
 *
 * These names are what the Settings page renders in a dropdown and what `list` reports as
 * `set`. A client secret stored on its own is not a credential: it authenticates nothing
 * without the client id beside it and a grant obtained with the pair. So an operator would
 * paste one, see the row go green, see `ogun secret list` agree, and have a project
 * that authenticates to nothing — "a secret nothing reads looks exactly like one
 * that works, right up until the night it mattered", arriving through the listing that
 * sentence is written under.
 *
 * So the closed set stays closed and stays about *values used verbatim as credentials*.
 * The application is written as a unit by the connect flow, which registers the id and the
 * secret together and proves the pair by spending it — see `setOAuthApp` below.
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
 * What reading a project's credential can tell you, kept as separate facts.
 *
 * Principle 6 in its narrowest form. A poller that cannot tell these apart has one
 * behaviour for all of them — stop, log "no Linear key" — and all but one are then
 * misreported:
 *
 *  - `granted` — an OAuth grant (ADR-0014). Sent as `Bearer`, and it **wins over an API
 *    key**; `apiKeyIgnored` says whether one is sitting behind it, because an operator
 *    rotating a key that nothing reads is an hour gone.
 *  - `unconnected` — an OAuth application is registered for this project, nobody finished
 *    the authorization, and there is no key to fall back to. The fix is a browser rather
 *    than a terminal, and reporting it as `absent` would send somebody who has already
 *    done half the work off to paste a personal key instead.
 *  - `malformed` — this project's OAuth entry is not a shape this build can read. Kept
 *    apart from `unreadable` below because the fix is to reconnect one project, where
 *    `unreadable` means a config.json that is currently failing to parse for everything
 *    on the machine.
 *  - `absent` — nobody has set one. The fix is `ogun secret set`.
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
  | { state: 'granted'; grant: OAuthGrant; apiKeyIgnored: boolean }
  | { state: 'present'; secret: Secret }
  | { state: 'unconnected'; clientId: string }
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'malformed'; reason: string }
  | { state: 'unreadable'; reason: string }

/**
 * **The seam.** The one function the Linear source calls to authenticate a poll.
 *
 * ```ts
 * const key = await readProjectSecret(project.slug, 'linear')
 * if (key.state === 'granted') return bearer(key.grant)    // ADR-0014, and it wins
 * if (key.state !== 'present') return skipped(key.state)   // never a throw, never a retry
 * headers.set('authorization', key.secret.expose())        // raw, with no prefix
 * ```
 *
 * ### Precedence lives here, in one function, so it cannot be decided twice
 *
 * **An OAuth grant wins over a personal API key.** The alternative was seriously
 * considered — prefer whichever was set most recently, or prefer the key on the grounds
 * that it is what the operator most recently touched — and both lose to the same argument.
 * A grant exists only because somebody deliberately ran an authorization flow and a
 * workspace admin approved an application; a personal key is very often a leftover from
 * before that, still in the store because nothing asked for it to be removed. Preferring
 * the leftover would mean a connection an operator just made silently does nothing, and
 * — once write-back lands — that every comment Ogun posts appears under their own name
 * after they connected an application precisely so that it would not.
 *
 * Falling *back* to a key when a grant has expired is the other tempting rule, and it is
 * rejected outright. A grant whose refresh has stopped working is a fact the operator has
 * to see; quietly authenticating as a person instead hides a broken connection behind a
 * working poll, and changes who Linear attributes writes to without anyone asking. A dead
 * grant refuses the poll and names the credential that died.
 *
 * A refresh is deliberately **not** here. It needs a network round trip and a write, and
 * both belong to the caller: this function is called by a loop at 3am whose nearest
 * `catch` would report a failed token exchange as "Linear is unreachable" — the exact
 * misnaming the four states existed to prevent.
 *
 * Async and unmemoised on purpose. A rotation is a file write (`ogun secret set` again),
 * and the whole point of rotating in place is that the next poll picks it up
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
  const apiKey: ProjectSecret =
    stored === undefined
      ? { state: 'absent' }
      : stored.trim() === ''
        ? { state: 'empty' }
        : { state: 'present', secret: sealSecret(stored) }

  const raw = store.config.oauth[projectSlug]?.[name]
  if (raw === undefined) return apiKey

  const app = parseOAuthApp(raw)
  if (!app.ok) return { state: 'malformed', reason: app.reason }
  if (app.app.grant) {
    return { state: 'granted', grant: app.app.grant, apiKeyIgnored: apiKey.state === 'present' }
  }
  /**
   * Registered but never authorized. A key beside it still works and is *not* shadowed by
   * an application nobody has connected: this is the ordinary state of a project halfway
   * through the migration, and refusing it would break a working poll to make a point.
   */
  if (apiKey.state === 'present') return apiKey
  return { state: 'unconnected', clientId: app.app.clientId }
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
 *
 * ### It reports what it displaced
 *
 * The overwrite is the right behaviour and it was also, for two days, an invisible one:
 * `ogun project secret set` printed the same four lines whether it had stored the first
 * key for a project or destroyed a working one, with only a character count differing. The
 * only mention of replacement was boilerplate that printed either way, which is to say it
 * carried no information about what had happened. So the caller is told.
 *
 * The previous state is read *inside* the updater, under `updateLocalConfig`'s lock and in
 * the same read-modify-write that performs the change. A caller that checked first and
 * wrote second would be reporting a fact from before the lock — usually right, wrong
 * exactly when two writers race, which is the case the lock exists for.
 *
 * It is `ProjectSecretPresence['state'] | 'absent'` and not the old value, and not the
 * updated config either. `updateLocalConfig` hands back the whole `LocalConfig`, which now
 * has live secrets in it, and a caller who logged the result of "set" would be logging the
 * thing it just set. A three-state enum has no field a value fits in — the same property
 * `ProjectSecretPresence` is built on, for the same reason.
 */
export type DisplacedSecret = 'absent' | 'present' | 'empty'

export async function setProjectSecret(
  projectSlug: string,
  name: SecretName,
  value: string,
  path = localConfigPath(),
): Promise<DisplacedSecret> {
  let displaced: DisplacedSecret = 'absent'
  await updateLocalConfig(
    (config) => {
      const previous = config.secrets[projectSlug]?.[name]
      // `empty` is worth keeping apart from `absent`: a blank entry is only reachable by
      // hand-editing the file, and a poller reads it as a key that exists and does not
      // work. "replaced" is a misleading word for it and "stored" is a wrong one.
      displaced =
        previous === undefined ? 'absent' : previous.trim() === '' ? 'empty' : 'present'
      return {
        ...config,
        secrets: {
          ...config.secrets,
          [projectSlug]: { ...config.secrets[projectSlug], [name]: value },
        },
      }
    },
    path,
  )
  return displaced
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
 *
 * `name` is a plain string here where `setProjectSecret` takes a `SecretName`, and the
 * asymmetry is deliberate. The closed set exists to stop a *write* creating a key nothing
 * reads; removal creates nothing. What it has to cover is everything the store can
 * actually hold, and that is wider than `SECRET_NAMES`: §4.5 says `~/.ogun/config.json`
 * gets hand-edited, `listProjectSecrets` reports whatever it finds, and the Settings page
 * renders that. A row a person can see and cannot remove is a live credential stranded in
 * the file by a validator meant to protect it.
 */
export async function clearProjectSecret(
  projectSlug: string,
  name: string,
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
 * Clean up what arrived on stdin, out of a prompt, or in a request body, and refuse what
 * cannot work.
 *
 * Whitespace goes first, and the trailing newline is why. `ogun secret set linear <
 * key.txt` and `pbpaste | ogun …` both deliver a value with `\n` on the end, and an API
 * key is not a whitespace-delimited token — so the naive implementation stores the
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

// ── an OAuth grant, which is the other way a project authenticates ─────────

/**
 * The application a project's OAuth grant belongs to, as it sits in the store.
 *
 * `clientId` is deliberately a plain string and the two token fields are not. A client id
 * is in every authorization URL the operator's browser visits and on Linear's own settings
 * page; treating it as a secret would mean `doctor` and the Settings page could not say
 * *which* application a project is connected as, which is the first question the moment
 * two workspaces are involved. The client secret, the access token and the refresh token
 * are sealed by the same `Secret` the API key uses, for the same reason.
 *
 * `redirectUri` is stored rather than derived. The token exchange has to send the *same*
 * `redirect_uri` the authorization used and Linear enforces that, so the value that was
 * actually used must survive the round trip. It is also the string the operator pasted
 * into Linear's registration form, and showing it back is how a mismatch — the classic
 * failure of this flow, and the one Linear's own error is least helpful about — becomes
 * something you can see instead of something you guess at.
 */
export type OAuthApp = {
  clientId: string
  clientSecret: Secret
  redirectUri: string
  /** Absent until somebody completes the authorization. A registered application is not a
   *  connection, and the two must never render as the same thing. */
  grant: OAuthGrant | undefined
}

/**
 * What Linear handed back, kept as the facts rather than as the response.
 *
 * The two tokens are sealed and everything beside them is not, and that split is the whole
 * reason this is a record in its own block rather than a JSON blob in the `secrets` map.
 * `doctor` prints `oauth, 7h left`, the Settings page shows the workspace and the scopes,
 * and the poll decides whether to refresh — all from fields that are not credentials. If
 * the expiry lived inside an opaque sealed string, every one of those callers would have
 * to `expose()` a token to read the number next to it, and ADR-0012's "expose() appears
 * once per consumer, at the wire" would be false by construction.
 *
 * `expiresAt` is absolute ms, not the `expires_in` seconds Linear sends. A duration is
 * only true at the instant it was received: stored raw, a config.json read after a restart
 * would say the token has 24 hours left forever. `CredentialExpiry`'s `{ kind: 'at' }`
 * made the same choice for the same reason, and this converts into it.
 *
 * `scopes` is what Linear *granted*, taken from the token response, because there is no
 * introspection endpoint anywhere in their API — the token response is the only place
 * granted scopes are ever reported. A grant that does not record them can never answer
 * "may this token comment?" except by trying it and reading the failure.
 *
 * `appUserId` is `viewer.id` under `actor=app`, which Linear's agent documentation asks
 * integrations to store beside the token so an app can recognise its own writes in a
 * workspace. Nothing reads it yet. It is recorded now because it is only obtainable while
 * holding a live token, and the write path that could obtain it runs once.
 */
export type OAuthGrant = {
  clientId: string
  access: Secret
  /**
   * **Absent for a `client_credentials` grant, and that is not a degraded state.**
   *
   * ADR-0014 refused to store a grant with no refresh token, on the grounds that a token
   * with no way to renew it is a connection that dies without warning. That was true when
   * the only renewal Ogun had was a refresh token. It is not true of the grant that is now
   * the default: renewing a `client_credentials` token means asking again with the client
   * id and secret that are already in this file, which needs no person, spends nothing,
   * and can be repeated. Which is why `grantType` is beside this field rather than being
   * inferred from whether it is set — the presence of a refresh token is a *consequence*
   * of the grant, and reading the consequence backwards would make a truncated write look
   * like a deliberate choice.
   */
  refresh?: Secret
  /**
   * Which grant produced this, in RFC 6749's names, which are also Linear's.
   *
   * It decides how the token is renewed and therefore what a renewal can cost, so it is
   * recorded rather than guessed. A grant written by the build before this one has no such
   * field and is read as `authorization_code`, because that is the only thing that build
   * could have written — see `parseOAuthApp`.
   */
  grantType: LinearGrantType
  /** Absolute, ms since epoch. */
  expiresAt: number
  obtainedAt: number
  /** As granted, not as requested. */
  scopes: string[]
  /** `app` or `user` — who Linear attributes a write to. Fixed at authorization time. */
  actor: string
  workspace?: { id: string; name: string; urlKey: string }
  appUserId?: string
}

/**
 * The application, including its client secret — for the two writers that need it.
 *
 * Separate from `readProjectSecret` because it answers a different question for a
 * different audience. The poll asks "what do I authenticate with" and must never be handed
 * a client secret it has no use for; the token exchange and the refresh ask "what
 * application is this" and need the secret precisely because they are the wire. Keeping
 * them apart means there is exactly one caller of `clientSecret.expose()`, in one file.
 */
export type ProjectOAuth =
  | { state: 'present'; app: OAuthApp }
  | { state: 'absent' }
  | { state: 'malformed'; reason: string }
  | { state: 'unreadable'; reason: string }

export async function readOAuthApp(
  projectSlug: string,
  provider: SecretName,
  path = localConfigPath(),
): Promise<ProjectOAuth> {
  const store = await readStore(path)
  if (store.state === 'missing') return { state: 'absent' }
  if (store.state === 'unreadable') return { state: 'unreadable', reason: store.reason }
  const raw = store.config.oauth[projectSlug]?.[provider]
  if (raw === undefined) return { state: 'absent' }
  const parsed = parseOAuthApp(raw)
  return parsed.ok
    ? { state: 'present', app: parsed.app }
    : { state: 'malformed', reason: parsed.reason }
}

/**
 * Register (or replace) the application a project connects through.
 *
 * **An existing grant survives a change of client secret and does not survive a change of
 * client id.** That asymmetry is the whole of this function. Rotating a secret in Linear's
 * settings leaves every token that application already issued working, so dropping the
 * grant would force an unnecessary reconnect — and a reconnect under `actor=app` needs a
 * workspace admin, who may well not be the person doing the rotation. Pointing the project
 * at a *different* application makes the stored tokens dead on arrival: they were minted by
 * an application this project no longer uses, and keeping them would leave a connection
 * that reports as healthy and 401s on the next poll. That is the state ADR-0012 keeps
 * `empty` separate from `absent` to avoid, one field over.
 */
export async function setOAuthApp(
  projectSlug: string,
  provider: SecretName,
  app: { clientId: string; clientSecret: string; redirectUri: string },
  path = localConfigPath(),
): Promise<{ grantKept: boolean }> {
  let grantKept = false
  await updateLocalConfig((config) => {
    const existing = config.oauth[projectSlug]?.[provider]
    const parsed = isRecord(existing) ? parseOAuthApp(existing) : undefined
    const keep =
      parsed?.ok === true && parsed.app.grant && parsed.app.clientId === app.clientId
        ? (existing as Record<string, unknown>).grant
        : undefined
    grantKept = keep !== undefined
    return {
      ...config,
      oauth: {
        ...config.oauth,
        [projectSlug]: {
          ...config.oauth[projectSlug],
          [provider]: {
            clientId: app.clientId,
            clientSecret: app.clientSecret,
            redirectUri: app.redirectUri,
            ...(keep === undefined ? {} : { grant: keep }),
          },
        },
      },
    }
  }, path)
  return { grantKept }
}

export class NoOAuthApp extends Error {}

/**
 * Write the tokens an authorization or a refresh produced.
 *
 * Merged into whatever the store holds *at the moment of the write*, inside
 * `updateLocalConfig`'s lock, rather than written over a copy read earlier. That is not
 * ceremony. A refresh reads the grant, spends a network round trip, and writes — and in
 * that window `ogun project add`, a runner joining, or an admin-token rotation can each
 * rewrite the same file. ADR-0010 rejected refreshing a *borrowed* credential partly
 * because two writers race over a file neither of them locks; this credential is Ogun's
 * own, this file has exactly one writer, and that is the difference which makes refreshing
 * safe here and unsafe there.
 *
 * Refuses when no application is registered, and the refusal is now load-bearing for both
 * grants rather than one. A grant with no client id and secret beside it can never be
 * renewed — an `authorization_code` refresh needs the pair to authenticate the refresh
 * token, and a `client_credentials` token *is* the pair, asked again. Either way, storing
 * one would create a connection that looks identical to a healthy one until the day it
 * expires.
 */
export async function storeOAuthGrant(
  projectSlug: string,
  provider: SecretName,
  grant: {
    accessToken: string
    refreshToken?: string
    grantType: LinearGrantType
    expiresAt: number
    obtainedAt: number
    scopes: string[]
    actor: string
    workspace?: { id: string; name: string; urlKey: string }
    appUserId?: string
  },
  path = localConfigPath(),
): Promise<void> {
  await updateLocalConfig((config) => {
    const existing = config.oauth[projectSlug]?.[provider]
    const parsed = isRecord(existing) ? parseOAuthApp(existing) : undefined
    if (parsed?.ok !== true) {
      throw new NoOAuthApp(
        `no ${provider} oauth application is registered for "${projectSlug}" on this ` +
          'machine, so a grant stored now could never be refreshed. Register the ' +
          'application first',
      )
    }
    return {
      ...config,
      oauth: {
        ...config.oauth,
        [projectSlug]: {
          ...config.oauth[projectSlug],
          [provider]: { ...(existing as Record<string, unknown>), grant },
        },
      },
    }
  }, path)
}

/**
 * Disconnect: forget the tokens, keep the application.
 *
 * Two functions rather than one flag, because they undo two different acts. Disconnecting
 * is "stop acting in that workspace", and reconnecting afterwards is one click because the
 * client id and secret are still here. Forgetting the application is "this project no
 * longer has a Linear app", and it takes the grant with it — a grant outliving the
 * credentials that could refresh it is exactly the unrefreshable connection
 * `storeOAuthGrant` refuses to create.
 *
 * Neither revokes anything at Linear, because neither can: revocation is a network call
 * with its own failure modes, and a local forget that depended on a remote call succeeding
 * would leave an operator unable to remove a credential from their own machine while
 * Linear was down. The route above this does attempt a revoke first, and forgets either
 * way.
 */
export async function clearOAuthGrant(
  projectSlug: string,
  provider: string,
  path = localConfigPath(),
): Promise<boolean> {
  let existed = false
  await updateLocalConfig((config) => {
    const entry = config.oauth[projectSlug]?.[provider]
    if (!isRecord(entry) || entry.grant === undefined) return config
    existed = true
    const { grant: _dropped, ...rest } = entry
    return {
      ...config,
      oauth: {
        ...config.oauth,
        [projectSlug]: { ...config.oauth[projectSlug], [provider]: rest },
      },
    }
  }, path)
  return existed
}

/**
 * Forget the application entirely, grant included.
 *
 * `provider` is a plain string rather than a `SecretName`, for the reason
 * `clearProjectSecret` gives: §4.5 says this file gets hand-edited, the listing reports
 * whatever it finds, and a row a person can see has to be a row they can remove. A closed
 * set guards writes, where an unknown name creates a credential nothing reads; there is
 * nothing to guard on the way out.
 */
export async function clearOAuthApp(
  projectSlug: string,
  provider: string,
  path = localConfigPath(),
): Promise<boolean> {
  let existed = false
  await updateLocalConfig((config) => {
    const entries = config.oauth[projectSlug]
    if (!entries || !(provider in entries)) return config
    existed = true
    const { [provider]: _removed, ...rest } = entries
    const { [projectSlug]: _project, ...others } = config.oauth
    return {
      ...config,
      oauth: Object.keys(rest).length > 0 ? { ...others, [projectSlug]: rest } : others,
    }
  }, path)
  return existed
}

/**
 * Which projects have an application, and what state its connection is in — never a token.
 *
 * The same structural rule as `ProjectSecretPresence`, and it matters more here because
 * there is more to say: this type has room for a workspace name, a scope list and an
 * expiry, and no field that any of the three secrets would fit in. `clientSecretSet` is a
 * boolean for exactly that reason — the honest thing to report is whether one is stored,
 * and a future editor cannot widen a boolean into a disclosure.
 *
 * `expiresAt` is here and is not a secret. It is the number `doctor` and the Settings page
 * print as "7h left", and withholding it would leave both of them able to say "connected"
 * and unable to say whether the connection will survive tonight.
 */
export type ProjectGrantPresence = {
  project: string
  provider: string
  clientId: string
  clientSecretSet: boolean
  redirectUri: string
  connected: boolean
  scopes: string[]
  actor: string
  /**
   * How this project is connected, so that every surface can say it in one word.
   *
   * Not a cosmetic column. The two grants differ in what they can *see* — a
   * `client_credentials` token reaches the workspace's public teams and no others — so
   * "connected" without it is an answer that cannot explain a source returning zero
   * tickets. Absent until somebody connects, because an application that was registered
   * and never used has not yet chosen.
   */
  grantType?: LinearGrantType
  expiresAt?: number
  obtainedAt?: number
  workspace?: { id: string; name: string; urlKey: string }
  /** The entry is in the file and this build cannot read it. Not the same as absent. */
  malformed?: string
}

export async function listOAuthApps(path = localConfigPath()): Promise<ProjectGrantPresence[]> {
  const store = await readStore(path)
  if (store.state === 'missing') return []
  if (store.state === 'unreadable') throw new LocalConfigError(store.reason)

  return Object.entries(store.config.oauth)
    .flatMap(([project, providers]) =>
      Object.entries(providers).map(([provider, raw]): ProjectGrantPresence => {
        const parsed = parseOAuthApp(raw)
        if (!parsed.ok) {
          return {
            project,
            provider,
            clientId: '',
            clientSecretSet: false,
            redirectUri: '',
            connected: false,
            scopes: [],
            actor: '',
            malformed: parsed.reason,
          }
        }
        const { app } = parsed
        return {
          project,
          provider,
          clientId: app.clientId,
          // The one `expose()` that is not at a wire, and it is here because the
          // alternative is worse: carrying an "is it blank" boolean through the parser
          // means a second field that can disagree with the value it describes.
          clientSecretSet: app.clientSecret.expose().trim() !== '',
          redirectUri: app.redirectUri,
          connected: app.grant !== undefined,
          scopes: app.grant?.scopes ?? [],
          actor: app.grant?.actor ?? '',
          ...(app.grant
            ? {
                grantType: app.grant.grantType,
                expiresAt: app.grant.expiresAt,
                obtainedAt: app.grant.obtainedAt,
              }
            : {}),
          ...(app.grant?.workspace ? { workspace: app.grant.workspace } : {}),
        }
      }),
    )
    .sort((a, b) => a.project.localeCompare(b.project) || a.provider.localeCompare(b.provider))
}

/**
 * The stored shape, parsed by hand and never by zod.
 *
 * The same rule as the secrets route's request body, for the same reason: a validator that
 * echoes what it received is one dependency bump away from a leak, and every string in this
 * object is either a credential or sits beside one. `zod@3` put the received value into an
 * `invalid_enum_value` issue; `zod@4` does not, for the codes this shape would produce —
 * and the distance between those two facts is a version range in a lockfile. Nothing below
 * quotes a value: a failure names the field and what was expected there.
 *
 * Total, and permissive about fields it does not know. A grant written by a newer build
 * must not make an older one report the project as disconnected, so unknown keys are
 * ignored and only the fields this build actually uses are required.
 */
type ParsedApp = { ok: true; app: OAuthApp } | { ok: false; reason: string }

function parseOAuthApp(raw: unknown): ParsedApp {
  if (!isRecord(raw)) return { ok: false, reason: 'the entry is not an object' }
  const { clientId, clientSecret, redirectUri } = raw
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return { ok: false, reason: 'clientId is missing or not a string' }
  }
  if (typeof clientSecret !== 'string') {
    return { ok: false, reason: 'clientSecret is missing or not a string' }
  }
  /**
   * Required to be a string, **allowed to be empty**, which it was not before.
   *
   * A redirect URI is a fact about a browser round trip, and the default grant has no
   * browser in it. An application registered by `ogun connect linear` on a machine with no
   * control plane running does not know what address anybody would reach one at — and
   * inventing a plausible `http://localhost:7777/…` would put a string in the store that
   * Linear has never been told about, which is precisely the mismatch this field exists to
   * make visible, manufactured. Empty says "there was no browser", which is true and is
   * what `connections` prints.
   *
   * `ogun connect linear --consent` writes a real one, through the server, because the
   * server that will receive the callback is the only thing that knows what it is.
   */
  if (typeof redirectUri !== 'string') {
    return { ok: false, reason: 'redirectUri is missing or not a string' }
  }

  const app: OAuthApp = {
    clientId,
    clientSecret: sealSecret(clientSecret),
    redirectUri,
    grant: undefined,
  }
  if (raw.grant === undefined) return { ok: true, app }

  const g = raw.grant
  if (!isRecord(g)) return { ok: false, reason: 'grant is not an object' }
  const { accessToken, refreshToken, expiresAt } = g
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    return { ok: false, reason: 'grant.accessToken is missing or not a string' }
  }
  /**
   * Which grant this came from, defaulted rather than required.
   *
   * **An entry with no `grantType` is an `authorization_code` grant**, because that is the
   * only kind the build before this one could write: `client_credentials` was refused, in
   * this function and in the token client, on the grounds that a token with no refresh
   * token could not be renewed. So the default is not a guess, it is the single fact the
   * absence can mean — and reading it that way is what lets an existing connection survive
   * this change with no migration and no reconnect.
   *
   * An unrecognised value is `malformed` rather than defaulted. A future build's third
   * grant type would have renewal rules this one does not know, and quietly treating it as
   * an authorization-code grant would mean spending a refresh token that is not there, at
   * 3am, on a connection somebody else's build made.
   */
  const grantType = g.grantType === undefined ? 'authorization_code' : g.grantType
  if (grantType !== 'authorization_code' && grantType !== 'client_credentials') {
    return { ok: false, reason: 'grant.grantType is not one this build knows' }
  }

  /**
   * A refresh token is required for the grant that rotates, and must be absent-tolerant for
   * the one that does not.
   *
   * ADR-0014 required it unconditionally, with this reason: *"a grant that cannot be
   * refreshed is a connection with a 24-hour life and no symptom until it ends — and
   * Linear's client-credentials flow does return a token with no refresh token beside it,
   * so this is the shape a plausible future edit would write."* The prediction was right
   * and the conclusion is now wrong. That edit landed deliberately, and the premise it
   * rested on — that a refresh token is the only renewal there is — was what changed: a
   * `client_credentials` token is renewed from the client id and secret two fields up.
   *
   * The check survives, narrowed to the grant it protects. An `authorization_code` entry
   * with no refresh token is still an unrenewable connection and is still `malformed`,
   * which asks for a reconnect rather than letting a poll discover it tomorrow.
   */
  if (grantType === 'authorization_code' && (typeof refreshToken !== 'string' || refreshToken.trim() === '')) {
    return { ok: false, reason: 'grant.refreshToken is missing on an authorization-code grant' }
  }
  /**
   * Required, and required to be finite. A grant whose expiry cannot be read is a token
   * this build would either refresh on every poll or never refresh at all, depending on
   * which way a `NaN` falls through a comparison — and both are silent. Calling the entry
   * malformed and asking for a reconnect costs thirty seconds and says what happened.
   */
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: 'grant.expiresAt is missing or not a number' }
  }

  return {
    ok: true,
    app: {
      ...app,
      grant: {
        clientId,
        access: sealSecret(accessToken),
        // Sealed only when there is one. A `client_credentials` grant has none, and an
        // empty `Secret` would be a credential-shaped object holding nothing — which every
        // caller would then have to check the *inside* of, with `expose()`, to find out.
        ...(typeof refreshToken === 'string' && refreshToken.trim() !== ''
          ? { refresh: sealSecret(refreshToken) }
          : {}),
        grantType,
        expiresAt,
        obtainedAt: typeof g.obtainedAt === 'number' ? g.obtainedAt : 0,
        // Tolerated rather than required: a grant with no recorded scopes came from a build
        // that did not record them, and reporting "connected, scopes unknown" beats
        // refusing to poll over a field nothing authenticates with.
        scopes: Array.isArray(g.scopes)
          ? g.scopes.filter((s): s is string => typeof s === 'string')
          : [],
        actor: typeof g.actor === 'string' ? g.actor : '',
        ...(isRecord(g.workspace) &&
        typeof g.workspace.id === 'string' &&
        typeof g.workspace.name === 'string' &&
        typeof g.workspace.urlKey === 'string'
          ? {
              workspace: {
                id: g.workspace.id,
                name: g.workspace.name,
                urlKey: g.workspace.urlKey,
              },
            }
          : {}),
        ...(typeof g.appUserId === 'string' ? { appUserId: g.appUserId } : {}),
      },
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
