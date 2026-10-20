import { createHash } from 'node:crypto'

/**
 * A ticket, and the deterministic filter that decides whether Ogun looks at it at all
 * (§4.13, principle 4).
 *
 * §4.13 gives this one sentence — "poll every N minutes with a *deterministic* filter
 * (status, label, not-blocked) before any AI sees a ticket" — and the load-bearing word
 * is *before*. The filter is not an optimisation that saves a model call; it is the
 * boundary deciding which of a company's tickets a machine with write access is allowed
 * to form an opinion about. So it lives here: pure functions over a plain value, in the
 * package that has no HTTP client, no database and no runtime in it, where the whole of
 * the rule can be read in one file and every branch of it is a unit test.
 *
 * **The type is the enforcement, not the ordering of the code.** `AdmittedTicket` carries
 * a brand no other module can mint, and everything downstream of the filter — prompt
 * composition, emission, the cycle run — takes an `AdmittedTicket` rather than a
 * `Ticket`. Handing a raw ticket to the emit path does not compile. That matters more
 * than it looks: the natural way to break this rule is not to delete the filter, it is a
 * second caller added six months from now that fetches a ticket for some other purpose
 * and passes it along, and a convention in a comment does not survive that. It is the
 * same trick `PinnedPolicies` uses on the policy split, applied to a boundary of the same
 * kind.
 */

/**
 * One Linear issue, normalized to the fields the filter and the prompt need, and no
 * others.
 *
 * Deliberately not "the issue as Linear returned it". The GraphQL payload is large,
 * nested, and shaped by Linear's product rather than by this decision; passing it whole
 * would mean every later reader has to work out which of forty fields the filter actually
 * consulted. What is here is exactly what §4.13's rule needs plus what a prompt needs,
 * which is also the list a fixture has to be honest about.
 *
 * Not a mirror of ticket state either (ADR-0004): this value lives for the length of one
 * poll and is never written to a table. What *is* written is the record that Ogun emitted
 * a job for it — a fact about us, not a copy of Linear.
 */
export type Ticket = {
  /** Linear's UUID. Stable across renames and moves; the identity everything else keys on. */
  id: string
  /** `ENG-123`. What a person types, and what a prompt has to name. */
  identifier: string
  title: string
  /** Markdown, `''` when the issue has none — never null, so callers stop guarding. */
  description: string
  url: string
  /** `WorkflowState.name` — user-chosen text like `Todo`. What `filter.status` matches. */
  status: string
  /**
   * `WorkflowState.type` — one of Linear's fixed set: triage, backlog, unstarted,
   * started, completed, canceled, duplicate. Not filtered on, because a project's own
   * state *names* are what somebody writes in config.yaml. Carried because it is what
   * decides whether a *blocking* ticket is still blocking anything (see `blockedBy`).
   */
  statusType: string
  labels: string[]
  /**
   * The issues blocking this one, with the state type of each.
   *
   * Linear models this as an `IssueRelation` of type `blocks` whose *source* is the
   * blocker, so for this ticket they arrive under `inverseRelations` — the relations where
   * this issue is the target. Getting that direction backwards silently inverts the rule:
   * a ticket that blocks three others would look blocked, and the one actually waiting on
   * something would sail through.
   */
  blockedBy: Array<{ identifier: string; statusType: string }>
  /** ISO 8601, as Linear sent it. The version stamp of what a poll acted on. */
  updatedAt: string
  /** The team key, e.g. `ENG`. */
  team: string
}

declare const passedTheFilter: unique symbol

/**
 * A ticket the deterministic filter admitted. Only `admitsTicket` can produce one.
 *
 * The brand is a phantom property — it does not exist at runtime and costs nothing. Its
 * whole job is that `emit(ticket)` where `ticket: Ticket` is a type error, so "no ticket
 * reaches an agent before the filter has seen it" is checked by `tsc` on every commit
 * rather than by whoever reviews the next caller.
 */
export type AdmittedTicket = Ticket & { readonly [passedTheFilter]: true }

/**
 * What a source will act on. Three criteria and no more, because §4.13 names three and
 * every criterion added here is a judgement that has escaped the scope evaluator.
 */
export type TicketFilter = {
  /**
   * Team keys. At least one, and checked here as well as narrowed on remotely.
   *
   * It used to be only a narrowing — a top-level `team:` that scoped the query and was
   * never re-tested locally — which was safe while it was one exact key. A list is not:
   * `StringComparator.in` is case-sensitive and this rule folds case, so the remote read
   * and the local rule can now disagree about `eng` versus `ENG`. The rule below is the
   * one that decides, which is the same reason `remoteNarrowing` carries no other
   * condition.
   */
  team: string[]
  /** Workflow state names. At least one, or the source fires on the whole team. */
  status: string[]
  label: LabelCondition
  /** Whether an unresolved `blocks` relation excludes the ticket. */
  notBlocked: boolean
}

/**
 * The three label questions, asked separately because they are three different questions.
 *
 * This replaced `labels` (all must be present) and `excludeLabels`. The old pair was not
 * missing a case so much as hiding one: `labels` silently meant *all*, the schema's own
 * comment admitted the two readings "genuinely differ once there are two labels", and
 * nothing in the spelling told you which you had written. A team wanting "any of these
 * three" had to write three sources.
 *
 * Named rather than positional, and empty means "not asked" rather than "matches
 * nothing": a source gating purely on status leaves all three empty, which is the common
 * case and must not be an accidental reject-everything.
 */
export type LabelCondition = {
  /** Every one must be present. */
  all_of: string[]
  /** At least one must be present. */
  any_of: string[]
  /** None may be present. */
  none_of: string[]
}

export type TicketVerdict =
  | { admitted: true; ticket: AdmittedTicket }
  /** Why not, in the words of whoever wrote the filter. Recorded, never dropped. */
  | { admitted: false; reason: string }

/**
 * Case- and whitespace-insensitive, because the alternative fails silently.
 *
 * A `status: [todo]` against a workflow state called `Todo`, or a trailing space in a
 * yaml list, produces a source that polls forever, matches nothing, and reports no error
 * — the hardest shape of failure to notice, because a quiet integration and a correct one
 * look identical from outside. Strictness would buy nothing: two Linear states differing
 * only in case is not something anybody does deliberately, and if they did, both are the
 * same word to the person who wrote the config.
 */
const fold = (s: string): string => s.trim().toLowerCase()

/**
 * A blocker that is finished does not block.
 *
 * Linear keeps the relation after the blocking issue closes — it is history, and removing
 * it would erase why the ticket waited. Reading the relation alone would therefore mean a
 * ticket stays excluded forever because of something that shipped in March. `completed`
 * and `canceled` are Linear's own state types for "this is over"; `duplicate` is the
 * third, and an issue merged into another is equally not blocking anything.
 */
const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled', 'duplicate'])

/**
 * The filter, and the only thing allowed to decide.
 *
 * Pure, total, and it returns a *reason* on refusal rather than a boolean. The reason is
 * not decoration: a source that emits nothing is the failure this whole slice has to be
 * legible about, and "nothing matched" and "eleven tickets matched everything except the
 * label you spelled wrong" are different facts (principle 6). The poll records the
 * refusals it saw, so "why has this never fired" is a query rather than an afternoon.
 *
 * Order matters only for which reason is reported, and it is deliberate: status first,
 * because a status mismatch is the ordinary case and the cheapest thing to read; the label
 * rules next, because that is where a typo lives; blocked-ness last, because it is the
 * only one that is a fact about *another* ticket and the only reason that has to name
 * something outside the row it is about.
 */
export function admitsTicket(filter: TicketFilter, ticket: Ticket): TicketVerdict {
  /**
   * Team first, because it is the broadest and because the remote narrowing is no longer
   * a reliable stand-in for it (see `TicketFilter.team`).
   */
  const teams = filter.team.map(fold)
  if (!teams.includes(fold(ticket.team))) {
    return {
      admitted: false,
      reason: `team "${ticket.team}" is not one of: ${filter.team.join(', ')}`,
    }
  }

  const statuses = filter.status.map(fold)
  if (!statuses.includes(fold(ticket.status))) {
    return {
      admitted: false,
      reason: `status "${ticket.status}" is not one of: ${filter.status.join(', ')}`,
    }
  }

  const labels = new Set(ticket.labels.map(fold))

  const missing = filter.label.all_of.filter((label) => !labels.has(fold(label)))
  if (missing.length > 0) {
    return {
      admitted: false,
      reason: `missing required label${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
    }
  }

  /**
   * Empty means "not asked", not "matches nothing".
   *
   * The guard is the whole correctness of this clause: `[].some(...)` is `false`, so
   * without it a source that gates purely on status — the common case, and what every
   * existing config does — would reject every ticket it saw and report each one as
   * missing a label nobody wrote down.
   */
  if (filter.label.any_of.length > 0) {
    const matched = filter.label.any_of.some((label) => labels.has(fold(label)))
    if (!matched) {
      return {
        admitted: false,
        reason: `carries none of: ${filter.label.any_of.join(', ')}`,
      }
    }
  }

  const excluded = filter.label.none_of.filter((label) => labels.has(fold(label)))
  if (excluded.length > 0) {
    return {
      admitted: false,
      reason: `carries excluded label${excluded.length > 1 ? 's' : ''}: ${excluded.join(', ')}`,
    }
  }

  if (filter.notBlocked) {
    const blockers = ticket.blockedBy.filter((b) => !RESOLVED_STATE_TYPES.has(b.statusType))
    if (blockers.length > 0) {
      return {
        admitted: false,
        reason: `blocked by ${blockers.map((b) => b.identifier).join(', ')}`,
      }
    }
  }

  return { admitted: true, ticket: ticket as AdmittedTicket }
}

/**
 * What the poll asks Linear for, derived from the same source config the local rule reads.
 *
 * **A narrowing, never a decision.** It carries the team and nothing else, and that is the
 * whole argument of this function. Pushing `status` and `labels` into the GraphQL filter
 * is the obvious optimisation, and it moves the rule §4.13 is about onto a server this
 * repository cannot test against: `StringComparator.in` is case-sensitive where the local
 * rule folds case, and Linear's `hasBlockedByRelations` counts a relation to a ticket that
 * shipped in March where the local rule does not. Both disagreements land in the *hides a
 * ticket* direction, which is invisible forever — a source that quietly stops seeing half
 * its queue looks exactly like a quiet week.
 *
 * The cost is real and is the one that was chosen; ADR-0004 makes the same trade in the
 * same direction. A team's issues are fetched and filtered here. `maxPages` bounds it,
 * `orderBy: updatedAt` decides which end gets trimmed — Linear documents that as how you
 * "get most recently updated resources" — and the poll records when it stopped early, so
 * a source outgrowing its cap says so rather than silently missing the bottom of the list.
 *
 * Returns a filter *object* rather than a bare team so that a future narrowing has an
 * obvious home and one rule about what may go in it: only a condition implied by
 * `admitsTicket` for *every* possible ticket — a property somebody has to be able to state
 * out loud before they add a line here.
 *
 * `in` rather than `eq` since a source may name several teams, and that is exactly where
 * the case-sensitivity above stops being theoretical: one key spelled `eng` in config
 * against `ENG` on the board narrows away every ticket in that team, silently, while the
 * local rule would have folded the case and admitted them. `admitsTicket` re-checks the
 * team for that reason — the narrowing is still only a narrowing, and it is now one that
 * can be wrong in the hiding direction.
 */
export function remoteNarrowing(teams: string[]): Record<string, unknown> {
  return { team: { key: { in: teams } } }
}

/**
 * A digest of the parts of a ticket that would change what an agent is asked to do.
 *
 * Recorded at emission so that "this ticket was edited after we acted on it" is
 * answerable. Deliberately *not* `updatedAt`: Linear bumps that for a comment, a label, an
 * assignee, a drag in the backlog view — so a policy keyed on it would fire for changes
 * that do not alter the work. Title, description and status are what the prompt is built
 * from and what the scope evaluator reads; if none of them moved, the job already emitted
 * is still the job the ticket describes.
 *
 * A hash rather than the text, and that is the ADR-0004 line rather than a space saving. A
 * column holding a ticket's title and body is a mirror of Linear's content, sitting where
 * a later caller can read it and believe it is current. A hash answers the one question
 * the ledger is entitled to ask — did this change since we acted — and cannot answer any
 * other.
 */
export function ticketDigest(ticket: Ticket): string {
  return createHash('sha256')
    .update([ticket.title, ticket.status, ticket.description].join(' '))
    .digest('hex')
    .slice(0, 16)
}
