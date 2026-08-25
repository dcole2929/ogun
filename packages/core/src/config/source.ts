import { z } from 'zod'
import type { TicketFilter } from '../sources/ticket.ts'

/**
 * A **source**: the thing that turns the outside world into jobs (§4.2's `integration`
 * trigger, §4.13).
 *
 * "Sources emit jobs; they are not workers" is one sentence in §4.13 and it decides the
 * whole shape of this block. A worker is skill + runtime + sandbox and produces a *run*; a
 * source produces *jobs* and never executes anything. So a source is not a worker with a
 * polling skill, and this is not a `workers:` entry with a different `kind`. It is a
 * trigger, and it sits beside `workers:` and `cycles:` for the same reason `schedule:`
 * does: it says when a cycle starts, not what the cycle does.
 *
 * ```yaml
 * sources:
 *   tickets:
 *     kind: linear
 *     cycle: ticket-pipeline   # the cycle each admitted ticket starts
 *     team: ENG
 *     pollMinutes: 5
 *     filter:
 *       status: [Todo]
 *       labels: [ogun]
 *       excludeLabels: [needs-design]
 *       notBlocked: true
 * ```
 *
 * Everything a source needs that is *not* in this file is deliberate. The API key is not
 * here, because a config file is committed to git and a key is not (§4.9's rule about
 * where each policy is read from, applied to a credential); it comes from the per-project
 * secret store at poll time. And the *worker* that judges each ticket is not named here
 * either — `cycle` names a graph, and the graph already says which node runs first. A
 * source declaring its own entry worker would be a second answer to a question the cycle
 * definition answers, sitting in the file somebody edits less often.
 */

export const ticketFilterSchema = z.object({
  /**
   * Workflow state names, matched case-insensitively against `state.name`.
   *
   * Required, with no default, and it is the one field here that could have had one. A
   * source whose status list is absent fires on *every* ticket in the team, which is a
   * runaway wearing the clothes of a convenience — and there is no value that is right
   * for every workspace, because these are names a team invented. Absent means "you have
   * not said", and the parse stops rather than guessing.
   */
  status: z.array(z.string().min(1)).min(1),
  /**
   * Labels that must **all** be present.
   *
   * "All", not "any", and the two readings genuinely differ once there are two labels.
   * All is the conservative one: a source that fires on fewer conditions than were written
   * down is the bad direction to be wrong in, since the result is a job nobody asked for
   * against a repository Ogun can open pull requests on. Empty is allowed — a team may
   * gate purely on status — and is not the same as absent-and-defaulted, because there is
   * nothing to default to.
   */
  labels: z.array(z.string().min(1)).default([]),
  /** Labels that, if present, exclude the ticket even when everything else matches. */
  excludeLabels: z.array(z.string().min(1)).default([]),
  /**
   * Whether an unresolved `blocks` relation excludes the ticket. §4.13 names this as one
   * of the three deterministic criteria, and it defaults on: starting work that is
   * explicitly waiting on something else is the failure the field exists to prevent.
   */
  notBlocked: z.boolean().default(true),
})

export const sourceSchema = z.object({
  /**
   * Which outside system. One value today, and it is spelled out rather than assumed so
   * that a GitHub source is a new literal here — and so that a config saying `kind: jira`
   * fails at the file rather than by polling nothing.
   *
   * Not a discriminated union yet, because a union of one produces worse messages than a
   * literal does. It becomes one the day there are two, and the shape below is already
   * the shape that survives that: `team` and `filter` are Linear's, and move under the
   * linear arm.
   */
  kind: z.literal('linear'),
  /**
   * The cycle an admitted ticket starts. A worker's own name works too — every worker is
   * a one-node cycle (§5.1, ADR-0007), so a source pointed at a single scope evaluator is
   * the smallest useful configuration and needs no `cycles:` block at all.
   */
  cycle: z.string().min(1),
  /**
   * The team key, e.g. `ENG`. Required: it is the scope of the poll, and a source without
   * one reads an entire workspace every few minutes to throw almost all of it away.
   */
  team: z.string().min(1),
  /**
   * How often to look. Five minutes, because the thing being waited on is a person
   * dragging a card, and a person who has just done that will wait five minutes without
   * wondering whether it worked.
   *
   * Minutes rather than a cron expression, and that is the design rather than sugar. A
   * cron expression implies *occurrences*, which implies missed ones, which is what
   * `onMissed` exists for — and a poll has none. See `pollSources`: a poll asks what
   * matches *now*, so a machine that slept through six of them has not missed six
   * anythings, it has one question to ask when it wakes up. A source therefore has no
   * `onMissed:` key, and the absence is the point.
   */
  pollMinutes: z.number().int().positive().default(5),
  /**
   * The most tickets one poll may emit for.
   *
   * The runaway bound, and the one that matters on the day a source is first switched on
   * against a real backlog: a filter that matches two hundred tickets would otherwise
   * create two hundred cycle runs in one tick. `maxConcurrentModifiers` throttles what
   * *executes* and `maxOpenPullRequests` bounds what reaches the remote, but neither stops
   * the queue itself filling, and a queue nobody meant to create is hours of work to
   * unpick.
   *
   * Three, and it is self-correcting rather than lossy: the emission ledger means the
   * tickets not taken this poll are taken by the next one, five minutes later. What the
   * cap actually buys is that the first poll of a misconfigured source is three jobs and a
   * ledger row saying it trimmed, instead of a night.
   */
  maxPerPoll: z.number().int().positive().default(3),
  /**
   * How many pages of 50 to read before giving up on the rest of the list.
   *
   * The filter runs here rather than on Linear's servers (see `remoteNarrowing`), so a
   * poll reads the team and decides locally, and a large team has to stop somewhere. Four
   * pages is 200 issues per poll — comfortably a team's active queue, and comfortably
   * inside Linear's hourly request and complexity budgets at a five-minute cadence.
   * Stopping early is recorded on the poll, so a team that has outgrown this says so.
   */
  maxPages: z.number().int().positive().default(4),
  filter: ticketFilterSchema,
  enabled: z.boolean().default(true),
})
export type SourceConfig = z.infer<typeof sourceSchema>

/**
 * The filter as the pure rule wants it, out of the config as the file wants it.
 *
 * A function rather than a structural coincidence: `TicketFilter` belongs to
 * `admitsTicket`, which knows nothing about zod or yaml, and the day the config grows a
 * key the rule does not read (or the reverse) this is where the mismatch shows up as a
 * type error instead of as a filter quietly ignoring a line somebody wrote.
 */
export const ticketFilterOf = (source: SourceConfig): TicketFilter => ({
  status: source.filter.status,
  labels: source.filter.labels,
  excludeLabels: source.filter.excludeLabels,
  notBlocked: source.filter.notBlocked,
})
