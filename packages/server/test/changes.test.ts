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
