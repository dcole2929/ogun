import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { cycleConfigSchema, expandCycle } from '@ogun/core'
import { startHarness } from './harness.ts'
import { startCycleRun, releaseDependents } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * Fan-in (§4.12): N reviewers stage, one triage node publishes.
 *
 * The property under test is not "the DAG executes" — it is that a reviewer feeding
 * triage writes *nothing* to the inbox. Get that wrong and the inbox shows the raw
 * findings alongside the consolidated ones, which is worse than not running triage.
 */
describe('triage fan-in', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `fanin-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  const workerIds = new Map<string, string>()

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id

    for (const name of ['reviewer-a', 'reviewer-b', 'triage']) {
      const [w] = await db
        .insert(schema.workers)
        .values({
          projectId,
          name,
          skillRef: name === 'triage' ? 'triage' : 'adversarial-review',
          runtime: 'claude',
          versionHash: 'v1',
          config: {},
        })
        .returning()
      workerIds.set(name, w!.id)
    }

    const definition = expandCycle(
      cycleConfigSchema.parse({ workers: ['reviewer-a', 'reviewer-b'], then: 'triage' }),
    )
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'nightly', definition })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const finish = async (
    cycleRunId: string,
    nodeKey: string,
    findings: unknown[],
    notes?: string,
  ) => {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, nodeKey)))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: { findings: findings as never, ...(notes ? { notes } : {}) },
      coverage: { outcome: findings.length > 0 ? 'found' : 'clean' },
      artifacts: [],
    })
    await releaseDependents(db, cycleRunId)
    return { job: job!, run: run!, result }
  }

  const finding = (fingerprint: string, path: string) => ({
    fingerprint,
    title: `problem at ${path}`,
    body: 'detail',
    severity: 'high' as const,
    citations: [{ path, line: 1 }],
  })

  test('reviewers stage but do not publish; triage publishes', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })

    // Triage must not be runnable before its dependencies are done — otherwise it would
    // triage an empty input and report a clean night.
    const [triageJob] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))
    assert.equal(triageJob?.state, 'blocked')

    const a = await finish(cycleRunId, 'reviewer-a', [finding('api/auth/isolation/swap', 'src/a.ts')])
    const b = await finish(cycleRunId, 'reviewer-b', [finding('api/auth/isolation/swap', 'src/a.ts')])

    assert.equal(a.result.findingsWritten, 0, 'a reviewer feeding triage must not reach the inbox')
    assert.equal(a.result.staged, 1)
    assert.equal(b.result.staged, 1)

    const inbox = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(inbox.length, 0, 'nothing is visible until triage has run')

    // Coverage still reflects what each reviewer found, not what was promoted.
    const cov = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    const reviewerCoverage = cov.filter((r) => r.workerId !== workerIds.get('triage'))
    assert.equal(reviewerCoverage.length, 2)
    for (const row of reviewerCoverage) {
      assert.equal(row.outcome, 'found')
      assert.equal(row.findingCount, 1, 'the reviewer found something; the ledger should say so')
    }

    const [released] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))
    assert.equal(released?.state, 'queued', 'triage runs once every dependency is done')

    const t = await finish(cycleRunId, 'triage', [finding('api/auth/isolation/swap', 'src/a.ts')])
    assert.equal(t.result.findingsWritten, 1)

    const after = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(after.length, 1, 'two reviewers, one invariant, one inbox item')
  })

  test('triage reads what upstream staged, including the reviewer that found nothing', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await finish(cycleRunId, 'reviewer-a', [finding('db/tx/atomicity/partial', 'src/db.ts')])
    await finish(cycleRunId, 'reviewer-b', [])

    const [triageJob] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))

    const res = await h.fetch(`/api/jobs/${triageJob!.id}/inputs`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      degraded: boolean
      sources: { worker: string; ran: boolean; findings: unknown[] }[]
    }

    assert.equal(body.sources.length, 2)
    assert.equal(body.degraded, false)
    const empty = body.sources.find((s) => s.worker === 'reviewer-b')
    assert.equal(empty?.ran, true, '"ran and found nothing" is a result triage needs')
    assert.equal(empty?.findings.length, 0)
    const found = body.sources.find((s) => s.worker === 'reviewer-a')
    assert.equal(found?.findings.length, 1)
  })

  test('a standalone reviewer still publishes directly', async () => {
    const [solo] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'just-a',
        definition: { nodes: [{ key: 'reviewer-a', worker: 'reviewer-a' }], edges: [] },
      })
      .returning()

    const { cycleRunId } = await startCycleRun(db, { cycleId: solo!.id, trigger: 'test' })
    const r = await finish(cycleRunId, 'reviewer-a', [finding('cli/args/parsing/quote', 'src/cli.ts')])
    assert.equal(
      r.result.findingsWritten,
      1,
      'membership in a fan-in cycle is what stages a run, not a property of the worker',
    )
  })

  /** Finish a node as a crash rather than a review — the case the edge policy is for. */
  const crash = async (cycleRunId: string, nodeKey: string, detail: string) => {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, nodeKey)))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, {
      runId: run!.id,
      outcome: 'error',
      detail,
      gates: [],
      coverage: { outcome: 'errored', reason: detail },
      artifacts: [],
    })
    await releaseDependents(db, cycleRunId)
    return { job: job!, run: run! }
  }

  const jobState = async (cycleRunId: string, nodeKey: string): Promise<string> => {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, nodeKey)))
    return job!.state
  }

  /**
   * `degrade` is the whole reason the nightly cycle is written the way it is: one
   * crashed reviewer must not bury the other's findings. It ran in production before it
   * ran in a test, which is the wrong order for the branch that decides whether a
   * night's work reaches anybody.
   */
  test('degrade: a failed dependency still releases triage, and says so', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await finish(cycleRunId, 'reviewer-a', [finding('auth/session/fixation/reuse', 'src/auth.ts')])
    await crash(cycleRunId, 'reviewer-b', 'codex exited 1: model not supported')

    assert.equal(
      await jobState(cycleRunId, 'triage'),
      'queued',
      'triage must run on a partial night rather than be buried with the crash',
    )

    const [triageJob] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'triage')))
    const body = (await (await h.fetch(`/api/jobs/${triageJob!.id}/inputs`)).json()) as {
      degraded: boolean
      sources: { worker: string; ran: boolean; outcome: string; detail: string | null }[]
    }

    assert.equal(body.degraded, true, 'a night missing a reviewer is not a clean night')
    const dead = body.sources.find((s) => s.worker === 'reviewer-b')
    assert.equal(dead?.ran, false, 'a crash is not a result')
    assert.match(dead?.detail ?? '', /model not supported/, 'triage names what did not run')

    // The surviving reviewer's work is intact and still staged, not published raw.
    const survivor = body.sources.find((s) => s.worker === 'reviewer-a')
    assert.equal(survivor?.outcome, 'approved')
  })

  /**
   * `block` is the other half of the same switch, and it has to skip rather than hang:
   * a dependent left `blocked` forever would keep the cycle run open and never reach a
   * terminal state.
   */
  test('block: a failed dependency skips the dependent and records why', async () => {
    const definition = expandCycle(
      cycleConfigSchema.parse({
        workers: ['reviewer-a'],
        then: 'triage',
        onDepFailure: 'block',
      }),
    )
    const [strict] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'strict-nightly', definition })
      .returning()

    const { cycleRunId } = await startCycleRun(db, { cycleId: strict!.id, trigger: 'test' })
    await crash(cycleRunId, 'reviewer-a', 'sandbox failed to provision')

    assert.equal(await jobState(cycleRunId, 'triage'), 'skipped')

    const [row] = await db
      .select()
      .from(schema.coverage)
      .where(
        and(
          eq(schema.coverage.cycleRunId, cycleRunId),
          eq(schema.coverage.workerId, workerIds.get('triage')!),
        ),
      )
    assert.equal(row?.outcome, 'blocked', '"blocked" is narrower than "errored" — say which')
    assert.match(row?.reason ?? '', /reviewer-a/, 'name the dependency that stopped it')
  })

  /**
   * The other half of a degraded night: what triage *said* about it.
   *
   * The ledger records that reviewer-b errored. Only triage can say what that cost —
   * which surface therefore went unexamined tonight — and the skill requires it to,
   * because an inbox with three findings from four reviewers looks identical to one with
   * three from three. The document schema accepted `notes` from the beginning and
   * finalize wrote it nowhere: a real triage run explained a missing security review and
   * the account went straight in the bin, which is principle 6 inverted in the one node
   * whose job is assembling the coverage picture.
   */
  test("a node's account of its own pass is kept, and readable per batch", async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const a = await finish(
      cycleRunId,
      'reviewer-a',
      [finding('auth/session/fixation/reuse', 'src/auth.ts')],
      'I could not build the worker package, so this pass read it without types.',
    )
    await crash(cycleRunId, 'reviewer-b', 'codex exited 1: model not supported')

    const account =
      'reviewer-b errored and produced nothing. Its empty findings array is a crash, not a' +
      ' clean result — and since its brief is authorization boundaries, nothing looked at' +
      ' that surface tonight.'
    const t = await finish(cycleRunId, 'triage', [], account)

    const [triageRun] = await db.select().from(schema.runs).where(eq(schema.runs.id, t.run.id))
    assert.equal(triageRun?.notes, account, "triage's account of a degraded night is durable")
    assert.equal(
      triageRun?.detail,
      null,
      'a note is not a failure reason; sharing `detail` would make a successful run read as a broken one',
    )

    // Staging withholds findings from the inbox. A note is output of the run, and is read
    // with the run whether or not anything downstream consumed it.
    const [staged] = await db.select().from(schema.runs).where(eq(schema.runs.id, a.run.id))
    assert.match(staged?.notes ?? '', /without types/, 'a staged reviewer still gets to speak')

    const res = await h.fetch(`/api/runs/notes?project=${slug}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      notes: Array<{ runId: string; cycleRunId: string; notes: string; worker: { name: string } }>
    }
    const batch = body.notes.filter((n) => n.cycleRunId === cycleRunId)
    assert.deepEqual(
      batch.map((n) => n.worker.name).sort(),
      ['reviewer-a', 'triage'],
      'the coverage ledger reads notes by batch, and the crashed reviewer wrote none',
    )
    assert.equal(batch.find((n) => n.worker.name === 'triage')?.notes, account)
  })

  /**
   * The guard that decides staging reads the run's frozen definition, and it used to
   * answer "I cannot read this" with the same value as "nothing depends on this node" —
   * which is publish. A reviewer feeding triage would then put its raw findings in the
   * inbox next to the consolidated ones, the one outcome the fan-in exists to prevent,
   * and nothing anywhere would say so.
   *
   * Defence in depth rather than a live bug: #38 made every write path parse with
   * `runnableCycleSchema`, so an unparseable definition should be unreachable through the
   * API. The bad state is therefore built directly — a row written before that check
   * existed, or edited by hand, is what this stands guard over. Last in the file because
   * it deliberately leaves a corrupt cycle run behind.
   */
  test('a graph that cannot be read withholds rather than publishes, and says so', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await db
      .update(schema.cycleRuns)
      .set({ definition: { nodes: 'not a graph' } })
      .where(eq(schema.cycleRuns.id, cycleRunId))

    const fingerprint = 'graph/unreadable/publishes-raw'
    /**
     * The call itself still throws: `releaseDependents` walks the same definition with a
     * strict parse once the transaction has committed. That is cycles.ts's answer to the
     * same corruption and it is not this guard's to change — what is under test is what
     * the transaction wrote before it.
     */
    await assert.rejects(
      finish(cycleRunId, 'reviewer-a', [finding(fingerprint, 'src/a.ts')]),
      'an unreadable graph is not something to be quiet about',
    )

    const published = await db
      .select()
      .from(schema.findings)
      .where(
        and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, fingerprint)),
      )
    assert.equal(published.length, 0, 'a guard that cannot tell must not publish')

    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'reviewer-a')))
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.jobId, job!.id))
    const staged = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, run!.id))
    assert.equal(staged.length, 1, 'withholding is only recoverable because it is still staged')
    assert.equal(run!.outcome, 'approved', 'the reviewer did its job; the graph is what is broken')

    const [row] = await db
      .select()
      .from(schema.coverage)
      .where(
        and(eq(schema.coverage.cycleRunId, cycleRunId), eq(schema.coverage.workerName, 'reviewer-a')),
      )
    assert.equal(row?.outcome, 'found', '"errored" already means the reviewer produced nothing')
    assert.equal(row?.findingCount, 1, 'the ledger records what was reported, not what was published')
    assert.match(
      row?.reason ?? '',
      /does not parse/,
      'a night withheld because nobody could read the graph must not read as a normal fan-in',
    )
  })
})

/**
 * History outlives the definitions that produced it (§4.4).
 *
 * `jobs`, `coverage`, `staged_findings` and `cycle_runs` used to cascade off `workers`
 * and `cycles`, and `reindexProject` deletes anything absent from config.yaml — so a
 * *rename*, which reaches it as a delete plus an insert, destroyed every run the old name
 * had ever produced. One worker toggle from the UI took a whole night's cycle run, its
 * three runs and its coverage rows with it, and nothing failed or said so.
 */
describe('editing config.yaml does not delete run history', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `hist-${Date.now()}`
  let projectId = ''
  let cycleId = ''
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
        name: 'doomed',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'doomed',
        definition: { nodes: [{ key: 'doomed', worker: 'doomed' }], edges: [] },
      })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  test('a run survives its worker and its cycle being deleted', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: {
        findings: [
          {
            fingerprint: 'a/b/c/d',
            title: 'problem',
            body: 'detail',
            severity: 'high',
            citations: [{ path: 'src/x.ts', line: 1 }],
          },
        ] as never,
      },
      coverage: { outcome: 'found' },
      artifacts: [],
    })

    // Exactly what `ogun project sync` does when a worker and cycle leave config.yaml.
    await db.delete(schema.workers).where(eq(schema.workers.id, workerId))
    await db.delete(schema.cycles).where(eq(schema.cycles.id, cycleId))

    const runsLeft = await db.select().from(schema.runs).where(eq(schema.runs.id, run!.id))
    assert.equal(runsLeft.length, 1, 'the run was deleted with its worker')

    const [survivingJob] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job!.id))
    assert.ok(survivingJob, 'the job was deleted with its worker')
    assert.equal(survivingJob!.workerId, null, 'the pointer goes, not the row')
    assert.equal(survivingJob!.workerName, 'doomed', 'the name is what makes it readable')

    const [cycleRun] = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.id, cycleRunId))
    assert.ok(cycleRun, 'the cycle run was deleted with its cycle')
    assert.equal(cycleRun!.cycleId, null)
    assert.equal(cycleRun!.cycleName, 'doomed')

    const cov = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, cycleRunId))
    assert.equal(cov.length, 1, 'the coverage ledger is the trust anchor — it must not vanish')
    assert.equal(cov[0]!.workerName, 'doomed')

    const staged = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, run!.id))
    assert.equal(staged.length, 1, 'raw reviewer output is a run artifact and outlives the worker')
    assert.equal(staged[0]!.workerName, 'doomed')
  })
})

/**
 * History reaches the sandbox as a file, not a query (§4.11, §4.12).
 *
 * Both review skills open by checking what has already been reported, and they used to
 * do it with `ogun findings list` — which cannot work inside a sandbox that has no route
 * to the control plane. Every reviewer therefore ran with no memory of any previous
 * night, which is how the same invite bug reached the inbox three times under three
 * fingerprints.
 */
describe('a job can read what the inbox already says', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `hist2-${Date.now()}`
  let projectId = ''
  let jobId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'reviewer',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    const [c] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'reviewer',
        definition: { nodes: [{ key: 'reviewer', worker: 'reviewer' }], edges: [] },
      })
      .returning()
    const { cycleRunId } = await startCycleRun(db, { cycleId: c!.id, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    jobId = job!.id

    for (const [fingerprint, status] of [
      ['security/invites/single-use/double-redeem', 'open'],
      ['foreman/claim/cap/overrun', 'fixed'],
      ['style/naming/casing/camel', 'wontfix'],
      ['noise/dup/of-the-first/again', 'duplicate'],
    ] as const) {
      await db.insert(schema.findings).values({
        projectId,
        workerId: w!.id,
        fingerprint,
        severity: 'high',
        title: `title for ${fingerprint}`,
        body: `the full argument for ${fingerprint}`,
        status,
      })
    }
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  test('the index carries every status that changes a decision, and drops duplicates', async () => {
    const res = await h.fetch(`/api/jobs/${jobId}/history`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      index: Array<{ fingerprint: string; status: string; title: string }>
      details: Record<string, string>
    }

    const byStatus = Object.fromEntries(body.index.map((f) => [f.status, f.fingerprint]))
    assert.ok(byStatus.open, 'an open finding accounts for its surface')
    assert.ok(byStatus.fixed, 'a fixed finding recurring is a regression, which is worth knowing')
    assert.ok(byStatus.wontfix, 're-litigating a decision is the loudest noise a reviewer makes')
    assert.equal(
      body.index.some((f) => f.status === 'duplicate'),
      false,
      'a duplicate is treated as though it never existed',
    )

    // Both halves are present and separate: the index states what, details hold why.
    assert.ok(body.index.every((f) => !('body' in f)), 'the index must stay compact')
    assert.match(
      body.details['security/invites/single-use/double-redeem'] ?? '',
      /the full argument/,
    )
  })
})
