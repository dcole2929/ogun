import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { cycleConfigSchema, expandCycle } from '@ogun/core'
import { startHarness } from './harness.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'

/**
 * A scope evaluator's verdict, and what the rest of a cycle does about it (§4.13,
 * ADR-0013).
 *
 * The thing being protected here is a distinction, not a feature. "Ogun looked at this
 * ticket and said no" has to be recordable *and* has to stop the pipeline, and every
 * outcome that already existed gets exactly one of those two halves right: `approved`
 * records it and releases the dependents anyway, `error` stops them and blames the worker,
 * `skipped` claims nothing ran. Each test below is one of the halves.
 *
 * The graph is the shape a ticket pipeline actually has — one entry node, one thing behind
 * it — and it exists twice on purpose. The default one takes the sugar's `degrade`, which
 * is what somebody writing `workers: [scope], then: plan` gets without thinking about it;
 * the strict one spells out `block`, which is what `.ogun/config.yaml` tells them to write.
 * A decline has to stop the pipeline on both, because a decline is not a failure and
 * `onDepFailure` only governs failures. The two graphs are what makes the difference
 * between those visible rather than asserted in one config and assumed in the other.
 */
describe('a scope verdict decides what the rest of the cycle does', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `scope-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  let strictCycleId = ''
  let chainCycleId = ''
  const workerIds = new Map<string, string>()

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id

    for (const name of ['scope', 'plan', 'implement']) {
      const [w] = await db
        .insert(schema.workers)
        .values({
          projectId,
          name,
          skillRef: name === 'scope' ? 'scope-a-ticket' : name,
          runtime: 'claude',
          // `plan` is a reviewer here rather than the modifier it will really be. A
          // modifier is refused at admission on a project with no checkout and no test
          // command, which would skip the node for a reason that has nothing to do with
          // the verdict and would pass every assertion below for the wrong cause.
          permissions: name === 'scope' ? 'observer' : 'reviewer',
          versionHash: 'v1',
          config: {},
        })
        .returning()
      workerIds.set(name, w!.id)
    }

    const definition = expandCycle(cycleConfigSchema.parse({ workers: ['scope'], then: 'plan' }))
    const [c] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'ticket-pipeline', definition })
      .returning()
    cycleId = c!.id

    // The same graph written the way `.ogun/config.yaml` tells an operator to write it.
    const strict = expandCycle(
      cycleConfigSchema.parse({ workers: ['scope'], then: 'plan', onDepFailure: 'block' }),
    )
    const [s] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'ticket-pipeline-strict', definition: strict })
      .returning()
    strictCycleId = s!.id

    /**
     * The full ticket pipeline (ADR-0015), so that a decline can be asserted from a node
     * that is neither the entry nor the last. Written as nodes and edges because that is
     * what a chain needs — the sugar expresses a fan-in.
     */
    const chain = expandCycle(
      cycleConfigSchema.parse({
        nodes: [
          { key: 'scope', worker: 'scope' },
          { key: 'plan', worker: 'plan' },
          { key: 'implement', worker: 'implement' },
        ],
        edges: [
          { from: 'scope', to: 'plan', onDepFailure: 'block' },
          { from: 'plan', to: 'implement', onDepFailure: 'block' },
        ],
      }),
    )
    const [ch] = await db
      .insert(schema.cycles)
      .values({ projectId, name: 'ticket-pipeline-chain', definition: chain })
      .returning()
    chainCycleId = ch!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const jobFor = async (cycleRunId: string, nodeKey: string) => {
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, nodeKey)))
    return job!
  }

  const coverageFor = async (cycleRunId: string, workerName: string) => {
    const [row] = await db
      .select()
      .from(schema.coverage)
      .where(
        and(
          eq(schema.coverage.cycleRunId, cycleRunId),
          eq(schema.coverage.workerName, workerName),
        ),
      )
    return row!
  }

  /**
   * A run, reported exactly as the runner reports one. `scope` here is the block the agent
   * wrote into its own document; everything else is what `pipeline.ts` derives from it.
   */
  const report = async (
    cycleRunId: string,
    nodeKey: string,
    verdict: 'admit' | 'decline',
    opts: { gateFailed?: boolean } = {},
  ) => {
    const job = await jobFor(cycleRunId, nodeKey)
    // The claim, which is what separates a run that happened from an admission refusal.
    await db.update(schema.jobs).set({ claimedAt: new Date() }).where(eq(schema.jobs.id, job.id))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job.id, runnerName: 'test' })
      .returning()
    const reason = verdict === 'decline' ? 'the ticket names no behaviour to change' : 'actionable'
    const result = await finalizeRun(db, {
      runId: run!.id,
      outcome: verdict === 'decline' ? 'declined' : 'approved',
      ...(verdict === 'decline' ? { detail: reason } : {}),
      gates: opts.gateFailed
        ? [{ name: 'grounded', method: 'tool', passed: false, detail: 'cites a file that is gone' }]
        : [{ name: 'verdict', method: 'tool', passed: true }],
      findings: {
        findings: [],
        scope: { verdict, reason },
      },
      coverage:
        verdict === 'decline' ? { outcome: 'declined' as const, reason } : { outcome: 'clean' as const },
      artifacts: [],
    })
    return { job, run: run!, result }
  }

  /**
   * The half that stops things. A ticket refused by the evaluator must not be planned, and
   * the edge here says `degrade` — the sugar's default, and the config anybody writing a
   * ticket pipeline will end up with.
   */
  test('a decline blocks the rest of the pipeline even on a degrade edge', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const { result } = await report(cycleRunId, 'scope', 'decline')

    assert.equal(result.outcome, 'declined')
    assert.equal(result.jobState, 'skipped')

    const plan = await jobFor(cycleRunId, 'plan')
    assert.equal(plan.state, 'skipped', 'the plan node must not run on a ticket that was refused')

    const planCoverage = await coverageFor(cycleRunId, 'plan')
    assert.equal(planCoverage.outcome, 'blocked')
    // Which of the two it was, because a failure sends a reader looking for a bug and a
    // decline sends them to a sentence somebody wrote on purpose.
    assert.match(planCoverage.reason ?? '', /declined the work/)
  })


  /**
   * The verdict is not the entry node's alone.
   *
   * `findings.ts` says so — *"a planner that cannot find a plan is answering the same
   * question one stage later"* — and the ticket pipeline (ADR-0015) is built on it: a plan
   * node that reads the code and concludes there is nothing one reviewable change could do
   * declines, and the modifier behind it never starts. Without this, the alternatives are
   * a modifier spending a container to read an empty plan and decline in turn, or a lens
   * that files "I decided not to" as "the gate refused me".
   *
   * Asserted mid-chain rather than trusted from the two-node case, because the thing that
   * could break it is exactly a positional assumption — `declinedNodes` keying on the entry
   * node, or a release that only consults the verdict for a job with no dependencies of its
   * own. Both would pass every test above.
   */
  test('a planner declining stops the modifier behind it, one hop further in', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId: chainCycleId, trigger: 'test' })

    const admitted = await report(cycleRunId, 'scope', 'admit')
    assert.equal(admitted.result.outcome, 'approved')
    assert.equal(
      (await jobFor(cycleRunId, 'plan')).state,
      'queued',
      'an admitted ticket has to reach the planner, or this proves nothing',
    )

    const declined = await report(cycleRunId, 'plan', 'decline')
    assert.equal(declined.result.outcome, 'declined')

    const implement = await jobFor(cycleRunId, 'implement')
    assert.equal(implement.state, 'skipped')
    const coverage = await coverageFor(cycleRunId, 'implement')
    assert.equal(coverage.outcome, 'blocked')
    assert.match(coverage.reason ?? '', /declined the work/)
  })
  /**
   * The half that records it. A decline that stopped the pipeline and left nothing saying
   * why is the silence principle 6 exists to prevent — and it is worse here than anywhere
   * else, because the emission ledger never re-emits a ticket, so this row is the only
   * trace the ticket will ever have.
   */
  test("a decline is recorded with the evaluator's reason, on the run and on the ledger", async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const { run } = await report(cycleRunId, 'scope', 'decline')

    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
    assert.equal(row!.outcome, 'declined')
    assert.match(row!.detail ?? '', /names no behaviour/)

    const cov = await coverageFor(cycleRunId, 'scope')
    assert.equal(cov.outcome, 'declined')
    assert.equal(cov.ran, true, 'an agent ran, read the repository and spent the money')
    assert.match(cov.reason ?? '', /names no behaviour/)

    // Never `clean`. That value says a surface is covered, and a declined ticket read as a
    // clean one makes "what did Ogun decline last night" unanswerable from this table.
    assert.notEqual(cov.outcome, 'clean')
  })

  /** The cycle run itself, which under the old derivation read `failed`. */
  test('a cycle that ended in a decline is graded declined, not failed', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await report(cycleRunId, 'scope', 'decline')

    const [cycleRun] = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.id, cycleRunId))
    assert.equal(cycleRun!.state, 'declined')
  })

  test('an admit releases what is behind it and reads as an ordinary clean run', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const { result } = await report(cycleRunId, 'scope', 'admit')

    assert.equal(result.outcome, 'approved')
    assert.equal(result.jobState, 'succeeded')
    assert.equal((await coverageFor(cycleRunId, 'scope')).outcome, 'clean')
    assert.equal((await jobFor(cycleRunId, 'plan')).state, 'queued')
  })

  /**
   * A verdict travels in the document the gate reads, so a declined run whose gate failed
   * is a run whose *verdict* is the thing that failed the gate. Letting it stand would mean
   * the one output that stops a pipeline is the one output nothing checked — and refusing
   * a ticket for good on the strength of an unparseable document is the expensive half.
   */
  test('a failed gate withdraws the verdict rather than honouring it', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const { result } = await report(cycleRunId, 'scope', 'decline', { gateFailed: true })

    assert.equal(result.outcome, 'changes-requested')
    assert.equal(result.coverage, 'gate-failed')
    assert.equal(result.jobState, 'failed')
  })

  /**
   * The hazard this graph is deliberately built with, asserted rather than left to be
   * discovered: on the sugar's default `degrade` edge, a scope evaluator that *failed* —
   * as opposed to declining — releases the pipeline anyway, and the planner runs on a
   * ticket nobody judged.
   *
   * That is `degrade` doing exactly what it says, and the fix is one word in the config
   * rather than a special case here: a ticket pipeline writes `onDepFailure: block`, and
   * `.ogun/config.yaml` says so beside the worked example. It is asserted because a
   * default that silently defeats the entry node of a pipeline should fail loudly the day
   * somebody changes their mind about it, in a test that explains the trade rather than in
   * production at 3am.
   */
  test('a degrade edge releases the pipeline when the evaluator failed — write block', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await report(cycleRunId, 'scope', 'decline', { gateFailed: true })
    assert.equal((await jobFor(cycleRunId, 'plan')).state, 'queued')
  })

  /**
   * The breaker is about a worker that is malfunctioning (§4.3). A run of badly-written
   * tickets is not that, and counting one would mean a team having a bad week at ticket
   * writing silently switches its own pipeline off after three of them.
   */
  test('declining neither latches the failure breaker nor leaves it where it was', async () => {
    const workerId = workerIds.get('scope')!
    await db
      .insert(schema.breakers)
      .values({ workerId, consecutiveFailures: 2 })
      .onConflictDoUpdate({
        target: schema.breakers.workerId,
        set: { consecutiveFailures: 2, openedAt: null },
      })

    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    await report(cycleRunId, 'scope', 'decline')

    const [breaker] = await db
      .select()
      .from(schema.breakers)
      .where(eq(schema.breakers.workerId, workerId))
    assert.equal(
      breaker!.consecutiveFailures,
      0,
      'a decline is a run that worked; leaving the count would latch on the next hiccup',
    )
    assert.equal(breaker!.openedAt, null)
  })

  /**
   * Nothing regresses for the nodes that carry no verdict. A cycle whose jobs all succeeded
   * is still `complete`, and one where something genuinely failed is still graded on the
   * failure — a decline must never be able to hide one.
   */
  test('a cycle with a failure is still graded on the failure', async () => {
    const { cycleRunId } = await startCycleRun(db, { cycleId: strictCycleId, trigger: 'test' })
    const job = await jobFor(cycleRunId, 'scope')
    await db.update(schema.jobs).set({ claimedAt: new Date() }).where(eq(schema.jobs.id, job.id))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job.id, runnerName: 'test' })
      .returning()
    await finalizeRun(db, {
      runId: run!.id,
      outcome: 'error',
      detail: 'the container died',
      gates: [],
      coverage: { outcome: 'errored' },
      artifacts: [],
    })

    const [cycleRun] = await db
      .select()
      .from(schema.cycleRuns)
      .where(eq(schema.cycleRuns.id, cycleRunId))
    assert.equal(cycleRun!.state, 'failed')
  })
})
