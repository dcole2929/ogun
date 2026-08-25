import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { sealSecret, singleWorkerCycle, sourceSchema, type Ticket } from '@ogun/core'
import { pollSource, pollSources, type SourceDeps } from '../src/foreman/sources.ts'
import {
  LinearUnavailable,
  type LinearApi,
  type LinearCredential,
} from '../src/integrations/linear.ts'
import { reindexProject, ConfigInvalid } from '../src/reindex.ts'
import { startHarness } from './harness.ts'
import { fixtureApi } from './linear-fixtures.ts'

/**
 * A source — the thing that turns tickets into jobs (§4.13, ADR-0013).
 *
 * The hard part is not fetching. It is that Ogun writes nothing back to Linear
 * (ADR-0004), so nothing about a ticket ever changes to record that it has been dealt
 * with: the card sits in `Todo` with its label until a person moves it, and every poll for
 * however many hours that takes sees it again. Idempotency is therefore not a nicety here,
 * it is the difference between one job and 288 a day.
 */
describe('a source', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  let projectId = ''
  let counter = 0

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug: 'sources' }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'scope-evaluator',
      skillRef: 'scope-evaluation',
      runtime: 'claude',
      versionHash: 'v',
      config: {},
    })
    await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'scope-evaluator',
        definition: singleWorkerCycle('scope-evaluator'),
      })
  })

  after(async () => {
    await h.stop()
  })

  const ticket = (over: Partial<Ticket> = {}): Ticket => ({
    id: `b2f9a1c4-4c37-4d3e-9a41-${String(counter++).padStart(12, '0')}`,
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

  /** A source row, as `ogun project sync` would have written it. */
  const source = async (name: string, over: Record<string, unknown> = {}) => {
    const config = sourceSchema.parse({
      kind: 'linear',
      cycle: 'scope-evaluator',
      team: 'ENG',
      filter: { status: ['Todo'], labels: ['ogun'] },
      ...over,
    })
    const [row] = await db
      .insert(schema.sources)
      .values({
        projectId,
        name,
        kind: config.kind,
        cycleName: config.cycle,
        config: config as unknown as Record<string, unknown>,
        enabled: config.enabled,
      })
      .returning()
    return { row: row!, config }
  }

  /** The secret seam stubbed, so no test reads this machine's `~/.ogun/config.json`. */
  const withKey: NonNullable<SourceDeps['secrets']> = async () => ({
    state: 'present',
    secret: sealSecret('lin_api_test'),
  })

  const deps = (tickets: Ticket[], over: Partial<SourceDeps> = {}): SourceDeps => ({
    secrets: withKey,
    linear: () => fixtureApi([{ tickets, next: undefined }]),
    ...over,
  })

  const emissions = async () =>
    db.select().from(schema.sourceEmissions).where(eq(schema.sourceEmissions.projectId, projectId))

  const pollsFor = async (name: string) =>
    db
      .select()
      .from(schema.sourcePolls)
      .where(
        and(eq(schema.sourcePolls.projectId, projectId), eq(schema.sourcePolls.sourceName, name)),
      )

  test('emits a cycle run for an admitted ticket, and only for an admitted one', async () => {
    const { row, config } = await source('basic')
    const wanted = ticket()
    const result = await pollSource(
      db,
      row,
      config,
      deps([wanted, ticket({ status: 'In Progress' }), ticket({ labels: [] })]),
    )

    assert.equal(result.outcome, 'ok')
    assert.equal(result.seen, 3)
    assert.equal(result.admitted, 1)

    const rows = (await emissions()).filter((e) => e.sourceName === 'basic')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.externalId, wanted.id)
    assert.ok(rows[0]?.cycleRunId, 'the emission points at the run it produced')

    const [run] = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.id, rows[0]!.cycleRunId!))
    assert.equal(run?.trigger, 'source:basic')
  })

  test('the ticket reaches the entry node as context, not as a replacement prompt', async () => {
    /**
     * §5.1 says a source "may override" the prompt, and taking that literally deletes the
     * sentence that names the skill — the agent gets a feature request and no idea what it
     * is being asked to do about it. The layers decide what to do; the source decides what
     * to do it to. Both halves have to be in the job's prompt or one of them is missing at
     * 3am with nothing saying so.
     */
    const { row, config } = await source('context')
    await pollSource(db, row, config, deps([ticket()]))

    const emission = (await emissions()).find((e) => e.sourceName === 'context')
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, emission!.cycleRunId!))

    assert.match(job!.prompt, /Use the scope-evaluation skill\./)
    assert.match(job!.prompt, /-----BEGIN TICKET-----/)
    assert.match(job!.prompt, /Rate limiter drops the first request/)
  })

  test('polling the same ticket ten times emits once', async () => {
    /**
     * The property the whole design turns on. Nothing moves the card, so every poll admits
     * it again; a naive implementation emits per poll and 288 cycle runs a day come out of
     * one ticket nobody touched. The unique index on (project, external id) is the claim,
     * taken before the run is created so two overlapping polls cannot both win it.
     */
    const { row, config } = await source('repeat')
    const stable = ticket()
    for (let i = 0; i < 10; i++) {
      const result = await pollSource(db, row, config, deps([stable]))
      assert.equal(result.admitted, 1, 'the filter keeps admitting it — nothing moved the card')
      assert.equal(result.emitted.length, i === 0 ? 1 : 0)
    }

    const rows = (await emissions()).filter((e) => e.externalId === stable.id)
    assert.equal(rows.length, 1)
    const runs = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.trigger, 'source:repeat'))
    assert.equal(runs.length, 1)
  })

  test('a ticket edited after it was emitted for is reported, and is not emitted again', async () => {
    /**
     * Two decisions in one. It is *not* re-emitted, because an edit is not new work and a
     * person tightening a description three times would otherwise get three jobs — the
     * runaway this table exists to prevent, wearing a more reasonable face. And it *is*
     * recorded, because "we acted on a different version of this ticket" has no other home
     * and is exactly the sort of fact principle 6 refuses to let evaporate.
     */
    const { row, config } = await source('edited')
    const original = ticket()
    await pollSource(db, row, config, deps([original]))

    const after = await pollSource(
      db,
      row,
      config,
      deps([{ ...original, description: 'rewritten entirely, with a different plan' }]),
    )
    assert.equal(after.emitted.length, 0)
    assert.match(after.detail ?? '', /edited since/)

    const rows = (await emissions()).filter((e) => e.externalId === original.id)
    assert.equal(rows.length, 1)
  })

  test('a machine that slept through six polls emits once, not six times', async () => {
    /**
     * The `onMissed` question (§4.2), and the answer is that a source does not have one. A
     * poll is level-triggered: it asks what matches *now*, so six missed polls collapse
     * into one question with one answer. The implementation that loses this property is the
     * tempting one — keep a cursor, ask for "issues updated since `lastPolledAt`" — which
     * re-emits everything the gap spans on the way back up, and never sees a ticket that
     * reached the trigger status without being updated.
     *
     * Simulated by polling at six wall-clock times a day apart with the same backlog, which
     * is exactly what a hibernating laptop produces.
     */
    const { row, config } = await source('slept')
    const backlog = [ticket(), ticket({ identifier: 'ENG-102' })]
    for (let day = 0; day < 6; day++) {
      await pollSource(db, row, config, {
        ...deps(backlog),
        now: () => new Date(Date.UTC(2026, 7, 10 + day)),
      })
    }

    const rows = (await emissions()).filter((e) => e.sourceName === 'slept')
    assert.equal(rows.length, 2, 'two tickets, six polls, two emissions')
  })

  test('caps how many tickets one poll may emit for, and the backlog still drains', async () => {
    /**
     * Two properties, and the second one caught a real bug in the first draft of this file.
     *
     * The cap exists because the first poll of a source against a real backlog is the
     * dangerous one: a filter matching two hundred tickets would create two hundred cycle
     * runs in one tick. `maxConcurrentModifiers` throttles what *executes* and
     * `maxOpenPullRequests` bounds what reaches the remote, but neither stops the queue
     * itself filling, and a queue nobody meant to create is hours of unpicking.
     *
     * The bug was applying that cap to *admitted* tickets rather than to *new* ones.
     * Nothing about an emitted ticket changes — Ogun writes nothing back to Linear — so the
     * admitted list is identical on every poll, and the same first `maxPerPoll` tickets
     * were re-selected forever, handed to a ledger that had already seen them, and rejected.
     * A backlog deeper than the cap never drained past the first poll, and the symptom was
     * silence: polls that reported themselves as fine while emitting nothing. The second
     * half of this test is the tripwire, and it is why `trimmed` counts new tickets waiting
     * rather than an artefact of list order.
     */
    const { row, config } = await source('capped', { maxPerPoll: 2 })
    const backlog = [ticket(), ticket(), ticket(), ticket(), ticket()]

    const first = await pollSource(db, row, config, deps(backlog))
    assert.equal(first.emitted.length, 2)
    assert.equal(first.trimmed, 3)

    const second = await pollSource(db, row, config, deps(backlog))
    assert.equal(second.emitted.length, 2, 'the next two, not the same two again')
    assert.equal(second.trimmed, 1)

    const third = await pollSource(db, row, config, deps(backlog))
    assert.equal(third.emitted.length, 1)
    assert.equal(third.trimmed, 0)

    const fourth = await pollSource(db, row, config, deps(backlog))
    assert.equal(fourth.emitted.length, 0, 'and then it is quiet, because the backlog drained')
    assert.equal(fourth.admitted, 5, 'while the filter goes on admitting all five, forever')
  })

  test('records a poll that found nothing, with the statuses it actually saw', async () => {
    /**
     * "The source has never fired" is this slice's most likely failure and its least
     * legible: a `status: [To Do]` written against a column called `Todo` polls forever,
     * matches nothing, and reports success. Recording the statuses that were on the tickets
     * it read turns an afternoon into one line, and only in the case where it matters — a
     * poll that admitted something needs no explanation.
     */
    const { row, config } = await source('typo', { filter: { status: ['To Do'], labels: [] } })
    const result = await pollSource(db, row, config, deps([ticket(), ticket({ status: 'Done' })]))

    assert.equal(result.outcome, 'ok')
    assert.equal(result.admitted, 0)
    const [poll] = await pollsFor('typo')
    assert.equal(poll?.seen, 2)
    assert.match(poll?.detail ?? '', /nothing matched; the statuses on those tickets were: Done, Todo/)
  })

  test('records a refusal when this machine has no key, rather than doing nothing', async () => {
    /**
     * The 3am failure: a key expires, the source stops emitting, and nothing anywhere says
     * so. A source that has stopped working and a quiet week are indistinguishable unless
     * the looking itself is recorded — the same argument the `coverage` table makes about
     * workers, applied to the trigger upstream of them.
     */
    const { row, config } = await source('nokey')
    const result = await pollSource(db, row, config, {
      secrets: async () => ({ state: 'absent' }),
      linear: () => {
        throw new Error('the client must not be built without a key')
      },
    })

    assert.equal(result.outcome, 'refused')
    const [poll] = await pollsFor('nokey')
    assert.equal(poll?.outcome, 'refused')
    assert.match(poll?.detail ?? '', /no linear api key for "sources"/)
    assert.match(poll?.detail ?? '', /ogun secret set linear --project sources/)
  })

  test('a store it could not read is not reported as a key nobody set', async () => {
    /**
     * `readProjectSecret` returns four states precisely so this one does not wear the same
     * message as `absent`, and the poll is where that distinction either survives or is
     * thrown away. A `config.json` mangled by an unrelated edit is a broken *store*, with
     * the key very probably still in it — reporting it as "no key" sends somebody to
     * overwrite a file that is already failing to parse.
     */
    const { row, config } = await source('unreadable')
    const result = await pollSource(db, row, config, {
      secrets: async () => ({ state: 'unreadable', reason: 'unexpected token } in JSON' }),
      linear: () => {
        throw new Error('unreachable')
      },
    })

    assert.equal(result.outcome, 'refused')
    assert.match(result.detail ?? '', /secret store could not be read/)
    assert.match(result.detail ?? '', /probably still there/)
  })

  /**
   * The property: a poll authenticating with an OAuth grant sends a `Bearer` token, and
   * the refresh decision runs **before** the first request rather than after a 401
   * (ADR-0014).
   *
   * Two mistakes are being fixed here and both are silent. Passing the grant's access
   * token to the client as if it were a personal key produces a well-formed request and an
   * `AUTHENTICATION_ERROR` — the same code Linear answers a revoked credential with — so
   * the symptom is "your connection stopped working". And skipping the refresh means the
   * poll spends a request to discover what the expiry field already said, on a poller whose
   * ordinary state at 3am is a token that died some hours ago.
   */
  test('a granted project polls with a bearer token, renewed before the request', async () => {
    const { row, config } = await source('granted')
    let built: LinearCredential | undefined
    const result = await pollSource(db, row, config, {
      secrets: async () => ({
        state: 'granted',
        apiKeyIgnored: false,
        grant: {
          clientId: 'client-1',
          access: sealSecret('access-stale'),
          refresh: sealSecret('refresh-1'),
          // Already dead, which is the normal state of a token when a nightly poller wakes.
          expiresAt: Date.now() - 60 * 60 * 1000,
          obtainedAt: Date.now() - 25 * 60 * 60 * 1000,
          scopes: ['read'],
          actor: 'app',
          workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
        },
      }),
      grant: async () => ({
        state: 'ready',
        credential: { kind: 'oauth', token: 'access-fresh', workspace: 'Acme' },
        expiresAt: Date.now() + 86_400_000,
        refreshed: true,
      }),
      linear: (credential) => {
        built = credential
        return fixtureApi([{ tickets: [], next: undefined }])
      },
    })

    assert.equal(result.outcome, 'ok')
    // The renewed token, not the stale one that came out of the store.
    assert.deepEqual(built, { kind: 'oauth', token: 'access-fresh', workspace: 'Acme' })
  })

  /**
   * The property: a connection that cannot be renewed **refuses** the poll rather than
   * quietly falling back to a personal API key that is still in the store.
   *
   * The fallback is the tempting behaviour — the key is right there and the poll would
   * succeed — and it is wrong twice. It hides a broken connection behind a working poll,
   * so nothing ever tells the operator to reconnect; and it silently changes who Linear
   * attributes activity to, which is the exact property the operator connected an
   * application in order to control.
   */
  test('a dead grant refuses the poll instead of falling back to a stored api key', async () => {
    const { row, config } = await source('dead-grant')
    const result = await pollSource(db, row, config, {
      secrets: async () => ({
        state: 'granted',
        apiKeyIgnored: true,
        grant: {
          clientId: 'client-1',
          access: sealSecret('access-stale'),
          refresh: sealSecret('refresh-revoked'),
          expiresAt: Date.now() - 60 * 60 * 1000,
          obtainedAt: 0,
          scopes: ['read'],
          actor: 'app',
        },
      }),
      grant: async () => ({
        state: 'refused',
        detail: 'the linear connection for "sources" could not be renewed: linear refused the grant',
      }),
      linear: () => {
        throw new Error('the poll must not authenticate with anything after a dead grant')
      },
    })

    assert.equal(result.outcome, 'refused')
    const [poll] = await pollsFor('dead-grant')
    assert.match(poll?.detail ?? '', /could not be renewed/)
  })

  /**
   * The property: an application registered but never connected gets its own refusal.
   *
   * Reported as `absent`, the message tells the operator to run `ogun secret set` —
   * sending somebody who has done most of the work of connecting an application back to
   * the credential they were migrating off. Principle 6 again: this remedy is a browser,
   * and no other state's sentence names one.
   */
  test('an application nobody finished connecting is refused with the connect command', async () => {
    const { row, config } = await source('halfway')
    const result = await pollSource(db, row, config, {
      secrets: async () => ({ state: 'unconnected', clientId: 'client-1' }),
      linear: () => {
        throw new Error('the client must not be built without a credential')
      },
    })

    assert.equal(result.outcome, 'refused')
    assert.match(result.detail ?? '', /nobody has finished the authorization/)
    assert.match(result.detail ?? '', /ogun linear connect --project sources/)
  })

  test('records a linear failure as failed, distinct from a local refusal', async () => {
    const { row, config } = await source('broken')
    const failing: LinearApi = {
      async issues() {
        throw new LinearUnavailable('auth', 'linear rejected the api key')
      },
    }
    const result = await pollSource(db, row, config, { secrets: withKey, linear: () => failing })

    assert.equal(result.outcome, 'failed')
    const [poll] = await pollsFor('broken')
    assert.equal(poll?.outcome, 'failed')
    assert.match(poll?.detail ?? '', /^auth: /)
  })

  test('refuses before spending a request when the cycle does not exist', async () => {
    /**
     * Ordering, and it is deliberate: a source pointed at a cycle that is gone can never
     * emit anything, and finding that out after a network round trip would report the
     * failure as whatever went wrong second.
     */
    const { row, config } = await source('orphan', { cycle: 'nothing-by-that-name' })
    const result = await pollSource(db, row, config, {
      secrets: async () => {
        throw new Error('the secret must not be fetched for a source that cannot emit')
      },
      linear: () => {
        throw new Error('unreachable')
      },
    })

    assert.equal(result.outcome, 'refused')
    assert.match(result.detail ?? '', /nothing-by-that-name/)
  })

  test('honours each source’s own cadence, and claims the poll before making it', async () => {
    /**
     * `lastPolledAt` is both the cursor the decision is read from and the record that it was
     * acted on, so advancing it conditionally on it still being what was read makes
     * deciding and claiming one statement. The interval in `main.ts` does not wait for its
     * callback and a poll takes as long as Linear takes, so two overlapping ticks reading
     * the same cursor is ordinary rather than exotic.
     */
    const { row } = await source('cadence', { pollMinutes: 10 })
    const noop = { secrets: withKey, linear: () => fixtureApi([{ tickets: [], next: undefined }]) }

    const at = (iso: string) => ({ ...noop, now: () => new Date(iso) })
    const first = await pollSources(db, at('2026-08-20T10:00:00Z'))
    assert.ok(first.some((r) => r.source === 'cadence'))

    const tooSoon = await pollSources(db, at('2026-08-20T10:05:00Z'))
    assert.equal(tooSoon.some((r) => r.source === 'cadence'), false)

    const later = await pollSources(db, at('2026-08-20T10:11:00Z'))
    assert.ok(later.some((r) => r.source === 'cadence'))

    const [current] = await db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.id, row.id))
    assert.equal(current?.lastPolledAt?.toISOString(), '2026-08-20T10:11:00.000Z')
  })

  test('two concurrent polls of the same backlog emit once between them', async () => {
    /**
     * The unique index is the claim, and this is the test that it is: the insert happens
     * before `startCycleRun`, so the racer that loses it does nothing at all rather than
     * creating a second run that nothing downstream could tell apart from the first.
     */
    const { row, config } = await source('racing')
    const contested = ticket()
    const [a, b] = await Promise.all([
      pollSource(db, row, config, deps([contested])),
      pollSource(db, row, config, deps([contested])),
    ])

    assert.equal(a.emitted.length + b.emitted.length, 1)
    const runs = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.trigger, 'source:racing'))
    assert.equal(runs.length, 1)
  })

  test('deleting a source from config.yaml does not re-emit its backlog', async () => {
    /**
     * Why the emission key is (project, ticket) rather than (source, ticket). A ticket is
     * one piece of work for one repository however Ogun came to notice it, so renaming or
     * removing a source — an ordinary tidy-up of a yaml file — must not hand its whole
     * backlog back to the next poll.
     */
    const { row, config } = await source('renamed')
    const known = ticket()
    await pollSource(db, row, config, deps([known]))

    await db.delete(schema.sources).where(eq(schema.sources.id, row.id))
    const { row: reborn, config: rebornConfig } = await source('renamed-again')
    const result = await pollSource(db, reborn, rebornConfig, deps([known]))

    assert.equal(result.admitted, 1)
    assert.equal(result.emitted.length, 0)

    // And the ledger survives its source, holding the name rather than a dangling id.
    const [orphaned] = (await emissions()).filter((e) => e.externalId === known.id)
    assert.equal(orphaned?.sourceId, null)
    assert.equal(orphaned?.sourceName, 'renamed')
  })
})

/**
 * The checks that happen where somebody is writing the config, rather than at 3am.
 *
 * Both failures here produce *silence*: a source that polls, admits tickets, and refuses
 * every emission. Neither raises an error anywhere a person would look.
 */
describe('syncing a sources: block', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']

  before(async () => {
    h = await startHarness()
    db = h.db
    await db.insert(schema.projects).values({ slug: 'sourcesync' })
  })

  after(async () => {
    await h.stop()
  })

  const worker = { skill: 's', runtime: 'claude', permissions: 'reviewer', sandbox: 'container' }
  const parsedWorkers = () => ({
    // Parsed through the real schema so this fixture cannot drift from what a config file
    // actually produces.
    evaluator: { ...worker, model: 'worker', onMissed: 'skip', enabled: true, timeoutMs: 1 },
  })

  const sync = (sources: Record<string, unknown>) =>
    reindexProject(db, 'sourcesync', {
      hash: 'h',
      workers: parsedWorkers() as never,
      cycles: {
        fanin: {
          nodes: [
            { key: 'a', worker: 'evaluator' },
            { key: 'b', worker: 'evaluator' },
          ],
          edges: [],
          onMissed: 'skip',
          enabled: true,
        },
      },
      sources: Object.fromEntries(
        Object.entries(sources).map(([name, s]) => [name, sourceSchema.parse(s)]),
      ),
    })

  test('refuses a source whose cycle does not exist', async () => {
    await assert.rejects(
      () =>
        sync({
          tickets: {
            kind: 'linear',
            cycle: 'no-such-cycle',
            team: 'ENG',
            filter: { status: ['Todo'] },
          },
        }),
      ConfigInvalid,
    )
  })

  test('refuses a source whose cycle has more than one entry node', async () => {
    /**
     * The ticket has to be handed to *a* node and there is no principled way to choose
     * between two. Picking the first in array order would be right most nights and wrong in
     * a way nobody could see — the ticket arriving at whichever reviewer happened to be
     * listed first, silently, forever.
     */
    await assert.rejects(
      () =>
        sync({
          tickets: { kind: 'linear', cycle: 'fanin', team: 'ENG', filter: { status: ['Todo'] } },
        }),
      (err: Error) => err instanceof ConfigInvalid && /exactly one/.test(err.message),
    )
  })

  test('accepts a source pointed straight at a worker, which is a one-node cycle', async () => {
    const result = await sync({
      tickets: { kind: 'linear', cycle: 'evaluator', team: 'ENG', filter: { status: ['Todo'] } },
    })
    assert.deepEqual(result.sources, [{ name: 'tickets', cycle: 'evaluator' }])
  })
})
