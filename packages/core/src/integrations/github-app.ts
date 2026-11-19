import { createSign } from 'node:crypto'
/**
 * `scrubSecrets` and `Fetch` come from the Linear client rather than being declared again
 * here. One scrubber, so the two token clients cannot disagree about what is short enough
 * to skip; one `Fetch`, because two aliases for `typeof globalThis.fetch` is two things to
 * keep in step and `index.ts` would re-export both under one name.
 */
import { scrubSecrets, type Fetch } from './linear-oauth.ts'

/**
 * A GitHub App authenticating **as itself**, behind one seam.
 *
 * ### What this is, and why it is not OAuth
 *
 * It is the reason `Application` is a per-provider union with `method` written down rather
 * than inferred. A GitHub App acting as itself has no client secret and performs no OAuth
 * grant: it **signs a JWT with its private key** and presents that to
 * `POST /app/installations/{installation_id}/access_tokens`, which answers with an
 * installation token good for about an hour. RFC 7591 calls that family of client
 * authentication `private_key_jwt`, which is the word recorded on the application; the
 * token that comes back is not an OAuth grant type at all, which is why `Grant.grantType`
 * has `installation` beside Linear's two.
 *
 * Nothing about it needs a browser, a `state` nonce, a redirect URI or a client secret —
 * so, like `client_credentials`, the whole flow is available to `ogun connect github` with
 * no control plane running (ADR-0012's promise about the credential this replaces).
 *
 * ### Three identifiers, and which of them are secrets
 *
 *  - **`appId`** — on the App's settings page, and in the `iss` of every JWT it signs. Not
 *    a secret.
 *  - **`installationId`** — which installation of the App to act as, visible in the URL of
 *    the installation's settings page. Not a secret.
 *  - **`privateKey`** — a PEM. The whole credential. Everything an attacker needs to mint
 *    installation tokens for every installation of the App, until somebody revokes the key
 *    in GitHub's UI.
 *
 * ### What is deliberately not here
 *
 * No retry, no backoff, no scheduling, and no store. Each exported function makes one HTTP
 * call (or none) and hands back a value or a typed failure — the same contract
 * `linear-oauth.ts` keeps, for the same reason: *when* to mint a token is a decision owned
 * by the thing that knows how long it needs one, which is the poll.
 *
 * ### The one rule this file inherits
 *
 * **No secret in an error message.** The JWT is a bearer credential for ten minutes and
 * the installation token is one for an hour, so both are scrubbed out of every message
 * built here, through the same `scrubSecrets` the Linear token client uses — one scrubber,
 * so the two cannot disagree about what counts as short enough to skip. Responses are
 * parsed by hand, with no zod, because a validator that echoes what it received is one
 * dependency bump away from a leak.
 *
 * ### What has been proved, and what has not
 *
 * **No GitHub App exists for this repository and no private key exists on any machine
 * here**, so nothing below has ever spoken to GitHub. It is written against GitHub's
 * published REST documentation and exercised against a stub that answers the two shapes
 * documented there (`test/github-app.test.ts`). The JWT half is better than that — a real
 * RSA key is generated in the test and the signature is verified with `node:crypto` — but
 * "GitHub accepts this JWT" is a claim no test here makes. `linear-oauth.ts` carries the
 * same disclaimer for the same reason, and it is worth more than a comment claiming
 * confidence nobody has earned.
 */

export const GITHUB_API_URL = 'https://api.github.com'

/**
 * Where minting an installation token can go wrong, kept apart because the remedies are
 * unrelated — the same three `LinearOAuthError` draws, minus the one that cannot happen.
 *
 *  - `config` — the application itself is wrong: a private key that is not a readable PEM,
 *    a key GitHub does not recognise for that App id, an installation the App is not
 *    installed on, or an App somebody uninstalled. Permanent, and the fix is in GitHub's
 *    UI rather than here.
 *  - `transport` — the network, a 5xx, or a response this build cannot parse. Nothing is
 *    wrong with the credential and trying again later is the right move.
 *
 * There is no `denied` and no `invalid-grant`. Nobody approves anything in this flow and
 * there is no refresh token to be rejected: the private key either signs an acceptable JWT
 * or it does not, which is `config` either way.
 */
export type GithubAppErrorKind = 'config' | 'transport'

export class GithubAppError extends Error {
  readonly kind: GithubAppErrorKind
  constructor(kind: GithubAppErrorKind, message: string) {
    super(message)
    this.name = 'GithubAppError'
    this.kind = kind
  }
}

/**
 * How long a signed JWT claims to be good for.
 *
 * GitHub's limit is ten minutes and it **rejects** anything longer, so this is not a
 * tuning knob with a safety margin at the wrong end: nine minutes is the limit minus
 * enough that a clock a little fast on this machine does not produce a token GitHub reads
 * as eleven minutes old.
 *
 * `iat` is backdated by sixty seconds for the mirror image of the same problem, which is
 * GitHub's own documented advice: a clock a little *slow* here produces an `iat` in
 * GitHub's future, and their answer to that is `'Issued at' claim ('iat') must be an
 * Integer representing the time that the assertion was issued` — a 401 that reads like a
 * bad key.
 */
const JWT_LIFETIME_S = 9 * 60
const JWT_BACKDATE_S = 60

/**
 * An installation token's documented lifetime, used only when GitHub does not say.
 *
 * One hour, from their documentation. The fallback direction matters for the reason
 * `expiresAtFrom` gives in `linear-oauth.ts`: too long is the 3am 401 that the
 * refresh-before-use path exists to avoid, and too short only spends an extra mint. A
 * response with no `expires_at` is already a response this build does not recognise, so
 * the conservative number is the right guess.
 */
const INSTALLATION_LIFETIME_MS = 60 * 60 * 1000

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url')

/**
 * Sign the JWT that authenticates the App as itself.
 *
 * `node:crypto` rather than a JWT library, and that is a decision about dependencies
 * rather than about effort. RS256 is `RSA-SHA256` over `<header>.<payload>`, base64url, and
 * `createSign` does exactly that in six lines; a library would add a package to the
 * **CLI's** dependency tree, and the CLI is bundled into the sandbox image (§7), so every
 * dependency here is a dependency in a container. There are three claims and one algorithm
 * — there is nothing for a library to get right that is not written below.
 *
 * `iss` is the App id as a string. GitHub's documentation shows the numeric id and accepts
 * either; a string is what the store holds, and converting it to a number here would mean
 * an App id that is somehow not numeric becomes `NaN` in a claim rather than a value
 * GitHub rejects with its own name in the message.
 *
 * A key that cannot be read throws `config` **without quoting any part of it**, which is
 * the one thing this function has to get right beyond the signature. OpenSSL's error for a
 * malformed PEM has, at times, included a fragment of the input, and the input here is the
 * entire credential. So the message names the field and the likely cause and nothing else.
 */
export function appJwt(input: { appId: string; privateKey: string; now?: number }): string {
  const nowS = Math.floor((input.now ?? Date.now()) / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iat: nowS - JWT_BACKDATE_S,
      exp: nowS + JWT_LIFETIME_S,
      iss: input.appId,
    }),
  )
  const signingInput = `${header}.${payload}`

  let signature: string
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(signingInput)
    signature = signer.sign(input.privateKey, 'base64url')
  } catch {
    /**
     * Nothing from the underlying error is kept, including its message. That is a
     * deliberate loss of a useful string: OpenSSL's failures here are terse
     * (`error:1E08010C:DECODER routines::unsupported`) and have historically included a
     * window of the input, and the input is a private key. The remedy does not depend on
     * which way it was malformed.
     */
    throw new GithubAppError(
      'config',
      'the private key stored for this github application is not one node could read. A ' +
        'GitHub App key is the PEM file GitHub generated — it begins `-----BEGIN RSA ' +
        'PRIVATE KEY-----` and has to be the whole file, newlines included. Nothing about ' +
        'it is quoted here, because the whole value is the credential',
    )
  }
  return `${signingInput}.${signature}`
}

/** What a successful mint yields, in Ogun's units rather than GitHub's. */
export type InstallationToken = {
  accessToken: string
  /** Absolute ms. Converted here, once, from GitHub's `expires_at` instant. */
  expiresAt: number
  /**
   * The permissions GitHub reports the token as actually having, as `name:level` strings
   * — `pull_requests:read`.
   *
   * Recorded for the reason `scopes` is recorded on a Linear grant: there is no
   * introspection endpoint, the mint response is the only place they are ever reported,
   * and a connection that does not write them down can never answer "may this token read
   * pull requests?" except by trying it and reading the failure. Flattened to strings
   * because they go into the same `scopes` field every other grant uses, and a surface
   * that prints "scopes" must not need a per-provider shape to do it.
   */
  permissions: string[]
  /**
   * `all` or `selected`. GitHub's own word for whether the installation covers every
   * repository in the account or a list somebody picked, and it is the first question when
   * a poll authenticates perfectly and 404s on a repository that plainly exists.
   */
  repositorySelection: string
}

/**
 * Exchange a signed JWT for an installation token.
 *
 * `POST /app/installations/{installation_id}/access_tokens`, which answers **201** with
 * the token rather than 200 — worth saying because `response.ok` covers both and a check
 * written as `status === 200` would reject every success.
 *
 * No `repositories` or `permissions` in the body, deliberately. Both narrow a token below
 * what the installation was granted, and narrowing is a decision about what Ogun is
 * allowed to do that belongs to whoever installs the App in GitHub's UI — where it is
 * visible, reviewable and revocable. Sending them from here would mean the permissions an
 * operator can see on the installation page are not the permissions in force, with nothing
 * at either end saying so.
 */
export async function installationToken(input: {
  appId: string
  installationId: string
  privateKey: string
  fetch?: Fetch
  endpoint?: string
  now?: () => number
}): Promise<InstallationToken> {
  const jwt = appJwt({
    appId: input.appId,
    privateKey: input.privateKey,
    ...(input.now ? { now: input.now() } : {}),
  })
  const path = `/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`
  const record = await call(input, jwt, path, 'POST')

  const token = record.token
  if (typeof token !== 'string' || token === '') {
    throw new GithubAppError(
      'transport',
      'github answered the installation token request without a token in it',
    )
  }

  return {
    accessToken: token,
    expiresAt: expiresAtFrom(record.expires_at, input.now?.() ?? Date.now()),
    permissions: permissionsFrom(record.permissions),
    repositorySelection:
      typeof record.repository_selection === 'string' ? record.repository_selection : '',
  }
}

/**
 * Who this installation belongs to, and what the App is called.
 *
 * `GET /app/installations/{installation_id}`, signed with the same JWT. Two facts come out
 * of one call, and both are needed at the moment a connection is made and obtainable only
 * while holding the key:
 *
 *  - **`account.login`** — the organisation or user the App is installed on. This is what
 *    the application is *named* after (`github:heirchive`), because a name has to describe
 *    the account the credential proved it reaches rather than whichever project registered
 *    it first.
 *  - **`app_slug`** — which gives the login GitHub attributes the App's writes to:
 *    `<slug>[bot]`. That login is load-bearing rather than cosmetic. `loopGuard` uses it to
 *    recognise Ogun's own comments, and a wrong answer there is a source that feeds itself
 *    — so it is read from GitHub rather than guessed from the App's display name, which is
 *    not the slug and may contain spaces.
 *
 * `GET /user` is **not** how this is asked, and the distinction costs an afternoon to
 * rediscover: an installation token is not a user, and that endpoint answers 403 for one.
 * `githubLogin` in the server's credential module does ask `/user`, correctly, because the
 * credential it is identifying is a personal access token.
 */
export type InstallationIdentity = {
  /** The organisation or user the App is installed on, as GitHub spells it. */
  account: string
  /** GitHub's numeric id for that account, when it reported one. */
  accountId?: string
  /** `Organization` or `User`. */
  accountType?: string
  /** The App's slug — `ogun` — from which `ogun[bot]` is built. */
  appSlug: string
}

export async function installationIdentity(input: {
  appId: string
  installationId: string
  privateKey: string
  fetch?: Fetch
  endpoint?: string
  now?: () => number
}): Promise<InstallationIdentity> {
  const jwt = appJwt({
    appId: input.appId,
    privateKey: input.privateKey,
    ...(input.now ? { now: input.now() } : {}),
  })
  const path = `/app/installations/${encodeURIComponent(input.installationId)}`
  const record = await call(input, jwt, path, 'GET')

  const account = asRecord(record.account)
  const login = account?.login
  if (typeof login !== 'string' || login === '') {
    throw new GithubAppError(
      'transport',
      `github described installation ${input.installationId} without an account login, so ` +
        'there is nothing to name this application after',
    )
  }
  const slug = record.app_slug
  if (typeof slug !== 'string' || slug === '') {
    throw new GithubAppError(
      'transport',
      'github described this installation without an app_slug, so the login its writes ' +
        'would be attributed to cannot be determined',
    )
  }
  return {
    account: login,
    ...(typeof account?.id === 'number' ? { accountId: String(account.id) } : {}),
    ...(typeof account?.type === 'string' ? { accountType: account.type } : {}),
    appSlug: slug,
  }
}

/**
 * The login GitHub attributes an App's writes to.
 *
 * `<slug>[bot]`, which is GitHub's own convention and not a guess: an App's actions appear
 * under a bot account whose login is the App's slug with that suffix. One function because
 * two places need the string — the stored grant's `actor`, and whatever later compares a
 * comment's author against it — and two spellings of a login used to filter Ogun's own
 * words is a loop guard that stops working on a rename.
 */
export const botLogin = (appSlug: string): string => `${appSlug}[bot]`

// ── the one call both of the above make ────────────────────────────────────

async function call(
  input: { endpoint?: string; fetch?: Fetch },
  jwt: string,
  path: string,
  method: 'GET' | 'POST',
): Promise<Record<string, unknown>> {
  const doFetch = input.fetch ?? globalThis.fetch
  const url = `${input.endpoint ?? GITHUB_API_URL}${path}`
  // Every value this call sends or could receive, named once, because this array is the
  // scrub list and a message built from a response is a message built out of what we sent.
  const secrets = [jwt]

  let response: Response
  try {
    response = await doFetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${jwt}`,
        // GitHub asks for one and rejects some requests without it. Named for the product
        // rather than the library, because it is what shows up in their logs.
        'user-agent': 'ogun',
      },
    })
  } catch (err) {
    throw new GithubAppError(
      'transport',
      // undici's message names the host and the syscall and never the body, so it is safe
      // as it stands — and it is scrubbed anyway, because "safe as it stands" is a claim
      // about a dependency's current formatting.
      `could not reach ${url}: ${scrubSecrets(asMessage(err), secrets)}`,
    )
  }

  const text = await response.text()

  /**
   * 401 and 404 are both the application being wrong, and both are `config`.
   *
   * 401 is a JWT GitHub will not accept — a private key that does not belong to that App
   * id, or a clock far enough out that the claims are refused. 404 on these paths is an
   * installation this App cannot see, which is usually one somebody uninstalled: GitHub
   * answers 404 rather than 403 so that an App cannot enumerate installations it has no
   * business knowing about. Neither improves by waiting, and reporting either as
   * `transport` would put a permanent failure into the ledger row that means "look again
   * tomorrow".
   */
  if (response.status === 401 || response.status === 404) {
    throw new GithubAppError(
      'config',
      `github refused the app credential (${response.status} from ${path}): ` +
        truncate(scrubSecrets(text, secrets)) +
        '. Check the App id, the installation id, and that the private key is the one ' +
        'GitHub generated for that App',
    )
  }

  if (!response.ok) {
    throw new GithubAppError(
      'transport',
      `${response.status} from ${url}: ${truncate(scrubSecrets(text, secrets))}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GithubAppError(
      'transport',
      `${response.status} from ${url}, and the body was not JSON: ` +
        // Scrubbed *then* sliced, and in that order: slicing first can cut a credential in
        // half and leave the half the scrubber no longer recognises.
        truncate(scrubSecrets(text, secrets)),
    )
  }
  const record = asRecord(parsed)
  if (record === undefined) {
    throw new GithubAppError('transport', `${response.status} from ${url} with a non-object body`)
  }
  return record
}

/**
 * `expires_at` → an absolute instant, keeping the conversion in one place.
 *
 * GitHub sends an ISO 8601 **instant** here where Linear sends a duration, so there is no
 * clock arithmetic to get wrong — but it is still parsed rather than trusted, because a
 * `Date` built from a string GitHub changed the format of is `NaN`, and a `NaN` expiry is
 * a token that is either refreshed on every poll or never refreshed at all depending on
 * which way the comparison falls. Both are silent.
 */
function expiresAtFrom(raw: unknown, now: number): number {
  if (typeof raw === 'string') {
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return at
  }
  return now + INSTALLATION_LIFETIME_MS
}

/**
 * `{ pull_requests: 'read' }` → `['pull_requests:read']`.
 *
 * Sorted, so that two mints of the same installation produce the same list and a stored
 * grant does not appear to have changed because an object's keys arrived in a different
 * order.
 */
function permissionsFrom(raw: unknown): string[] {
  const record = asRecord(raw)
  if (record === undefined) return []
  return Object.entries(record)
    .filter(([, level]) => typeof level === 'string')
    .map(([name, level]) => `${name}:${String(level)}`)
    .sort()
}

/** Enough to recognise an error page; not enough to be a paste of one. */
const truncate = (text: string): string => (text.length <= 200 ? text : `${text.slice(0, 200)}…`)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
