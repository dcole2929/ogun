/**
 * The recorded Linear OAuth responses these tests run against, and — more importantly —
 * what they are recordings *of*.
 *
 * **Provenance, stated plainly because a fixture's honesty is the whole of its value.**
 * There is no Linear OAuth application registered to this project and no client secret on
 * any machine here, so **none of this was captured from live traffic**. Every field name,
 * value shape and delimiter below was taken from Linear's developer documentation at
 * `linear.app/developers/oauth-2-0-authentication`, `…/oauth-actor-authorization` and
 * `…/agents`, read on 2026-08-25, together with the GraphQL schema their official SDK is
 * generated from. The specific facts that were checked against the live docs rather than
 * assumed — each of them a way to write a fixture that proves only that the author and the
 * parser agree:
 *
 *  - The token endpoint is `POST https://api.linear.app/oauth/token` and takes
 *    `application/x-www-form-urlencoded`, **not** JSON. A client that sends JSON is
 *    rejected by a body-parse error rather than by anything naming the content type.
 *  - `scope` is **comma**-separated on the authorization request (`scope=read,write`) and
 *    **space**-separated in the token response (`"scope": "read write"`). The asymmetry is
 *    real and is the single easiest thing to get backwards here.
 *  - `expires_in` is **seconds**: the documented example is `86399`, one second under 24
 *    hours. Stored as a duration rather than converted, a token would report a full day
 *    remaining forever.
 *  - A refresh returns **a new refresh token as well as a new access token** — Linear
 *    rotates — and a consumed refresh token can be **replayed for 30 minutes** if the
 *    response was lost.
 *  - `actor=app` takes `user` (default) or `app`; the docs say `app` "should be used for
 *    agents and service accounts". It cannot be combined with the `admin` scope, and
 *    installing that way is workspace-level and needs an admin to approve.
 *  - `client_credentials` returns a 30-day token (`expires_in: 2591999`) with **no**
 *    refresh token, and its `scope` parameter is **required** and **comma-separated**. The
 *    token "will be an `app` actor token that has access to all public teams in the
 *    workspace" — the actor is implicit, so there is no `actor` parameter on that request.
 *    Linear's instruction for renewing it is "your server is expected to fetch a new token
 *    if it receives a 401 error", which is to say: ask again. **This is now the grant Ogun
 *    connects with by default.** The earlier note here said Ogun refused that shape rather
 *    than storing an unrenewable connection; the premise — that a refresh token is the only
 *    renewal there is — is what changed.
 *  - `teams(first: 50) { nodes { id key name } }` is the probe run once at connect to show
 *    which teams a new token can actually read. The field names come from the schema their
 *    SDK is generated from. **Nothing here has observed what a `read`-only app-actor token
 *    returns from it**, and that is the same honest gap named below rather than a new one.
 *  - The only documented error body is `{ "error": …, "error_description": … }`, and it is
 *    documented only for the client-credentials grant, where `error` is the literal string
 *    `"Error"` rather than an RFC 6749 code. There is no documented error table for the
 *    authorization-code or refresh grants, which is why `classifyTokenError` matches on
 *    text and falls back to `transport` — the direction that keeps a refresh token.
 *  - There is **no token introspection** anywhere: no RFC 7662 endpoint, and nothing in
 *    the GraphQL schema that reports the current token's scopes. `viewer { id name app }`
 *    and `organization { id name urlKey }` are how a grant's identity is established, and
 *    `User.app` is the only confirmation that a token really is an app-actor token.
 *
 * ### What that proves and what it does not
 *
 * It proves this build sends the shape Linear documents, converts the units correctly,
 * tells a permanent refusal apart from a transient one in the safe direction, and never
 * puts a client secret or an authorization code into an error message. It does **not**
 * prove Linear's live server behaves as documented, and it cannot: nothing here has ever
 * completed an authorization.
 *
 * **The first real application registered against this project should be run through the
 * flow once, by hand, and any difference recorded by fixing the fixture rather than the
 * parser.** The two most likely places for a surprise are the token endpoint's error body
 * — undocumented for the grants Ogun uses — and whether a `read`-only `actor=app` install
 * can read issues at all, which the docs imply and nothing here has observed.
 */

/** The documented success body for an authorization-code exchange. */
export const tokenResponse = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    access_token: '00a21d8b0c4e2375114e49c067dfb81eb0d2076f48354714cd5df984d87b67cc',
    token_type: 'Bearer',
    // Seconds. 86399 is what the documentation prints, and it is deliberately not 86400.
    expires_in: 86399,
    scope: 'read',
    refresh_token: 'sz0c8ffy95zj2ff6bh1hiausauw3dbfsu4gly1z4p49b5odqv8l7owunb654vg1f',
    ...over,
  })

/** A refresh, which rotates: both tokens come back different. */
export const refreshedResponse = (): string =>
  tokenResponse({
    access_token: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
    refresh_token: 'rrrr1111ssss2222tttt3333uuuu4444vvvv5555wwww6666xxxx7777yyyy8888',
  })

/**
 * The one error body Linear documents. Note `"error": "Error"` — not an RFC 6749 code,
 * which is why nothing here switches on one.
 */
export const tokenErrorResponse = (description: string): string =>
  JSON.stringify({ error: 'Error', error_description: description })

/** `viewer` and `organization`, as an app-actor token sees them. */
export const identityResponse = (over: { app?: boolean } = {}): string =>
  JSON.stringify({
    data: {
      viewer: { id: 'app-user-1', name: 'Ogun', app: over.app ?? true },
      organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    },
  })

/**
 * The documented success body for a `client_credentials` grant.
 *
 * No `refresh_token`, and `expires_in: 2591999` — one second under 30 days, the same way
 * the authorization-code example is one second under 24 hours. Both oddities are Linear's
 * and are reproduced rather than rounded, because a fixture that tidies its source is a
 * fixture that proves the author and the parser agree.
 */
export const appTokenResponse = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    access_token: 'cccc1111dddd2222eeee3333ffff4444aaaa5555bbbb6666cccc7777dddd8888',
    token_type: 'Bearer',
    expires_in: 2591999,
    scope: 'read',
    ...over,
  })

/** What the teams probe reads. `HEI` is the team this feature was built against. */
export const teamsResponse = (): string =>
  JSON.stringify({
    data: {
      teams: {
        nodes: [
          { id: 'team-1', key: 'ENG', name: 'Engineering' },
          { id: 'team-2', key: 'HEI', name: 'Heirchive' },
        ],
      },
    },
  })
