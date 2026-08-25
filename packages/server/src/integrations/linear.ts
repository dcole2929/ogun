import { z } from 'zod'
import type { Ticket } from '@ogun/core'

/**
 * Linear, behind one seam (§4.13, ADR-0013).
 *
 * The house precedent is `PublishRemote` in `runner/src/publish.ts`: the network call is a
 * two-method interface, `gh` is one implementation of it, and every gate around it — the
 * PR cap, the branch shape, the default-branch refusal — is a test that runs without a
 * network or a credential. The same argument applies here with more force, because there
 * is no Linear credential on any machine in this project and the rules being protected
 * (the deterministic filter, idempotency, read-only) are exactly the ones you cannot
 * exercise by hand.
 *
 * So: `LinearApi` has one method, `linearHttp` is the only thing in the tree that opens a
 * socket to `api.linear.app`, and everything upstream of it takes the interface.
 *
 * **Read-only by construction, not by intention.** The GraphQL document is a module
 * constant and is not a parameter of anything — there is no way to ask this client to send
 * a different document, so there is no way to make it mutate. That is deliberate rather
 * than incidental: "Ogun writes nothing back to Linear in this slice" is a sentence in a
 * plan, and a client that takes a document string is one refactor away from a slice that
 * does. A human moves the ticket.
 *
 * **The credential never leaves the host, and this file is not how a sandbox reaches
 * Linear.** The key is read from the per-project store by the poll, handed to this
 * function, and used in one header. Nothing about the *poll* is mounted into or reachable
 * from a sandbox: the ticket reaches an agent as prompt text and nothing else (ADR-0010,
 * principle 3). **If a worker in this pipeline appears to need `api.linear.app` in order to
 * decide what to work on, the allowlist is not the fix** — selection is enforced by
 * `admitsTicket`'s brand, which nothing in a container can mint however much of Linear's
 * API it can reach.
 *
 * **[amended]** A skill acting on a ticket it was *already* given can now call Linear, over
 * the egress gateway, with `connections: [linear]` on its worker (ADR-0013, Consequences).
 * That is a different request at a different time and it does not go through this file: the
 * container holds a placeholder, `packages/gateway` splices the grant in at the wire, and
 * only `POST /graphql` is carried. This paragraph used to say the gateway "knows nothing
 * about Linear and must not learn", which was a claim about the poll dressed as a claim
 * about the system. What stays true of this module is narrower and still worth having: it
 * is the only thing in the tree that opens a socket to Linear *from the control plane*, its
 * document is a module constant so it cannot be asked to mutate, and the grant is refreshed
 * here and nowhere else.
 */

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'

/**
 * The one document this client can send.
 *
 * Every field here is on Linear's published schema — the same `schema.graphql` their
 * official SDK is generated from — and the shapes matter in three places that are easy to
 * get subtly wrong:
 *
 * - `labels` and `inverseRelations` are *connections*, not arrays, so they are `{ nodes }`
 *   and they paginate. 50 of each is well past what a ticket has; a ticket with 51 labels
 *   is a ticket whose 51st label is not deciding anything.
 * - `state.type` is Linear's fixed vocabulary (`triage`, `backlog`, `unstarted`, `started`,
 *   `completed`, `canceled`, `duplicate`) while `state.name` is whatever the team called
 *   the column. The filter matches the name, because that is what somebody writes in
 *   config.yaml; the type is what tells us a *blocking* ticket is already finished.
 * - `inverseRelations` and not `relations`, because an `IssueRelation` of type `blocks`
 *   points *from* the blocker *to* the blocked. Reading `relations` inverts the rule
 *   silently: a ticket that blocks three others would look blocked.
 *
 * Variables rather than interpolation, which also means nothing a person types into Linear
 * or into config.yaml is ever concatenated into a query.
 */
const ISSUES_QUERY = `query OgunSourcePoll($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      description
      url
      updatedAt
      team { key }
      state { name type }
      labels(first: 50) { nodes { name } }
      inverseRelations(first: 50) { nodes { type issue { identifier state { type } } } }
    }
  }
}`

export type TicketPage = {
  tickets: Ticket[]
  /** The cursor to pass as `after` for the next page, when there is one. */
  next: string | undefined
}

/**
 * What the poll needs from Linear, and nothing else.
 *
 * One method, because one method is what the feature uses. A wider interface — teams,
 * workflow states, a mutation for later — would be an interface whose extra surface no
 * test covers and no caller needs, sitting in the file that is supposed to be the narrow
 * part.
 */
export type LinearApi = {
  /**
   * One page of issues matching `filter`, which is the *narrowing* built by
   * `remoteNarrowing` and never the deterministic rule itself.
   *
   * Throws `LinearUnavailable` for everything that is not a page of issues. A poll turns
   * that into a recorded failure rather than a crash, because the whole point of the
   * `source_polls` ledger is that a dead key at 3am leaves evidence.
   */
  issues(input: {
    filter: Record<string, unknown>
    first: number
    after?: string | undefined
  }): Promise<TicketPage>
}

/**
 * Linear could not answer, and which kind of "could not" it was.
 *
 * Three kinds, kept apart for the reason principle 6 keeps every other trio apart: the
 * remedies are different and nothing downstream can tell them apart once they are one
 * string. `auth` is somebody's key — the fix is `ogun` on this machine. `ratelimited` is
 * this poll being too eager and will pass on its own. `transport` is the network or a
 * response this build cannot parse, which is either nothing or a Linear change worth
 * knowing about.
 */
export class LinearUnavailable extends Error {
  readonly kind: 'auth' | 'ratelimited' | 'transport'
  constructor(kind: 'auth' | 'ratelimited' | 'transport', message: string) {
    super(message)
    this.name = 'LinearUnavailable'
    this.kind = kind
  }
}

/**
 * The response, parsed rather than trusted.
 *
 * `.catchall`-free and narrow: unknown keys are dropped by zod, which is what we want —
 * this build should keep working when Linear adds a field, and should stop when Linear
 * removes one this depends on. A `nullable()` here is a claim about the schema, not a
 * defensive habit: `description` is `String` (nullable), `title`, `url`, `identifier` and
 * `id` are non-null, `state` is `WorkflowState!`, `team` is `Team!`. Getting one of those
 * wrong in the permissive direction would turn a Linear outage into a page of tickets with
 * empty titles.
 */
const relationNodeSchema = z.object({
  type: z.string(),
  issue: z.object({
    identifier: z.string(),
    state: z.object({ type: z.string() }),
  }),
})

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  updatedAt: z.string(),
  team: z.object({ key: z.string() }),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  inverseRelations: z.object({ nodes: z.array(relationNodeSchema) }),
})

const responseSchema = z.object({
  /**
   * `nullish`, not `optional`, and the difference is not pedantry: a GraphQL error
   * response carries `"data": null` beside its `errors` rather than omitting the key. A
   * schema that only tolerated absence failed to parse every error Linear sends, so an
   * expired key and a rate limit both arrived as "the body was not a GraphQL response" —
   * two remedies collapsed into a third that was wrong. Found by the fixtures, which is
   * what fixtures are for.
   */
  data: z
    .object({
      issues: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(issueSchema),
      }),
    })
    .nullish(),
  /**
   * GraphQL puts failures here with a 200 as often as not, so this is checked before
   * `data` rather than after the status code. `extensions.code` is where Linear puts
   * `RATELIMITED` and `AUTHENTICATION_ERROR`; it is optional because a transport-level
   * error has neither.
   */
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
})

/** One GraphQL issue node, flattened to the value the filter and the prompt work on. */
export function toTicket(node: z.infer<typeof issueSchema>): Ticket {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    // Normalized here rather than at every reader: a null description and an empty one
    // are the same thing to a prompt, and `?? ''` scattered over four call sites is how
    // one of them ends up printing "null" into an agent's instructions.
    description: node.description ?? '',
    url: node.url,
    status: node.state.name,
    statusType: node.state.type,
    labels: node.labels.nodes.map((l) => l.name),
    blockedBy: node.inverseRelations.nodes
      .filter((r) => r.type === 'blocks')
      .map((r) => ({ identifier: r.issue.identifier, statusType: r.issue.state.type })),
    updatedAt: node.updatedAt,
    team: node.team.key,
  }
}

/**
 * The two ways a project authenticates, as a value rather than as a boolean.
 *
 * One client, two credential shapes, and they disagree about the *format of one header*.
 * A boolean `bearer: true` beside a `token: string` would compile and would be exactly the
 * kind of flag that gets defaulted wrong by a caller added later; a discriminated union
 * cannot be constructed without saying which one it is.
 *
 * `describe` is not decoration. When a poll 401s, the only useful first question is which
 * credential Linear rejected — a project can have both a personal key and an OAuth grant
 * in the store, and an operator who rotates the wrong one loses an evening. So the kind
 * travels with the token and is the first thing in the auth failure below. It never
 * contains the token; see `LinearUnavailable`'s message construction.
 */
export type LinearCredential =
  | { kind: 'api-key'; token: string }
  | { kind: 'oauth'; token: string; workspace?: string | undefined }

export type LinearHttpOptions = {
  credential: LinearCredential
  /** Overridden only by tests, which point it at a local server. */
  endpoint?: string
  /** The `fetch` to use. Injected so a test can assert what was sent without a socket. */
  fetch?: typeof globalThis.fetch
}

/**
 * How the credential goes on the wire, which is the one thing the two modes disagree on.
 *
 * The personal API key is sent **raw**, with no `Bearer` prefix; an OAuth access token is
 * sent **with** one. That is not a stylistic choice and it is the single most common way
 * to get a `401` out of this API: Linear's documentation shows `Authorization: <API_KEY>`
 * for a personal key and `Authorization: Bearer <token>` for OAuth. The two share one
 * header and neither error says which shape it expected.
 *
 * A function rather than an inline ternary at the call site because getting it backwards
 * is invisible — both produce a well-formed request and a 401 that reads like a revoked
 * credential — so it is worth a name and a test of its own.
 */
export const authorizationHeader = (credential: LinearCredential): string =>
  credential.kind === 'oauth' ? `Bearer ${credential.token}` : credential.token

/** What to call the credential in a failure, without any part of the credential in it. */
export const describeCredential = (credential: LinearCredential): string =>
  credential.kind === 'oauth'
    ? `the oauth access token${credential.workspace ? ` for ${credential.workspace}` : ''}`
    : 'the personal api key'

/**
 * The only implementation that touches the network.
 */
export function linearHttp(options: LinearHttpOptions): LinearApi {
  const endpoint = options.endpoint ?? LINEAR_ENDPOINT
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    async issues({ filter, first, after }) {
      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Raw for a personal key, `Bearer` for an OAuth token. See
            // `authorizationHeader`; getting it backwards is a silent 401.
            authorization: authorizationHeader(options.credential),
          },
          body: JSON.stringify({
            query: ISSUES_QUERY,
            variables: { filter, first, ...(after ? { after } : {}) },
          }),
        })
      } catch (err) {
        throw new LinearUnavailable('transport', `could not reach ${endpoint}: ${asMessage(err)}`)
      }

      const text = await response.text()
      let parsed: z.infer<typeof responseSchema>
      try {
        parsed = responseSchema.parse(JSON.parse(text))
      } catch (err) {
        /**
         * A body that is neither a GraphQL result nor a GraphQL error. In practice this is
         * an HTML error page from something in front of the API, and the useful half is
         * the status code plus a short prefix of the body — the whole thing is a megabyte
         * of markup and it lands in a database column.
         */
        throw new LinearUnavailable(
          'transport',
          `${response.status} from ${endpoint}, and the body was not a GraphQL response ` +
            `(${asMessage(err)}): ${text.slice(0, 200)}`,
        )
      }

      if (parsed.errors && parsed.errors.length > 0) {
        const codes = parsed.errors.map((e) => e.extensions?.code).filter(Boolean)
        const message = parsed.errors.map((e) => e.message).join('; ')
        /**
         * Linear answers a rate limit with a **400** and a `RATELIMITED` code in the body,
         * not a 429, so a client switching on the status alone reads it as a permanent bad
         * request and a poll would record "your query is wrong" every five minutes while
         * the actual remedy was to wait. The remaining-requests header is included because
         * it is the number that tells you whether the cadence is the problem.
         */
        if (codes.includes('RATELIMITED')) {
          const remaining = response.headers.get('x-ratelimit-requests-remaining')
          throw new LinearUnavailable(
            'ratelimited',
            `linear rate limit: ${message}` +
              (remaining === null ? '' : ` (${remaining} requests left this window)`),
          )
        }
        if (codes.includes('AUTHENTICATION_ERROR') || response.status === 401) {
          /**
           * Which credential, by name. A project can hold a personal key and an OAuth
           * grant at the same time — the key is the documented fallback, and connecting
           * does not remove it — so "linear rejected the api key" on a project that is
           * actually authenticating with a grant sends an operator to rotate something
           * nothing reads. The name comes from the credential this client was built with,
           * which is the only thing that knows.
           */
          throw new LinearUnavailable(
            'auth',
            `linear rejected ${describeCredential(options.credential)}: ${message}`,
          )
        }
        throw new LinearUnavailable('transport', `linear returned an error: ${message}`)
      }

      if (!parsed.data) {
        throw new LinearUnavailable(
          'transport',
          `${response.status} from ${endpoint} with neither data nor errors`,
        )
      }

      const page = parsed.data.issues
      return {
        tickets: page.nodes.map(toTicket),
        // `hasNextPage` decides, not the presence of a cursor: Linear returns an
        // `endCursor` on the last page too, and following it forever is a poll that never
        // finishes.
        next: page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined,
      }
    },
  }
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
