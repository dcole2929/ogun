/**
 * The recorded GitHub App responses these tests run against, and — more importantly —
 * what they are recordings *of*.
 *
 * **Provenance, stated plainly because a fixture's honesty is the whole of its value.**
 * **There is no GitHub App registered for this project and no App private key on any
 * machine here**, so none of this was captured from live traffic, and **the GitHub App path
 * has never been proved end to end**. Every field name and value shape below was taken from
 * GitHub's REST documentation for `POST /app/installations/{installation_id}/access_tokens`
 * and `GET /app/installations/{installation_id}`, together with their "Generating a JSON
 * Web Token (JWT) for a GitHub App" guide. The specific facts that were read rather than
 * assumed — each of them a way to write a fixture that proves only that the author and the
 * parser agree:
 *
 *  - The mint answers **201**, not 200. `response.ok` covers both; a check written as
 *    `status === 200` would reject every success, which is the single easiest thing to get
 *    wrong here.
 *  - The token field is `token` and not `access_token` — the OAuth name, which is what a
 *    reader coming from `linear-oauth.ts` would reach for.
 *  - `expires_at` is an **ISO 8601 instant** (`"2026-11-19T12:00:00Z"`), where Linear's
 *    `expires_in` is a duration in seconds. There is no clock arithmetic to get wrong, and
 *    a `Date.parse` that silently yields `NaN` is still a token that is either refreshed
 *    on every poll or never refreshed at all.
 *  - The lifetime is **one hour**. That is short enough that renewal is routine rather
 *    than monthly, which is why `usableGithubGrant` exists and why its horizon is the same
 *    ten minutes every other surface means by "expiring".
 *  - `permissions` is an object of `name → level` (`{"pull_requests": "read"}`), and
 *    `repository_selection` is `"all"` or `"selected"`. The second is the first question
 *    when a poll authenticates perfectly and 404s on a repository that plainly exists.
 *  - The JWT is **RS256**, `iss` is the App id, `exp` is at most **ten minutes** out and
 *    GitHub rejects anything longer, and their own guidance is to backdate `iat` by 60
 *    seconds against clock drift — whose symptom is `'Issued at' claim ('iat') must be an
 *    Integer representing the time that the assertion was issued`, a 401 that reads like a
 *    bad key.
 *  - The installation object carries `account` (with `login`, `id`, `type`) **and**
 *    `app_slug`. Both facts come out of one call, which is why there is one call: the
 *    account is what the application is *named* after, and `<app_slug>[bot]` is the login
 *    GitHub attributes the App's writes to.
 *  - `GET /user` **does not work for an installation token** — it is not a user — so the
 *    bot login cannot be discovered the way a personal access token's login is.
 *  - A 404 on these paths is an installation the App cannot see, which GitHub answers
 *    rather than 403 so that an App cannot enumerate installations it has no business
 *    knowing about. It is permanent, which is why it is classified beside the 401 rather
 *    than with the 5xx.
 *
 * ### What that proves and what it does not
 *
 * It proves this build sends the shape GitHub documents, signs a JWT that `node:crypto`
 * verifies against the public half of a real RSA key, converts the expiry correctly, tells
 * a permanent refusal apart from a transient one in the safe direction, and never puts a
 * JWT or an installation token into an error message.
 *
 * It does **not** prove GitHub accepts the JWT, that the endpoints behave as documented, or
 * that `<app_slug>[bot]` is the login that appears on a pull request Ogun opens. Those need
 * an App to exist. Nothing here should be read as evidence that they do.
 */

export const installationTokenResponse = (
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    token: 'ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    expires_at: '2026-11-19T12:00:00Z',
    permissions: { pull_requests: 'read', contents: 'read' },
    repository_selection: 'all',
    ...over,
  })

export const installationResponse = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 98765432,
    app_id: 1234567,
    app_slug: 'ogun',
    target_type: 'Organization',
    account: { login: 'Heirchive', id: 42, type: 'Organization' },
    ...over,
  })
