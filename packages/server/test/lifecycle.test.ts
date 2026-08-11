import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { createDb, schema } from '@ogun/core/db'
import { singleWorkerCycle } from '@ogun/core'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'
import { admit } from '../src/foreman/admission.ts'

const url = process.env.DATABASE_URL ?? 'postgres://ogun:ogun@localhost:5433/ogun'
const reachable = await fetch('http://localhost:7777/api/health').then(
  () => true,
  () => false,
)

describe('run lifecycle', { skip: reachable ? false : 'no control plane running' }, () => {
  const { db, close } = createDb(url)
  const slug = `test-${Date.now()}`
  let projectId = ''
  let workerId = ''
  let cycleId = ''

  before(async () => {
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
    workerId = w!.id
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'reviewer', definition: singleWorkerCycle('reviewer') })
      .returning()
    cycleId = c!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await close()
  })

  const runOnce = async (report: Parameters<typeof finalizeRun>[1] extends infer R ? Omit<R & object, 'runId'> : never) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.cycleRunId, cycleRunId))
    if (job?.state === 'skipped') return { skipped: true as const, cycleRunId }
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerId: 'test' })
      .returning()
    const result = await finalizeRun(db, { ...report, runId: run!.id })
    return { skipped: false as const, cycleRunId, result }
  }

  test('a clean run records coverage as clean, not as absence', async () => {
    const r = await runOnce({
      outcome: 'approved',
      gates: [{ name: 'schema', method: 'tool', passed: true }],
      findings: { findings: [] },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })
    assert.equal(r.skipped, false)
    assert.equal(r.result?.coverage, 'clean')
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, r.cycleRunId))
    assert.equal(cov?.ran, true, '"ran and found nothing" must be distinguishable from "never ran"')
    assert.equal(cov?.findingCount, 0)
  })

  test('the same fingerprint twice is one finding with a bumped count', async () => {
    const finding = {
      fingerprint: 'security/orders/isolation/id-swap',
      title: 'Order lookup trusts a client id',
      body: 'detail',
      severity: 'high' as const,
      citations: [{ path: 'src/orders.ts', line: 12 }],
    }
    const report = {
      outcome: 'approved' as const,
      gates: [],
      findings: { findings: [finding] },
      coverage: { outcome: 'found' as const },
      artifacts: [],
    }
    await runOnce(report)
    await runOnce(report)
    const rows = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId))
    assert.equal(rows.length, 1, 'night two must not regenerate night one')
    assert.equal(rows[0]?.seenCount, 2)
  })

  test('a failed gate blocks persistence and is not reported as success', async () => {
    const before = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    const r = await runOnce({
      outcome: 'approved',
      gates: [{ name: 'grounded', method: 'tool', passed: false, detail: 'src/ghost.ts:1 not in diff' }],
      findings: {
        findings: [
          {
            fingerprint: 'security/ghost/isolation/hallucinated',
            title: 'x',
            body: 'y',
            severity: 'critical',
            citations: [{ path: 'src/ghost.ts', line: 1 }],
          },
        ],
      },
      coverage: { outcome: 'found' },
      artifacts: [],
    })
    assert.equal(r.result?.outcome, 'changes-requested', 'the gate decides, not the runner')
    assert.equal(r.result?.findingsWritten, 0)
    assert.equal(r.result?.coverage, 'gate-failed')
    const after = await db.select().from(schema.findings).where(eq(schema.findings.projectId, projectId))
    assert.equal(after.length, before.length)
  })

  test('consecutive failures open the breaker and refuse the next job before it queues', async () => {
    const fail = {
      outcome: 'error' as const,
      detail: 'agent exited 1',
      gates: [],
      coverage: { outcome: 'errored' as const },
      artifacts: [],
    }
    // Two more on top of the gate failure above reaches the default threshold of three.
    await runOnce(fail)
    await runOnce(fail)

    const verdict = await admit(db, workerId)
    assert.equal(verdict.allowed, false)

    const r = await runOnce(fail)
    assert.equal(r.skipped, true, 'a refused job is never dispatched')
    const [cov] = await db
      .select()
      .from(schema.coverage)
      .where(eq(schema.coverage.cycleRunId, r.cycleRunId))
    assert.equal(cov?.outcome, 'blocked')
    assert.match(cov?.reason ?? '', /breaker open/)
  })
})
