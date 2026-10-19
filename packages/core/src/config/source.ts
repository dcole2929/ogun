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

/**
 * `conditions:` — which tickets this source acts on.
 *
 * The rule for the spelling: **a bare list where only one reading exists, named
 * operators where two do.** `team` and `status` are single-valued on a ticket, so a list
 * of them can only mean "any of these" and `any_of:` would be ceremony. A ticket carries
 * many labels, so `[admin, agent-ready]` is genuinely ambiguous between all and any —
 * and that ambiguity is not hypothetical, it is what the previous `labels:` key resolved
 * silently in favour of *all* while its own comment conceded the two "genuinely differ".
 *
 * ```yaml
 * conditions:
 *   team: [EXC, HEI]
 *   status: [Todo]
 *   label:
 *     all_of: [ogun]
 *     any_of: [admin, agent-ready]
 *     none_of: [needs-design]
 *   notBlocked: true
 * ```
 */
export const labelConditionSchema = z.object({
  /** Every one must be present. */
  all_of: z.array(z.string().min(1)).default([]),
  /** At least one must be present. Empty means not asked, never matches-nothing. */
  any_of: z.array(z.string().min(1)).default([]),
  /** None may be present. */
  none_of: z.array(z.string().min(1)).default([]),
})

export const conditionsSchema = z.object({
  /**
   * Team keys. Required, because it is the scope of the poll and a source without one
   * reads an entire workspace every few minutes to throw almost all of it away.
   *
   * A list now, and that moved it from being *only* a narrowing to being a condition the
   * local rule re-checks — see `TicketFilter.team` for why a list makes that necessary
   * where a single exact key did not.
   */
  team: z.array(z.string().min(1)).min(1),
  /**
   * Workflow state names, matched case-insensitively against `state.name`.
   *
   * Required, with no default, and it is the one field here that could have had one. A
   * source whose status list is absent fires on *every* ticket in the team, which is a
   * runaway wearing the clothes of a convenience — and there is no value that is right
   * for every workspace, because these are names a team invented.
   */
  status: z.array(z.string().min(1)).min(1),
  /**
   * `prefault`, not `default`. Zod hands back a `.default()` literal without running it
   * through the object schema, so `.default({})` on a block whose every field has its own
   * default yields exactly `{}` — and `label.all_of` would then be `undefined` for the
   * overwhelmingly common config that gates on status alone, which `admitsTicket` would
   * take straight into `undefined.filter`.
   */
  label: labelConditionSchema.prefault({}),
  /**
   * Whether an unresolved `blocks` relation excludes the ticket. §4.13 names this as one
   * of the deterministic criteria, and it defaults on: starting work that is explicitly
   * waiting on something else is the failure the field exists to prevent.
   */
  notBlocked: z.boolean().default(true),
})

/**
 * The shape this file used to take: a top-level `team:` string beside a `filter:` block
 * with `labels` (all) and `excludeLabels`.
 *
 * Translated rather than refused, and the reason is specific to where these live. A
 * source's definition is also stored as jsonb on the `sources` row, and `pollSources`
 * **skips a row it cannot parse** — deliberately, so one source written by a newer CLI
 * does not stop every other source on the machine. So refusing the old shape would not
 * produce an error anybody sees; it would produce a poller that silently stopped,
 * which is the exact failure this whole slice is built to be legible about.
 *
 * `usesLegacyShape` is exported beside it so `ogun project sync` can say the thing out
 * loud at the one moment a person is looking.
 */
export const usesLegacyShape = (raw: unknown): boolean =>
  typeof raw === 'object' &&
  raw !== null &&
  !('conditions' in raw) &&
  ('filter' in raw || 'team' in raw)

const liftLegacy = (raw: unknown): unknown => {
  if (!usesLegacyShape(raw)) return raw
  const source = raw as Record<string, unknown>
  const filter = (source.filter ?? {}) as Record<string, unknown>
  const { team, filter: _dropped, ...rest } = source
  return {
    ...rest,
    conditions: {
      ...(team === undefined ? {} : { team: Array.isArray(team) ? team : [team] }),
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.notBlocked === undefined ? {} : { notBlocked: filter.notBlocked }),
      label: {
        ...(filter.labels === undefined ? {} : { all_of: filter.labels }),
        ...(filter.excludeLabels === undefined ? {} : { none_of: filter.excludeLabels }),
      },
    },
  }
}

const sourceShape = z.object({
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
  conditions: conditionsSchema,
  enabled: z.boolean().default(true),
})

/**
 * Parsed through the legacy lift, so a `filter:` block written before the rename still
 * produces a source rather than a silently skipped row.
 */
export const sourceSchema = z.preprocess(liftLegacy, sourceShape)
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
  team: source.conditions.team,
  status: source.conditions.status,
  label: source.conditions.label,
  notBlocked: source.conditions.notBlocked,
})
