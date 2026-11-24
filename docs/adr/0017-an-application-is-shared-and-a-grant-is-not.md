---
status: accepted
---

# An application is shared, and a grant is not

ADR-0012 settled *where* a project's credential lives: `~/.ogun/config.json`, at 0600, on
the machine that polls. ADR-0014 settled *what* Ogun should authenticate to Linear as: an
application rather than a person. Neither asked what an application **is**, because with one
provider and one project the question had no consequences — `oauth[project][provider]` held
a client id, a client secret and the token obtained with them, and that read as one thing.

It is two things, and they have different lifetimes and different owners. An **application**
is a credential registered with a provider: a Linear OAuth app, a GitHub App. One of them
serves every project that reaches that provider. A **grant** is one project's live token from
one of those, with an expiry and a renewal path. Keyed together under one project slug, a
second project meant a **second copy of the same client secret** — two values that have to
agree with nothing that makes them, and nothing that can say which one a poll used. That was
not hypothetical: two projects sharing one Linear application is the ordinary setup, and
under the old shape every one of them stored its own copy of that application's client
secret.

A GitHub App is what made the duplication untenable rather than merely untidy. It is
installed once on an organisation and serves every repository under it, so the natural setup
is one application and N projects — and **a GitHub App's private key is displayed once at
generation and can never be retrieved again.** Under the old shape that is N copies of an
unrecoverable secret, diverging the first time anybody rotates it, with no way to get the
original back.

**So the map is two maps.** `applications` holds the credential, keyed by a name a person can
type. `grants[project][provider]` holds what each project currently has, flat, with an `app`
field naming the application it came from — so a token can be renewed without the project
holding the thing that renews it. `oauth` stays declared in `localConfigSchema` because an
unconverted file still has one, and zod strips what a schema does not name.

**`oauth` was the wrong name for both halves.** Half of what goes under it is not OAuth: a
GitHub App authenticating as itself signs a JWT with its private key and exchanges it for an
installation token, which is not an OAuth grant type at all, and RFC 7591 §2 names five
client authentication methods of which a shared secret is one. What every one of them does
produce is a grant — a token with an expiry, obtained from an application — so that is what
the map is called.

**The application's authentication `method` is recorded, not inferred.** `Application` is a
union per provider rather than `{ clientId, clientSecret, redirectUri }`: that struct was
written on the stated grounds that an application registered in a provider always means a
client id and a client secret, which was true of the one provider that existed and is false
in general — RFC 6749 §2.1's public clients have a client id and no secret at all. Linear's
entry carries `client_credentials` or `authorization_code`; GitHub's carries
`private_key_jwt`. Two providers can both carry a client id and differ entirely in what they
do with it, so a method read backwards out of which fields happen to be present is a method
that changes silently when a write truncates. This is ADR-0014's `grantType` argument one
level up, and it arrived for the same reason.

**The name is derived from the account the credential proved it reaches** —
`<provider>:<account>`, lowercased, `linear:acme`, `github:heirchive` — and never from the
project that registered it first. Naming a shared thing after one of its users is a name that
is wrong as soon as there are two. `--as` overrides it for the one account holding two
applications; `--link <name>` is how a second project points at an application already here,
and it still mints a token, because "connected" has to mean "proved" rather than "a pointer
was written".

**Nothing unproven reaches the store.** The order is **exchange → identify → name → write the
application → write the grant.** An application in config.json is one that has been spent at
least once, and the name on it describes an account the credential actually reached.

## Considered Options

- **Leave `oauth[project][provider]` alone and accept the copies.** The status quo, and it
  is the option that costs nothing today. Rejected because the two copies are not a
  duplication of a *derived* value, they are two independent credentials that must agree:
  rotate at the provider, update one project, and the second keeps a secret that now
  authenticates nothing, reported by every surface as a connection that exists. For a GitHub
  App there is no repair at all — the key is shown once — so the failure is not "run the
  command again", it is "generate a new key and reconnect everything". A store that makes an
  unrecoverable credential easy to fork is the wrong store regardless of how few projects
  exist on the day it is written.

- **Keep one map and key the application by project, with other projects pointing at a
  project.** Rejected — it makes a project the owner of a shared thing, so disconnecting the
  project that happened to register first either cascades or strands every other project
  behind a dangling pointer. It also produces the name problem in its worst form: the handle
  an operator types at `--link` would be somebody else's project slug, which says nothing
  about which account the credential reaches.

- **Infer the authentication method from the fields present.** Rejected above, and worth
  naming as an option because it needs no schema change and reads as obviously equivalent.
  It is equivalent exactly while no two providers share a field, which stopped being true
  with the second one.

- **A migration command the operator runs.** Rejected. The machine that needs converting is
  the one nobody is sitting at, and a command that must be remembered is a command that is
  run after the symptom rather than before it. The conversion is a pure function applied
  inside every write and read *through* by `readProjectSecret`, `readGrant`,
  `readApplication` and `listApplications`, so an upgraded build answers correctly about a
  file nothing has written since, and the file converts on the first connect, `project add`
  or token refresh. It never overwrites an entry already in the new shape, so a
  half-converted file converges rather than flapping between two readers.

- **A separate file for applications, since they are per-machine rather than per-project.**
  Rejected by ADR-0012's own rejection of `~/.ogun/secrets.json`, with the same two bugs
  waiting at the end of it: `writeFile`'s `mode` applies only on create, and concurrent
  read-modify-write silently drops whichever edit loses. Both are already fixed in
  `updateLocalConfig`, and neither was cheap. A second file would also be a second thing
  that can disagree with the first about which application a grant came from.

- **A zod schema for the stored shapes.** Rejected, and this is ADR-0014's reasoning
  extended to two more blocks. A strict schema in `machine.ts` would make an entry written by
  a newer build unparseable by an older one, and `parseLocalConfig` throws on a schema
  failure — so one unknown field would take the admin token and the runner credential down
  with it. And a zod issue names a path and can quote what it received: every string in these
  objects is either a credential or sits beside one. The blocks are `z.unknown()` in the
  schema and parsed by hand in `config/secrets.ts`, permissively about unknown keys, and no
  failure quotes a value — it names the field and what was expected there.

- **Drop a project's grants whenever its application is written.** The simple rule, and it
  is wrong in the direction that costs a workspace admin's afternoon. `setApplication` keeps
  grants across a **secret** change and drops them across an **identity** change, because
  rotating a secret in the provider's settings leaves every token that application already
  issued working, while pointing a name at a *different* application makes the stored tokens
  dead on arrival — minted by something those projects no longer use, reporting healthy and
  401ing on the next poll. `identityOf` is the per-provider answer: `linear:<clientId>`, and
  `github:<appId>:<installationId>`, because an installation token is scoped to one
  installation and a token minted for another is not a narrower credential, it is a different
  account.

- **Cascade on `disconnect`: remove the application with the last project that named it, and
  with any other project too.** Rejected for the other projects. A cascade takes four working
  projects offline to satisfy one `disconnect` typed in the wrong directory, and for GitHub it
  destroys the only copy of a private key while doing it. `clearApplication` refuses while any
  project still holds a grant from it and **names them**, which is the list somebody needs in
  order to decide. The last grant going does take the application with it, because a
  credential kept after the last thing that read it is a live credential nobody is watching —
  ADR-0012's rule for keys, reaching a value that only just became one.

- **Write the application first, so a failed token call leaves a cheap retry.** The previous
  order, and it bought something real: the operator re-ran the command without pasting
  anything. Rejected because the thing it left behind is the one failure this repository has a
  sentence about — *a credential nothing reads looks exactly like one that works* — a client
  secret on disk that no poll would ever spend, reported by `connect list` and `doctor` as a
  thing that exists. **The new cost is stated rather than hidden: a first-ever connect whose
  token call fails stores nothing and asks for the fields again.** A reconnect is unaffected,
  and `--consent` holds its credentials in the server's in-memory, single-use, ten-minute
  pending-authorization entry across the browser round trip rather than writing them.

- **Applications in postgres, now that they are a per-machine rather than a per-project
  fact.** Rejected by ADR-0012, whose argument is untouched and is stronger here: an
  application is a client secret or an unrecoverable private key, and the thing a column
  would sit on is a row that already travels through `GET /api/projects`.

## Consequences

- **A grant whose application is missing is refused rather than stored.** `storeGrant` throws
  `NoApplication`, checked inside `updateLocalConfig`'s lock in the same read-modify-write
  that performs the change. The refusal is load-bearing for all three grants: a
  `client_credentials` token *is* the client id and secret asked again, an `installation`
  token is a fresh JWT signed with the private key, and an `authorization_code` refresh needs
  the pair to authenticate the refresh token. A grant with no application could never be
  renewed, and would be indistinguishable from a healthy connection until the day it expired.

- **Replacing an application names the projects it disconnected.** `setApplication` returns
  what it displaced and which grants it dropped, because connecting one project can now
  disconnect two others and the caller is the only thing in a position to say so. A previous
  entry this build cannot **parse** counts as a different application, which is the safe
  direction: its identity is unknown, so a grant claiming to come from it cannot be shown to
  still belong to it. Nothing is revoked at the provider, because this function has no network
  and a local write that depended on one would be unavailable during an outage.

- **A malformed application is listed, not dropped.** An entry this build cannot parse is
  exactly the one somebody needs to see, and omitting it would answer "what can I link to"
  with a list missing the thing that is broken. `listApplications` carries the state and the
  reason; `applicationIdentifier` is one function rather than a per-surface `switch`, because
  three surfaces print "application 1234567 is registered" in the same sentence and a
  repeated switch is how the GitHub arm ends up printing a private key in the one place
  somebody forgot.

- **`unconnected` can no longer be created, and is kept because files outlive builds.** It is
  ADR-0014's state for "registered, authorization never finished", and the write order above
  makes it unreachable. What still reaches it is a machine that registered under the old
  `oauth` shape and never finished, which the migration names `<provider>:<slug>` for want of
  a workspace to name it after — so `readProjectSecret` recognises the state **by that name
  only**. Answering `unconnected` because some *other* project registered a Linear
  application would send an operator to finish an authorization for a project nobody meant to
  connect. The Settings page's "registered, not connected" pill is gone with the Connect
  button beside it.

- **Two listings everywhere there was one.** `ogun connect list` and the Settings page both
  show an applications table — name, provider, method, the identifiers that are not secrets,
  and which projects use it — above per-project rows that each name the application they go
  **through**. An application **no project holds a grant from** is called out, because that is
  a credential on the disk nothing reads, and it is reachable: `disconnect --keep-application`
  for the last project using one. Nothing in either listing prints a stored value.

- **`--keep-application` now means different things per provider, and says so.** It is
  refused on a Linear client-credentials connection, where the pair *is* the credential and
  the next poll would mint a token with it, and allowed for GitHub, where a private key with
  no installation token beside it mints nothing until somebody signs a JWT. Revocation is
  routed **by provider**: before this, every disconnect went through Linear's revoke endpoint,
  so the day a GitHub grant existed it would have POSTed a GitHub installation token to
  `api.linear.app`. **GitHub has no endpoint that ends an installation token early** — a
  one-hour life is the whole of its revocation story — so that is stated rather than a revoke
  being reported as done.

- **The GitHub App path has never been proved end to end, and the fixtures say so.** There is
  no GitHub App registered for this project and no App private key on any machine here, so
  `appJwt`, `installationToken` and `installationIdentity` run only against recordings taken
  from GitHub's documentation. `test/github-app-fixtures.ts` states that provenance in full
  and names the facts that were read rather than assumed: the mint answers **201** not 200,
  the field is `token` and not `access_token`, `expires_at` is an ISO instant where Linear's
  `expires_in` is a duration, the JWT is RS256 with `exp` at most ten minutes out and `iat`
  backdated 60 seconds against clock drift, and **`GET /user` does not work for an
  installation token**, which is why the bot login comes from `GET /app/installations/{id}`
  and why that call is required rather than optional — it carries both the account to derive
  the name from and the `<app_slug>[bot]` login the loop guard needs. **The first real App
  registered against this project should be run through the flow once by hand, and any
  difference recorded by fixing the fixture rather than the parser**, which is the instruction
  ADR-0014 left for Linear and the same honest gap.

- **No database migration.** Nothing here touches postgres. The migration this change has is
  a config-file one and it runs on read, which is why the real config.json it was verified
  against — two copies of one Linear client secret becoming one application and two grants,
  both tokens and both expiries intact, idempotent on a second pass — came out of the
  verification **byte-identical**: nothing was written to convert it.

- **The default for a missing `grantType` disagrees with ADR-0014, and it is not settled
  here.** That record says an entry with no `grantType` is read as `authorization_code`;
  `parseGrant` reads it as `client_credentials`. The disagreement is only reachable through
  the legacy path this ADR introduced — `migrateLegacyOAuth` derives an application's `method`
  from such an entry by the reasoning ADR-0014 wrote, and then the grant it carried across is
  parsed by the other rule. See ADR-0014's amendment for both arguments. **A finding that the
  two disagree is a real finding.**
