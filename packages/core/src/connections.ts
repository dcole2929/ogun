/**
 * The outside applications a *sandbox* can be granted, and the hosts each one lives at.
 *
 * ### This is not the source's credential, and the distinction is the whole point
 *
 * §4.13 and ADR-0013 say that ticket *selection* never enters a sandbox: the deterministic
 * filter runs host-side, `admitsTicket` mints a branded `AdmittedTicket` that only the
 * filter can produce, and the ticket reaches an agent as prompt text. Nothing here touches
 * that. `admitsTicket` still runs in the control-plane process, still before a prompt
 * exists, and a sandbox still cannot ask Linear which tickets to work on — because it
 * cannot mint the brand, whatever it can reach over the network.
 *
 * What this adds is the *other* half of the same integration. Once a ticket has been
 * selected on the host, a skill working on it may legitimately need to read the ticket's
 * comments, follow a linked issue, or — when write-back lands — post its result. That is a
 * runtime API call from inside the sandbox, and it is exactly what ADR-0010's gateway is
 * for: the container gets a placeholder, the real credential is spliced in at the wire on
 * the host, and there is nothing in the container to steal.
 *
 * Both sentences are true at once and they are about different things:
 *
 *   - *A worker in the source pipeline needing `api.linear.app` to decide what to work on*
 *     is still a symptom, not a configuration. That rule is enforced by the type system,
 *     not by this file.
 *   - *A skill needing `api.linear.app` to act on work it was already given* is what
 *     `connections:` declares, and it is off by default for every worker.
 *
 * ### Vocabulary only
 *
 * This module imports nothing, for the same reason `credentials.ts` imports nothing: it is
 * read by the gateway, which sits in the request path of every job and deliberately does
 * not drag a yaml parser and a zod runtime in behind it (see the note at the top of
 * `packages/gateway/src/credentials.ts`). The zod schema that validates a worker's
 * declaration lives in `config/project.ts`; the matcher that decides a live request lives
 * in `packages/gateway/src/connections.ts`.
 */

/**
 * Every connected application there is. One, and it is spelled out as a closed set rather
 * than as a `string` so that adding the second one is a compile error everywhere it has to
 * be handled — the host table below, the gateway's injection, the stub written into the
 * container — instead of a value that falls through three switches and reaches nothing.
 */
export const CONNECTED_APPS = ['linear'] as const
export type ConnectedApp = (typeof CONNECTED_APPS)[number]

/**
 * Where each application is reached, and nothing beside it.
 *
 * Exact names, never a wildcard, and that is a decision rather than an omission. This
 * table is what decides where a real workspace credential is allowed to go, and
 * `*.linear.app` would hand it to every subdomain Linear ever adds — a marketing site, a
 * file host, an OAuth endpoint that accepts a token and returns a session. `hosts.ts`
 * already refuses to wildcard `chatgpt.com` for that reason; a third party's issue tracker
 * deserves the same care.
 *
 * Note what is *not* narrowed here: the path. `api.linear.app` also serves
 * `/oauth/token` and `/oauth/revoke`, and a sandbox that could reach the second one could
 * end the project's connection. The path restriction is a request-shape rule and lives
 * with the thing that sees requests — `connectionRequestRefusal` in the gateway.
 */
export const CONNECTION_HOSTS: Readonly<Record<ConnectedApp, readonly string[]>> = {
  linear: ['api.linear.app'],
}

/** The hosts a set of granted applications adds to a session's allowlist, deduplicated. */
export function connectionHosts(apps: readonly ConnectedApp[]): string[] {
  return [...new Set(apps.flatMap((app) => CONNECTION_HOSTS[app]))]
}

/**
 * Is this hostname one an application is reached at? **For config validation only.**
 *
 * Deliberately a plain normalized comparison and deliberately not exported as a matcher.
 * `@ogun/core` used to hold a second host matcher (`isHostAllowed`) beside the gateway's,
 * they drifted over the DNS root's trailing dot, and the tested one and the running one
 * disagreed about `api.anthropic.com.` — see the epitaph at the bottom of `config/egress.ts`.
 * So this answers exactly one question, at parse time, about a string a person typed into
 * `.ogun/config.yaml`: "did you put a connection host in `egress:`?" It never sees a
 * request. The request-time decision is `connectionForHost` in the gateway, which goes
 * through `hostMatches` like every other host decision in the system.
 */
export function namesConnectionHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  return CONNECTED_APPS.some((app) => CONNECTION_HOSTS[app].includes(normalized))
}
