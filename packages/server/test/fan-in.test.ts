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

  const finish = async (cycleRunId: string, nodeKey: string, findings: unknown[]) => {
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
      findings: { findings: findings as never },
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
})
