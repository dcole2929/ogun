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
 * Two shapes now, in three blocks of one file: a personal API key a person typed
 * (`secrets`, ADR-0012), and a grant Ogun obtained for itself from an application it holds
 * (`grants` and `applications`, ADR-0014 — one block each, because an application is
 * shared between projects and a grant is not). One module reads and writes all of them,
 * and one function — `readProjectSecret` — decides which a poll authenticates with, so
 * precedence exists in exactly one place.
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
 *     three things that write one — `ogun connect`, `ogun secret set`, and the Settings
 *     page's route — all go through this module and therefore only into the machine file.
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
 * The **integrations** Ogun knows how to authenticate, as a closed set.
 *
 * Closed rather than free-form because of the failure `inertPolicies` exists for
 * elsewhere: a key that nothing reads is indistinguishable from a key that works, right
 * up until the night it mattered. `ogun connect linaer` typed at 1am would otherwise
 * store a secret, print success, and leave the poller unauthenticated with no evidence
 * anywhere connecting the two.
 *
 * A name is added here when the code that reads it lands, not before.
 *
 * ### What this set is *not*, since `ogun secret` came back
 *
 * It is not the set of things `~/.ogun/config.json`'s `secrets` block may hold. That was
 * true for two days, while every name in here was an integration credential and `ogun
 * secret` had been folded into `ogun connect` on that observation. **A secret is not
 * guaranteed to be an integration** — a webhook signing key, a shared HMAC, a token for
 * something Ogun hands to a skill rather than polls itself — and a closed set would refuse
 * every one of them for the sole reason that nothing here *polls* under that name.
 *
 * So the set belongs to `connect`, where the argument for it is exact, and `secret set`
 * takes free-form names under a different protection: see `setProjectSecret`.
 * `readProjectSecret` still takes a `SecretName`, because it answers "what does a poll
 * authenticate with", and only these are polled.
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
 * secret together and proves the pair by spending it before it is stored at all — see
 * `setApplication` below, and `connectWithAppToken` for why that order is the one the
 * writes happen in.
 */
/**
 * `github` joins `linear` on the test this set was written around: a value used verbatim
 * as a credential, by something that polls. The control plane reads pull requests Ogun
 * opened to find the ones somebody has asked it to revise, and that read authenticates.
 *
 * Not the same thing as the gateway's `OGUN_GATEWAY_GITHUB_TOKEN`, and the two must not
 * be conflated. That one is env-only, deliberately never discovered, and exists so a
 * *sandbox* can read a public repository without a push ever being carried (ADR-0005).
 * This one lives on the machine that polls (ADR-0012), is per project, and never enters
 * a container.
 */
export const SECRET_NAMES = ['linear', 'github'] as const
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
 *  - `granted` — a grant from an application (ADR-0014). Sent as `Bearer`, and it **wins
 *    over an API key**; `apiKeyIgnored` says whether one is sitting behind it, because an
 *    operator rotating a key that nothing reads is an hour gone.
 *  - `unconnected` — an application this project has not taken a token from, and no key to
 *    fall back to. The fix is one more `connect` rather than a paste, and reporting it as
 *    `absent` would send somebody who has already done half the work off to find a
 *    personal key instead.
 *
 *    **The write path can no longer create this**, and that is the point of the change
 *    that split `applications` from `grants`: nothing is written until a token has come
 *    back, so an application in the store is an application that has been spent at least
 *    once. What still reaches it is a machine that registered an application under the old
 *    `oauth` shape and never finished the authorization — `migrateLegacyOAuth` names that
 *    application after the project slug, because there is no workspace on it to name it
 *    after, and that is the one name this state is recognised by. See
 *    `readProjectSecret`, which says why it is recognised by name rather than by guessing
 *    from the whole set of applications.
 *  - `malformed` — this project's OAuth entry is not a shape this build can read. Kept
 *    apart from `unreadable` below because the fix is to reconnect one project, where
 *    `unreadable` means a config.json that is currently failing to parse for everything
 *    on the machine.
 *  - `absent` — nobody has set one. The fix is `ogun connect <integration>`.
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
  | { state: 'granted'; grant: Grant; apiKeyIgnored: boolean }
  | { state: 'present'; secret: Secret }
  /**
   * `clientId` keeps its name, and it now carries **whichever non-secret identifier the
   * provider's application is known by** — a Linear client id, a GitHub App id. Renaming it
   * was the first instinct and it buys nothing: every reader of this field prints it beside
   * the word "application" for a person to compare against a settings page, and the three
   * surfaces that do (`linear-credential.ts`, `github-credential.ts`, the runner's sandbox
   * lookup) would all have to be edited to say the same thing in a different spelling.
   */
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
 * Async and unmemoised on purpose. A rotation is a file write (`ogun connect` again),
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

  /**
   * Read through the migration rather than out of the raw file, for the reason `readGrant`
   * states: a config.json that has not been written since the upgrade still holds its
   * grants under `oauth`, and a poll must not report a live connection as absent while
   * waiting for somebody to run a command that happens to write. The migrated copy is
   * thrown away; the file converts on the next write.
   */
  const config = migrateLegacyOAuth(store.config)

  const raw = config.grants[projectSlug]?.[name]
  if (raw !== undefined) {
    const parsed = parseGrant(raw)
    if (!parsed.ok) return { state: 'malformed', reason: parsed.reason }
    return { state: 'granted', grant: parsed.grant, apiKeyIgnored: apiKey.state === 'present' }
  }

  /**
   * No grant. A key beside it still works and is *not* shadowed by an application nobody
   * has taken a token from: this is the ordinary state of a project halfway through the
   * migration, and refusing it would break a working poll to make a point.
   */
  if (apiKey.state === 'present') return apiKey

  /**
   * The last thing to check is the one state the split made hard to express, and it is
   * recognised **by name** rather than by looking at the set of applications as a whole.
   *
   * An application is shared now, so "is one registered?" is a question about the machine
   * and not about this project — and answering `unconnected` because *some other* project
   * registered a Linear app would tell an operator to finish an authorization for a
   * project nobody ever meant to connect. The one name that does mean this project is
   * `<provider>:<slug>`, because that is the fallback `migrateLegacyOAuth` uses when the
   * old entry carried no workspace to name itself after — which is exactly the
   * registered-and-never-authorized entry this state was built for. So the lookup is for
   * that name and nothing else: the pre-split behaviour survives where it existed, and
   * invents itself nowhere.
   */
  const orphan = config.applications[deriveApplicationName(name, projectSlug)]
  if (orphan !== undefined) {
    const parsed = parseApplication(deriveApplicationName(name, projectSlug), orphan)
    if (!parsed.ok) return { state: 'malformed', reason: parsed.reason }
    return { state: 'unconnected', clientId: applicationIdentifier(parsed.app) }
  }
  return apiKey
}

/**
 * The identifier of an application that is safe to print, per provider.
 *
 * One function because three surfaces print it in the same sentence — "application 1234567
 * is registered and nothing has connected it" — and a `switch` repeated per surface is how
 * the GitHub arm ends up printing a private key in the one place somebody forgot.
 */
export const applicationIdentifier = (app: Application): string =>
  app.provider === 'github' ? app.appId : app.clientId

/**
 * A secret by whatever name the project calls it, for `env: { secret: <name> }`.
 *
 * The sibling of `readProjectSecret`, and the differences are the reason it is a separate
 * function rather than a widened parameter.
 *
 * It takes a `string`, not a `SecretName`. The closed set exists so that a name Ogun
 * *polls under*, misspelled, is refused rather than stored to be silently unused — a rule
 * about integration credentials, which `readProjectSecret` reads. A name here is legitimate
 * exactly because the project's own `.ogun/config.yaml` asked for it by that spelling, so
 * there is nothing for a closed set to protect: a typo is caught by the run refusing with
 * the name printed, which is the same feedback a moment sooner.
 *
 * It never consults `oauth`. A grant is an access token with scopes and an expiry that the
 * connect flow maintains; handing one to a project's stack as an environment variable
 * would put a live, refreshable credential inside a sandbox, which ADR-0010 exists to
 * prevent. `env:` reaches only the store a person typed into.
 *
 * `hasOwnProperty` rather than `in` or a bare index, because the name comes from a
 * repository file. `secrets.<project>.constructor` is a plain lookup away from returning a
 * function, and `ogun secret rm toString` once reported removing a secret that never
 * existed for exactly this reason.
 */
export async function readNamedSecret(
  projectSlug: string,
  name: string,
  path = localConfigPath(),
): Promise<Secret | undefined> {
  const store = await readStore(path)
  /**
   * `missing` is `undefined` — no store, no secret, and the caller's refusal ("nothing is
   * stored under that name") is exactly right. `unreadable` throws, because the same
   * refusal would be a lie: the value may well be sitting in the file, and sending someone
   * to `ogun secret set` over a permissions error is how an afternoon disappears.
   */
  if (store.state === 'missing') return undefined
  if (store.state === 'unreadable') throw new LocalConfigError(store.reason)

  const forProject = store.config.secrets[projectSlug]
  if (!forProject || !Object.prototype.hasOwnProperty.call(forProject, name)) return undefined

  const stored = forProject[name]
  if (typeof stored !== 'string' || stored.trim() === '') return undefined
  return sealSecret(stored)
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
 *
 * ### `name` is a plain string, and the closed set moved up to the callers
 *
 * It was `SecretName`, which made the type system the guard. That was right while this
 * store held nothing but integration credentials, and it stopped being right when `ogun
 * secret set <name>` came back as a general per-project store: **a secret is not
 * guaranteed to be an integration**, and arbitrary names are the point of a store like
 * that. A closed set here would refuse a webhook signing key on the grounds that Ogun does
 * not poll one.
 *
 * The protection `SECRET_NAMES` gave is not abandoned, it is applied where it is true.
 * `connect` still validates the integration against the closed set, because there the
 * failure is exact: a name Ogun polls under, misspelled, is a live credential nothing ever
 * reads. `secret set` cannot borrow that argument — `env: { secret: <name> }` reads
 * whatever a project's config asks for, and no closed set could know those names. What
 * survives is a line at the moment of storing that prints both readers and lets the person
 * match; see `requireSecretName` in the CLI, which also carries why the *shape* rule that
 * briefly sat beside it is gone.
 *
 * ### A name is a key in a plain object, so it can be `constructor`
 *
 * `entries[name]` is a lookup that walks the prototype chain, and every object has an
 * inherited `constructor`. `ogun secret set constructor` therefore read a *function* out of
 * an object that held no such secret and died on `previous.trim is not a function` — a
 * stack trace, from a name the CLI's own validator accepted. `Object.hasOwn` is the fix
 * and it belongs here rather than in a name rule: the store's own lookups have to be
 * honest about what the store contains, whatever the callers let through.
 */
export type DisplacedSecret = 'absent' | 'present' | 'empty'

export async function setProjectSecret(
  projectSlug: string,
  name: string,
  value: string,
  path = localConfigPath(),
): Promise<DisplacedSecret> {
  let displaced: DisplacedSecret = 'absent'
  await updateLocalConfig(
    (config) => {
      const entries = config.secrets[projectSlug]
      // `Object.hasOwn` and not `entries?.[name]`: `constructor` is inherited by every
      // object, so the plain lookup answered with a function for a secret nobody had set.
      const previous = entries && Object.hasOwn(entries, name) ? entries[name] : undefined
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
 * `name` is a plain string, as it always was, and the asymmetry it used to have with
 * `setProjectSecret` is gone now that writes take one too. The reason it was never
 * narrowed here still holds and is the stronger half of the argument: removal creates
 * nothing, and what it has to cover is everything the store can actually hold — §4.5 says
 * `~/.ogun/config.json` gets hand-edited, `listProjectSecrets` reports whatever it finds,
 * and the Settings page renders that. A row a person can see and cannot remove is a live
 * credential stranded in the file by a validator meant to protect it.
 */
export async function clearProjectSecret(
  projectSlug: string,
  name: string,
  path = localConfigPath(),
): Promise<boolean> {
  let existed = false
  await updateLocalConfig((config) => {
    const entries = config.secrets[projectSlug]
    // `Object.hasOwn` and not `name in entries`, which is true of `constructor` and
    // `toString` for every object alive: `ogun secret rm constructor` reported a removal
    // that had not happened, which is the one answer this function exists to get right.
    if (!entries || !Object.hasOwn(entries, name)) return config
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

// ── applications and grants, which `oauth` used to conflate ───────────────

/**
 * An application registered with a provider, as it sits in the store.
 *
 * ### Why this is a union and `OAuthApp` was a struct
 *
 * `OAuthApp` was `{ clientId, clientSecret, redirectUri }`, and the flag that wrote it was
 * called `--oauth` on the stated grounds that *"an application registered in the provider
 * always means a client id and a client secret"*. That was true of the one provider that
 * existed and is false in general. RFC 6749 §2.1 has public clients, which have a client
 * id and no secret at all; RFC 7591 names five client authentication methods, of which a
 * shared secret is one. And a GitHub App authenticating as itself is none of them: it
 * signs a JWT with a private key and exchanges it for an installation token, which is not
 * an OAuth grant type.
 *
 * So the shape is per provider, and `method` is recorded rather than inferred from which
 * fields are present. Two providers could both carry a `clientId` and differ in what they
 * do with it, and guessing from shape is how one of them half-works.
 *
 * ### Why the name is part of the record
 *
 * An application is shared — that is the whole reason it moved out of `oauth[project]` —
 * so it needs a handle that projects can point at. The name is derived from the provider
 * and the account the credential proved it authenticates against (`github:heirchive`),
 * never from the project that happened to register it first: naming a shared thing after
 * one of its users is a name that is wrong as soon as there are two.
 */
export type Application =
  | {
      name: string
      provider: 'linear'
      /** `client_credentials` acts as the app; `authorization_code` acts for a person. */
      method: 'client_credentials' | 'authorization_code'
      clientId: string
      clientSecret: Secret
      /**
       * Stored rather than derived, and allowed to be empty — see the note that was on
       * `parseOAuthApp`: the token exchange must send the *same* redirect uri the
       * authorization used, and the grant that needs no browser has none to send.
       */
      redirectUri: string
    }
  | {
      name: string
      provider: 'github'
      /** The only one GitHub offers for an app acting as itself. */
      method: 'private_key_jwt'
      /** Not secrets: both are on the App's settings page and in every JWT it signs. */
      appId: string
      installationId: string
      privateKey: Secret
    }

/**
 * A live token one project holds from one application.
 *
 * Flat rather than `{ app, grant: {…} }`, because a record called a grant that contains a
 * field called a grant reads as two things when it is one. `app` names where it came
 * from, which is what makes renewal possible without the project holding the credential
 * that renews it.
 *
 * The fields below `app` are the ones `OAuthGrant` already had and the reasoning for each
 * is unchanged: the token is sealed and everything beside it is not, so `doctor`, the
 * Settings page and the poll can all read an expiry without a single `expose()`;
 * `expiresAt` is absolute because a duration is only true at the instant it arrived.
 */
export type Grant = {
  /** The key into `applications`. */
  app: string
  access: Secret
  /** Absent for any grant that renews by asking again rather than by rotating. */
  refresh?: Secret
  /** RFC 6749's names where the provider uses them; the provider's own where it does not. */
  grantType: LinearGrantType | 'installation'
  /** Absolute, ms since epoch. */
  expiresAt: number
  obtainedAt: number
  /** As granted, not as requested. Empty where the provider reports none. */
  scopes: string[]
  /** Who the provider attributes a write to. */
  actor: string
  /** The account this grant reaches, for `connect list` and for deriving an app name. */
  account?: { id?: string; name: string; urlKey: string }
  /** Linear's `viewer.id` under `actor=app`, stored because it is only obtainable live. */
  appUserId?: string
}

export type StoredApplication =
  | { state: 'present'; app: Application }
  | { state: 'absent' }
  | { state: 'malformed'; reason: string }
  | { state: 'unreadable'; reason: string }

/**
 * The name an application gets when nobody supplies one.
 *
 * `<provider>:<account>`, lowercased because it is a handle somebody types into `--link`.
 * The account comes from what the provider reported when the credential was proved, not
 * from anything the operator typed, so an application cannot be named after a workspace it
 * does not actually reach.
 */
export const deriveApplicationName = (provider: SecretName, account: string): string =>
  `${provider}:${account.trim().toLowerCase()}`

/**
 * The stored shape, parsed by hand and never by zod.
 *
 * Written for `parseOAuthApp`, which this and `parseGrant` replace; the argument is
 * unchanged because it was never about the shape. The same rule as the secrets route's
 * request body, for the same reason: a validator that echoes what it received is one
 * dependency bump away from a leak, and every string in this object is either a credential
 * or sits beside one. `zod@3` put the received value into an `invalid_enum_value` issue;
 * `zod@4` does not, for the codes this shape would produce — and the distance between those
 * two facts is a version range in a lockfile. Nothing below quotes a value: a failure names
 * the field and what was expected there.
 *
 * Total, and permissive about fields it does not know. An application or grant written by a
 * newer build must not make an older one report the project as disconnected, so unknown
 * keys are ignored and only the fields this build actually uses are required.
 */
function parseApplication(name: string, raw: unknown): ParsedApplication {
  if (!isRecord(raw)) return { ok: false, reason: 'the entry is not an object' }
  const provider = raw.provider
  if (provider !== 'linear' && provider !== 'github') {
    return { ok: false, reason: `provider "${String(provider)}" is not one this build knows` }
  }

  if (provider === 'github') {
    const { appId, installationId, privateKey } = raw
    for (const [field, value] of Object.entries({ appId, installationId, privateKey })) {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, reason: `${field} is missing or not a string` }
      }
    }
    return {
      ok: true,
      app: {
        name,
        provider: 'github',
        method: 'private_key_jwt',
        appId: appId as string,
        installationId: installationId as string,
        privateKey: sealSecret(privateKey as string),
      },
    }
  }

  const { clientId, clientSecret, redirectUri } = raw
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return { ok: false, reason: 'clientId is missing or not a string' }
  }
  if (typeof clientSecret !== 'string') {
    return { ok: false, reason: 'clientSecret is missing or not a string' }
  }
  if (typeof redirectUri !== 'string') {
    return { ok: false, reason: 'redirectUri is missing or not a string' }
  }
  /**
   * An application written before `method` existed is `client_credentials`, which is the
   * only thing `ogun connect linear` wrote by default — the same reasoning the old
   * `grantType` default carried, moved up a level. An unrecognised value is malformed
   * rather than defaulted: a future build's method has renewal rules this one does not
   * know, and guessing would mean spending the wrong credential at 3am.
   */
  const method = raw.method === undefined ? 'client_credentials' : raw.method
  if (method !== 'client_credentials' && method !== 'authorization_code') {
    return { ok: false, reason: `method "${String(method)}" is not one this build knows` }
  }

  return {
    ok: true,
    app: {
      name,
      provider: 'linear',
      method,
      clientId,
      clientSecret: sealSecret(clientSecret),
      redirectUri,
    },
  }
}

type ParsedApplication = { ok: true; app: Application } | { ok: false; reason: string }

/**
 * Move anything still under `oauth` into `applications` and `grants`.
 *
 * A pure function applied inside every write, rather than a migration command somebody
 * has to remember. `updateLocalConfig` is already a read-modify-write under a lock, so
 * folding this into it means the file is converted by the first `ogun connect`, `ogun
 * project add` or token refresh that runs after the upgrade — and converted exactly once,
 * because the second pass finds an empty `oauth` and does nothing.
 *
 * **It never overwrites.** An application or grant already in the new shape wins, so a
 * half-migrated file — one project converted by a refresh, another not yet — converges
 * rather than flapping. And `oauth` is cleared only for the entries actually moved, so an
 * entry this build cannot parse stays where it is instead of being deleted by the upgrade
 * that could not read it.
 *
 * The derived name uses the workspace the old grant recorded, falling back to the project
 * slug when there is none. That fallback produces a worse name — `linear:ogun` for a
 * registered-but-unauthorized application — and it is still better than refusing to
 * migrate, because the alternative leaves a credential in a map nothing reads any more.
 */
export function migrateLegacyOAuth(config: LocalConfig): LocalConfig {
  const applications = { ...config.applications }
  const grants: LocalConfig['grants'] = Object.fromEntries(
    Object.entries(config.grants).map(([slug, byProvider]) => [slug, { ...byProvider }]),
  )
  const oauth: LocalConfig['oauth'] = {}
  let moved = false

  for (const [slug, byProvider] of Object.entries(config.oauth)) {
    for (const [provider, raw] of Object.entries(byProvider)) {
      if (!isSecretName(provider) || !isRecord(raw)) {
        oauth[slug] = { ...(oauth[slug] ?? {}), [provider]: raw }
        continue
      }
      const grant = isRecord(raw.grant) ? raw.grant : undefined
      const workspace = isRecord(grant?.workspace) ? grant.workspace : undefined
      const account =
        typeof workspace?.urlKey === 'string' && workspace.urlKey.trim() !== ''
          ? workspace.urlKey
          : slug
      const name = deriveApplicationName(provider, account)

      const { grant: _grant, ...application } = raw
      if (applications[name] === undefined) {
        /**
         * The method, from the **grant** when the old entry carried one.
         *
         * Defaulting to `client_credentials` outright was wrong in the one direction that
         * costs reach. A legacy entry has no `method` — the field did not exist — but it
         * very often has a grant, and for Linear the grant's type *is* the method. An
         * entry whose grant is `authorization_code` migrated as `client_credentials` would
         * make `ogun connect linear` treat a consent connection as an ordinary one and
         * silently reconnect it with a token that reaches public teams only: a poll that
         * authenticates perfectly and finds nothing, which is the refusal in `reuseLinked`
         * defeated by the migration beneath it.
         *
         * With no grant, `client_credentials` remains the right answer: that is the only
         * method the build which wrote those entries used by default, and there is nothing
         * else to read it from.
         */
        const method =
          raw.method ??
          /**
           * A grant with **no** `grantType` is `authorization_code` too, which is
           * `parseOAuthApp`'s own default and for its reason: the build that wrote those
           * entries refused a token with no refresh token in two places, so an
           * authorization-code grant is the only thing it could have produced.
           */
          (grant === undefined || grant.grantType === 'client_credentials'
            ? 'client_credentials'
            : 'authorization_code')
        applications[name] = { ...application, provider, method }
      }
      if (grant !== undefined && grants[slug]?.[provider] === undefined) {
        const { workspace: _ws, ...rest } = grant
        grants[slug] = {
          ...(grants[slug] ?? {}),
          [provider]: { ...rest, app: name, ...(workspace ? { account: workspace } : {}) },
        }
      }
      moved = true
    }
  }

  return moved ? { ...config, applications, grants, oauth } : config
}

/**
 * An application as a *writer* has it: every field of `Application`, with the secrets as
 * plain strings rather than sealed.
 *
 * Named rather than written inline at the parameter, because three callers now build one
 * — `ogun connect`'s two kinds and the server's route — and an anonymous intersection of
 * `Omit`s is a type no caller can refer to in its own signature.
 *
 * The secrets arrive bare and leave sealed, and that direction is the whole asymmetry of
 * this module: `Secret` exists to stop a value that has been *read* from spreading, and a
 * value on its way to the disk has to be the string. `sealSecret` at this boundary would
 * be ceremony — the next thing that happens to it is `JSON.stringify`, which `Secret`
 * answers with `[redacted]`.
 */
export type ApplicationWrite =
  | (Omit<Extract<Application, { provider: 'linear' }>, 'clientSecret'> & {
      clientSecret: string
    })
  | (Omit<Extract<Application, { provider: 'github' }>, 'privateKey'> & {
      privateKey: string
    })

/**
 * Write an application, keeping any grants that still belong to it.
 *
 * Returns what it displaced, because overwriting a credential silently is how an operator
 * ends up with a working connection they cannot explain — the same reason
 * `setProjectSecret` reports what it displaced.
 *
 * ### A grant survives a change of secret and does not survive a change of *identity*
 *
 * That asymmetry is the whole of this function and it was nearly lost in the move off
 * `oauth[project][provider]`. `setOAuthApp` had it explicitly, and the reasoning holds
 * word for word:
 *
 * > *"Rotating a secret in the provider's settings leaves every token that application
 * > already issued working, so dropping the grant would force an unnecessary reconnect —
 * > and a reconnect under `actor=app` needs a workspace admin, who may well not be the
 * > person doing the rotation. Pointing the project at a **different** application makes
 * > the stored tokens dead on arrival: they were minted by an application this project no
 * > longer uses, and keeping them would leave a connection that reports as healthy and
 * > 401s on the next poll."*
 *
 * Under the old map a grant was *inside* the application entry, so a replaced entry took
 * its grant with it and the rule enforced itself. Under a name-keyed map the grants point
 * at the **name**, so a replaced entry silently re-points every one of them at credentials
 * that never minted them — and the shared application makes that worse rather than better,
 * because the projects whose connections just died are the ones nobody was looking at.
 *
 * So the drop is explicit and it is scoped to what actually changed. `identityOf` below is
 * the per-provider answer to "is this the same application?", and the grants dropped are
 * named in the result rather than removed in silence: the caller is the only thing in a
 * position to tell somebody that connecting one project just disconnected two others.
 *
 * It is a **drop, not a cascade into the secrets store**, and the project's own
 * `readProjectSecret` then reports `absent` — or falls through to a personal key, which is
 * the documented fallback. Nothing is revoked at the provider, because this function has no
 * network and a local write that depended on one would be unavailable during an outage.
 */
export async function setApplication(
  app: ApplicationWrite,
  path = localConfigPath(),
): Promise<{ replaced: boolean; droppedGrants: string[] }> {
  let replaced = false
  let droppedGrants: string[] = []
  await updateLocalConfig((config) => {
    const migrated = migrateLegacyOAuth(config)
    const previous = migrated.applications[app.name]
    const parsed = previous === undefined ? undefined : parseApplication(app.name, previous)
    replaced = previous !== undefined
    /**
     * A previous entry this build cannot parse counts as a *different* application, which
     * is the safe direction: its identity is unknown, so a grant that claims to come from
     * it cannot be shown to still belong to it. The alternative keeps a token nothing can
     * explain.
     */
    const sameApplication = parsed?.ok === true && identityOf(parsed.app) === identityOf(app)

    const { name, ...rest } = app
    const grants = { ...migrated.grants }
    if (replaced && !sameApplication) {
      const dropped: string[] = []
      for (const [slug, byProvider] of Object.entries(grants)) {
        const kept = Object.fromEntries(
          Object.entries(byProvider).filter(([, g]) => !(isRecord(g) && g.app === name)),
        )
        if (Object.keys(kept).length === Object.keys(byProvider).length) continue
        dropped.push(slug)
        if (Object.keys(kept).length === 0) delete grants[slug]
        else grants[slug] = kept
      }
      droppedGrants = dropped.sort()
    }
    return {
      ...migrated,
      applications: { ...migrated.applications, [name]: rest },
      grants,
    }
  }, path)
  return { replaced, droppedGrants }
}

/**
 * What makes two applications the *same* application, per provider.
 *
 * Deliberately not "every field": a client secret and a private key are rotated in place
 * and rotating one must not disconnect anything. What identifies an application is what the
 * provider issues tokens *against* — a client id, or an App id together with the
 * installation being acted as. A GitHub installation id is part of the identity rather than
 * a parameter of it, because an installation token is scoped to one installation and a
 * token minted for another is not a narrower credential, it is a different account.
 *
 * The provider is in the string so that no pair of providers can collide on a bare id.
 */
const identityOf = (app: Application | ApplicationWrite): string =>
  app.provider === 'github'
    ? `github:${app.appId}:${app.installationId}`
    : `linear:${app.clientId}`

export type StoredGrant =
  | { state: 'present'; grant: Grant }
  | { state: 'absent' }
  | { state: 'malformed'; reason: string }
  | { state: 'unreadable'; reason: string }

function parseGrant(raw: unknown): { ok: true; grant: Grant } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'the entry is not an object' }
  const { app, accessToken, refreshToken, expiresAt, obtainedAt } = raw
  if (typeof app !== 'string' || app.trim() === '') {
    return { ok: false, reason: 'app is missing — the grant does not say which application it came from' }
  }
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    return { ok: false, reason: 'accessToken is missing or not a string' }
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: 'expiresAt is missing or not a number' }
  }
  const grantType = raw.grantType === undefined ? 'client_credentials' : raw.grantType
  if (
    grantType !== 'authorization_code' &&
    grantType !== 'client_credentials' &&
    grantType !== 'installation'
  ) {
    return { ok: false, reason: `grantType "${String(grantType)}" is not one this build knows` }
  }
  /**
   * A refresh token is required for the grant that rotates and must be absent for the two
   * that do not — the rule ADR-0014 settled, now with a third member. An `installation`
   * token is renewed by signing a fresh JWT with the private key in the application, which
   * needs no person and spends nothing, exactly as `client_credentials` is renewed by
   * asking again.
   */
  if (grantType === 'authorization_code' && typeof refreshToken !== 'string') {
    return { ok: false, reason: 'grant.refreshToken is missing on a grant that rotates' }
  }

  return {
    ok: true,
    grant: {
      app,
      access: sealSecret(accessToken),
      ...(typeof refreshToken === 'string' ? { refresh: sealSecret(refreshToken) } : {}),
      grantType,
      expiresAt,
      obtainedAt: typeof obtainedAt === 'number' ? obtainedAt : expiresAt,
      scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s) => typeof s === 'string') : [],
      actor: typeof raw.actor === 'string' ? raw.actor : 'app',
      ...(isRecord(raw.account) && typeof raw.account.name === 'string' &&
      typeof raw.account.urlKey === 'string'
        ? {
            account: {
              ...(typeof raw.account.id === 'string' ? { id: raw.account.id } : {}),
              name: raw.account.name,
              urlKey: raw.account.urlKey,
            },
          }
        : {}),
      ...(typeof raw.appUserId === 'string' ? { appUserId: raw.appUserId } : {}),
    },
  }
}

export async function readGrant(
  projectSlug: string,
  provider: SecretName,
  path = localConfigPath(),
): Promise<StoredGrant> {
  const store = await readStore(path)
  if (store.state === 'missing') return { state: 'absent' }
  if (store.state === 'unreadable') return { state: 'unreadable', reason: store.reason }
  /**
   * Read through the migration rather than from the raw file, so a config that has not
   * been written since the upgrade answers correctly. The migration is pure and this copy
   * is thrown away; the file converts on the next write.
   */
  const config = migrateLegacyOAuth(store.config)
  const raw = config.grants[projectSlug]?.[provider]
  if (raw === undefined) return { state: 'absent' }
  const parsed = parseGrant(raw)
  return parsed.ok
    ? { state: 'present', grant: parsed.grant }
    : { state: 'malformed', reason: parsed.reason }
}

/**
 * Raised when a grant is written for an application that is not in the store.
 *
 * `NoOAuthApp` under the old shape, renamed with the map it was about. The refusal it
 * carries is unchanged and is still load-bearing: a grant whose application is missing can
 * never be renewed — a `client_credentials` token *is* the client id and secret asked
 * again, an `installation` token is a fresh JWT signed with the private key, and an
 * `authorization_code` refresh needs the pair to authenticate the refresh token. Storing
 * one anyway would create a connection indistinguishable from a healthy one until the day
 * it expires.
 */
export class NoApplication extends Error {}

/**
 * Point a project at an application and record what it got back.
 *
 * Refuses when the application named is not in the store, which is the invariant
 * `storeOAuthGrant` held before the split and the reason the two writes have an order.
 * `setApplication` goes first; see `connectWithAppToken`, which now does both *after* the
 * token call rather than before it.
 */
export async function storeGrant(
  projectSlug: string,
  provider: SecretName,
  grant: {
    app: string
    accessToken: string
    refreshToken?: string
    grantType: Grant['grantType']
    expiresAt: number
    obtainedAt: number
    scopes: string[]
    actor: string
    account?: { id?: string; name: string; urlKey: string }
    appUserId?: string
  },
  path = localConfigPath(),
): Promise<void> {
  await updateLocalConfig((config) => {
    const migrated = migrateLegacyOAuth(config)
    // Checked inside the updater, under `updateLocalConfig`'s lock and in the same
    // read-modify-write that performs the change — the reason `setProjectSecret` reads the
    // displaced value here rather than before the call. A check made outside is a check
    // made against the file as it was before the lock.
    if (migrated.applications[grant.app] === undefined) {
      throw new NoApplication(
        `no application named "${grant.app}" is registered on this machine, so a ` +
          `${provider} grant stored for "${projectSlug}" could never be renewed. Register ` +
          'the application first',
      )
    }
    return {
      ...migrated,
      grants: {
        ...migrated.grants,
        [projectSlug]: { ...(migrated.grants[projectSlug] ?? {}), [provider]: grant },
      },
    }
  }, path)
}

/**
 * Which projects hold a grant, from which application, and how healthy each one is —
 * never a token.
 *
 * The replacement for `listOAuthApps`, and the shape is different because the thing being
 * listed is. That function answered "which projects have an application", which conflated
 * the two halves of a connection and could therefore report a project as *registered and
 * not connected*; a grant is a connection by construction, so there is no such row here.
 * Applications are listed separately by `listApplications`, which can say who shares one.
 *
 * The same structural rule as `ProjectSecretPresence`: this type has room for an
 * application name, an account, a scope list and an expiry, and no field any of the
 * secrets would fit in. `expiresAt` is here and is not a credential — it is the number
 * `doctor` and the Settings page print as "7h left", and withholding it would leave both
 * of them able to say "connected" and unable to say whether it survives tonight.
 */
export type GrantPresence = {
  project: string
  provider: string
  /** The key into `applications`. Empty on a malformed entry, which may not name one. */
  app: string
  scopes: string[]
  actor: string
  /**
   * How this project is connected, so every surface can say it in one word. Not cosmetic:
   * the grants differ in what they can *see* — a `client_credentials` token reaches the
   * workspace's public teams and no others — so "connected" without it is an answer that
   * cannot explain a source returning zero tickets.
   */
  grantType?: Grant['grantType']
  expiresAt?: number
  obtainedAt?: number
  account?: { id?: string; name: string; urlKey: string }
  /** The entry is in the file and this build cannot read it. Not the same as absent. */
  malformed?: string
}

export async function listGrants(path = localConfigPath()): Promise<GrantPresence[]> {
  const store = await readStore(path)
  if (store.state === 'missing') return []
  if (store.state === 'unreadable') throw new LocalConfigError(store.reason)

  // Through the migration, so an unconverted config.json lists its connections rather than
  // reporting a machine with nothing on it — the worst answer a presence check can give.
  const config = migrateLegacyOAuth(store.config)
  return Object.entries(config.grants)
    .flatMap(([project, byProvider]) =>
      Object.entries(byProvider).map(([provider, raw]): GrantPresence => {
        const parsed = parseGrant(raw)
        if (!parsed.ok) {
          return { project, provider, app: '', scopes: [], actor: '', malformed: parsed.reason }
        }
        const { grant } = parsed
        return {
          project,
          provider,
          app: grant.app,
          scopes: grant.scopes,
          actor: grant.actor,
          grantType: grant.grantType,
          expiresAt: grant.expiresAt,
          obtainedAt: grant.obtainedAt,
          ...(grant.account ? { account: grant.account } : {}),
        }
      }),
    )
    .sort((a, b) => a.project.localeCompare(b.project) || a.provider.localeCompare(b.provider))
}

/**
 * Remove a project's grant, leaving the application alone.
 *
 * The asymmetry is the point of the split: disconnecting one project must not take a
 * credential out from under five others. Removing the application itself is
 * `clearApplication`, which refuses while anything still points at it.
 */
export async function clearGrant(
  projectSlug: string,
  provider: SecretName,
  path = localConfigPath(),
): Promise<boolean> {
  let had = false
  await updateLocalConfig((config) => {
    const migrated = migrateLegacyOAuth(config)
    const byProvider = { ...(migrated.grants[projectSlug] ?? {}) }
    had = byProvider[provider] !== undefined
    delete byProvider[provider]
    const grants = { ...migrated.grants }
    if (Object.keys(byProvider).length === 0) delete grants[projectSlug]
    else grants[projectSlug] = byProvider
    return { ...migrated, grants }
  }, path)
  return had
}

export class ApplicationInUse extends Error {
  readonly usedBy: string[]
  constructor(name: string, usedBy: string[]) {
    super(`"${name}" is still used by ${usedBy.join(', ')}`)
    this.name = 'ApplicationInUse'
    this.usedBy = usedBy
  }
}

/**
 * Remove an application. Refuses while a project still holds a grant from it.
 *
 * Refusing rather than cascading, because the cascade is unrecoverable: the private key
 * is the only copy and deleting it takes five projects offline to satisfy one `disconnect`
 * somebody typed in the wrong directory. The error names who is still using it, which is
 * the list they need in order to decide.
 */
export async function clearApplication(
  name: string,
  path = localConfigPath(),
): Promise<boolean> {
  let had = false
  await updateLocalConfig((config) => {
    const migrated = migrateLegacyOAuth(config)
    const usedBy = Object.entries(migrated.grants)
      .filter(([, byProvider]) => Object.values(byProvider).some((g) => isRecord(g) && g.app === name))
      .map(([slug]) => slug)
      .sort()
    if (usedBy.length > 0) throw new ApplicationInUse(name, usedBy)
    had = migrated.applications[name] !== undefined
    const applications = { ...migrated.applications }
    delete applications[name]
    return { ...migrated, applications }
  }, path)
  return had
}


export async function readApplication(
  name: string,
  path = localConfigPath(),
): Promise<StoredApplication> {
  const store = await readStore(path)
  if (store.state === 'missing') return { state: 'absent' }
  if (store.state === 'unreadable') return { state: 'unreadable', reason: store.reason }
  /**
   * Through the migration, for the reason `readGrant` states — and it is not symmetry for
   * its own sake. A config.json that has not been written since the upgrade holds its
   * applications under `oauth`, so a read straight out of `applications` answers `absent`
   * for an application that is plainly there. `readGrant` already migrates, so the pair
   * disagreed: the grant was found, the application it named was not, and every caller
   * that reads one to find the other — the renewal, the reconnect, `--link` — reported a
   * credential this machine was holding as missing.
   */
  const raw = migrateLegacyOAuth(store.config).applications[name]
  if (raw === undefined) return { state: 'absent' }
  const parsed = parseApplication(name, raw)
  return parsed.ok
    ? { state: 'present', app: parsed.app }
    : { state: 'malformed', reason: parsed.reason }
}

/**
 * Every application on this machine, for `connect list` and for `--link`'s error when it
 * cannot guess.
 *
 * Malformed entries are *listed*, not dropped. An application this build cannot parse is
 * exactly the one somebody needs to see, and silently omitting it would answer "what can I
 * link to" with a list that is missing the thing that is broken.
 */
export type ApplicationListing =
  | { name: string; state: 'present'; app: Application; usedBy: string[] }
  | { name: string; state: 'malformed'; reason: string; usedBy: string[] }

export async function listApplications(path = localConfigPath()): Promise<ApplicationListing[]> {
  const store = await readStore(path)
  if (store.state !== 'read') return []
  // Through the migration, for the reason `readApplication` gives: an unconverted file
  // would otherwise list nothing on a machine holding four.
  const config = migrateLegacyOAuth(store.config)
  const uses = (name: string): string[] =>
    Object.entries(config.grants)
      .filter(([, byProvider]) =>
        Object.values(byProvider).some((g) => isRecord(g) && g.app === name),
      )
      .map(([slug]) => slug)
      .sort()

  return Object.entries(config.applications)
    .map(([name, raw]): ApplicationListing => {
      const parsed = parseApplication(name, raw)
      return parsed.ok
        ? { name, state: 'present', app: parsed.app, usedBy: uses(name) }
        : { name, state: 'malformed', reason: parsed.reason, usedBy: uses(name) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}


const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
