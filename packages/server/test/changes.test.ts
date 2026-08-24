import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { singleWorkerCycle, type RunReport } from '@ogun/core'
import { startHarness } from './harness.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * What the control plane records when a modifier run ends (§4.4).
 *
 * The `changes` row is an artifact record, not a work queue — which is the distinction
 * every test here is about. A row exists for a run that changed nothing and for a run
 * whose gate rejected the work, and a publisher that read "there is a row" as "open a
 * pull request" would publish both.
 */
describe('a modifier run is recorded', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `changes-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'fixer',
      skillRef: 'fix-the-thing',
      runtime: 'claude',
      versionHash: 'v1',
      config: { permissions: 'modifier' },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'fixer', definition: singleWorkerCycle('fixer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const runOnce = async (report: Omit<RunReport, 'runId'>) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, { ...report, runId: run!.id })
    const rows = await db.select().from(schema.changes).where(eq(schema.changes.runId, run!.id))
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    return { runId: run!.id, result, rows, cov, report: { ...report, runId: run!.id } }
  }

  const withPatch = {
    outcome: 'dispatched',
    gates: [],
    change: { baseSha: 'a'.repeat(40), filesChanged: 3, patchRef: '/scratch/patches/r/changes.patch' },
    coverage: { outcome: 'changed' },
    artifacts: [{ kind: 'patch', ref: '/scratch/patches/r/changes.patch', bytes: 4096 }],
  } satisfies Omit<RunReport, 'runId'>

  test('a patch becomes a change row, an artifact, and a dispatched run', async () => {
    const r = await runOnce(withPatch)

    assert.equal(r.result.outcome, 'dispatched')
    assert.equal(r.result.jobState, 'succeeded')
    assert.equal(r.rows.length, 1)
    assert.equal(r.rows[0]?.filesChanged, 3)
    assert.equal(r.rows[0]?.baseSha, 'a'.repeat(40))
    // The pointer, never the patch itself — blobs live on disk (§4.4).
    assert.equal(r.rows[0]?.patchRef, '/scratch/patches/r/changes.patch')
    // Host-side columns, and they stay empty until something host-side fills them: the
    // runner cannot know either, because neither exists until after the container exits.
    assert.equal(r.rows[0]?.branch, null)
    assert.equal(r.rows[0]?.prUrl, null)
    // `clean` would say the night produced nothing, and a modifier reports no findings at
    // all — so without its own value the ledger cannot tell the two nights apart.
    assert.equal(r.cov?.outcome, 'changed')
  })

  test('a modifier that changed nothing says so, rather than leaving no record', async () => {
    const r = await runOnce({
      outcome: 'approved',
      gates: [],
      change: { baseSha: 'b'.repeat(40), filesChanged: 0 },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })

    assert.equal(r.result.outcome, 'approved')
    assert.equal(r.rows.length, 1, 'a run that read the code and left it alone still ran')
    assert.equal(r.rows[0]?.filesChanged, 0)
    assert.equal(r.rows[0]?.patchRef, null)
    assert.equal(r.cov?.outcome, 'clean')
  })

  /**
   * The gate decides, and for a modifier that is the sharper end of the same rule the
   * findings path already follows. `dispatched` means "there is a patch ready to
   * publish"; the modifier gate that runs the project's test suite (§9) has just said it
   * is not. Leaving the run `dispatched` would hand the publisher work the
   * gate rejected — with tests red.
   */
  test('a failed gate withdraws the claim that a patch is ready', async () => {
    const r = await runOnce({
      ...withPatch,
      gates: [{ name: 'tests', method: 'tool', passed: false, detail: '2 failing' }],
      change: { ...withPatch.change, testsRun: true, testsPassed: false },
    })

    assert.equal(r.result.outcome, 'changes-requested')
    assert.equal(r.result.jobState, 'failed')
    // `gate-failed`, and none of the three neighbours it could be confused with:
    // `errored` is a run that broke, `refused` is a run that never happened, and
    // `changed` is a patch waiting to be published (principle 6).
    assert.equal(r.cov?.outcome, 'gate-failed')
    // Recorded anyway: the patch exists on disk and a person debugging the failure needs
    // to be able to read it. What the gate withdraws is readiness, not the artefact.
    assert.equal(r.rows.length, 1)
    // And the row says which of the two it was — the suite ran, and it was red.
    assert.equal(r.rows[0]?.testsRun, true)
    assert.equal(r.rows[0]?.testsPassed, false)
  })

  /**
   * The two columns §9 asked for, which existed on this table with nothing writing them.
   * A publisher selecting work has to be able to read "the suite ran and passed" off the
   * change rather than re-deriving it from a list of gate names.
   */
  test('a proved patch records that its suite ran and was green', async () => {
    const r = await runOnce({
      ...withPatch,
      gates: [
        { name: 'tests', method: 'tool', passed: true, detail: '`pnpm -s test` passed in 41s' },
      ],
      change: { ...withPatch.change, testsRun: true, testsPassed: true },
    })

    assert.equal(r.result.outcome, 'dispatched')
    assert.equal(r.rows[0]?.testsRun, true)
    assert.equal(r.rows[0]?.testsPassed, true)
  })

  /**
   * Null is not false. A run recorded before this gate existed says nothing about tests,
   * and a publisher reading that silence as "did not pass" would be refusing on the
   * absence of evidence — right by accident, and wrong the moment the column is used for
   * anything else.
   */
  test('a run that reported no test outcome leaves the columns unsaid', async () => {
    const r = await runOnce(withPatch)
    assert.equal(r.rows[0]?.testsRun, null)
    assert.equal(r.rows[0]?.testsPassed, null)
  })

  /**
   * The retry loop's ledger (§5.2, principle 6).
   *
   * `gates` carries only the *final* round's verdict — it has to, because the derivation
   * below reads any failed gate as the gate's answer, so folding a rejected first round in
   * would turn a run that recovered into `changes-requested`. That leaves nothing in the
   * report able to say a run needed two attempts, which is why the count is its own
   * column and is copied rather than derived.
   */
  test('a run that took two rounds is not the same row as one that took one', async () => {
    const retried = await runOnce({ ...withPatch, rounds: 2 })
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, retried.runId))
    assert.equal(row?.rounds, 2)
    // And it is still a clean run: the retry succeeded, so no gate failed.
    assert.equal(retried.result.outcome, 'dispatched')
  })

  /**
   * Null, not one. A runner that predates the retry loop reports no count, and filling it
   * in would be the control plane inventing evidence about a night nobody measured — the
   * same distinction `tests_passed` makes one test above.
   */
  test('a run that reported no round count leaves it null', async () => {
    const r = await runOnce(withPatch)
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, r.runId))
    assert.equal(row?.rounds, null)
  })

  /**
   * Two callers race for every run — the runner reporting and the stale-claim sweep — and
   * the loser applies nothing. `changes` has no unique key on `run_id`, so an insert
   * outside the claim would double-count a modifier's night in every query that goes near
   * this table, with nothing to tell the copies apart.
   */
  test('a report that lost the race adds no second change row', async () => {
    const r = await runOnce(withPatch)
    const second = await finalizeRun(db, r.report)

    assert.equal(second.alreadyFinalized, true)
    const rows = await db.select().from(schema.changes).where(eq(schema.changes.runId, r.runId))
    assert.equal(rows.length, 1)
  })
})


/**
 * The publisher's write-back: the two columns that have been on `changes` since it was
 * created with nothing writing them (§9).
 *
 * A second call rather than two more fields on the report, because the report is sent
 * *first* on purpose (ADR-0009) — the pull request does not exist yet when it goes. Which
 * means this endpoint receives a claim from a runner about something the control plane
 * cannot see, and the tests here are about what it refuses to take on trust.
 */
describe('a published patch fills in its branch and pull request', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `published-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'fixer',
      skillRef: 'fix-the-thing',
      runtime: 'claude',
      versionHash: 'v1',
      config: { permissions: 'modifier' },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'fixer', definition: singleWorkerCycle('fixer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const send = (path: string, body: unknown) =>
    h.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const finish = async (report: Omit<RunReport, 'runId'>): Promise<string> => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, { ...report, runId: run!.id })
    return run!.id
  }

  const dispatched = {
    outcome: 'dispatched',
    gates: [{ name: 'tests', method: 'tool', passed: true }],
    change: {
      baseSha: 'c'.repeat(40),
      filesChanged: 2,
      patchRef: '/scratch/patches/r/changes.patch',
      testsRun: true,
      testsPassed: true,
    },
    coverage: { outcome: 'changed' },
    artifacts: [],
  } satisfies Omit<RunReport, 'runId'>

  test('the branch and pull request land on the run\'s existing change row', async () => {
    const runId = await finish(dispatched)
    const res = await send(`/api/runs/${runId}/published`, {
      branch: 'ogun/fixer/9f3c2a104b5e',
      prUrl: 'https://github.com/o/r/pull/7',
    })
    assert.equal(res.status, 200)

    const [row] = await db.select().from(schema.changes).where(eq(schema.changes.runId, runId))
    assert.equal(row?.branch, 'ogun/fixer/9f3c2a104b5e')
    assert.equal(row?.prUrl, 'https://github.com/o/r/pull/7')
    // Still one row. This fills a record in; it does not add a second account of the night.
    const all = await db.select().from(schema.changes).where(eq(schema.changes.runId, runId))
    assert.equal(all.length, 1)
    assert.equal(all[0]?.patchRef, '/scratch/patches/r/changes.patch')
  })

  /**
   * The gate the runner cannot be the judge of. `finalizeRun` derives a `dispatched` with
   * a failed gate down to `changes-requested`, and a runner announcing a pull request for
   * such a run is either confused or lying. Either way the row must not say the work was
   * published — that row is what the run page shows and what any later query for "what did
   * this factory ship" reads.
   */
  test('a run the gate rejected cannot be reported as published', async () => {
    const runId = await finish({
      ...dispatched,
      gates: [{ name: 'tests', method: 'tool', passed: false, detail: '2 failing' }],
      change: { ...dispatched.change, testsPassed: false },
    })
    const res = await send(`/api/runs/${runId}/published`, {
      branch: 'ogun/fixer/deadbeef',
      prUrl: 'https://github.com/o/r/pull/8',
    })
    assert.equal(res.status, 409)

    const [row] = await db.select().from(schema.changes).where(eq(schema.changes.runId, runId))
    assert.equal(row?.branch, null)
    assert.equal(row?.prUrl, null)
  })

  /**
   * Publishing twice means something upstream went wrong, and the first pull request is
   * the one already linked from the run page. Overwriting it would leave that one open
   * with nothing in the database pointing at it — the exact orphan the report-first
   * ordering exists to avoid, arriving by another door.
   */
  test('a second publication does not overwrite the first', async () => {
    const runId = await finish(dispatched)
    await send(`/api/runs/${runId}/published`, {
      branch: 'ogun/fixer/first',
      prUrl: 'https://github.com/o/r/pull/9',
    })
    const res = await send(`/api/runs/${runId}/published`, {
      branch: 'ogun/fixer/second',
      prUrl: 'https://github.com/o/r/pull/10',
    })
    assert.equal(res.status, 409)

    const [row] = await db.select().from(schema.changes).where(eq(schema.changes.runId, runId))
    assert.equal(row?.branch, 'ogun/fixer/first')
    assert.equal(row?.prUrl, 'https://github.com/o/r/pull/9')
  })

  /** A reviewer has no change row, so there is nothing a publication could describe. */
  test('a run with no change row is a 404, not a new row', async () => {
    const runId = await finish({
      outcome: 'dispatched',
      gates: [],
      coverage: { outcome: 'changed' },
      artifacts: [],
    })
    const res = await send(`/api/runs/${runId}/published`, {
      branch: 'ogun/fixer/nothing',
      prUrl: 'https://github.com/o/r/pull/11',
    })
    assert.equal(res.status, 404)
    const rows = await db.select().from(schema.changes).where(eq(schema.changes.runId, runId))
    assert.equal(rows.length, 0)
  })
})

/**
 * Admission, for the profile that has a prerequisite no other profile has (§4.3).
 *
 * A modifier is the only worker whose output nobody can check by reading it, so the
 * project has to supply the means: an image with its toolchain in it, and a command that
 * runs its suite. Missing either, the job is refused before it is queued — not run and
 * failed afterwards, and not run and published unproved.
 */
describe('a modifier is not dispatched into a project that cannot verify it', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `admit-modifier-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    await db.insert(schema.workers).values({
      projectId,
      name: 'fixer',
      skillRef: 'fix-the-thing',
      runtime: 'claude',
      versionHash: 'v1',
      // The column, not the config blob: this is what the claim route hands the runner,
      // and therefore what admission has to read.
      permissions: 'modifier',
      config: { permissions: 'modifier' },
    })
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'fixer', definition: singleWorkerCycle('fixer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const start = async (
    modifierReadiness?: Parameters<typeof startCycleRun>[1]['modifierReadiness'],
  ) => {
    const { cycleRunId } = await startCycleRun(db, {
      cycleId,
      trigger: 'test',
      ...(modifierReadiness ? { modifierReadiness } : {}),
    })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    return { job, cov }
  }

  test('a project with no image and no test command gets a refusal, not a run', async () => {
    const { job, cov } = await start({
      ready: false,
      reason: `${slug} has no .ogun/Dockerfile, so a modifier would run in ogun/base`,
    })

    assert.equal(job?.state, 'skipped', 'a refused job is never queued')
    // `refused`, not `errored` and not `gate-failed`: nothing ran and nothing failed. The
    // project has not said how a patch of its own code would be checked, and that is a
    // different fact from a patch that was checked and found wanting (principle 6).
    assert.equal(cov?.outcome, 'refused')
    assert.equal(cov?.ran, false)
    assert.match(cov?.reason ?? '', /no \.ogun\/Dockerfile/)
  })

  /**
   * The default path, with nothing injected: this control plane has no local checkout for
   * a slug invented by a test, so it cannot confirm either requirement. "I could not
   * check" must refuse — reading it as "fine" is the one mistake that ends with an
   * unverifiable modifier running unattended.
   */
  test('a project this control plane cannot see is refused rather than assumed ready', async () => {
    const { job, cov } = await start()

    assert.equal(job?.state, 'skipped')
    assert.equal(cov?.outcome, 'refused')
    assert.match(cov?.reason ?? '', /no local path/)
  })

  test('a project that can build and test its own code admits the job', async () => {
    const { job, cov } = await start({ ready: true })

    assert.equal(job?.state, 'queued')
    assert.equal(cov?.outcome, 'pending')
  })
})
