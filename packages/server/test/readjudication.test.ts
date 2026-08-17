import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'
import type { Adjudication } from '@ogun/core'

/**
 * Re-adjudication (§4.11): a verdict on a finding nobody re-reported.
 *
 * Hashing catches an exact repeat. It does not catch a finding that stopped being true,
 * and nothing else in the system ever revisits one — reviewers report what they found
 * tonight. Without this, findings stay `open` after the code stops being wrong, and the
 * inbox degrades into a list nobody reads.
 */
describe('re-adjudication', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `adj-${Date.now()}`
  let projectId = ''
  let cycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    const [w] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'triage',
        skillRef: 'triage',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    const [c] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'triage',
        definition: { nodes: [{ key: 'triage', worker: 'triage' }], edges: [] },
      })
      .returning()
    cycleId = c!.id
    void w
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const seed = async (fingerprint: string, status = 'open') => {
    await db
      .insert(schema.findings)
      .values({
        projectId,
        fingerprint,
        severity: 'high',
        title: `title for ${fingerprint}`,
        body: 'the argument',
        status,
      })
      .onConflictDoUpdate({
        target: [schema.findings.projectId, schema.findings.fingerprint],
        set: { status },
      })
  }

  const rowOf = async (fingerprint: string) =>
    (
      await db
        .select()
        .from(schema.findings)
        .where(
          and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, fingerprint)),
        )
    )[0]

  /** Run a triage node that publishes only adjudications. */
  const adjudicate = async (adjudications: Adjudication[]) => {
    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()
    const result = await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: { findings: [], adjudications },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })
    return { result, runId: run!.id }
  }

  test('a fixed verdict closes the finding and records who decided it', async () => {
    await seed('security/invites/single-use/toctou')
    const { result, runId } = await adjudicate([
      {
        verdict: 'fixed',
        fingerprint: 'security/invites/single-use/toctou',
        reason: 'redemption is now a conditional UPDATE',
        citations: [{ path: 'packages/server/src/routes/runners.ts', line: 168 }],
      },
    ])

    assert.deepEqual(
      result.adjudicated.map((a) => a.applied),
      [true],
    )
    const row = await rowOf('security/invites/single-use/toctou')
    assert.equal(row?.status, 'fixed')
    assert.match(row?.statusReason ?? '', /^fixed: redemption is now/)
    assert.equal(row?.statusRun, runId, 'a status nobody can account for is the thing to avoid')
  })

  test('still-applies is recorded, not a no-op', async () => {
    await seed('foreman/claim/cap/overrun')
    const before = await rowOf('foreman/claim/cap/overrun')
    const { runId } = await adjudicate([
      {
        verdict: 'still-applies',
        fingerprint: 'foreman/claim/cap/overrun',
        reason: 'read the claim path again; the cap is still per-runner',
      },
    ])
    const after = await rowOf('foreman/claim/cap/overrun')
    assert.equal(after?.status, 'open')
    assert.equal(after?.statusRun, runId, '"checked and still broken" must be distinguishable')
    assert.notEqual(after?.statusReason, before?.statusReason)
  })

  test('duplicate-of merges without deleting, and keeps the pointer', async () => {
    await seed('security/invites/single-use/toctou', 'open')
    await seed('security/invites/single-use/parallel-redeem')
    await adjudicate([
      {
        verdict: 'duplicate-of',
        fingerprint: 'security/invites/single-use/parallel-redeem',
        duplicateOf: 'security/invites/single-use/toctou',
        reason: 'same invariant, described from the runner side',
      },
    ])
    const dupe = await rowOf('security/invites/single-use/parallel-redeem')
    assert.equal(dupe?.status, 'duplicate')
    assert.equal(dupe?.duplicateOf, 'security/invites/single-use/toctou')
    assert.ok(dupe, 'triage marks, it does not delete (§4.12)')
  })

  test('no-longer-applicable is not the same as fixed', async () => {
    await seed('legacy/scope-probe/entry/removed')
    await adjudicate([
      {
        verdict: 'no-longer-applicable',
        fingerprint: 'legacy/scope-probe/entry/removed',
        reason: 'the scope-probe worker and its module were deleted',
      },
    ])
    const row = await rowOf('legacy/scope-probe/entry/removed')
    assert.equal(
      row?.status,
      'obsolete',
      '"we fixed it" and "the question stopped existing" are different facts',
    )
  })

  /**
   * The guards matter more than the happy path. A model closing findings unattended at
   * 3am is the one thing here that can quietly lose real work.
   */
  test('a verdict on a finding that does not exist is refused, not applied', async () => {
    const { result } = await adjudicate([
      {
        verdict: 'fixed',
        fingerprint: 'invented/surface/does-not/exist',
        reason: 'looks handled',
        citations: [{ path: 'README.md', line: 1 }],
      },
    ])
    assert.equal(result.adjudicated[0]?.applied, false)
    assert.match(result.adjudicated[0]?.refused ?? '', /no such finding/)
  })

  test('a wontfix cannot be overruled', async () => {
    await seed('style/naming/casing/camel', 'wontfix')
    const { result } = await adjudicate([
      {
        verdict: 'still-applies',
        fingerprint: 'style/naming/casing/camel',
        reason: 'I still think this is wrong',
      },
    ])
    assert.equal(result.adjudicated[0]?.applied, false)
    assert.match(result.adjudicated[0]?.refused ?? '', /human decision/)
    assert.equal((await rowOf('style/naming/casing/camel'))?.status, 'wontfix')
  })

  test('a merge cannot point at a duplicate, or at itself', async () => {
    await seed('a/b/c/keeper')
    await seed('a/b/c/first-dupe')
    await seed('a/b/c/second-dupe')
    await adjudicate([
      {
        verdict: 'duplicate-of',
        fingerprint: 'a/b/c/first-dupe',
        duplicateOf: 'a/b/c/keeper',
        reason: 'same invariant',
      },
    ])

    const { result } = await adjudicate([
      {
        verdict: 'duplicate-of',
        fingerprint: 'a/b/c/second-dupe',
        duplicateOf: 'a/b/c/first-dupe',
        reason: 'chaining onto a duplicate',
      },
      {
        verdict: 'duplicate-of',
        fingerprint: 'a/b/c/keeper',
        duplicateOf: 'a/b/c/keeper',
        reason: 'itself',
      },
    ])
    assert.equal(result.adjudicated[0]?.applied, false)
    assert.match(result.adjudicated[0]?.refused ?? '', /itself a duplicate/)
    assert.equal(result.adjudicated[1]?.applied, false)
    assert.match(result.adjudicated[1]?.refused ?? '', /duplicate of itself/)
    assert.equal((await rowOf('a/b/c/keeper'))?.status, 'open', 'the survivor is untouched')
  })

  /**
   * The same rule findings follow (§4.12): only a node that publishes may change the
   * inbox, read off the graph rather than declared on the worker. A reviewer feeding
   * triage that could close findings directly would defeat the whole arrangement —
   * triage exists so one node decides, and it cannot decide about a row already
   * rewritten upstream.
   */
  test('a reviewer that stages cannot adjudicate', async () => {
    const [reviewer] = await db
      .insert(schema.workers)
      .values({
        projectId,
        name: 'stager',
        skillRef: 'adversarial-review',
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
      .returning()
    const [fan] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'fan',
        definition: {
          nodes: [
            { key: 'stager', worker: 'stager' },
            { key: 'triage', worker: 'triage' },
          ],
          edges: [{ from: 'stager', to: 'triage', onDepFailure: 'degrade' }],
        },
      })
      .returning()
    void reviewer

    await seed('upstream/should/not/close')
    const { cycleRunId } = await startCycleRun(db, { cycleId: fan!.id, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.cycleRunId, cycleRunId), eq(schema.jobs.nodeKey, 'stager')))
    const [run] = await db
      .insert(schema.runs)
      .values({ jobId: job!.id, runnerName: 'test' })
      .returning()

    const result = await finalizeRun(db, {
      runId: run!.id,
      outcome: 'approved',
      gates: [],
      findings: {
        findings: [],
        adjudications: [
          {
            verdict: 'fixed',
            fingerprint: 'upstream/should/not/close',
            reason: 'a reviewer trying to close something itself',
            citations: [{ path: 'README.md', line: 1 }],
          },
        ],
      },
      coverage: { outcome: 'clean' },
      artifacts: [],
    })

    assert.deepEqual(result.adjudicated, [], 'a staged run adjudicates nothing')
    assert.equal((await rowOf('upstream/should/not/close'))?.status, 'open')
  })

  test('one bad verdict does not discard the good ones beside it', async () => {
    await seed('good/one/to/close')
    const { result } = await adjudicate([
      {
        verdict: 'still-applies',
        fingerprint: 'nope/not/a/finding',
        reason: 'invented',
      },
      {
        verdict: 'fixed',
        fingerprint: 'good/one/to/close',
        reason: 'genuinely fixed',
        citations: [{ path: 'README.md', line: 1 }],
      },
    ])
    assert.equal(result.adjudicated.filter((a) => a.applied).length, 1)
    assert.equal((await rowOf('good/one/to/close'))?.status, 'fixed')
  })
})
