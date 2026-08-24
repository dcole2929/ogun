import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { singleWorkerCycle } from '@ogun/core'
import { startHarness } from './harness.ts'
import { admit, modifiersOverCap, type ModifierJob } from '../src/foreman/admission.ts'
import { policiesByProject, projectPolicies } from '../src/foreman/policies.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * `.ogun/config.yaml` declared a `policies:` block, `policiesSchema` parsed it, the CLI
 * posted it — and `applySync` never read `body.policies`. There was no column to put it
 * in. `failureBreakerThreshold: 5` therefore meant three, from a constant, and
 * `maxConcurrentModifiers` meant nothing at all.
 *
 * These tests are about the whole path: what the file says has to be what the foreman
 * decides with, and the two keys the runner reads from git have to stay out of the
 * database.
 */
const worker = {
  skill: 'review',
  runtime: 'claude',
  model: 'worker',
  permissions: 'reviewer',
  sandbox: 'container',
  onMissed: 'skip',
  enabled: true,
  timeoutMs: 60_000,
}

describe('a project’s policies survive reaching the control plane', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `pol-${Date.now()}`

  const sync = (policies: Record<string, unknown>) =>
    h.fetch('/api/projects/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug,
        defaultBranch: 'main',
        configHash: `h-${JSON.stringify(policies)}`,
        workers: { nightly: worker },
        policies,
        skills: [],
      }),
    })

  const row = async () =>
    db.query.projects.findFirst({ where: eq(schema.projects.slug, slug) })

  before(async () => {
    h = await startHarness()
    db = h.db
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.slug, slug))
    await h.stop()
  })

  /**
   * The bug itself. Everything else here is about which value wins where; this is about
   * the value arriving at all.
   */
  test('what the config asks for is what the row holds', async () => {
    assert.equal(
      (await sync({ failureBreakerThreshold: 5, maxConcurrentModifiers: 2 })).status,
      200,
    )
    const project = await row()
    assert.deepEqual(project?.policies, {
      failureBreakerThreshold: 5,
      maxConcurrentModifiers: 2,
    })
  })

  /**
   * The half the runner owns must not acquire a second home.
   *
   * `allowSandboxDowngrade` and `maxOpenPullRequests` are gates on what an agent's own
   * work may become, and they are read from the git blob at the pinned base precisely
   * because a modifier can write to its checkout (ADR-0009, §4.6). A copy in postgres
   * would be a second answer to that question sitting where a future caller will look
   * first — and it would look exactly as authoritative as the real one while having been
   * posted by whoever ran `ogun project sync`.
   *
   * A naive implementation stores `body.policies` whole. It typechecks, because `Policies`
   * is structurally assignable to the narrower type, and jsonb stores whatever it is
   * handed. So the payload here deliberately carries both, the way an older CLI would.
   */
  test('a sync carrying pinned-blob policies does not store them', async () => {
    await sync({
      failureBreakerThreshold: 4,
      maxConcurrentModifiers: 1,
      maxOpenPullRequests: 999,
      allowSandboxDowngrade: true,
      directPush: true,
    })
    const stored = (await row())?.policies as Record<string, unknown>
    assert.deepEqual(Object.keys(stored).sort(), [
      'failureBreakerThreshold',
      'maxConcurrentModifiers',
    ])
    // Said twice on purpose: `deepEqual` on keys would still pass if a later refactor
    // renamed the column, and these two are the ones that must never be readable here.
    assert.equal(Object.hasOwn(stored, 'maxOpenPullRequests'), false)
    assert.equal(Object.hasOwn(stored, 'allowSandboxDowngrade'), false)
  })

  /**
   * Deleting a policy line has to take effect. The skills upsert already spells out why
   * this row is written wholesale — it is an index of a file, and a stale half of it is
   * worse than none — and policies are no different: a config that dropped
   * `failureBreakerThreshold: 5` is asking for the default back.
   */
  test('a policy removed from the file returns to the default, not its last value', async () => {
    await sync({ failureBreakerThreshold: 5 })
    await sync({})
    assert.equal((await row())?.policies?.failureBreakerThreshold, 3)
  })

  /**
   * Principle 6, applied to a column: "we read a config that wants the defaults" and "we
   * have never read a config" are two facts and must not share a representation. A naive
   * implementation defaults the column to `{...}` in the migration, at which point every
   * project ever registered claims to have declared the defaults and there is no way left
   * to tell which ones have actually synced.
   */
  test('never synced and synced-to-the-defaults are different facts', async () => {
    const [legacy] = await db
      .insert(schema.projects)
      .values({ slug: `${slug}-legacy` })
      .returning()
    try {
      const never = await projectPolicies(db, legacy!.id)
      assert.equal(never.source, 'unsynced')
      assert.equal(never.policies.failureBreakerThreshold, 3)

      await sync({ failureBreakerThreshold: 3, maxConcurrentModifiers: 1 })
      const declared = await projectPolicies(db, (await row())!.id)
      assert.equal(declared.source, 'project')
      // Identical numbers. Only `source` can tell them apart, which is the point.
      assert.deepEqual(declared.policies, never.policies)
    } finally {
      await db.delete(schema.projects).where(eq(schema.projects.id, legacy!.id))
    }
  })

  test('policiesByProject answers for every id it was asked about', async () => {
    const project = (await row())!
    const map = await policiesByProject(db, [project.id, '00000000-0000-0000-0000-000000000000'])
    // Including the one with no row. A caller that has to check for both `undefined` and
    // `unsynced` has two spellings of the same absence and will handle one of them.
    assert.equal(map.get(project.id)?.source, 'project')
    assert.equal(map.get('00000000-0000-0000-0000-000000000000')?.source, 'unsynced')
  })
})

/**
 * The breaker threshold, end to end.
 *
 * The property protected: the number of consecutive failures that opens a worker's
 * breaker is the number in that project's `config.yaml`. What a naive implementation gets
 * wrong is reading it from `DEFAULT_LIMITS` — which is what shipped, and which meant a
 * project that had deliberately raised the threshold to 5 was cut off after 3 with every
 * command reporting exactly what it had been asked to do.
 */
describe('the failure breaker counts to what the project asked for', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `breaker-${Date.now()}`
  let projectId = ''
  let workerId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db
      .insert(schema.projects)
      .values({
        slug,
        // Five, not three: a threshold no constant in the tree happens to equal, so a
        // test that passes cannot be passing because the default agreed with it.
        policies: { failureBreakerThreshold: 5, maxConcurrentModifiers: 1 },
      })
      .returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'reviewer',
        skillRef: 'review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'reviewer', definition: singleWorkerCycle('reviewer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const failOnce = async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    if (job?.state === 'skipped') return 'skipped' as const
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, {
      runId: run!.id,
      outcome: 'error',
      detail: 'agent exited 1',
      gates: [],
      coverage: { outcome: 'errored' },
      artifacts: [],
    })
    return 'ran' as const
  }

  const breaker = async () =>
    db.query.breakers.findFirst({ where: eq(schema.breakers.workerId, workerId) })

  test('three failures do not open a breaker set to five', async () => {
    for (let i = 0; i < 3; i++) assert.equal(await failOnce(), 'ran')
    const b = await breaker()
    assert.equal(b?.consecutiveFailures, 3)
    assert.equal(b?.openedAt, null, 'the constant said three; the project said five')
  })

  test('the fifth does', async () => {
    assert.equal(await failOnce(), 'ran')
    assert.equal((await breaker())?.openedAt, null, 'four is still under five')
    assert.equal(await failOnce(), 'ran')
    assert.notEqual((await breaker())?.openedAt, null)
    // And the gate it feeds actually holds: the next run never leaves admission.
    assert.equal(await failOnce(), 'skipped')
  })
})

/**
 * The static half of the modifier cap: zero.
 *
 * A cap of zero is not a fact about this minute — it is the project saying no modifier
 * runs here at all, and it cannot become false while the queue drains. So it is answered
 * at admission, where the refusal writes a `skipped` job and a `refused` coverage row and
 * a person reading Coverage is told which line to edit. A naive implementation leaves it
 * to the claim, where a zero cap means the job sits `queued` for ever with nothing
 * recorded anywhere — the silent stall principle 6 exists to prevent.
 */
describe('a modifier cap of zero refuses at admission, with a sentence', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `nomods-${Date.now()}`
  let projectId = ''
  let workerId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'fixer',
        skillRef: 'fix',
        runtime: 'claude',
        versionHash: 'v1',
        permissions: 'modifier',
        config: {},
      })
      .returning()
    workerId = w!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  test('the refusal names the policy rather than the project’s setup', async () => {
    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier' },
      { maxConcurrentModifiers: 0, failureBreakerThreshold: 3 },
      // Ready in every other respect. The point is which of several true refusals is the
      // one a person is handed: told about a missing Dockerfile, they write one and the
      // worker still does not run.
      { ready: true },
    )
    assert.equal(verdict.allowed, false)
    assert.match(verdict.allowed === false ? verdict.reason : '', /maxConcurrentModifiers: 0/)
  })

  test('a cap of one lets the same worker through', async () => {
    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier' },
      { maxConcurrentModifiers: 1, failureBreakerThreshold: 3 },
      { ready: true },
    )
    assert.equal(verdict.allowed, true)
  })

  test('the cap says nothing about a reviewer', async () => {
    const [r] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'reader',
        skillRef: 'review',
        runtime: 'claude',
        versionHash: 'v1',
        permissions: 'reviewer',
        config: {},
      })
      .returning()
    // A modifier cap that quietly stopped reviewers would be a project switching off its
    // own nightly review by tightening an unrelated policy.
    const verdict = await admit(
      db,
      { id: r!.id, permissions: 'reviewer' },
      { maxConcurrentModifiers: 0, failureBreakerThreshold: 3 },
    )
    assert.equal(verdict.allowed, true)
  })
})

/**
 * The dynamic half, through the endpoint that actually decides it.
 *
 * `modifiersOverCap` is arithmetic and is tested as arithmetic below; this is the wiring,
 * which is the part that was missing rather than wrong — the cap existed in the schema and
 * nothing anywhere consulted it. It is asserted at `/api/jobs/claim` rather than at
 * admission because that is the difference this design turns on: a job over the cap stays
 * `queued` and is picked up later, where an admission refusal would have written it off as
 * `skipped` for the night.
 */
describe('the claim hands out no more modifiers than a project allows', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const stamp = Date.now()
  const projects: Record<string, { id: string; cycleId: string }> = {}

  const setUp = async (slug: string, cap: number) => {
    const [p] = await db
      .insert(schema.projects)
      .values({ slug, policies: { maxConcurrentModifiers: cap, failureBreakerThreshold: 3 } })
      .returning()
    await db.insert(schema.workers).values({
      projectId: p!.id,
      name: 'fixer',
      skillRef: 'fix',
      runtime: 'claude',
      versionHash: 'v1',
      permissions: 'modifier',
      sandbox: 'worktree',
      config: {},
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId: p!.id, name: 'fixer', definition: singleWorkerCycle('fixer') })
      .returning()
    projects[slug] = { id: p!.id, cycleId: c!.id }
  }

  const queue = async (slug: string) => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId: projects[slug]!.cycleId,
      trigger: 'test',
      // The seam `startCycleRun` documents: readiness is a disk probe, and a test that
      // lays out a Dockerfile to assert a concurrency rule is a test about filesystems.
      modifierReadiness: { ready: true },
    })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    assert.equal(job?.state, 'queued', 'the fixture job must be claimable')
    return job!.id
  }

  const claim = async (capacity: number) => {
    const res = await h.fetch('/api/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runnerName: `r-${stamp}`, labels: ['claude'], capacity }),
    })
    assert.equal(res.status, 200)
    return ((await res.json()) as { jobs: Array<{ jobId: string; projectSlug: string }> }).jobs
  }

  before(async () => {
    h = await startHarness()
    db = h.db
    await db.insert(schema.runners).values({
      name: `r-${stamp}`,
      labels: ['claude'],
      maxConcurrency: 5,
      enrolledAt: new Date(),
    })
    await setUp(`capA-${stamp}`, 1)
    await setUp(`capB-${stamp}`, 1)
  })

  after(async () => {
    for (const p of Object.values(projects)) {
      await db.delete(schema.projects).where(eq(schema.projects.id, p.id))
    }
    await db.delete(schema.runners).where(eq(schema.runners.name, `r-${stamp}`))
    await h.stop()
  })

  test('two queued modifiers for one project yield one claim, not two', async () => {
    await queue(`capA-${stamp}`)
    await queue(`capA-${stamp}`)
    const claimed = await claim(5)
    assert.equal(claimed.length, 1, 'the second is over the project cap and waits its turn')
    assert.equal(claimed[0]?.projectSlug, `capA-${stamp}`)
  })

  test('the one held back is still queued — held, not refused', async () => {
    const waiting = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.projectId, projects[`capA-${stamp}`]!.id))
    // The distinction the whole placement rests on. `skipped` here would mean tonight's
    // second modifier was thrown away because tonight's first was still running.
    assert.deepEqual(waiting.map((j) => j.state).sort(), ['claimed', 'queued'])
  })

  test('a different project is not throttled by the busy one', async () => {
    await queue(`capB-${stamp}`)
    const claimed = await claim(5)
    // The naive implementation counts modifiers globally, which is the machine cap wearing
    // a project policy's name: B is idle and waits because A is busy, for a reason neither
    // project's config.yaml mentions.
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0]?.projectSlug, `capB-${stamp}`)
  })
})

/**
 * `maxConcurrentModifiers` had no consumer anywhere — the only cap a modifier ever met
 * was `maxConcurrentJobs`, which is the machine's. A project asking for one modifier at a
 * time got as many as this box could carry, and two projects would have shared that one
 * counter.
 *
 * The arithmetic is tested directly rather than through two projects, a runner and a
 * queue: the interesting cases are a full project beside an empty one, a cap of zero, and
 * which job gets held back — and a test that stands up fixtures to assert arithmetic is a
 * test about fixtures.
 */
describe('the modifier cap is per project', () => {
  const at = (ms: number) => new Date(1_700_000_000_000 + ms)
  const job = (over: Partial<ModifierJob> & { id: string; projectId: string }): ModifierJob => ({
    inFlight: false,
    priority: 0,
    createdAt: at(0),
    ...over,
  })

  test('a project at its cap holds back its own queue and nobody else’s', () => {
    const held = modifiersOverCap(
      [
        job({ id: 'a-running', projectId: 'A', inFlight: true }),
        job({ id: 'a-queued', projectId: 'A', createdAt: at(1) }),
        job({ id: 'b-queued', projectId: 'B', createdAt: at(2) }),
      ],
      () => 1,
    )
    // The naive implementation counts modifiers globally, which is the machine cap wearing
    // a project policy's name: B is idle and gets throttled because A is busy, for a
    // reason neither project's config.yaml mentions.
    assert.deepEqual(held, ['a-queued'])
  })

  test('each project gets its own cap, not the smallest one in the queue', () => {
    const caps: Record<string, number> = { A: 2, B: 1 }
    const held = modifiersOverCap(
      [
        job({ id: 'a1', projectId: 'A', createdAt: at(1) }),
        job({ id: 'a2', projectId: 'A', createdAt: at(2) }),
        job({ id: 'b1', projectId: 'B', createdAt: at(3) }),
        job({ id: 'b2', projectId: 'B', createdAt: at(4) }),
      ],
      (p) => caps[p] ?? 1,
    )
    assert.deepEqual(held, ['b2'])
  })

  test('the ones held back are the ones the claim would have reached last', () => {
    // Ordered the way the claim orders — priority first, then age. Holding back a
    // high-priority job to leave room for one the claim then does not take wastes the
    // slot and reorders the queue for no reason anybody asked for.
    const held = modifiersOverCap(
      [
        job({ id: 'old-low', projectId: 'A', priority: 0, createdAt: at(1) }),
        job({ id: 'new-high', projectId: 'A', priority: 5, createdAt: at(9) }),
        job({ id: 'old-high', projectId: 'A', priority: 5, createdAt: at(2) }),
      ],
      () => 2,
    )
    assert.deepEqual(held, ['old-low'])
  })

  test('a cap of zero holds back everything queued', () => {
    // Belt and braces. `admit` refuses a modifier outright when the cap is zero, so
    // nothing should reach the queue — but a job queued before the policy changed will,
    // and "nothing may run" must not be reachable as "no limit".
    const held = modifiersOverCap([job({ id: 'a1', projectId: 'A' })], () => 0)
    assert.deepEqual(held, ['a1'])
  })

  test('room already spent by running jobs is not offered twice', () => {
    const held = modifiersOverCap(
      [
        job({ id: 'r1', projectId: 'A', inFlight: true }),
        job({ id: 'r2', projectId: 'A', inFlight: true }),
        job({ id: 'q1', projectId: 'A', createdAt: at(1) }),
      ],
      () => 2,
    )
    assert.deepEqual(held, ['q1'])
  })

  test('a project under its cap holds nothing back', () => {
    assert.deepEqual(modifiersOverCap([job({ id: 'q1', projectId: 'A' })], () => 1), [])
  })
})
