import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import type { Db } from '@ogun/core/db'
import {
  admitsTicket,
  cycleDefinitionSchema,
  readProjectSecret,
  remoteNarrowing,
  sourceSchema,
  ticketBrief,
  ticketDigest,
  ticketFilterOf,
  type AdmittedTicket,
  type ProjectSecret,
  type SecretName,
  type SourceConfig,
  type Ticket,
} from '@ogun/core'
import {
  linearHttp,
  LinearUnavailable,
  type LinearApi,
  type LinearCredential,
} from '../integrations/linear.ts'
import { usableGrant } from './linear-grant.ts'
import { fleetCredentials } from './admission.ts'
import { startCycleRun } from './cycles.ts'

const { cycles, projects, sourceEmissions, sourcePolls, sources } = schema

/**
 * The integration trigger (§4.2's `integration`, §4.13, ADR-0013).
 *
 * A **source** turns the outside world into jobs. It is not a worker: it runs in the
 * control-plane process, on the host, holding the credential; it never provisions a
 * sandbox and it never runs an agent. What it produces is a `cycle_runs` row and its jobs,
 * created through `startCycleRun` — the same function cron and the manual trigger call —
 * so admission, the breaker, the modifier cap, the credential preflight and the coverage
 * ledger all apply to a ticket exactly as they apply to a nightly review. There is no
 * second path into the queue, which is the whole reason a source is shaped this way.
 *
 * ### Why a poll needs no missed-run policy
 *
 * A schedule has *occurrences*, so a machine that slept through six of them has six facts
 * to decide about and needs `onMissed` to decide them (§4.2). A poll has none. It asks
 * "what matches right now", and the answer after a two-day hibernation is the same shape
 * as the answer after five minutes: a list of tickets, most of which have already been
 * emitted for. So six missed polls collapse into one, structurally, and a source has no
 * `onMissed:` key to get wrong.
 *
 * That property is bought by asking the *level* question rather than the *edge* one, and
 * it is easy to lose. The tempting implementation keeps a cursor and asks Linear for
 * "issues updated since `lastPolledAt`", which is smaller, faster, and wrong in both
 * directions at once: a machine down for a day comes back and re-emits everything the
 * cursor spans, and a ticket that reached the trigger status *without* being updated —
 * dragged into a column by someone else's automation, unblocked by another issue closing —
 * is never seen at all. The cursor here is only ever a rate limiter.
 *
 * ### Why the emission ledger is the only thing that stops a runaway
 *
 * Ogun writes nothing back to Linear (ADR-0004), so nothing about the ticket ever changes
 * to record that it has been dealt with. The card sits in `Todo` with its label until a
 * person moves it, and every poll for however many hours that takes sees it again. The
 * `source_emissions` unique index is therefore not an optimisation or a safety net — it is
 * the only thing standing between one card and 288 cycle runs a day.
 */

export type SourceDeps = {
  /**
   * Where a project's Linear credential comes from — `readProjectSecret` (ADR-0012,
   * ADR-0014), taken as a parameter so a test can answer it without a
   * `~/.ogun/config.json`.
   *
   * Consumed rather than reimplemented, and consumed *whole*: every state it returns is
   * carried through to its own refusal sentence rather than collapsed into "no key".
   * Collapsing them is the failure principle 6 names — `absent` tells an operator to set a
   * key, `empty` tells them something wrote a blank over the one they set, `unreadable`
   * says the store itself is broken and their key is probably fine, and `unconnected` says
   * an OAuth application is registered and the authorization was never finished. A poller
   * that reports all of them as the first sends somebody to create a second key for a
   * project that already has one.
   *
   * **Which credential wins is decided there, not here.** That is the point of it being
   * one function: this file cannot hold a second opinion about precedence, and neither can
   * `doctor`, and neither can the Settings page.
   */
  secrets?: (projectSlug: string, name: SecretName) => Promise<ProjectSecret>
  /**
   * How a client is built from a credential.
   *
   * The seam `publish.ts` puts around `gh`, for the same reason: every rule this file
   * enforces has to be testable on a machine with no Linear credential and no network,
   * and there is no machine in this project that has one.
   *
   * It takes a `LinearCredential` rather than a string because the two shapes disagree
   * about the `Authorization` header — raw for a personal key, `Bearer` for an OAuth
   * access token — and a `string` parameter is a parameter that cannot say which.
   */
  linear?: (credential: LinearCredential) => LinearApi
  /**
   * How an OAuth grant becomes a usable token, refreshing it first if the poll would
   * outlive it (ADR-0014). Injected so that the *precedence* rules in this file can be
   * tested without a token endpoint, which is the half that has no fixture.
   */
  grant?: typeof usableGrant
  now?: () => Date
}

/** What one poll did. Returned rather than logged, so a caller can report and a test can assert. */
export type PollResult = {
  source: string
  outcome: 'ok' | 'refused' | 'failed'
  /**
   * Which kind of failure, for a `failed` poll only, and it is carried rather than
   * recovered downstream.
   *
   * `LinearUnavailable` has drawn this distinction since it was written because the
   * remedies differ, and until now the distinction died here: it went into `detail` as a
   * `"auth: …"` prefix and every reader had to match that prefix back out of a sentence
   * written for a human. That is a rule with two implementations, one of them a regular
   * expression over prose, and when the prose is reworded the three remedies silently
   * become one "poll failed" — the collapse `source_polls` exists to prevent.
   *
   * `local` is the fourth and belongs to `failed` rather than `refused`: a renewal that
   * Linear granted and this machine could not store did reach the network, so it is not a
   * refusal, and it is not fixed by waiting, so it is not `transport`.
   *
   * Absent on `ok` and `refused` — a refusal never reached Linear, so it has no kind of
   * unavailability — and absent on the one `failed` that cannot be classified, the
   * unforeseen-error catch in `pollSources`. "Failed, and we do not know which" is an
   * honest answer; a default would forge one.
   */
  kind?: 'auth' | 'ratelimited' | 'transport' | 'local'
  seen: number
  admitted: number
  emitted: string[]
  trimmed: number
  truncated: boolean
  detail?: string
}

const PAGE_SIZE = 50

/**
 * Poll every source whose cadence has come round, and emit for what its filter admits.
 *
 * Driven by an interval in `main.ts` at a coarser grain than any source's `pollMinutes`,
 * so this runs often and usually finds nothing due. That is the same arrangement the cron
 * scheduler uses and it has the same virtue: a tick that is late, early or missed
 * altogether changes when work starts and nothing else.
 */
export async function pollSources(db: Db, deps: SourceDeps = {}): Promise<PollResult[]> {
  const now = deps.now?.() ?? new Date()
  const results: PollResult[] = []

  const rows = await db.select().from(sources).where(eq(sources.enabled, true))

  for (const row of rows) {
    let config: SourceConfig
    try {
      config = sourceSchema.parse(row.config)
    } catch (err) {
      /**
       * A stored config this build cannot parse. Skipped rather than thrown, so one
       * source written by a newer CLI does not stop every other source on the machine —
       * the same rule `findDue` applies to an unparseable cron expression. It is silent
       * here because a poll row would need a cadence to bound it and the cadence is in the
       * config that would not parse; `ogun project sync` is where this gets said out loud.
       */
      void err
      continue
    }

    const dueAt = new Date(now.getTime() - config.pollMinutes * 60_000)

    /**
     * The claim, and it comes *before* the poll rather than after.
     *
     * `lastPolledAt` is both the cursor the decision is read from and the record that it
     * was acted on, so advancing it conditionally on it still being what this loop read
     * makes deciding and claiming one statement — exactly one racer gets a row back. The
     * interval in `main.ts` does not wait for its callback and a poll takes as long as
     * Linear takes, so two overlapping ticks reading the same `lastPolledAt` is ordinary
     * rather than exotic. Without this they would both poll, both admit the same ticket,
     * and be stopped only by the unique index downstream — which works, but records one of
     * them as a mysterious no-op.
     *
     * Advanced to `now` rather than to `now + interval`, because a poll is a rate limit
     * and not a schedule: there is no occurrence to keep in phase, and drifting a few
     * seconds later each time is the correct behaviour for "at most every five minutes".
     */
    const [claimed] = await db
      .update(sources)
      .set({ lastPolledAt: now })
      .where(
        and(
          eq(sources.id, row.id),
          or(isNull(sources.lastPolledAt), lt(sources.lastPolledAt, dueAt)),
          // Part of the claim rather than a separate read: two ticks that both saw a null
          // cursor must not both proceed.
          row.lastPolledAt === null
            ? isNull(sources.lastPolledAt)
            : eq(sources.lastPolledAt, row.lastPolledAt),
        ),
      )
      .returning()
    if (!claimed) continue

    /**
     * One source's failure is not the fleet's. `pollSource` records everything it can
     * foresee, so reaching this catch means something unforeseen — and letting it escape
     * would stop every *later* source in this tick from being polled at all, which turns
     * one broken integration into a machine that has quietly stopped hearing about
     * tickets. The claim above already advanced, so the loop cannot spin on it either.
     */
    try {
      results.push(await pollSource(db, row, config, deps))
    } catch (err) {
      const failure: PollResult = {
        source: row.name,
        outcome: 'failed',
        seen: 0,
        admitted: 0,
        emitted: [],
        trimmed: 0,
        truncated: false,
        detail: err instanceof Error ? err.message : String(err),
      }
      /**
       * Recorded here as well as returned, and it was not before.
       *
       * The claim above has already advanced `lastPolledAt`, so a poll that died in this
       * catch consumed its turn and left **no row at all** — the one shape the ledger
       * cannot represent, and the one it was built to prevent. A source throwing on every
       * poll looked, from every surface, exactly like a source nobody had ever configured:
       * a `last_polled_at` ticking forward beside an empty history. The result was returned
       * to `main.ts`, which printed it to a terminal nobody is watching at 3am.
       *
       * Best-effort, and a failure to write it is swallowed: reaching here already means
       * something unforeseen, and an insert that throws inside the handler for an
       * unforeseen error would escape the loop and stop every *later* source in this tick
       * — trading one broken source for a machine that has quietly stopped hearing about
       * tickets, which is the trade this catch exists to refuse.
       *
       * No `kind`. Everything `pollSource` can classify it classifies itself; an
       * unforeseen throw is by definition unclassified, and guessing `transport` for it
       * would put a fabricated remedy in front of an operator.
       */
      await db
        .insert(sourcePolls)
        .values({
          projectId: row.projectId,
          sourceId: row.id,
          sourceName: row.name,
          startedAt: now,
          endedAt: deps.now?.() ?? new Date(),
          outcome: 'failed',
          detail: failure.detail ?? null,
        })
        .catch(() => {})
      results.push(failure)
    }
  }

  return results
}

/**
 * One source, one look. Exported because it is what a "poll now" button and a test both
 * want, and neither should have to wait out a cadence to get it.
 */
export async function pollSource(
  db: Db,
  row: typeof sources.$inferSelect,
  config: SourceConfig,
  deps: SourceDeps = {},
): Promise<PollResult> {
  const startedAt = deps.now?.() ?? new Date()
  const record = async (result: PollResult): Promise<PollResult> => {
    await db.insert(sourcePolls).values({
      projectId: row.projectId,
      sourceId: row.id,
      sourceName: row.name,
      startedAt,
      endedAt: deps.now?.() ?? new Date(),
      outcome: result.outcome,
      ...(result.kind !== undefined ? { kind: result.kind } : {}),
      seen: result.seen,
      admitted: result.admitted,
      emitted: result.emitted.length,
      trimmed: result.trimmed,
      truncated: result.truncated,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    })
    return result
  }
  const refuse = (detail: string): Promise<PollResult> =>
    record({
      source: row.name,
      outcome: 'refused',
      seen: 0,
      admitted: 0,
      emitted: [],
      trimmed: 0,
      truncated: false,
      detail,
    })

  /**
   * The cycle first, before the credential and before the network.
   *
   * A source pointed at a cycle that does not exist can never emit anything, and finding
   * that out *after* spending a Linear request would report the failure as whatever went
   * wrong second. Resolved by name on every poll rather than held as an FK, because
   * `ogun project sync` deletes and recreates cycle rows and a foreign key would be nulled
   * by an ordinary config edit.
   */
  const cycle = await db.query.cycles.findFirst({
    where: and(eq(cycles.projectId, row.projectId), eq(cycles.name, row.cycleName)),
  })
  if (!cycle) {
    return refuse(
      `sources.${row.name}.cycle names "${row.cycleName}", and this project has no worker ` +
        'or cycle by that name — nothing emitted',
    )
  }

  /**
   * Parsed rather than trusted, and the failure recorded rather than thrown. `cycles` is a
   * jsonb column and a graph written by a newer build — or by hand — can be sitting in it;
   * an exception here would escape to the interval in `main.ts`, which would report it as
   * a poll loop that crashed rather than as one source with a definition nobody can read,
   * and would take every other source on the machine down with it for that tick.
   */
  const parsed = cycleDefinitionSchema.safeParse(cycle.definition)
  if (!parsed.success) {
    return refuse(`cycle "${row.cycleName}" has a definition this build cannot read`)
  }
  const definition = parsed.data
  const entry = entryNode(definition)
  if (!entry) {
    return refuse(
      `cycle "${row.cycleName}" has ${entryNodes(definition).length} nodes with no ` +
        'dependencies, so there is no single place to hand the ticket to — a source needs ' +
        'a cycle with exactly one entry node',
    )
  }

  /**
   * The project's slug, because that is what the secret store is keyed by and what a
   * person types into the command that fixes a refusal (ADR-0012). Read here rather than
   * carried on the source row: a slug is a project's name and this table has a foreign key
   * to the row that owns it, so a copy would be a second answer to a question that already
   * has one.
   */
  const project = await db.query.projects.findFirst({ where: eq(projects.id, row.projectId) })
  if (!project) return refuse('this source belongs to no project')

  /**
   * Which credential, decided in `readProjectSecret` and nowhere else (ADR-0014).
   *
   * An OAuth grant wins over a personal API key, and the reasoning for that lives with the
   * function that applies it rather than being restated — the point of putting precedence
   * in one place is that this file cannot hold a second opinion about it.
   */
  const key = await (deps.secrets ?? readProjectSecret)(project.slug, 'linear')

  let credential: LinearCredential
  if (key.state === 'granted') {
    /**
     * The refresh, immediately before the request that needs the token, because a token
     * that lasts 24 hours and a poller that wakes at 3am never coincide by accident. See
     * `linear-grant.ts` for why this is not a timer and not a reaction to a 401.
     */
    const usable = await (deps.grant ?? usableGrant)(project.slug, 'linear', key.grant)
    if (usable.state === 'refused') return refuse(usable.detail)
    if (usable.state === 'failed') {
      return record({
        source: row.name,
        outcome: 'failed',
        // Taken from the grant rather than guessed at here. `usableGrant` is the only
        // thing that knows whether the token endpoint was unreachable or the write to this
        // machine's store failed, and those two want opposite advice.
        kind: usable.kind,
        seen: 0,
        admitted: 0,
        emitted: [],
        trimmed: 0,
        truncated: false,
        detail: usable.detail,
      })
    }
    credential = usable.credential
  } else if (key.state === 'present') {
    /**
     * `expose()` at the wire and nowhere else — the one place per consumer ADR-0012 asks
     * for. The value goes straight into the client that puts it in a header; it is never
     * held in a variable this function logs, records, or puts in a `source_polls` row.
     */
    credential = { kind: 'api-key', token: key.secret.expose() }
  } else {
    return refuse(missingKey(project.slug, key))
  }

  const api = (deps.linear ?? ((c: LinearCredential) => linearHttp({ credential: c })))(credential)

  /**
   * The read. Paged, bounded, and ordered by `updatedAt` so that the tickets a cap cuts
   * off are the least recently touched ones.
   */
  const seen: Ticket[] = []
  let truncated = false
  let after: string | undefined
  for (let page = 0; page < config.maxPages; page++) {
    let result
    try {
      result = await api.issues({
        filter: remoteNarrowing(config.team),
        first: PAGE_SIZE,
        after,
      })
    } catch (err) {
      /**
       * Recorded, not thrown. A source whose key expired must leave a row saying so —
       * that is the entire reason `source_polls` exists, and an exception escaping to the
       * interval in `main.ts` would produce a line in a log nobody reads and a factory
       * that has silently stopped hearing about tickets.
       */
      const detail =
        err instanceof LinearUnavailable ? `${err.kind}: ${err.message}` : String(err)
      return record({
        source: row.name,
        outcome: 'failed',
        /**
         * The kind, stored as a fact and not only as a prefix on the sentence above.
         *
         * The prefix stays because it is what a person reads, but it is no longer what a
         * *machine* reads: `auth` sends somebody to `ogun connect`, `ratelimited` sends
         * them nowhere because the next poll fixes it, and `transport` is worth watching
         * for a pattern. A surface recovering that by matching `/^(auth|…):/` on a string
         * a future edit may reword is one prose change away from telling every operator
         * the same useless thing.
         *
         * Not anything at all when this was not a `LinearUnavailable`: the client throws
         * that for everything it can classify, so reaching the `String(err)` branch means
         * something nobody foresaw, and inventing `transport` for it would be a guess
         * recorded as evidence.
         */
        ...(err instanceof LinearUnavailable ? { kind: err.kind } : {}),
        seen: seen.length,
        admitted: 0,
        emitted: [],
        trimmed: 0,
        truncated: false,
        detail,
      })
    }
    seen.push(...result.tickets)
    if (!result.next) break
    after = result.next
    if (page === config.maxPages - 1) truncated = true
  }

  /**
   * **The deterministic filter, and everything after this line is downstream of it.**
   *
   * `admitsTicket` is the only thing in this file that decides, it is a pure function in
   * `@ogun/core` with no client and no database behind it, and it hands back a branded
   * `AdmittedTicket` that nothing else can mint. `emit` below takes that brand, so a
   * future caller that skips this loop does not compile (§4.13's "before any AI sees a
   * ticket", enforced by the type checker rather than by the order of the statements).
   */
  const admitted: AdmittedTicket[] = []
  for (const ticket of seen) {
    const verdict = admitsTicket(ticketFilterOf(config), ticket)
    if (verdict.admitted) admitted.push(verdict.ticket)
  }

  /**
   * What has already been emitted for, read *before* the cap is applied.
   *
   * The order of these two steps is the whole of it, and getting it wrong produces a
   * source that works for exactly one poll. Capping first takes the same first `maxPerPoll`
   * tickets every time — the list is stable, because nothing about an emitted ticket
   * changes — so every poll after the first hands the ledger three tickets it has already
   * seen, emits nothing, and reports itself as fine. A backlog deeper than the cap never
   * drains, and the symptom is silence.
   *
   * So the cap is on tickets that are *new*, and the trimmed count is how many new ones are
   * waiting. That also makes `trimmed` mean something a person can act on: it is work
   * queued up behind the cap, not an artefact of how the list was ordered.
   *
   * This read is not the safety boundary — the unique index still is, and `emit` still
   * claims through it, because two polls can pass this check at the same instant. It is
   * what makes the cap correct.
   */
  const previously =
    admitted.length === 0
      ? []
      : await db
          .select()
          .from(sourceEmissions)
          .where(
            and(
              eq(sourceEmissions.projectId, row.projectId),
              inArray(
                sourceEmissions.externalId,
                admitted.map((t) => t.id),
              ),
            ),
          )
  const known = new Map(previously.map((e) => [e.externalId, e]))

  /**
   * A ticket edited since the job for it was emitted.
   *
   * Nothing re-emits: an edit is not new work, and re-emitting on a changed digest means a
   * person tightening a description three times gets three jobs — the runaway the ledger
   * exists to prevent, wearing a more reasonable face. But "we acted on a different version
   * of this ticket" is a real fact with no other home, so the poll carries it and the person
   * decides. Re-running one deliberately is a human act; today that means deleting the
   * emission row, and a command for it belongs with the pipeline slice, where there is
   * something to re-run.
   */
  const edited = admitted.flatMap((ticket) => {
    const previous = known.get(ticket.id)
    return previous && previous.digest !== ticketDigest(ticket)
      ? [`${ticket.identifier} was edited since it was emitted on ${previous.createdAt.toISOString()}`]
      : []
  })

  /**
   * The runaway bound. The tickets left behind are not lost — the next poll takes the next
   * `maxPerPoll` of them — so trimming costs five minutes and buys a first poll against a
   * real backlog that is three jobs instead of two hundred.
   */
  const fresh = admitted.filter((ticket) => !known.has(ticket.id))
  const taking = fresh.slice(0, config.maxPerPoll)
  const trimmed = fresh.length - taking.length

  const emitted: string[] = []
  const failures: string[] = []
  for (const ticket of taking) {
    const outcome = await emit(db, {
      row,
      cycleId: cycle.id,
      nodeKeys: definition.nodes.map((n) => n.key),
      ticket,
      credentials: await fleetCredentials(db),
    })
    if (outcome.emitted) emitted.push(ticket.identifier)
    else if (outcome.detail) failures.push(`${ticket.identifier}: ${outcome.detail}`)
  }

  return record({
    source: row.name,
    outcome: 'ok',
    seen: seen.length,
    admitted: admitted.length,
    emitted,
    trimmed,
    truncated,
    ...detailFor({
      seen,
      admitted: admitted.length,
      team: config.team,
      notes: [...edited, ...failures],
      truncated,
    }),
  })
}

/**
 * The ways a credential can be missing, each with the sentence that fixes it.
 *
 * Written out per state rather than templated, because the whole value of
 * `readProjectSecret` returning a state per remedy is lost the moment they share a
 * message. The `unreadable` case is the one that matters most and reads least like a
 * credential problem: the store is broken — a config.json mangled by an unrelated edit —
 * and the key is very likely still in it, so telling somebody to go and set one would send
 * them to overwrite a file that is already failing to parse.
 *
 * `unconnected` is the one ADR-0014 added, and it is the same mistake one step further
 * along: an operator who has registered an OAuth application and not finished the
 * authorization has done most of the work, and telling them to paste a personal API key
 * sends them backwards to the credential they were migrating off.
 */
function missingKey(
  slug: string,
  key: Exclude<ProjectSecret, { state: 'present' } | { state: 'granted' }>,
): string {
  const set = `\`ogun connect linear --project ${slug}\``
  switch (key.state) {
    case 'unconnected':
      return (
        `"${slug}" has a linear oauth application registered (client ${key.clientId}) and ` +
        'nobody has finished the authorization, so there is nothing to poll with. Connect ' +
        `it from Settings, or run \`ogun connect linear --project ${slug}\``
      )
    case 'malformed':
      return (
        `the linear oauth entry for "${slug}" is not a shape this build can read ` +
        `(${key.reason}). The store itself is fine — this one project needs reconnecting`
      )
    case 'absent':
      return `"${slug}" is not connected to linear on this machine — run ${set}`
    case 'empty':
      return (
        `the linear api key for "${slug}" is set to an empty value, which the write path ` +
        `refuses to create — something wrote a blank over it. Run ${set} --api-key again`
      )
    case 'unreadable':
      return (
        `this machine's secret store could not be read (${key.reason}), so the linear key ` +
        `for "${slug}" could not be looked up — it is probably still there, and the store ` +
        'is what needs fixing'
      )
  }
}

/**
 * What a person needs to read off a poll that emitted nothing.
 *
 * A source that has never fired is the failure this whole slice is most likely to produce,
 * and "seen: 40, admitted: 0" does not say whether the filter is working perfectly or
 * whether `status: [To Do]` was written against a column called `Todo`. The statuses that
 * were actually on the tickets it read answer that in one line, and only in the case where
 * it matters — a poll that admitted something needs no explanation.
 */
function detailFor(input: {
  seen: Ticket[]
  admitted: number
  team: string
  notes: string[]
  truncated: boolean
}): { detail?: string } {
  const parts: string[] = []
  if (input.admitted === 0 && input.seen.length > 0) {
    const statuses = [...new Set(input.seen.map((t) => t.status))].sort()
    parts.push(`nothing matched; the statuses on those tickets were: ${statuses.join(', ')}`)
  }
  /**
   * A poll that read **nothing at all**, which is a different fault from a poll that read
   * a hundred tickets and admitted none — and it used to say nothing, because the branch
   * above needs at least one ticket to describe.
   *
   * Found by pointing a real source at a team key the workspace does not have: the poll
   * reported `ok`, `seen: 0`, no detail, and looked exactly like a well-configured source
   * on a quiet afternoon. Forever, since a team key does not fix itself.
   *
   * Two causes and both are named, because they are indistinguishable from here and have
   * different fixes. Linear answers a filter on an unknown team key with an empty list
   * rather than an error, so a typo reads as emptiness; and a `client_credentials` grant
   * reaches only the workspace's *public* teams, so a correct key for a private team reads
   * as emptiness too. `ogun connect list` prints which grant is in use, which is the half
   * this sentence cannot know.
   */
  if (input.seen.length === 0) {
    parts.push(
      `read no tickets at all for team "${input.team}" — either no issue in that team ` +
        'matched the remote query, or the team key is not one this workspace has, or the ' +
        'grant cannot see it (an app-token grant reaches only public teams; `ogun connect ' +
        'list` says which grant this project uses)',
    )
  }
  if (input.truncated) {
    parts.push('stopped at maxPages, so the least recently updated tickets were not read')
  }
  parts.push(...input.notes)
  return parts.length > 0 ? { detail: parts.join(' — ') } : {}
}

/**
 * Turn one admitted ticket into a cycle run, at most once, ever.
 *
 * Takes an `AdmittedTicket`, which is the type-level half of §4.13's rule: there is no way
 * to reach this function with a ticket the deterministic filter has not seen.
 *
 * The order is the whole of the idempotency argument. The emission row is inserted
 * **first**, with `onConflictDoNothing` against the `(project, external id)` unique index,
 * and only a caller that got a row back goes on to create the run. That makes the insert
 * the claim: two overlapping polls, or a poll racing a restart, produce one run and one
 * quiet no-op rather than two runs nothing downstream could tell apart. It is the same
 * compare-and-set shape as `scheduler.tick` advancing `lastRunAt` before starting, and it
 * is chosen over a transaction around both for the same reason — a transaction spanning
 * `startCycleRun` would hold a write transaction open across a graph's worth of inserts.
 */
async function emit(
  db: Db,
  input: {
    row: typeof sources.$inferSelect
    cycleId: string
    /**
     * Every node of the cycle this ticket starts, not only the one it starts *at*.
     *
     * `entryNode` is still checked and still refuses a cycle with more than one entry:
     * that rule is about there being exactly one place a ticket *arrives*, which is a
     * question about the graph's shape. Which nodes may *read* the ticket is a different
     * question, and answering it with the entry node was the wrong answer for anything
     * longer than one node.
     *
     * A cycle a ticket started is about that ticket end to end. A planning node that
     * cannot read the ticket is planning from an upstream node's paraphrase of it, and a
     * ticket retyped by a model is not the ticket — the words somebody actually filed are
     * the whole of what §4.13's filter admitted, and losing them at the first hop makes
     * every node after it work from a summary nobody can check. The node that builds the
     * change needs them for the same reason from the other end: it is the one that can
     * tell that the plan it was handed would not give the person who filed the ticket
     * what they asked for.
     *
     * Nothing about the layering changes (§5.1): the brief is *appended* to each node's
     * own resolved prompt, so every node still knows what it was asked to do and now also
     * knows what about. A node in this cycle with no interest in the ticket — a reviewer
     * reused from another graph — gets a paragraph it can ignore, which is the cheap side
     * of being wrong.
     */
    nodeKeys: string[]
    ticket: AdmittedTicket
    credentials: Awaited<ReturnType<typeof fleetCredentials>>
  },
): Promise<{ emitted: boolean; detail?: string }> {
  const digest = ticketDigest(input.ticket)

  const [claim] = await db
    .insert(sourceEmissions)
    .values({
      projectId: input.row.projectId,
      sourceId: input.row.id,
      sourceName: input.row.name,
      externalId: input.ticket.id,
      externalKey: input.ticket.identifier,
      digest,
      outcome: 'emitted',
    })
    .onConflictDoNothing({
      target: [sourceEmissions.projectId, sourceEmissions.externalId],
    })
    .returning()

  /**
   * Lost the claim: another poll of this project emitted for this ticket between the
   * caller's read and this insert. Silent, because it is not a fact about the ticket — the
   * ticket has been dealt with, exactly as intended, and the racer that won has already
   * recorded it. The ordinary "already emitted" case never reaches here at all; the caller
   * filters those out before the cap, which is what stops a deep backlog from stalling.
   */
  if (!claim) return { emitted: false }

  try {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId: input.cycleId,
      /**
       * `source:<name>`, matching `cron` and `manual`. The ticket is not in this string
       * because `cycle_runs.trigger` is grouped on and the emission row answers "which
       * ticket" with a join — a trigger value per ticket would make "how much of tonight
       * came from Linear" a `like` query.
       */
      trigger: `source:${input.row.name}`,
      promptContext: Object.fromEntries(
        input.nodeKeys.map((key) => [key, ticketBrief(input.ticket)]),
      ),
      credentials: input.credentials,
    })
    await db
      .update(sourceEmissions)
      .set({ cycleRunId })
      .where(eq(sourceEmissions.id, claim.id))
    return { emitted: true }
  } catch (err) {
    /**
     * The claim stays. At most once, and the reasoning is `scheduler.tick`'s: a cycle that
     * cannot start — a node naming a worker that has been deleted, a definition this build
     * cannot parse — would otherwise be retried every five minutes forever, half-creating
     * a cycle run each time. A row marked `failed` with the error on it is a fact somebody
     * can act on; a loop at 3am is not.
     */
    const detail = err instanceof Error ? err.message : String(err)
    await db
      .update(sourceEmissions)
      .set({ outcome: 'failed', detail })
      .where(eq(sourceEmissions.id, claim.id))
    return { emitted: false, detail }
  }
}

/** Nodes nothing points at — where a cycle starts. */
const entryNodes = (definition: { nodes: Array<{ key: string }>; edges: Array<{ to: string }> }) =>
  definition.nodes.filter((n) => !definition.edges.some((e) => e.to === n.key)).map((n) => n.key)

/**
 * The single node a ticket is handed to, or nothing.
 *
 * A source's cycle has to have exactly one entry, because the ticket has to arrive
 * somewhere and "somewhere" cannot be a choice made at 3am. `reindexProject` refuses a
 * config that breaks this, so reaching the `undefined` branch means a definition that
 * arrived by some other route — and refusing the poll with a sentence beats picking the
 * first node in array order and being right most nights.
 */
function entryNode(definition: {
  nodes: Array<{ key: string }>
  edges: Array<{ to: string }>
}): string | undefined {
  const entries = entryNodes(definition)
  return entries.length === 1 ? entries[0] : undefined
}
