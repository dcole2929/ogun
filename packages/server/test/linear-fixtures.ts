import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LinearApi, TicketPage } from '../src/integrations/linear.ts'

/**
 * The recorded Linear responses these tests run against, and — more importantly — what
 * they are recordings *of*.
 *
 * **Provenance, stated plainly because a fixture's honesty is the whole of its value.**
 * There is no Linear credential on any machine in this project, so these were not captured
 * from live traffic against a real workspace. Every field name, nullability and enum value
 * in them was taken from Linear's published GraphQL schema — the `schema.graphql` their
 * official SDK is generated from, at `github.com/linear/linear`, read on 2026-08-24 — and
 * the envelope (`data` / `errors[].extensions.code`) and the rate-limit behaviour from
 * their developer documentation at `linear.app/developers`. The specific facts that were
 * checked rather than assumed, because each of them is a way to write a fixture that
 * proves only that the author and the parser agree:
 *
 *  - `labels` and `inverseRelations` are connections (`{ nodes: [...] }`), not arrays.
 *  - `Issue.description` is nullable; `title`, `url`, `identifier`, `id`, `state`, `team`
 *    and `updatedAt` are not.
 *  - `WorkflowState.type` is one of `triage | backlog | unstarted | started | completed |
 *    canceled | duplicate`, while `name` is free text the team chose.
 *  - `IssueRelation.type` is a string, documented as including `blocks`, `duplicate` and
 *    `related`, and its `issue` is the *source* of the relation — the blocker.
 *  - A rate limit is a **400** with `extensions.code: "RATELIMITED"` in the body, not a 429.
 *  - An authentication failure carries `extensions.code: "AUTHENTICATION_ERROR"`.
 *
 * What that does and does not prove: it proves this build parses the shape Linear
 * documents, that the filter reads the right end of a `blocks` relation, and that a rate
 * limit is not mistaken for a permanent error. It does *not* prove Linear's live server
 * behaves as documented. The first real key that reaches this project should be pointed at
 * `linearHttp` once, by hand, and any difference recorded by fixing the fixture rather than
 * the parser.
 */
const here = dirname(fileURLToPath(import.meta.url))

export const fixtureText = (name: string): Promise<string> =>
  readFile(join(here, 'fixtures', 'linear', `${name}.json`), 'utf8')

export const fixture = async (name: string): Promise<unknown> => JSON.parse(await fixtureText(name))

/**
 * A `LinearApi` that serves pre-parsed pages, for tests about the *poll* rather than about
 * the wire.
 *
 * Deliberately separate from the fixtures above: `linear-client.test.ts` proves the client
 * turns a recorded response into tickets, and everything downstream takes tickets. Making
 * every source test go through JSON as well would mean a change to the parser breaking
 * twenty tests that are not about parsing.
 */
export function fixtureApi(pages: TicketPage[]): LinearApi & { calls: number } {
  const api = {
    calls: 0,
    async issues() {
      const page = pages[api.calls] ?? { tickets: [], next: undefined }
      api.calls++
      return page
    },
  }
  return api
}
