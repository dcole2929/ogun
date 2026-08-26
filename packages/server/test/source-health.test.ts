import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { sealSecret, singleWorkerCycle, sourceSchema, type Ticket } from '@ogun/core'
import { pollSource, pollSources, type SourceDeps } from '../src/foreman/sources.ts'
import { LinearUnavailable, type LinearApi } from '../src/integrations/linear.ts'
import {
  recentEmissions,
  sourceHealth,
  troubledSources,
} from '../src/source-health.ts'
import { startHarness } from './harness.ts'

/**
 * Reading the poll ledger (§4.13, principle 6).
 *
 * `source_polls` records every look a source takes, and until this slice nothing read it —
 * so a key that died at 3am left a perfect row in a table with no reader and a line in a
 * terminal nobody was watching. What is protected here is not the *writing* (that is
 * `sources.test.ts`) but the two things a reader can quietly get wrong:
 *
 *  1. **Collapsing the failure kinds.** `auth`, `ratelimited`, `transport` and `local` are
 *     kept apart at the wire because the remedies differ, and the natural shape of a
 *     read model — "the last poll failed" — throws all four away at the last step, which
 *     is the only step an operator sees.
 *  2. **Deriving a state from the last row alone.** The two most expensive failures leave
 *     *no row at all*: a control plane that stopped polling, and a source whose stored
 *     config the poller skips because it cannot parse it. An implementation that reads the
 *     latest poll reports both of those as whatever was true a week ago, or as a source
 *     that has never been used.
 */
describe('what a poll ledger says about a source', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  let projectId = ''
  const slug = 'poll-ledger'

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'scope-evaluator',
      skillRef: 'scope-evaluation',
      runtime: 'claude',
      versionHash: 'v',
      config: {},
    })
    await db.insert(schema.cycles).values({
      projectId,
      name: 'scope-evaluator',
      definition: singleWorkerCycle('scope-evaluator'),
    })
  })

  after(async () => {
    await h.stop()
  })

  const NOW = new Date('2026-08-20T12:00:00.000Z')
  const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000)
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60_000)

  /** A source row, as `ogun project sync` would have written it. */
  const source = async (
    name: string,
    over: Record<string, unknown> = {},
    row: { lastPolledAt?: Date | null; createdAt?: Date } = {},
  ) => {
    const config = sourceSchema.parse({
      kind: 'linear',
      cycle: 'scope-evaluator',
      team: 'ENG',
      filter: { status: ['Todo'], labels: ['ogun'] },
      ...over,
    })
    const [inserted] = await db
      .insert(schema.sources)
      .values({
        projectId,
        name,
        kind: config.kind,
        cycleName: config.cycle,
        config: config as unknown as Record<string, unknown>,
        enabled: config.enabled,
        lastPolledAt: row.lastPolledAt ?? minutesAgo(1),
        ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      })
      .returning()
    return { row: inserted!, config }
  }

  /** A poll row, written by hand where the test is about how one is *read*. */
  const poll = async (
    sourceRow: typeof schema.sources.$inferSelect,
    at: Date,
    over: Partial<typeof schema.sourcePolls.$inferInsert> = {},
  ) => {
    await db.insert(schema.sourcePolls).values({
      projectId,
      sourceId: sourceRow.id,
      sourceName: sourceRow.name,
      startedAt: at,
      endedAt: at,
      outcome: 'ok',
      ...over,
    })
  }

  const healthOfSource = async (name: string) => {
    const all = await sourceHealth(db, { projectId, now: NOW })
    const found = all.find((s) => s.name === name)
    assert.ok(found, `${name} is in the report`)
    return found!
  }

  /**
   * **The writer and the reader, checked against each other in one test.**
   *
   * This is the only test that runs a real `pollSource` here, and it exists because the
   * classification has to survive the trip through the database. The previous shape of
   * this feature would have been a regular expression over `detail` — the client writes
   * `"auth: …"` as a prefix, so a reader *can* recover the kind by matching it, and that
   * works right up until somebody rewords the sentence, at which point four remedies
   * silently become one "poll failed" and nothing fails. Driving the real poller and then
   * reading the real report is what makes that drift a red test instead of a quiet loss.
   */
  for (const kind of ['auth', 'ratelimited', 'transport'] as const) {
    test(`a poll that failed with ${kind} is reported as ${kind}, not as "failed"`, async () => {
      const { row, config } = await source(`kind-${kind}`)
      const throwing: LinearApi = {
        issues: () => Promise.reject(new LinearUnavailable(kind, 'from the fixture')),
      }
      const result = await pollSource(db, row, config, {
        secrets: async () => ({ state: 'present', secret: sealSecret('lin_api_test') }),
        linear: () => throwing,
      })
      assert.equal(result.outcome, 'failed')
      assert.equal(result.kind, kind)

      const [stored] = await db
        .select()
        .from(schema.sourcePolls)
        .where(eq(schema.sourcePolls.sourceId, row.id))
      assert.equal(stored?.kind, kind, 'the ledger row carries the kind, not only the prose')

      const report = await healthOfSource(`kind-${kind}`)
      assert.equal(report.health.state, 'failing')
      assert.equal(report.health.kind, kind)
    })
  }

  /**
   * Four kinds, four remedies, and no two of them the same sentence.
   *
   * The whole reason `LinearUnavailable` splits `auth` from `ratelimited` from `transport`
   * is that they want opposite actions: go and rotate a credential, do nothing at all, and
   * wait but keep an eye on it. `local` is the fourth, and it is the one a naive read model
   * would fold into `transport` — it is also the one where waiting is guaranteed not to
   * work, because Linear already answered and this machine could not write the answer down.
   */
  test('each failure kind gets its own remedy', async () => {
    const kinds = ['auth', 'ratelimited', 'transport', 'local'] as const
    const remedies: string[] = []
    for (const kind of kinds) {
      const { row } = await source(`remedy-${kind}`)
      await poll(row, minutesAgo(2), { outcome: 'failed', kind, detail: `${kind} happened` })
      const report = await healthOfSource(`remedy-${kind}`)
      assert.equal(report.health.kind, kind)
      assert.ok(report.health.remedy, `${kind} has a remedy`)
      remedies.push(report.health.remedy!)
    }
    assert.equal(new Set(remedies).size, kinds.length, 'no two kinds share a sentence')

    // The two that must never read alike: one says a person has to act, the other says
    // nobody does. If these ever converge, the column stopped earning its place.
    const [auth, ratelimited] = remedies
    assert.match(auth!, /ogun connect/)
    assert.doesNotMatch(ratelimited!, /ogun connect/)
  })

  /**
   * A `failed` row with no kind is reported as unclassified rather than as a guess.
   *
   * Rows written before the column existed have none, and so does the unforeseen-error
   * catch in `pollSources`. Defaulting them to `transport` would put "the next poll asks
   * again" in front of an operator on the strength of nothing at all.
   */
  test('a failure the ledger could not classify does not acquire a kind', async () => {
    const { row } = await source('unclassified')
    await poll(row, minutesAgo(2), { outcome: 'failed', detail: 'something nobody foresaw' })
    const report = await healthOfSource('unclassified')
    assert.equal(report.health.state, 'failing')
    assert.equal(report.health.kind, null)
    assert.match(report.health.remedy!, /could not classify/)
  })

  /**
   * **The state with no row behind it.**
   *
   * `pollSources` skips a source whose stored config this build cannot parse — before the
   * claim, before any row is written — so that one bad source cannot stop the others. That
   * is the right call and it makes the bad source *completely silent*: no poll rows ever,
   * and a `last_polled_at` frozen at whenever it last worked. A read model built on "the
   * most recent poll" reports it as whatever was true before the config broke, or as a
   * source nobody has used yet. Both are wrong and both look calm.
   */
  test('a source nothing has polled is overdue, even though it has no failed poll', async () => {
    const { row } = await source('stalled', { pollMinutes: 5 }, { lastPolledAt: minutesAgo(240) })
    await poll(row, minutesAgo(240), { outcome: 'ok', seen: 4, admitted: 1 })

    const report = await healthOfSource('stalled')
    assert.equal(report.health.state, 'overdue')
    // The last row is a *success*. Anything reading only the latest poll calls this healthy.
    assert.equal(report.health.pollsRecorded, 1)
    assert.match(report.health.remedy!, /control plane/)
  })

  test('a source whose stored config will not parse says so, and is still listed', async () => {
    const [broken] = await db
      .insert(schema.sources)
      .values({
        projectId,
        name: 'unreadable',
        kind: 'linear',
        cycleName: 'scope-evaluator',
        // A shape a newer CLI (or a hand-edit) could leave behind. `sourceSchema` refuses
        // it, and the poller's response to that is to skip the source in silence.
        config: { kind: 'linear', cycle: 'scope-evaluator', filter: { status: [] } },
        lastPolledAt: minutesAgo(600),
      })
      .returning()
    assert.ok(broken)

    const report = await healthOfSource('unreadable')
    assert.equal(report.health.state, 'overdue')
    assert.equal(report.filter, null, 'a filter that would not parse is null, not invented')
    assert.match(report.health.detail!, /not a shape this build can read/)
    assert.match(report.health.remedy!, /ogun project sync/)
  })

  /**
   * Silence is a remark, and it is not a failure.
   *
   * `ok` covers "looked and matched nothing" on purpose — that is the ordinary state of a
   * source on a quiet afternoon, and a surface that flagged it would flag every source most
   * of the time. But a filter that has matched nothing for a *week* is much more likely to
   * be `status: [To Do]` against a column the team calls `Todo`, and the poll that would
   * prove it already recorded the statuses it saw.
   */
  test('a source that has matched nothing for a week is silent; one quiet for an hour is not', async () => {
    const { row: quiet } = await source('quiet-week')
    for (const d of [10, 8, 3, 0.01]) {
      await poll(quiet, daysAgo(d), { outcome: 'ok', seen: 6, admitted: 0, detail: 'nothing matched; the statuses on those tickets were: In Progress' })
    }
    const silent = await healthOfSource('quiet-week')
    assert.equal(silent.health.state, 'silent')
    assert.match(silent.health.remedy!, /not a failure/)
    // The diagnosis needs both halves, so the filter has to arrive with it.
    assert.deepEqual(silent.filter?.status, ['Todo'])
    assert.match(silent.health.detail!, /In Progress/)

    const { row: busy } = await source('quiet-hour')
    await poll(busy, daysAgo(20), { outcome: 'ok', seen: 6, admitted: 0 })
    await poll(busy, minutesAgo(90), { outcome: 'ok', seen: 6, admitted: 2 })
    await poll(busy, minutesAgo(2), { outcome: 'ok', seen: 6, admitted: 0 })
    assert.equal((await healthOfSource('quiet-hour')).health.state, 'healthy')
  })

  /**
   * A source switched on this morning that has matched nothing is not "silent" — it is a
   * source switched on this morning. Silence is measured from the last poll that admitted
   * something, and from the first *recorded* poll when nothing ever has, so a filter that
   * has never once matched can still reach the state; it just needs a week of evidence
   * first.
   */
  test('a young source that has never matched anything says nothing about it', async () => {
    const { row } = await source('fresh')
    await poll(row, minutesAgo(30), { outcome: 'ok', seen: 3, admitted: 0 })
    await poll(row, minutesAgo(2), { outcome: 'ok', seen: 3, admitted: 0 })
    assert.equal((await healthOfSource('fresh')).health.state, 'healthy')

    const { row: old } = await source('never-matched')
    await poll(old, daysAgo(21), { outcome: 'ok', seen: 3, admitted: 0 })
    await poll(old, minutesAgo(2), { outcome: 'ok', seen: 3, admitted: 0 })
    const report = await healthOfSource('never-matched')
    assert.equal(report.health.state, 'silent')
    assert.match(report.health.remedy!, /never admitted anything/)
  })

  /**
   * A poll that read **nothing at all** says so — the one silent success left.
   *
   * Found by pointing a real source at a team key the workspace does not have. Linear
   * answers a filter on an unknown team with an empty list rather than an error, so the
   * poll recorded `ok`, `seen: 0`, and *no detail*: the "nothing matched, here are the
   * statuses" sentence needs at least one ticket to describe, and there were none. From
   * every surface it was indistinguishable from a correctly configured source on a quiet
   * afternoon, and it would have stayed that way forever, because a mistyped team key does
   * not fix itself.
   *
   * The same shape covers the case that is not a typo at all: a `client_credentials` grant
   * reaches only the workspace's *public* teams, so a perfectly correct key for a private
   * team also reads as emptiness. Both are named, because nothing at this layer can tell
   * them apart and they have different fixes.
   */
  test('a poll that read no tickets at all says so, rather than reporting a quiet afternoon', async () => {
    const { row, config } = await source('empty-team', { team: 'NOPE' })
    const result = await pollSource(db, row, config, {
      secrets: async () => ({ state: 'present', secret: sealSecret('lin_api_test') }),
      linear: () => ({ issues: async () => ({ tickets: [], next: undefined }) }),
    })

    assert.equal(result.outcome, 'ok', 'an empty answer is not a failure')
    assert.equal(result.seen, 0)
    assert.match(result.detail ?? '', /read no tickets at all for team "NOPE"/)
    // The two causes it cannot tell apart are both named; a sentence offering one of them
    // sends half the operators who read it to the wrong place.
    assert.match(result.detail ?? '', /team key is not one this workspace has/)
    assert.match(result.detail ?? '', /public teams/)

    assert.match((await healthOfSource('empty-team')).health.detail!, /read no tickets/)
  })

  test('a disabled source is not a broken one', async () => {
    const { row } = await source('switched-off', { enabled: false }, { lastPolledAt: daysAgo(30) })
    // Long overdue by every clock, and correctly so: nobody is polling it on purpose.
    assert.equal((await healthOfSource('switched-off')).health.state, 'disabled')
  })

  test('a refusal keeps its own remedy rather than being given a generic one', async () => {
    const { row } = await source('no-key')
    await poll(row, minutesAgo(2), {
      outcome: 'refused',
      detail: '"poll-ledger" is not connected to linear on this machine — run `ogun connect linear`',
    })
    const report = await healthOfSource('no-key')
    assert.equal(report.health.state, 'refused')
    /**
     * Null on purpose. Every refusal `pollSource` writes already names the exact command
     * that fixes it, with this project's slug in it; a second, vaguer sentence beside a
     * specific one leaves the reader deciding which to believe.
     */
    assert.equal(report.health.remedy, null)
    assert.match(report.health.detail!, /ogun connect linear/)
  })

  /**
   * The status rail's bar, and it is the failure kinds deciding what interrupts somebody.
   *
   * Chrome that is always lit stops being read, so this filter is stricter than the
   * listing — and *how* much stricter depends on which kind of failure it is. A dead
   * credential never heals, so one failure is enough. A throttled poll is expected to clear
   * within a cadence or two, so lighting the rail for a single one would keep it lit most
   * of the time and teach everybody to ignore it, taking the credential warning with it.
   */
  test('a rate-limited poll waits before it interrupts anyone; a dead credential does not', async () => {
    const { row: throttled } = await source('throttled', { pollMinutes: 5 })
    // One failed poll, one cadence after a poll that worked. Exactly the shape a throttle
    // takes, and exactly the shape that must not light the rail.
    await poll(throttled, minutesAgo(6), { outcome: 'ok', seen: 2, admitted: 0 })
    await poll(throttled, minutesAgo(1), { outcome: 'failed', kind: 'ratelimited', detail: 'slow down' })

    const { row: dead } = await source('dead-key', { pollMinutes: 5 })
    await poll(dead, minutesAgo(6), { outcome: 'ok', seen: 2, admitted: 0 })
    await poll(dead, minutesAgo(1), { outcome: 'failed', kind: 'auth', detail: 'token rejected' })

    const first = (await troubledSources(db, { now: NOW })).map((s) => s.source)
    assert.ok(!first.includes('throttled'), 'one throttled poll is not an incident')
    assert.ok(first.includes('dead-key'), 'a rejected credential is one from the first failure')

    /**
     * The same source, still throttled forty minutes later — eight of its own cadences,
     * every one of them polled and every one refused. It has stopped being a blip and
     * started being an outage, and the rail says so now without the rule changing.
     */
    const later = new Date(NOW.getTime() + 40 * 60_000)
    await poll(throttled, new Date(later.getTime() - 60_000), {
      outcome: 'failed',
      kind: 'ratelimited',
      detail: 'slow down',
    })
    await db
      .update(schema.sources)
      .set({ lastPolledAt: new Date(later.getTime() - 60_000) })
      .where(eq(schema.sources.id, throttled.id))
    const stillTroubled = await troubledSources(db, { now: later })
    assert.ok(stillTroubled.some((s) => s.source === 'throttled'))
    // And it still says *which* kind, because that is what decides whether anybody acts.
    assert.equal(stillTroubled.find((s) => s.source === 'throttled')?.kind, 'ratelimited')
  })

  test('the rail carries nothing about a silent or a disabled source', async () => {
    const troubled = (await troubledSources(db, { now: NOW })).map((s) => s.source)
    assert.ok(!troubled.includes('quiet-week'), 'a quiet filter is a remark, not an alarm')
    assert.ok(!troubled.includes('switched-off'))
    assert.ok(troubled.includes('stalled'), 'nothing polling at all always interrupts')
  })

  /**
   * "Has this ticket already produced work?" — the question a live source generates more
   * often than every other question combined.
   *
   * Ogun writes nothing back to Linear (ADR-0004), so a ticket that has been completely
   * dealt with sits in `Todo` with its label on, looking exactly like one nothing ever saw.
   * The emission row is the only record anywhere that anything happened.
   */
  test('a ticket lookup is by the key a person types, and is scoped to the project', async () => {
    const { row, config } = await source('emitting')
    const wanted: Ticket = {
      id: 'b2f9a1c4-4c37-4d3e-9a41-000000000901',
      identifier: 'HEI-42',
      title: 'Rate limiter drops the first request after a restart',
      description: 'The token bucket is initialised empty.',
      url: 'https://linear.app/acme/issue/HEI-42/rate-limiter',
      status: 'Todo',
      statusType: 'unstarted',
      labels: ['ogun'],
      blockedBy: [],
      updatedAt: '2026-08-19T09:14:22.401Z',
      team: 'HEI',
    }
    const deps: SourceDeps = {
      secrets: async () => ({ state: 'present', secret: sealSecret('lin_api_test') }),
      linear: () => ({ issues: async () => ({ tickets: [wanted], next: undefined }) }),
    }
    await pollSource(db, row, config, deps)

    // Lower case, because that is what gets pasted out of Slack. The identity is the uuid;
    // the key is the handle, and a lookup that is case-sensitive on a handle answers
    // "never emitted" about a ticket that plainly was.
    const found = await recentEmissions(db, projectId, { ticket: 'hei-42' })
    assert.equal(found.length, 1)
    assert.equal(found[0]?.externalKey, 'HEI-42')
    assert.ok(found[0]?.cycleRunId, 'it points at the run it became')

    assert.equal((await recentEmissions(db, projectId, { ticket: 'HEI-999' })).length, 0)
  })

  /**
   * The catch of last resort now leaves a row.
   *
   * `pollSources` advances `last_polled_at` *before* it polls, so a poll that died in the
   * unforeseen-error handler consumed its turn and — until this change — wrote nothing at
   * all. A source throwing on every tick was, from every surface, indistinguishable from a
   * source nobody had ever configured: a cursor moving forward beside an empty history. The
   * result was handed to `main.ts`, which printed it to a terminal.
   */
  test('a poll that fails in a way nobody foresaw still leaves evidence', async () => {
    const { row } = await source('explodes', { pollMinutes: 1 }, { lastPolledAt: daysAgo(1) })
    const results = await pollSources(db, {
      secrets: async () => ({ state: 'present', secret: sealSecret('lin_api_test') }),
      // Not a `LinearUnavailable` and not thrown from `issues` — thrown from building the
      // client, which is outside every branch `pollSource` guards.
      linear: () => {
        throw new Error('the client blew up')
      },
    })
    assert.ok(results.some((r) => r.source === 'explodes' && r.outcome === 'failed'))

    const rows = await db
      .select()
      .from(schema.sourcePolls)
      .where(eq(schema.sourcePolls.sourceId, row.id))
    assert.equal(rows.length, 1, 'the ledger records the poll it could not explain')
    assert.equal(rows[0]?.outcome, 'failed')
    assert.equal(rows[0]?.kind, null, 'an unclassified failure is not given a fabricated kind')
    assert.match(rows[0]?.detail ?? '', /blew up/)

    const report = await healthOfSource('explodes')
    assert.equal(report.health.state, 'failing')
  })

  test('the route answers with the state, the history and the emissions', async () => {
    /**
     * Its own source, timestamped against the wall clock: the route has no `now` seam and
     * must not have one — a read model whose sense of "overdue" comes from the caller is a
     * read model a caller can talk out of reporting an outage.
     */
    const real = new Date()
    const { row: live } = await source('route-dead-key', { pollMinutes: 5 }, {
      lastPolledAt: new Date(real.getTime() - 60_000),
    })
    await poll(live, new Date(real.getTime() - 6 * 60_000), { outcome: 'ok', seen: 2 })
    await poll(live, new Date(real.getTime() - 60_000), {
      outcome: 'failed',
      kind: 'auth',
      detail: 'token rejected',
    })

    const res = await h.fetch(`/api/projects/${slug}/sources`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      sources: Array<{ name: string; health: { state: string; kind: string | null }; polls: unknown[] }>
      emissions: Array<{ externalKey: string }>
      ticket: string | null
    }
    const dead = body.sources.find((s) => s.name === 'route-dead-key')
    assert.ok(dead, 'every source is listed, healthy or not')
    assert.equal(dead!.health.state, 'failing')
    assert.equal(dead!.health.kind, 'auth')
    assert.equal(dead!.polls.length, 2, 'the history rides under the state')
    assert.ok(body.emissions.some((e) => e.externalKey === 'HEI-42'))
    assert.equal(body.ticket, null)

    const one = await h.fetch(`/api/projects/${slug}/sources?ticket=hei-42`)
    const narrowed = (await one.json()) as {
      emissions: Array<{ externalKey: string }>
      ticket: string
    }
    assert.equal(narrowed.ticket, 'hei-42', 'echoed back, so a surface can name what it asked')
    assert.equal(narrowed.emissions.length, 1)
  })

  test('a project with no sources is an empty list, not a 404', async () => {
    await db.insert(schema.projects).values({ slug: 'no-sources-here' })
    const res = await h.fetch('/api/projects/no-sources-here/sources')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { sources: unknown[] }
    assert.deepEqual(body.sources, [])
    await db.delete(schema.projects).where(eq(schema.projects.slug, 'no-sources-here'))
  })
})
