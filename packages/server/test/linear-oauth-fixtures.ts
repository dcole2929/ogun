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
 *  - `client_credentials` returns a 30-day token with **no** refresh token. Ogun refuses
 *    that shape rather than storing an unrenewable connection.
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
