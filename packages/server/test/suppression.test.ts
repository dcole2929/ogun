import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { finalizeRun } from '../src/foreman/finalize.ts'
import type { DismissalCheck, FindingEvidence, RawFinding } from '@ogun/core'

/**
 * Suppression: what a run is not allowed to say, because a person already said it (§4.11).
 *
 * The failure this exists to stop is the one every automated reviewer eventually
 * exhibits — you dismiss a finding, the nightly runs again, and it comes straight back.
 * Two nights of that and the inbox is noise; three and nobody opens it, at which point
 * every other thing the factory does is worth nothing.
 *
 * The failure it must not *cause* is the mirror image, and it is worse: a dismissal that
 * outlives the code it was about, silencing the one worker positioned to notice that
 * somebody has since rewritten that code into something broken. §9 records a real `high`
 * in this exact path — a finding marked `fixed` that regressed stayed `fixed` and never
 * reappeared. Every test below that reopens something is guarding the same door from the
 * other side.
 *
 * So the properties, in the order they would be got wrong:
 *
 *  1. A dismissed finding reported again is silent, and the silence is *recorded*.
 *  2. A dismissed finding whose code moved is not silent, whoever dismissed it.
 *  3. Two findings that merely resemble each other never share one dismissal.
 *  4. Nothing but a person's own decision can make the system quiet.
 */
describe('suppression against a dismissal', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `sup-${Date.now()}`
  let projectId = ''
  let cycleId = ''
  let fanCycleId = ''

  before(async () => {
    h = await startHarness()
    db = h.db
    const [p] = await db.insert(schema.projects).values({ slug }).returning()
    projectId = p!.id
    for (const name of ['triage', 'stager']) {
      await db.insert(schema.workers).values({
        projectId,
        name,
        skillRef: name,
        runtime: 'claude',
        versionHash: 'v1',
        config: {},
      })
    }
    const [c] = await db
      .insert(schema.cycles)
      .values({
        projectId,
        name: 'nightly',
        definition: { nodes: [{ key: 'triage', worker: 'triage' }], edges: [] },
      })
      .returning()
    cycleId = c!.id
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
    fanCycleId = fan!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  const finding = (fingerprint: string, over: Partial<RawFinding> = {}): RawFinding => ({
    fingerprint,
    title: `problem at ${fingerprint}`,
    body: 'the argument, at length',
    severity: 'medium',
    citations: [{ path: 'packages/server/src/foreman/finalize.ts', line: 40 }],
    ...over,
  })

  /** Run the publishing node of a one-node cycle and report `document` from it. */
  const publish = async (
    reported: RawFinding[],
    extra: { checks?: DismissalCheck[]; evidence?: FindingEvidence[]; nodeKey?: string } = {},
  ) => {
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
      findings: { findings: reported },
      coverage: { outcome: 'found' },
      artifacts: [],
      ...(extra.evidence ? { evidence: extra.evidence } : {}),
      ...(extra.checks ? { dismissalChecks: extra.checks } : {}),
    })
    return { result, runId: run!.id }
  }

  const rowOf = async (fingerprint: string) =>
    (
      await db
        .select()
        .from(schema.findings)
        .where(
          and(
            eq(schema.findings.projectId, projectId),
            eq(schema.findings.fingerprint, fingerprint),
          ),
        )
    )[0]

  /**
   * Dismiss through the API, not by writing the row.
   *
   * The freeze is half the mechanism — the basis a dismissal is anchored to is copied out
   * of the finding at the moment a person decides — so a test that seeded the columns by
   * hand would assert the enforcement and skip the thing that arms it.
   */
  const dismiss = async (fingerprint: string, reason = 'this is fine') => {
    const row = await rowOf(fingerprint)
    const res = await h.fetch(`/api/findings/${row!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'wontfix', reason }),
    })
    assert.equal(res.status, 200)
    return (await res.json()) as { finding: { dismissedBasis: string | null } }
  }

  const evidence = (fingerprint: string, snippet: string): FindingEvidence => ({
    fingerprint,
    path: 'packages/server/src/foreman/finalize.ts',
    snippet,
  })

  /**
   * The core case, and the one the product is unusable without.
   *
   * Night one reports it and a person dismisses it. Night two reports the same thing
   * against the same code. Nothing changes in the inbox, and the ledger says why — an
   * absence with no record is indistinguishable from a reviewer that looked and found
   * nothing, which is exactly the collapse principle 6 forbids.
   */
  test('a dismissed finding reported again is silent, and the ledger says on whose authority', async () => {
    const fp = 'runner/retry-loop/backoff/unbounded-attempts'
    await publish([finding(fp)], { evidence: [evidence(fp, 'for (let i = 0; i < max; i++) { await attempt() }')] })
    await dismiss(fp, 'the loop is bounded by the job timeout')

    const { result, runId } = await publish([finding(fp)], {
      checks: [{ fingerprint: fp, basis: 'intact' }],
    })

    assert.equal(result.findingsWritten, 0, 'nothing reached the inbox')
    assert.equal(result.suppressed.length, 1)
    assert.equal(result.suppressed[0]?.dismissal, fp)
    assert.equal(result.suppressed[0]?.basis, 'intact')

    const row = await rowOf(fp)
    assert.equal(row?.status, 'wontfix', 'a re-sighting does not overrule a person')
    assert.equal(row?.seenCount, 2, 'the pressure stays visible even while the row is quiet')

    // The record of the silence, which is the half that did not exist before.
    const [staged] = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, runId))
    assert.equal(staged?.suppressedBy, fp)
    assert.match(staged?.suppressionReason ?? '', /dismissed as wontfix/)
    assert.match(staged?.suppressionReason ?? '', /unchanged/)
  })

  /**
   * The dangerous direction, and the reason a dismissal carries a basis at all.
   *
   * Dismiss "this retry loop is fine", let somebody rewrite the retry loop into something
   * genuinely broken, and a naive implementation — status `wontfix`, hold forever — stays
   * silent about the new code on the authority of a decision about the old code. That is
   * strictly worse than the noise suppression exists to remove: the noise costs attention,
   * this costs the bug.
   */
  test('a dismissal whose code was rewritten underneath it lapses, and the finding comes back', async () => {
    const fp = 'security/session/expiry/never-revalidated'
    await publish([finding(fp)], { evidence: [evidence(fp, 'if (session) return session.user')] })
    await dismiss(fp, 'sessions are short-lived here')

    const { result } = await publish([finding(fp)], {
      checks: [{ fingerprint: fp, basis: 'moved' }],
    })

    assert.equal(result.suppressed.length, 0, 'a lapsed dismissal suppresses nothing')
    assert.equal(result.lapsed.length, 1)
    const row = await rowOf(fp)
    assert.equal(row?.status, 'open')
    assert.match(row?.statusReason ?? '', /dismissal lapsed/)
    assert.equal(
      row?.dismissedBasis,
      null,
      'a spent dismissal is emptied, or setting the status back would re-arm it',
    )
  })

  /**
   * The same door, opened by the other key. A dismissal answers a *consequence*: "this is
   * fine" is a reply to a `low`, and it is not a reply to a `critical`. A reviewer that
   * has since found a way to make the same surface far worse is making a claim the person
   * never ruled on.
   *
   * Severity is the one input to this decision an agent supplies, and the wiring is
   * deliberately one-way: inflating it can only produce a row somebody dismisses again,
   * and deflating it changes nothing. A model cannot use it to buy silence.
   */
  test('the same finding reported far worse than it was dismissed lapses the dismissal', async () => {
    const fp = 'api/orders/rate-limit/burst-window'
    await publish([finding(fp, { severity: 'low' })], {
      evidence: [evidence(fp, 'const limit = perMinute(60) // generous on purpose')],
    })
    await dismiss(fp, 'a burst here is harmless')

    const { result } = await publish([finding(fp, { severity: 'critical' })], {
      checks: [{ fingerprint: fp, basis: 'intact' }],
    })

    assert.equal(result.lapsed.length, 1, 'an intact basis does not hold a dismissal of a lesser problem')
    assert.match(result.lapsed[0]?.reason ?? '', /reported as critical/)
    assert.equal((await rowOf(fp))?.status, 'open')
  })

  /**
   * A dismissal of `…/account-isolation/cross-account-id-swap` must not silence
   * `…/account-isolation/forged-tenant-header`. They share three of four segments because
   * the fingerprint is a taxonomy, and the fourth segment is where the actual bug lives.
   *
   * This is what a prefix match would get wrong, and prefix matching is genuinely
   * tempting: §4.11 builds the hierarchy so a *cooldown* can cover a surface. A cooldown
   * is temporary and loud. A dismissal is permanent and silent, and widening one by prefix
   * would silence bugs nobody ever looked at on the strength of a decision about a
   * sibling.
   */
  test('a dismissal does not spread to a sibling technique on the same invariant', async () => {
    const dismissed = 'security/public-orders/account-isolation/cross-account-id-swap'
    const sibling = 'security/public-orders/account-isolation/forged-tenant-header'
    await publish([finding(dismissed)], { evidence: [evidence(dismissed, 'where(eq(orders.id, id)) // no tenant predicate')] })
    await dismiss(dismissed, 'the gateway already scopes this')

    const { result } = await publish([finding(sibling)], {
      checks: [{ fingerprint: dismissed, basis: 'intact' }],
    })

    assert.equal(result.suppressed.length, 0, 'a neighbouring technique is a different bug')
    assert.equal(result.findingsWritten, 1)
    assert.equal((await rowOf(sibling))?.status, 'open')
    assert.equal((await rowOf(dismissed))?.status, 'wontfix', 'and the dismissal is untouched')
  })

  /**
   * §9's `high`, from the other side. A finding marked `fixed` that regressed stayed
   * `fixed` and never reappeared in the inbox. Suppression is a new way to make a finding
   * invisible, so the guard is asserted again next to it: `fixed` is a claim about the
   * code, not a decision to stay quiet, and evidence against it reopens the row.
   */
  test('a fixed finding that regresses still reopens — suppression is only for dismissals', async () => {
    const fp = 'foreman/claim/single-flight/double-dispatch'
    await publish([finding(fp)])
    await db
      .update(schema.findings)
      .set({ status: 'fixed' })
      .where(and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, fp)))

    const { result } = await publish([finding(fp)])
    assert.equal(result.suppressed.length, 0)
    const row = await rowOf(fp)
    assert.equal(row?.status, 'open')
    assert.match(row?.statusReason ?? '', /after being marked fixed/)
  })

  /**
   * The cross-night rephrasing problem, which is the one hashing cannot touch: four
   * reviewers describe one bug four ways over four nights, and only the first of them was
   * ever dismissed.
   *
   * Deterministic matching genuinely cannot see this, so the agent is allowed to *widen* a
   * dismissal — but only by filing an ordinary `duplicate-of` verdict, which leaves a row,
   * a pointer, a reason and a run behind it. The inference is auditable and reversible.
   * What the agent is never allowed to do is make the decision to stay silent, which is
   * why the alias is honoured through the dismissal's authority rather than its own.
   */
  test('a rephrasing merged into a dismissal inherits its silence, through a visible pointer', async () => {
    const dismissed = 'db/migrations/ordering/concurrent-index-lock'
    const rephrased = 'db/migrations/ordering/index-build-blocks-writes'
    await publish([finding(dismissed)], { evidence: [evidence(dismissed, 'await sql`create index on orders (tenant_id)`')] })
    await dismiss(dismissed, 'this table is small enough that the lock is irrelevant')

    await publish([finding(rephrased)])
    await db
      .update(schema.findings)
      .set({ status: 'duplicate', duplicateOf: dismissed })
      .where(
        and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, rephrased)),
      )

    const { result } = await publish([finding(rephrased)], {
      checks: [{ fingerprint: dismissed, basis: 'intact' }],
    })
    assert.equal(result.suppressed.length, 1)
    assert.equal(result.suppressed[0]?.dismissal, dismissed, 'the authority is the dismissal, not the alias')
    assert.match(result.suppressed[0]?.reason ?? '', /reported here as/)

    // And the lapse reaches it through the same pointer: the alias arriving is what
    // establishes the dismissal has lost its subject, so the dismissed row is what reopens.
    const lapsing = await publish([finding(rephrased)], {
      checks: [{ fingerprint: dismissed, basis: 'moved' }],
    })
    assert.equal(lapsing.result.lapsed.length, 1)
    assert.equal((await rowOf(dismissed))?.status, 'open', 'the reader belongs at the finding, not the alias')
    assert.equal(
      (await rowOf(rephrased))?.status,
      'duplicate',
      'the alias keeps its pointer — triage never deletes, it marks (§4.12)',
    )
  })

  /**
   * One hop, never two. `applyAdjudications` refuses a merge onto a duplicate, so a chain
   * cannot be built through the supported path — but a chain that arrived some other way
   * must not quietly extend a dismissal across two findings nobody ever compared.
   */
  test('a duplicate of a duplicate of a dismissal is not suppressed', async () => {
    const dismissed = 'gateway/ca/leaf-reuse/stale-san'
    const first = 'gateway/ca/leaf-reuse/cached-past-rotation'
    const second = 'gateway/ca/leaf-reuse/never-evicted'
    await publish([finding(dismissed)], { evidence: [evidence(dismissed, 'const leaf = cache.get(host) ?? mint(host)')] })
    await dismiss(dismissed)
    await publish([finding(first)])
    await publish([finding(second)])
    await db
      .update(schema.findings)
      .set({ status: 'duplicate', duplicateOf: dismissed })
      .where(and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, first)))
    await db
      .update(schema.findings)
      .set({ status: 'duplicate', duplicateOf: first })
      .where(and(eq(schema.findings.projectId, projectId), eq(schema.findings.fingerprint, second)))

    const { result } = await publish([finding(second)], {
      checks: [{ fingerprint: dismissed, basis: 'intact' }],
    })
    assert.equal(result.suppressed.length, 0)
  })

  /**
   * Three ways a dismissal can hold, and they are not the same fact.
   *
   * All three produce silence, so a boolean would have been enough to make the code work
   * and would have made the ledger useless: "suppressed on a live check" and "suppressed
   * because nobody looked" are exactly the distinction someone auditing a quiet night
   * needs. Principle 6 is about names, not about behaviour.
   */
  test('a dismissal standing on no check says so, rather than reading as one that passed', async () => {
    const unrecorded = 'cli/output/table/width-overflow'
    const unchecked = 'cli/output/json/unstable-key-order'
    // No evidence on the first sighting, so the dismissal has nothing to be anchored to.
    await publish([finding(unrecorded)])
    await dismiss(unrecorded)
    await publish([finding(unchecked)], { evidence: [evidence(unchecked, 'return JSON.stringify(Object.fromEntries(rows))')] })
    await dismiss(unchecked)

    const bare = await publish([finding(unrecorded)], {
      checks: [],
      evidence: [evidence(unrecorded, 'const width = columns.reduce((n, c) => n + c.width, 0)')],
    })
    assert.equal(bare.result.suppressed[0]?.basis, 'unrecorded')
    assert.match(bare.result.suppressed[0]?.reason ?? '', /no basis was recorded/)
    // The one chance a dismissal that predates this mechanism has to become anchorable: a
    // suppressed row is quiet, so nothing else will ever write to it again. Filled, not
    // overwritten — the dismissal itself stays unanchored until a person re-affirms it.
    assert.match((await rowOf(unrecorded))?.snippet ?? '', /columns\.reduce/)
    assert.equal((await rowOf(unrecorded))?.dismissedBasis, null)

    // Anchored, but this run reported no check at all — an older runner, or one that could
    // not reach history. It still suppresses; it does not claim to have looked.
    const blind = await publish([finding(unchecked)], { checks: [] })
    assert.equal(blind.result.suppressed[0]?.basis, 'unchecked')
    assert.match(blind.result.suppressed[0]?.reason ?? '', /nobody having looked/)

    // An unreadable file establishes nothing either way, and must not lapse a person's
    // decision on the strength of an I/O error.
    const broken = await publish([finding(unchecked)], {
      checks: [{ fingerprint: unchecked, basis: 'unreadable' }],
    })
    assert.equal(broken.result.suppressed[0]?.basis, 'unreadable')
    assert.equal((await rowOf(unchecked))?.status, 'wontfix')
  })

  /**
   * A dismissal's `status_reason` is a person's answer to a specific write-up. The upsert
   * used to rewrite the title, body and severity of a held row from tonight's report,
   * which left that answer attached to a question nobody had asked — and quietly changed
   * what the reader believed they had dismissed.
   */
  test('a later reviewer does not rewrite the write-up a person dismissed', async () => {
    const fp = 'web/inbox/sorting/severity-tiebreak'
    await publish([finding(fp, { title: 'ties sort by id', body: 'the original argument' })], {
      evidence: [evidence(fp, 'rows.sort((a, b) => rank(b.severity) - rank(a.severity))')],
    })
    await dismiss(fp, 'the order is arbitrary and that is fine')

    await publish(
      [finding(fp, { title: 'SOMETHING ELSE ENTIRELY', body: 'a different argument', severity: 'low' })],
      { checks: [{ fingerprint: fp, basis: 'intact' }] },
    )

    const row = await rowOf(fp)
    assert.equal(row?.title, 'ties sort by id')
    assert.equal(row?.body, 'the original argument')
    assert.equal(row?.severity, 'medium', 'the severity a person dismissed is what they dismissed')
  })

  /**
   * The same rule findings and adjudications already follow (§4.12): the node that
   * publishes decides. A reviewer feeding triage stages everything it found — including
   * the dismissed thing — because triage needs to see it in order to merge tonight's
   * rephrasing into it. Suppressing upstream would hide the input from the only node
   * equipped to use it, and would put the decision in N reviewers instead of one place.
   */
  test('a reviewer that stages suppresses nothing, and stages what was dismissed', async () => {
    const fp = 'skills/review/anchoring/history-read-whole'
    await publish([finding(fp)], { evidence: [evidence(fp, 'for (const entry of history) read(entry)')] })
    await dismiss(fp)

    const { cycleRunId } = await startCycleRun(db, { cycleId: fanCycleId, trigger: 'test' })
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
      findings: { findings: [finding(fp)] },
      coverage: { outcome: 'found' },
      artifacts: [],
      dismissalChecks: [{ fingerprint: fp, basis: 'intact' }],
    })

    assert.deepEqual(result.suppressed, [], 'staging is not silence')
    assert.equal(result.staged, 1)
    const [staged] = await db
      .select()
      .from(schema.stagedFindings)
      .where(eq(schema.stagedFindings.runId, run!.id))
    assert.equal(staged?.suppressedBy, null, 'withheld for triage is a different fact from suppressed')
  })

  /**
   * Nothing that runs unattended may create the silence. `applyAdjudications` already
   * refuses the status; this asserts the second half — that the freeze which arms a
   * dismissal happens on the human route and nowhere else.
   */
  test('only a person can arm a dismissal, and doing so anchors it', async () => {
    const fp = 'server/events/sse/gap-detection'
    await publish([finding(fp)], { evidence: [evidence(fp, 'if (event.seq !== last + 1) markGap(event.seq)')] })

    const body = await dismiss(fp, 'gaps are reported by the client already')
    assert.equal(body.finding.dismissedBasis, 'if (event.seq !== last + 1) markGap(event.seq)')

    const row = await rowOf(fp)
    assert.equal(row?.dismissedSeverity, 'medium')
    assert.ok(row?.dismissedAt, 'a dismissal with no date cannot be audited')
    assert.equal(row?.statusRun, null, 'a person overruling a run must not leave that run under the decision')
  })

  /**
   * The seam between the two halves, checked end to end rather than assumed.
   *
   * The control plane holds the anchor and cannot read a repository (§4.5); the runner
   * holds the tree and decides nothing. If the anchor never crosses that boundary, every
   * dismissal in the system silently downgrades to "standing on nobody having looked" —
   * which still suppresses, so nothing would fail and nothing would say so.
   */
  test('the anchor reaches the runner, and the silence reaches the run page', async () => {
    const fp = 'gateway/allowlist/dns-root/trailing-dot'
    await publish([finding(fp)], { evidence: [evidence(fp, 'return host === pattern || host.endsWith(`.${pattern}`)')] })
    await dismiss(fp, 'the gateway matcher already handles it')

    const { cycleRunId } = await startCycleRun(db, { cycleId, trigger: 'test' })
    const [job] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.cycleRunId, cycleRunId))
    const history = (await (await h.fetch(`/api/jobs/${job!.id}/history`)).json()) as {
      bases: Array<{ fingerprint: string; path: string; basis: string }>
    }
    const anchor = history.bases.find((b) => b.fingerprint === fp)
    assert.ok(anchor, 'a dismissal with no anchor on the wire can never lapse')
    assert.match(anchor.basis, /endsWith/)

    const { runId } = await publish([finding(fp)], { checks: [{ fingerprint: fp, basis: 'intact' }] })
    const detail = (await (await h.fetch(`/api/runs/${runId}`)).json()) as {
      produced: { suppressed: Array<{ dismissal: string; reason: string }> }
    }
    assert.equal(detail.produced.suppressed.length, 1)
    assert.equal(detail.produced.suppressed[0]?.dismissal, fp)
    assert.match(detail.produced.suppressed[0]?.reason ?? '', /dismissed as wontfix/)
  })

  /** Undismissing clears the anchor, or setting the status back would re-arm the old one. */
  test('taking a dismissal back disarms it', async () => {
    const fp = 'runner/workspace/cleanup/scratch-never-pruned'
    await publish([finding(fp)], { evidence: [evidence(fp, 'await mkdir(join(scratch, "patches", runId))')] })
    await dismiss(fp)
    const row = await rowOf(fp)
    const res = await h.fetch(`/api/findings/${row!.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'open', reason: 'changed my mind' }),
    })
    assert.equal(res.status, 200)
    const after = await rowOf(fp)
    assert.equal(after?.dismissedBasis, null)
    assert.equal(after?.dismissedAt, null)

    const { result } = await publish([finding(fp)], {
      checks: [{ fingerprint: fp, basis: 'intact' }],
    })
    assert.equal(result.suppressed.length, 0, 'the dismissal is gone, not dormant')
  })
})
