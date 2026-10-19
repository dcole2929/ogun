import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  admitsTicket,
  remoteNarrowing,
  sourceSchema,
  ticketBrief,
  ticketDigest,
  ticketFilterOf,
  usesLegacyShape,
  type Ticket,
  type TicketFilter,
} from '../src/index.ts'

/**
 * The deterministic filter (§4.13, principle 4) — the boundary that decides which of a
 * company's tickets a machine with write access is allowed to form an opinion about.
 *
 * Every test here runs with no database, no network and no credential, which is the
 * property that makes this rule auditable at all: it is ordinary code, and its whole
 * decision surface fits in one file.
 */

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'b2f9a1c4-4c37-4d3e-9a41-1f6f0b6c2d10',
  identifier: 'ENG-101',
  title: 'Rate limiter drops the first request after a restart',
  description: 'The token bucket is initialised empty.',
  url: 'https://linear.app/acme/issue/ENG-101/rate-limiter',
  status: 'Todo',
  statusType: 'unstarted',
  labels: ['ogun'],
  blockedBy: [],
  updatedAt: '2026-08-19T09:14:22.401Z',
  team: 'ENG',
  ...over,
})

const filter = (over: Partial<TicketFilter> = {}): TicketFilter => ({
  team: ['ENG'],
  status: ['Todo'],
  label: { all_of: ['ogun'], any_of: [], none_of: [] },
  notBlocked: true,
  ...over,
})

/** Overrides one arm of the label condition without restating the other two. */
const labels = (over: Partial<TicketFilter['label']>): Partial<TicketFilter> => ({
  label: { all_of: [], any_of: [], none_of: [], ...over },
})

describe('the deterministic ticket filter', () => {
  it('admits a ticket that matches on all three criteria', () => {
    const verdict = admitsTicket(filter(), ticket())
    assert.equal(verdict.admitted, true)
  })

  it('refuses on status, and says which status it saw', () => {
    /**
     * The reason, not just the refusal. A source that never fires is this slice's most
     * likely failure, and "seen: 40, admitted: 0" cannot distinguish a filter working
     * perfectly from `status: [To Do]` written against a column called `Todo`.
     */
    const verdict = admitsTicket(filter(), ticket({ status: 'In Progress' }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /"In Progress" is not one of/)
  })

  it('folds case and whitespace on both sides of every name comparison', () => {
    /**
     * The property: a config written with different capitalisation than the workspace uses
     * still matches. The naive implementation compares strings exactly, and its failure is
     * the worst-shaped one available — the source polls forever, matches nothing, and
     * reports success. There is no error to find and nothing in a log; a correct quiet
     * source and a broken one look identical.
     */
    const verdict = admitsTicket(
      filter({ status: [' todo '], ...labels({ all_of: ['OGUN'] }) }),
      ticket({ status: 'Todo', labels: ['ogun'] }),
    )
    assert.equal(verdict.admitted, true)
  })

  it('requires every configured label, not merely one of them', () => {
    /**
     * "All" and "any" only differ once there are two labels, and the difference decides
     * whether a job runs against a repository Ogun can open pull requests on. A source that
     * fires on fewer conditions than were written down is the wrong direction to be wrong
     * in, so the naive `some()` is the bug this protects against.
     */
    const verdict = admitsTicket(
      filter(labels({ all_of: ['ogun', 'ready'] })),
      ticket({ labels: ['ogun'] }),
    )
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /missing required label: ready/)
  })

  it('refuses a ticket carrying an excluded label even when everything else matches', () => {
    const verdict = admitsTicket(
      filter(labels({ none_of: ['needs-design'] })),
      ticket({ labels: ['ogun', 'needs-design'] }),
    )
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /needs-design/)
  })

  it('refuses a blocked ticket and names what is blocking it', () => {
    const verdict = admitsTicket(
      filter(),
      ticket({ blockedBy: [{ identifier: 'ENG-90', statusType: 'started' }] }),
    )
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /blocked by ENG-90/)
  })

  it('treats a blocker that is already finished as not blocking', () => {
    /**
     * Linear keeps a `blocks` relation after the blocking issue closes — it is history, and
     * deleting it would erase why the ticket waited. An implementation that reads the
     * relation alone therefore excludes a ticket forever because of something that shipped
     * in March: a source that worked for a month and then quietly stopped seeing half its
     * queue, with no error and nothing to notice.
     */
    for (const statusType of ['completed', 'canceled', 'duplicate']) {
      const verdict = admitsTicket(
        filter(),
        ticket({ blockedBy: [{ identifier: 'ENG-77', statusType }] }),
      )
      assert.equal(verdict.admitted, true, `a ${statusType} blocker should not block`)
    }
  })

  it('ignores blocked-ness entirely when the source turned it off', () => {
    const verdict = admitsTicket(
      filter({ notBlocked: false }),
      ticket({ blockedBy: [{ identifier: 'ENG-90', statusType: 'started' }] }),
    )
    assert.equal(verdict.admitted, true)
  })

  it('narrows the remote query to the team and nothing else', () => {
    /**
     * The property that makes the local filter the only authority: whatever is sent to
     * Linear must be implied by `admitsTicket` for *every* possible ticket, or the remote
     * filter can hide a ticket the local rule would have admitted — a false negative that
     * is invisible forever, because a source that stops seeing half its queue looks exactly
     * like a quiet week.
     *
     * Status and labels are the tempting additions and are exactly the ones that break it:
     * `StringComparator.in` is case-sensitive where the rule above folds case, and
     * `hasBlockedByRelations` counts a relation to an issue that closed in March where the
     * rule above does not. This test is the tripwire on that refactor.
     */
    assert.deepEqual(remoteNarrowing(['ENG']), { team: { key: { in: ['ENG'] } } })
  })
})

describe('a ticket digest', () => {
  it('changes when the work changes and holds when the noise changes', () => {
    /**
     * What the emission ledger compares. Keyed on title, status and description — the
     * things the prompt is built from — and deliberately *not* on `updatedAt`, which Linear
     * bumps for a comment, an assignee, or a drag in the backlog view. A ledger keyed on
     * `updatedAt` would report "edited since" on every ticket anybody looked at.
     */
    const base = ticket()
    assert.equal(ticketDigest(base), ticketDigest({ ...base, updatedAt: '2027-01-01T00:00:00Z' }))
    assert.equal(ticketDigest(base), ticketDigest({ ...base, labels: ['ogun', 'p1'] }))
    assert.notEqual(ticketDigest(base), ticketDigest({ ...base, title: 'Something else' }))
    assert.notEqual(ticketDigest(base), ticketDigest({ ...base, description: 'rewritten' }))
  })
})

describe('the ticket brief handed to an agent', () => {
  it('fences the ticket body and says it is not an instruction', () => {
    /**
     * Whoever filed the ticket is not necessarily whoever configured this factory. A
     * description reading "ignore previous instructions" will eventually exist, and while
     * the real guarantees are elsewhere — the sandbox holds no credential and cannot push
     * (ADR-0005, ADR-0010) — presenting untrusted text as though it were part of the
     * instruction is free to avoid and free to get wrong.
     */
    const verdict = admitsTicket(filter(), ticket({ description: '```\nnot a fence\n```' }))
    assert.equal(verdict.admitted, true)
    if (!verdict.admitted) return

    const brief = ticketBrief(verdict.ticket)
    assert.match(brief, /not an\s*instruction to you/)
    assert.match(brief, /-----BEGIN TICKET-----/)
    assert.match(brief, /-----END TICKET-----/)
    // A ticket containing triple backticks is ordinary, and a fence a ticket can close is
    // not a fence.
    assert.ok(brief.includes('```'))
  })

  it('cannot be built from a ticket the filter has not seen', () => {
    /**
     * §4.13's "before any AI sees a ticket", enforced by the type checker rather than by
     * the order of statements in the poll. `ticketBrief` and `emit` take an
     * `AdmittedTicket`, whose brand only `admitsTicket` can mint, so the way this rule
     * actually gets broken — a second caller added later that fetches a ticket for some
     * other purpose and passes it along — does not compile.
     *
     * The assertion is `@ts-expect-error` itself: `tsc` fails the build if that line stops
     * being an error, which is the only way to test a compile-time guarantee. The call is
     * left in because the brand is a phantom and running it proves the enforcement is
     * purely static — it costs nothing at runtime.
     */
    // @ts-expect-error a Ticket is not an AdmittedTicket, and that is the point
    assert.equal(typeof ticketBrief(ticket()), 'string')
  })

  it('says out loud that nothing will be written back to Linear', () => {
    const verdict = admitsTicket(filter(), ticket())
    assert.equal(verdict.admitted, true)
    if (!verdict.admitted) return
    assert.match(ticketBrief(verdict.ticket), /read-only/)
  })
})

describe('the sources: block', () => {
  it('refuses a source with no status list rather than firing on the whole team', () => {
    /**
     * The one field here that could plausibly have had a default, and must not: a source
     * whose status list is absent matches every ticket in the team, which is a runaway
     * dressed as a convenience. There is also no value that is right everywhere, since
     * these are names a team invented.
     */
    const parsed = sourceSchema.safeParse({
      kind: 'linear',
      cycle: 'ticket-pipeline',
      team: 'ENG',
      filter: { labels: ['ogun'] },
    })
    assert.equal(parsed.success, false)
  })

  it('carries every filter key through to the rule, so a key cannot be silently ignored', () => {
    /**
     * `requires:` was parsed, stored, returned by the API and read by nothing for months
     * (§4.9). The same shape of bug here would be a filter criterion somebody wrote in
     * config.yaml that the rule never consults — a source firing on tickets it was told to
     * skip. `ticketFilterOf` is the one crossing, so this is the test that it crosses.
     */
    const source = sourceSchema.parse({
      kind: 'linear',
      cycle: 'ticket-pipeline',
      team: 'ENG',
      filter: {
        status: ['Todo'],
        labels: ['ogun'],
        excludeLabels: ['needs-design'],
        notBlocked: false,
      },
    })
    assert.deepEqual(ticketFilterOf(source), {
      team: ['ENG'],
      status: ['Todo'],
      label: { all_of: ['ogun'], any_of: [], none_of: ['needs-design'] },
      notBlocked: false,
    })
  })

  it('has no onMissed key, because a poll cannot miss an occurrence', () => {
    /**
     * Structural, not an omission. A schedule has occurrences and therefore needs a policy
     * for the ones a sleeping machine slept through (§4.2); a poll asks what matches *now*,
     * so six missed polls collapse into one question. A source that grew an `onMissed:` key
     * would be a source that had stopped being level-triggered somewhere, and this is where
     * that shows up.
     */
    const parsed = sourceSchema.parse({
      kind: 'linear',
      cycle: 'ticket-pipeline',
      team: 'ENG',
      filter: { status: ['Todo'] },
    })
    assert.equal('onMissed' in parsed, false)
    assert.equal(parsed.pollMinutes, 5)
  })
})

/**
 * `conditions:`, and the three label questions the old `labels` / `excludeLabels` pair
 * could not ask separately.
 */
describe('the conditions grammar', () => {
  it('admits on any_of when the ticket carries one of them, not all', () => {
    const verdict = admitsTicket(
      filter(labels({ any_of: ['admin', 'agent-ready'] })),
      ticket({ labels: ['agent-ready'] }),
    )
    assert.equal(verdict.admitted, true, 'one of the set is enough')
  })

  it('refuses when the ticket carries none of the any_of set, and says so', () => {
    const verdict = admitsTicket(
      filter(labels({ any_of: ['admin', 'agent-ready'] })),
      ticket({ labels: ['chore'] }),
    )
    assert.equal(verdict.admitted, false)
    assert.match(
      verdict.admitted === false ? verdict.reason : '',
      /carries none of: admin, agent-ready/,
    )
  })

  /**
   * The clause that would be wrong by default. `[].some(...)` is `false`, so an unguarded
   * `any_of` rejects every ticket for a source that gates on status alone — which is what
   * every config written before this existed does.
   */
  it('an empty any_of means not asked, never matches-nothing', () => {
    const verdict = admitsTicket(filter(labels({})), ticket({ labels: [] }))
    assert.equal(verdict.admitted, true, 'a source gating purely on status still fires')
  })

  it('all_of and any_of are both required when both are written', () => {
    const condition = labels({ all_of: ['ogun'], any_of: ['admin', 'agent-ready'] })
    assert.equal(
      admitsTicket(filter(condition), ticket({ labels: ['ogun', 'admin'] })).admitted,
      true,
    )
    assert.equal(
      admitsTicket(filter(condition), ticket({ labels: ['admin'] })).admitted,
      false,
      'any_of matching does not excuse a missing all_of',
    )
    assert.equal(
      admitsTicket(filter(condition), ticket({ labels: ['ogun'] })).admitted,
      false,
      'and all_of matching does not excuse an unmatched any_of',
    )
  })

  it('none_of still wins over everything else', () => {
    const verdict = admitsTicket(
      filter(labels({ any_of: ['admin'], none_of: ['needs-design'] })),
      ticket({ labels: ['admin', 'needs-design'] }),
    )
    assert.equal(verdict.admitted, false)
  })

  /**
   * Team became a condition rather than only a narrowing, and the local rule has to check
   * it: `StringComparator.in` is case-sensitive where this folds case, so the remote read
   * can now disagree with the rule in the hiding direction.
   */
  it('checks the team locally, folding case, across several of them', () => {
    const several = filter({ team: ['EXC', 'HEI'] })
    assert.equal(admitsTicket(several, ticket({ team: 'HEI' })).admitted, true)
    assert.equal(admitsTicket(several, ticket({ team: 'exc' })).admitted, true, 'case folds')

    const verdict = admitsTicket(several, ticket({ team: 'OPS' }))
    assert.equal(verdict.admitted, false)
    assert.match(verdict.admitted === false ? verdict.reason : '', /team "OPS" is not one of/)
  })

  it('narrows the read to every team it names', () => {
    assert.deepEqual(remoteNarrowing(['EXC', 'HEI']), {
      team: { key: { in: ['EXC', 'HEI'] } },
    })
  })

  it('parses the documented shape', () => {
    const source = sourceSchema.parse({
      kind: 'linear',
      cycle: 'ticket',
      conditions: {
        team: ['EXC', 'HEI'],
        status: ['Todo'],
        label: { any_of: ['admin', 'agent-ready'], none_of: ['needs-design'] },
      },
    })
    assert.deepEqual(ticketFilterOf(source), {
      team: ['EXC', 'HEI'],
      status: ['Todo'],
      label: { all_of: [], any_of: ['admin', 'agent-ready'], none_of: ['needs-design'] },
      notBlocked: true,
    })
  })

  /**
   * A config that omits `label:` entirely is the common case, and `prefault` rather than
   * `default` is what makes its three arms arrive as empty arrays instead of as an
   * undefined the rule would take into `undefined.filter`.
   */
  it('fills every arm of label when the block is absent', () => {
    const source = sourceSchema.parse({
      kind: 'linear',
      cycle: 'ticket',
      conditions: { team: ['ENG'], status: ['Todo'] },
    })
    assert.deepEqual(source.conditions.label, { all_of: [], any_of: [], none_of: [] })
  })
})

/**
 * The shape written before the rename, still parsed.
 *
 * Refusing it would not produce an error anybody sees: `pollSources` skips a stored row
 * it cannot parse, so an un-migrated source would become a poller that silently stopped
 * — the exact failure this slice exists to be legible about.
 */
describe('a source written in the old shape', () => {
  const legacy = {
    kind: 'linear' as const,
    cycle: 'ticket',
    team: 'ENG',
    filter: { status: ['Todo'], labels: ['ogun'], excludeLabels: ['wip'], notBlocked: false },
  }

  it('is translated rather than refused', () => {
    const source = sourceSchema.parse(legacy)
    assert.deepEqual(ticketFilterOf(source), {
      team: ['ENG'],
      status: ['Todo'],
      label: { all_of: ['ogun'], any_of: [], none_of: ['wip'] },
      notBlocked: false,
    })
  })

  it('is recognisable, so sync can say so at the one moment somebody is looking', () => {
    assert.equal(usesLegacyShape(legacy), true)
    assert.equal(
      usesLegacyShape({ kind: 'linear', cycle: 'ticket', conditions: { team: ['ENG'] } }),
      false,
    )
  })

  it('still refuses a filter with no status, which was never defaultable', () => {
    const parsed = sourceSchema.safeParse({ kind: 'linear', cycle: 'ticket', team: 'ENG' })
    assert.equal(parsed.success, false, 'no status anywhere is still a parse failure')
  })
})
