import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import { sourceSchema, type SourceConfig } from '@ogun/core'

const { projects, sourceEmissions, sourcePolls, sources } = schema

/**
 * What a source is *doing*, read off the ledger it writes (§4.13, principle 6).
 *
 * `source_polls` landed with nothing reading it, which was correct on the day it landed —
 * a table with no source pointed at it and no route with a caller. It stopped being
 * correct the moment a project connected: a poll that fails writes a row, `main.ts` prints
 * a line, and both of those are invisible to the person who will notice at some point next
 * week that no tickets have turned into work. Evidence nobody can read is not evidence.
 *
 * ### The unit is a state, not a log
 *
 * There are ~288 poll rows a day per source and every one of them is true. A surface that
 * lists them is a log: it answers "what happened at 03:12" and cannot answer the only
 * question anybody actually has, which is *is this working, and if not what do I do*. So
 * this derives one state per source, and the history stays available underneath it for the
 * one case where you want it — you have found the broken source and now want to see when
 * it broke.
 *
 * ### The four remedies stay four
 *
 * `LinearUnavailable` splits `auth`, `ratelimited` and `transport`, `usableGrant` adds
 * `local`, and every one of those splits exists because the remedy differs. Nothing here
 * merges them: `kind` is carried from the row, and `remedy` is written per kind. The way
 * this feature fails is by rendering all four as a red "failed" pill, which tells an
 * operator that something is wrong and nothing about which of four completely different
 * things it is.
 */

/** `null` on `ok` and `refused`, and on a `failed` row the ledger could not classify. */
export type SourceFailureKind = 'auth' | 'ratelimited' | 'transport' | 'local'

/**
 * The states, in the order they are decided. Precedence is load-bearing rather than
 * cosmetic — see `stateOf` for why "nothing is looking" outranks "the last look failed".
 */
export type SourceState =
  /** `enabled: false` in config.yaml. Not a fault: somebody turned it off on purpose. */
  | 'disabled'
  /**
   * Enabled, and nothing has looked for far longer than its own cadence.
   *
   * This is the state with no row behind it, and it is the only way two real failures are
   * visible at all. The poll loop lives in the control-plane process, so a control plane
   * that is down or wedged writes nothing anywhere; and `pollSources` *skips* a source
   * whose stored config this build cannot parse — deliberately, so one bad source cannot
   * stop the others — before the claim, before any row is written, silently, forever.
   * Both look identical from the ledger: an unchanging `last_polled_at` and no new rows.
   */
  | 'overdue'
  /** Synced, and its first poll has not come round yet. Ordinary, and brief. */
  | 'never-polled'
  /** The last poll never reached Linear. Something local; its `detail` names the fix. */
  | 'refused'
  /** The last poll asked and got no answer. `kind` says which of four, and they differ. */
  | 'failing'
  /**
   * Polling fine and matching nothing, for long enough that a quiet week no longer
   * explains it. **Not a failure**, and it is important that it is not rendered as one.
   */
  | 'silent'
  | 'healthy'

export type SourceHealth = {
  state: SourceState
  kind: SourceFailureKind | null
  /** The last poll's sentence — the error, or the statuses that were on what it read. */
  detail: string | null
  /** What to do, when the state does not already carry that in `detail`. */
  remedy: string | null
  /** The claim, advanced before each poll: when this source last *looked*. */
  lastPolledAt: string | null
  /** The last poll that came back `ok`. A failure has lasted since this instant. */
  lastOkAt: string | null
  /** The last poll whose filter admitted anything. Silence is measured from here. */
  lastAdmittedAt: string | null
  /** The last ticket that became a cycle run. Null for a source that never emitted. */
  lastEmittedAt: string | null
  /** The oldest poll on record, so "never matched" can be given a since. */
  firstPollAt: string | null
  /**
   * Rows in the ledger for this source. Zero and "never polled" are the same fact.
   *
   * Named for what it counts rather than `polls`, because the route hangs the *history*
   * off the report under that name and two fields called `polls` — one a number, one an
   * array — is a shape somebody reads wrong once and never notices.
   */
  pollsRecorded: number
}

export type SourceReport = {
  /** The row's id, so a caller can ask for this source's history without a second lookup. */
  id: string
  project: string
  name: string
  kind: string
  cycle: string
  enabled: boolean
  pollMinutes: number
  team: string
  /**
   * The deterministic filter as configured.
   *
   * On the wire beside the health because of one pairing: a poll that admitted nothing
   * records *the statuses that were actually on the tickets it read*, and that sentence is
   * only useful next to the statuses the filter is asking for. `status: [To Do]` against a
   * column called `Todo` is a source that polls forever, matches nothing and reports
   * success, and the two halves of that diagnosis were in two different places.
   */
  filter: SourceConfig['filter'] | null
  health: SourceHealth
}

/**
 * How far past its own cadence a source has to be before "nothing is looking".
 *
 * Expressed in the source's own `pollMinutes` rather than as a constant, because a
 * five-minute source and an hourly one are late by completely different amounts. Two
 * cadences plus a two-minute floor: `main.ts` ticks once a minute, so a due source is
 * looked at within `pollMinutes + 1`, and one whole missed cadence on top of that is a
 * margin wide enough that an ordinary slow poll never trips it. The floor matters for a
 * `pollMinutes: 1` source, where twice the cadence is inside the tick granularity.
 */
const overdueAfterMs = (pollMinutes: number): number =>
  Math.max(pollMinutes * 2 * 60_000, 2 * 60_000)

/**
 * How long a source may match nothing before that is worth remarking on.
 *
 * A source that matches nothing is not a source that is broken — that is the whole
 * argument for `ok` covering "looked and found nothing", and a surface that flagged every
 * empty poll would flag every source on every quiet afternoon. But a filter that has
 * matched nothing for a *week* is far more likely to be a typo than a quiet week, and the
 * poll that would prove it already recorded the statuses it saw.
 *
 * Seven days rather than something tuned, and the number is only a threshold on a note: it
 * changes what is *said*, never what runs, and `silent` is deliberately kept out of the
 * status rail. Getting it wrong in one direction produces a remark a week early; in the
 * other, a remark a week late. Neither is worth a knob in config.yaml that nobody sets.
 */
const SILENT_AFTER_MS = 7 * 24 * 60 * 60_000

/**
 * What an aggregate over a `timestamptz` actually arrives as.
 *
 * A column read through drizzle comes back as a `Date`; the same value read through a
 * `sql` fragment — `max(started_at) filter (where …)` — comes back as the driver's raw
 * string, because there is no column definition behind the expression. That difference is
 * invisible at the type level — the generic on `sql<T>` is an assertion, not a check — so
 * declaring `Date` there compiles happily and throws `toISOString is not a function` at
 * run time. Named and converted in one place rather than trusted three times.
 */
type Instant = string | Date | null

const asDate = (value: Instant | undefined): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(value)

/**
 * Every source, with the state its ledger puts it in.
 *
 * Three queries and no `N+1`, whatever the fleet holds: the sources, the latest poll per
 * source, and the aggregates. `distinct on` rather than a correlated subquery because it
 * is one index scan over `source_polls_source_started_idx`, which is the index that exists.
 */
export async function sourceHealth(
  db: Db,
  opts: { projectId?: string; now?: Date } = {},
): Promise<SourceReport[]> {
  const now = opts.now ?? new Date()

  const rows = await db
    .select({ source: sources, project: { slug: projects.slug } })
    .from(sources)
    .innerJoin(projects, eq(projects.id, sources.projectId))
    .where(opts.projectId ? eq(sources.projectId, opts.projectId) : undefined)
    .orderBy(projects.slug, sources.name)
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.source.id)

  /**
   * The most recent poll per source. `order by` has to lead with the same expression
   * `distinct on` takes — that is postgres's rule, not a preference — and the second key
   * is what actually picks the row.
   */
  const latest = await db
    .selectDistinctOn([sourcePolls.sourceId], {
      sourceId: sourcePolls.sourceId,
      startedAt: sourcePolls.startedAt,
      outcome: sourcePolls.outcome,
      kind: sourcePolls.kind,
      detail: sourcePolls.detail,
    })
    .from(sourcePolls)
    .where(inArray(sourcePolls.sourceId, ids))
    .orderBy(sourcePolls.sourceId, desc(sourcePolls.startedAt))
  const lastPoll = new Map(latest.map((p) => [p.sourceId, p]))

  /**
   * The instants a state is measured from. `filter (where …)` rather than three queries,
   * and rather than reading the history into memory: the whole point of deriving a state
   * is that it costs one aggregate however many hundred rows a day the source writes.
   */
  const totals = await db
    .select({
      sourceId: sourcePolls.sourceId,
      polls: sql<number>`count(*)::int`,
      firstPollAt: sql<Instant>`min(${sourcePolls.startedAt})`,
      lastOkAt: sql<Instant>`max(${sourcePolls.startedAt}) filter (where ${sourcePolls.outcome} = 'ok')`,
      lastAdmittedAt: sql<Instant>`max(${sourcePolls.startedAt}) filter (where ${sourcePolls.admitted} > 0)`,
    })
    .from(sourcePolls)
    .where(inArray(sourcePolls.sourceId, ids))
    .groupBy(sourcePolls.sourceId)
  const totalFor = new Map(
    totals.map((t) => [
      t.sourceId,
      {
        polls: t.polls,
        firstPollAt: asDate(t.firstPollAt),
        lastOkAt: asDate(t.lastOkAt),
        lastAdmittedAt: asDate(t.lastAdmittedAt),
      },
    ]),
  )

  /**
   * When each source last turned a ticket into work — read from `source_emissions` rather
   * than from `source_polls.emitted`, because they answer different questions and the
   * ledger's is the narrower one. A poll row says "this look emitted three"; the emission
   * row says which ticket, into which cycle run, and survives the source being renamed.
   */
  const emitted = await db
    .select({
      sourceId: sourceEmissions.sourceId,
      at: sql<Instant>`max(${sourceEmissions.createdAt}) filter (where ${sourceEmissions.outcome} = 'emitted')`,
    })
    .from(sourceEmissions)
    .where(inArray(sourceEmissions.sourceId, ids))
    .groupBy(sourceEmissions.sourceId)
  const emittedFor = new Map(emitted.map((e) => [e.sourceId, asDate(e.at)]))

  return rows.map(({ source, project }) => {
    /**
     * Parsed rather than trusted, and a config this build cannot read does not throw.
     *
     * It is the same jsonb `pollSources` re-parses on every tick, and it is also the
     * *cause* of one of the states below: a stored config that will not parse is skipped
     * by the poller without a row, which is exactly what `overdue` catches. A listing that
     * threw on it would fail to report the one source it most needs to report.
     */
    const parsed = sourceSchema.safeParse(source.config)
    const pollMinutes = parsed.success ? parsed.data.pollMinutes : 5

    return {
      id: source.id,
      project: project.slug,
      name: source.name,
      kind: source.kind,
      cycle: source.cycleName,
      enabled: source.enabled,
      pollMinutes,
      team: parsed.success ? parsed.data.team : '',
      filter: parsed.success ? parsed.data.filter : null,
      health: healthOf({
        slug: project.slug,
        name: source.name,
        enabled: source.enabled,
        pollMinutes,
        unparseable: !parsed.success,
        lastPolledAt: source.lastPolledAt,
        createdAt: source.createdAt,
        latest: lastPoll.get(source.id),
        totals: totalFor.get(source.id),
        lastEmittedAt: emittedFor.get(source.id) ?? null,
        now,
      }),
    }
  })
}

type HealthInput = {
  slug: string
  name: string
  enabled: boolean
  pollMinutes: number
  unparseable: boolean
  lastPolledAt: Date | null
  createdAt: Date
  latest:
    | { startedAt: Date; outcome: string; kind: string | null; detail: string | null }
    | undefined
  totals:
    | { polls: number; firstPollAt: Date | null; lastOkAt: Date | null; lastAdmittedAt: Date | null }
    | undefined
  lastEmittedAt: Date | null
  now: Date
}

/**
 * One source's state, and the order the questions are asked in.
 *
 * The order is the design. **"Nothing is looking" outranks "the last look failed"**,
 * because a stale failure is a description of a machine that has stopped rather than of a
 * machine that is failing — and an operator shown `failing: auth` for a source nothing has
 * polled since Tuesday goes and rotates a credential that was never the problem. It is the
 * same reason `reach.ts` separates `offline` from `unmatched`: the sentence you show
 * decides where somebody spends their evening.
 *
 * `silent` comes *after* both, and last among the things worth saying, because it is the
 * only one that is not a fault. A source that is failing is not also silent in any useful
 * sense — of course it has matched nothing; it has not been able to look.
 */
export function healthOf(input: HealthInput): SourceHealth {
  const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
  const totals = input.totals
  const base = {
    kind: null,
    detail: input.latest?.detail ?? null,
    remedy: null,
    lastPolledAt: iso(input.lastPolledAt),
    lastOkAt: iso(totals?.lastOkAt),
    lastAdmittedAt: iso(totals?.lastAdmittedAt),
    lastEmittedAt: iso(input.lastEmittedAt),
    firstPollAt: iso(totals?.firstPollAt),
    pollsRecorded: totals?.polls ?? 0,
  } satisfies Omit<SourceHealth, 'state'> & { kind: null }

  if (!input.enabled) return { ...base, state: 'disabled' }

  /**
   * Measured from the claim, or — for a source that has never been claimed — from when it
   * was indexed. `last_polled_at` is advanced *before* the poll runs, so a source that is
   * failing, refusing, or crashing still advances it: reaching this branch means nothing
   * ran at all, which is a different fault with a different owner.
   */
  const since = input.lastPolledAt ?? input.createdAt
  if (input.now.getTime() - since.getTime() > overdueAfterMs(input.pollMinutes)) {
    return {
      ...base,
      state: 'overdue',
      detail:
        `its cadence is every ${input.pollMinutes}m and nothing has looked since ` +
        `${since.toISOString()}` +
        (input.unparseable
          ? ' — and its stored config is not a shape this build can read, which is what ' +
            'the poller skips without writing a row'
          : ''),
      remedy: input.unparseable
        ? 'Re-publish it: `ogun project sync` reports a source config this build refuses. ' +
          'A skipped source writes nothing to the ledger, so this state is the only ' +
          'evidence it leaves.'
        : 'No poll has been recorded and no row says why, so the failure is upstream of ' +
          'this source: the control plane is not running, or its poll loop is wedged. ' +
          'Check the server process first, not the credential.',
    }
  }

  if (!input.latest) {
    return {
      ...base,
      state: 'never-polled',
      detail: 'indexed, and its first poll has not come round yet',
    }
  }

  if (input.latest.outcome === 'refused') {
    return {
      ...base,
      state: 'refused',
      /**
       * No remedy of our own, deliberately. Every refusal `pollSource` writes carries its
       * own fix in `detail` — the exact `ogun connect` line with this project's slug in
       * it, or the name of the cycle that does not exist. A generic sentence beside a
       * specific one is a second, vaguer answer to a question that already has a good one,
       * and the reader has to work out which to believe.
       */
      remedy: null,
    }
  }

  if (input.latest.outcome === 'failed') {
    const kind = failureKind(input.latest.kind)
    return {
      ...base,
      state: 'failing',
      kind,
      remedy: remedyFor(kind, input.slug),
    }
  }

  /**
   * Nothing has matched for long enough that a quiet week no longer covers it.
   *
   * Measured from the last poll that admitted something, and from the *first recorded
   * poll* when nothing ever has — otherwise a source whose filter has never once matched,
   * which is the likeliest configuration mistake there is, would be the one source that
   * could never reach this state. A source younger than the window says nothing at all:
   * "this has matched nothing in the eleven minutes since you created it" is noise.
   */
  const quietSince = totals?.lastAdmittedAt ?? totals?.firstPollAt ?? null
  if (quietSince && input.now.getTime() - quietSince.getTime() > SILENT_AFTER_MS) {
    const days = Math.floor((input.now.getTime() - quietSince.getTime()) / (24 * 60 * 60_000))
    return {
      ...base,
      state: 'silent',
      detail: input.latest.detail,
      remedy:
        `Polling normally — this is not a failure. ${
          totals?.lastAdmittedAt
            ? `Its filter has admitted nothing for ${days} days`
            : `Its filter has never admitted anything, over ${days} days of polling`
        }. A poll that admits nothing records the statuses that were on the tickets it ` +
        'read; compare them with the filter beside this row before assuming a quiet week.',
    }
  }

  return { ...base, state: 'healthy' }
}

/**
 * The stored string, narrowed back to the closed set — and `null` for anything else.
 *
 * A `failed` row written before this column existed, or by the unforeseen-error catch in
 * `pollSources`, genuinely has no kind. Mapping that to `transport` would be inventing a
 * remedy ("the next poll retries") for a failure nobody has classified, which is worse
 * than admitting the ledger does not know.
 */
const failureKind = (stored: string | null): SourceFailureKind | null =>
  stored === 'auth' || stored === 'ratelimited' || stored === 'transport' || stored === 'local'
    ? stored
    : null

/**
 * What to do about each kind, and the reason the kinds were kept apart in the first place.
 *
 * Written out per kind rather than templated, for the reason `missingKey` is written out
 * per state one file over: the moment two of them share a sentence, the distinction the
 * `kind` column was added to preserve is gone again at the last possible step.
 */
function remedyFor(kind: SourceFailureKind | null, slug: string): string {
  switch (kind) {
    case 'auth':
      return (
        'The credential, not the network. Nothing retries this into working — an expired ' +
        'or revoked token fails identically every five minutes until somebody acts. ' +
        `Reconnect with \`ogun connect linear --project ${slug}\`, and check \`ogun ` +
        'connect list\` for a personal key sitting behind a grant that is being used ' +
        'instead of it.'
      )
    case 'ratelimited':
      return (
        'Linear is throttling this poll, and it clears on its own — there is nothing to ' +
        'fix. If it does not clear, the cadence is the knob: raise `pollMinutes` for this ' +
        'source rather than reconnecting anything.'
      )
    case 'transport':
      return (
        'The network, or Linear itself. The next poll asks again and usually gets an ' +
        'answer, so one of these is not an incident. A run of them is worth reading: this ' +
        'is also where a Linear API change surfaces first, as a response this build cannot ' +
        'parse.'
      )
    case 'local':
      return (
        'Linear answered and this machine could not write the result down, so waiting ' +
        'will not help — the store is what needs fixing. `ogun runner doctor` checks the ' +
        'permissions and readability of ~/.ogun/config.json.'
      )
    default:
      return (
        'The ledger recorded a failure it could not classify, which means it was not one ' +
        'the Linear client raised — look at the control-plane log for this poll. A row ' +
        'with no kind is either an unforeseen error or a poll recorded before failures ' +
        'were classified.'
      )
  }
}

/**
 * The sources worth interrupting somebody about, across every project.
 *
 * The status rail's rule, and it is a filter rather than a second derivation: the states
 * are already decided above, and this only says which of them are worth putting in the
 * chrome of a page about something else. Chrome that is always lit stops being read, so
 * the bar is higher here than on the Sources listing — the listing is where you go to look
 * at sources; this is what taps you on the shoulder while you are reading the inbox.
 *
 * **The bar is the remedy, which is the whole reason the kinds are kept apart.**
 *
 *  - `auth` and `local` are shown from the very first failure. Neither ever heals: a
 *    revoked token fails identically every five minutes forever, and an unwritable
 *    config.json is unwritable at 4am too. Waiting is not a strategy for either.
 *  - `transport` and `ratelimited` are shown only once the source has had no successful
 *    poll for several of its own cadences. Both are *expected* to clear by themselves, and
 *    a rail that lit up for one throttled poll would be lit most of the time and read none
 *    of it. Expressed in the source's own `pollMinutes` rather than as a wall-clock
 *    constant, because "it has not worked for three tries" means the same thing to a
 *    five-minute source and an hourly one.
 *  - `refused` and `overdue` are always shown. A refusal is a fact about this machine's
 *    configuration that will still be true in five minutes, and `overdue` means nothing is
 *    looking at all — which is the failure with no row behind it and therefore the one
 *    nothing else can surface.
 *
 * `silent` and `disabled` are deliberately never shown. A source somebody turned off is
 * not a fault, and a filter that has matched nothing for a week is a remark rather than an
 * outage — putting it in the rail would make it permanent (nothing about it changes on its
 * own) and unactionable-at-a-glance, which is exactly how a warning teaches people to
 * scroll past every warning beside it.
 */
export async function troubledSources(
  db: Db,
  opts: { now?: Date } = {},
): Promise<Array<{ project: string; source: string; state: SourceState; kind: SourceFailureKind | null; detail: string | null }>> {
  const now = opts.now ?? new Date()
  const selfHealing = (kind: SourceFailureKind | null): boolean =>
    kind === 'transport' || kind === 'ratelimited'

  return (await sourceHealth(db, { now }))
    .filter((s) => {
      const { state, kind, lastOkAt } = s.health
      if (state === 'overdue' || state === 'refused') return true
      if (state !== 'failing') return false
      if (!selfHealing(kind)) return true
      /**
       * "Several of its own cadences", and `lastOkAt` is the right clock for it: the
       * failure has lasted since the last poll that worked, and a source that has *never*
       * had one has been failing since it was created. Counting consecutive failed rows
       * would be the same number by a longer route, and would need the poll history in
       * memory to get it.
       */
      const since = lastOkAt ? new Date(lastOkAt) : new Date(s.health.firstPollAt ?? now)
      return now.getTime() - since.getTime() > s.pollMinutes * 3 * 60_000
    })
    .map((s) => ({
      project: s.project,
      source: s.name,
      state: s.health.state,
      kind: s.health.kind,
      detail: s.health.detail,
    }))
}

/**
 * The recent history for one source, for the reader who has already found the broken one.
 *
 * Bounded and deliberately not paged. The state above is the report; this is the follow-up
 * question — *when did it start* — and twenty rows answers that at any cadence from five
 * minutes to an hour. A surface that could page through every poll ever would be the log
 * this whole module exists to avoid becoming.
 */
export async function recentPolls(db: Db, sourceId: string, limit = 20) {
  return db
    .select({
      startedAt: sourcePolls.startedAt,
      endedAt: sourcePolls.endedAt,
      outcome: sourcePolls.outcome,
      kind: sourcePolls.kind,
      seen: sourcePolls.seen,
      admitted: sourcePolls.admitted,
      emitted: sourcePolls.emitted,
      trimmed: sourcePolls.trimmed,
      truncated: sourcePolls.truncated,
      detail: sourcePolls.detail,
    })
    .from(sourcePolls)
    .where(eq(sourcePolls.sourceId, sourceId))
    .orderBy(desc(sourcePolls.startedAt))
    .limit(limit)
}

/**
 * Which tickets have already produced work — the answer to the question a source generates
 * more often than any other.
 *
 * *"ENG-123 is sitting in Todo with the label on it and nothing happened"* has exactly
 * three answers, and only one of them is a fault. The poll may be failing, which the state
 * above says. The filter may not admit it, which the last poll's `detail` says. Or it was
 * **already emitted on Tuesday**, Ogun writes nothing back to Linear (ADR-0004) so the card
 * looks untouched, and the system is working exactly as designed. That third answer lives
 * only in `source_emissions` and had no reader at all.
 *
 * Scoped to the project rather than to a source, because identity here is
 * `(project, external id)` on purpose: two sources whose filters overlap emit once between
 * them, and an answer scoped to one source would say "not emitted" about a ticket the
 * project has definitely already worked on.
 *
 * `ticket` matches the human-facing key (`ENG-123`) case-insensitively, since that is what
 * gets pasted out of Linear and out of Slack, and it is not the identity — the identity is
 * a uuid nobody types.
 */
export async function recentEmissions(
  db: Db,
  projectId: string,
  opts: { ticket?: string; limit?: number } = {},
) {
  const ticket = opts.ticket?.trim()
  return db
    .select({
      externalKey: sourceEmissions.externalKey,
      externalId: sourceEmissions.externalId,
      sourceName: sourceEmissions.sourceName,
      outcome: sourceEmissions.outcome,
      detail: sourceEmissions.detail,
      cycleRunId: sourceEmissions.cycleRunId,
      createdAt: sourceEmissions.createdAt,
    })
    .from(sourceEmissions)
    .where(
      ticket
        ? and(
            eq(sourceEmissions.projectId, projectId),
            sql`lower(${sourceEmissions.externalKey}) = lower(${ticket})`,
          )
        : eq(sourceEmissions.projectId, projectId),
    )
    .orderBy(desc(sourceEmissions.createdAt))
    .limit(opts.limit ?? 20)
}
