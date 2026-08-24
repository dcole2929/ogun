import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startCycleRun } from '../src/foreman/cycles.ts'
import { startHarness, truncate } from './harness.ts'

/**
 * `workers.*.requires` — a capability label a runner must advertise before it may claim
 * this worker's jobs — from the line in config.yaml to the machine that does or does not
 * get the work, and to the person who has to find out why nothing happened.
 *
 * The field was declared in the schema, documented, parsed, stored on `workers.config`,
 * echoed back by the API, and deliberately preserved through UI PATCH round-trips — and
 * read by nothing. Requirements were *derived* from `runtime` and `sandbox` alone, so a
 * worker asking for `gpu` was offered to every machine in the fleet and failed on
 * whichever one was free.
 *
 * Honouring it is the easy half. The half that matters is that requiring something no
 * machine advertises must not be silent: a `requires <@ labels` test that never matches
 * produces no error, no timeout, and no coverage row — just a `queued` job that stays,
 * indefinitely, looking exactly like one that is about to be picked up. That is the
 * failure shape principle 6 exists to forbid, and it is the one a one-line union
 * introduces if nobody adds the diagnostics with it.
 *
 * Where it is made visible, and the one obvious place it deliberately is not:
 *
 *  - `ogun project sync` reports it, because that is the moment somebody wrote the label.
 *  - `POST /api/trigger` reports it per node, because pressing run and being told
 *    "queued" is the moment a person concludes the system is working.
 *  - `GET /api/runs` tells the queue apart in three states rather than two: claimable, a
 *    capable machine that is offline, and nothing that has ever advertised the label.
 *  - The claim query keeps refusing the job, which is the behaviour being asked for.
 *  - **Not** admission. A refusal there is permanent — a `skipped` job and a `refused`
 *    coverage row — and "no runner advertises this" is a fact about this minute, not
 *    about the job. The GPU box being provisioned this afternoon, the laptop that has not
 *    re-run `ogun runner init` since the label was added: in each the job is waiting for
 *    a machine that is coming, and discarding it is worse than the wait. The wait was
 *    never the bug. Nobody being told was.
 */
describe('a worker gets only the runners it asked for', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  const slug = 'reqs'

  const sync = (workers: Record<string, unknown>) =>
    h.fetch('/api/projects/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug,
        defaultBranch: 'main',
        configHash: `h-${Math.random()}`,
        workers,
        policies: { maxConcurrentModifiers: 1, failureBreakerThreshold: 3 },
        skills: [{ name: 'review', sourcePath: '.agents/skills/review', versionHash: 'sv1' }],
      }),
    })

  const worker = (over: Record<string, unknown> = {}) => ({
    skill: 'review',
    runtime: 'claude',
    model: 'worker',
    permissions: 'reviewer',
    sandbox: 'container',
    onMissed: 'skip',
    enabled: true,
    timeoutMs: 600_000,
    ...over,
  })

  /**
   * A registered machine, with a heartbeat of our choosing — because "no machine
   * advertises this" and "the machine that does is asleep" are the two the queue view has
   * to keep apart, and only the timestamp tells them apart.
   */
  const register = async (name: string, labels: string[], secondsAgo = 0) => {
    await h.db.insert(schema.runners).values({
      name,
      labels,
      pending: false,
      lastSeenAt: new Date(Date.now() - secondsAgo * 1000),
    })
  }

  const queue = async (workerName: string) => {
    const cycle = await h.db.query.cycles.findFirst({ where: eq(schema.cycles.name, workerName) })
    assert.ok(cycle, `no cycle for ${workerName}`)
    const { jobIds } = await startCycleRun(h.db, { cycleId: cycle.id, trigger: 'test' })
    const [job] = await h.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobIds[0]!))
    return job!
  }

  const claim = async (runnerName: string, labels: string[]) => {
    const res = await h.fetch('/api/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runnerName, labels, capacity: 4 }),
    })
    return ((await res.json()) as { jobs: Array<{ jobId: string }> }).jobs
  }

  const pending = async () => {
    const res = await h.fetch('/api/runs?limit=50')
    return (await res.json()) as {
      pending: Array<{
        job: { id: string }
        worker: { name: string }
        requires: string[]
        reach: string
        missing: string[]
      }>
      liveRunners: number
    }
  }

  before(async () => {
    h = await startHarness()
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
  })

  after(async () => {
    await truncate(h.db)
    await h.stop()
  })

  /**
   * The union itself, at the only place it can be observed: the row the claim query
   * reads. Asserting on `jobs.requires` rather than on the function keeps this test about
   * the wiring — the derivation is unit-tested in core, and what broke here was that the
   * two were never connected.
   *
   * `docker` has to still be there. The tempting reading of "derived when omitted" is
   * that a declared list replaces the derived one, which would quietly hand a container
   * job to a machine with no Docker.
   */
  test('a declared label reaches the job row alongside the derived ones', async () => {
    await register('plain', ['claude', 'docker'])
    await sync({ 'needs-gpu': worker({ requires: ['gpu'] }) })

    const job = await queue('needs-gpu')
    assert.deepEqual(job.requires, ['claude', 'docker', 'gpu'])
  })

  /**
   * And the label is one the claim query acts on, not one it merely stores. Before the
   * union, this runner took the job — which is the whole bug, seen from the machine that
   * should not have been offered it.
   */
  test('a runner that does not advertise the label is not offered the job', async () => {
    assert.deepEqual(await claim('plain', ['claude', 'docker']), [])

    // And the same machine, once it advertises the label, takes it. Otherwise this test
    // would pass just as well against a queue that hands out nothing at all.
    await register('gpu-box', ['claude', 'docker', 'gpu'])
    const claimed = await claim('gpu-box', ['claude', 'docker', 'gpu'])
    assert.equal(claimed.length, 1)
  })

  /**
   * The diagnostic. A job whose labels nothing here advertises is reported as
   * `unmatched`, and — the part that makes it actionable — the response names the labels
   * rather than saying "nothing can run this", which sends a person to a Runners page
   * where every machine is green and correct.
   */
  test('a requirement no registered runner advertises is named, not left silent', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
    await register('plain', ['claude', 'docker'])
    await sync({ 'needs-vpn': worker({ requires: ['vpn'] }) })
    await queue('needs-vpn')

    const [row] = (await pending()).pending
    assert.equal(row?.reach, 'unmatched')
    assert.deepEqual(row?.missing, ['vpn'])
  })

  /**
   * The distinction the previous boolean could not make, and the reason it had to be
   * replaced rather than extended.
   *
   * A job whose only capable machine is rebooting was reported as "nothing can run this"
   * — false, and identical to the sentence shown when it is true. A person who sees that
   * message once about a machine that comes back ninety seconds later has learned to
   * disbelieve it, and the case it exists for is the one they will disbelieve.
   */
  test('a capable runner that is merely offline is a different answer from none at all', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
    // Registered, advertising everything the worker needs, and last seen five minutes ago.
    await register('asleep', ['claude', 'docker'], 300)
    await sync({ ordinary: worker() })
    await queue('ordinary')

    const offline = await pending()
    assert.equal(offline.pending[0]?.reach, 'offline')
    assert.deepEqual(offline.pending[0]?.missing, [], 'nothing is missing — the machine is')
    assert.equal(offline.liveRunners, 1)

    // The same job, once that machine checks in, is simply waiting its turn.
    await h.db
      .update(schema.runners)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.runners.name, 'asleep'))
    assert.equal((await pending()).pending[0]?.reach, 'claimable')
  })

  /**
   * The warning at the moment of writing, which is the only surface that reaches somebody
   * who never opens the UI — a nightly cycle on a headless box being the case this whole
   * feature is for.
   *
   * A disabled worker is excluded on purpose: it produces no jobs, so there is no queue
   * to explain, and a warning with no failure behind it is how a channel stops being
   * read.
   */
  test('sync says which labels this fleet cannot satisfy', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
    await register('plain', ['claude', 'docker'])

    const res = await sync({
      'needs-gpu': worker({ requires: ['gpu', 'staging-db'] }),
      ordinary: worker(),
      'switched-off': worker({ requires: ['gpu'], enabled: false }),
    })
    const body = (await res.json()) as {
      unmetRequirements: Array<{ worker: string; missing: string[] }>
      registeredRunners: number
    }
    assert.deepEqual(body.unmetRequirements, [
      { worker: 'needs-gpu', missing: ['gpu', 'staging-db'] },
    ])
    assert.equal(body.registeredRunners, 1)
  })

  /**
   * The noise case, and the reason `registeredRunners` travels with the list.
   *
   * On a control plane nobody has joined a runner to, *every* worker's requirements are
   * unmet — including `claude` and `docker`, which every worker has. A caller that
   * printed the list here would greet a fresh install with a wall of warnings about a
   * situation with one cause and one fix, and a warning seen on a correct setup is one
   * that stops being read. The count is what lets the CLI say the single true sentence
   * instead.
   */
  test('with no runner joined at all, the count is what distinguishes the situation', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })

    const res = await sync({ ordinary: worker() })
    const body = (await res.json()) as {
      unmetRequirements: Array<{ worker: string; missing: string[] }>
      registeredRunners: number
    }
    assert.equal(body.registeredRunners, 0)
    assert.deepEqual(body.unmetRequirements, [{ worker: 'ordinary', missing: ['claude', 'docker'] }])
  })

  /**
   * The interactive surface. `queued` is true and is also what a job about to start in
   * four seconds says, which is exactly what made this invisible: you press run, are told
   * it worked, and nothing ever happens. Admission's refusals were already explained here
   * — the accepted-but-unclaimable node was the one that got a bare word.
   */
  test('triggering a worker nothing can claim says so, rather than just "queued"', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
    await register('plain', ['claude', 'docker'])
    await sync({ 'needs-gpu': worker({ requires: ['gpu'] }), ordinary: worker() })

    const res = await h.fetch('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug: slug, worker: 'needs-gpu' }),
    })
    const body = (await res.json()) as {
      jobs: Array<{ state: string; reach: string; missing: string[] }>
    }
    assert.equal(body.jobs[0]?.state, 'queued', 'it is queued — that part was never wrong')
    assert.equal(body.jobs[0]?.reach, 'unmatched')
    assert.deepEqual(body.jobs[0]?.missing, ['gpu'])

    // And a worker this fleet can serve says nothing extra, so the warning stays worth
    // reading.
    const fine = await h.fetch('/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug: slug, worker: 'ordinary' }),
    })
    const ok = (await fine.json()) as { jobs: Array<{ reach: string; missing: string[] }> }
    assert.equal(ok.jobs[0]?.reach, 'claimable')
    assert.deepEqual(ok.jobs[0]?.missing, [])
  })

  /**
   * A revoked machine is one somebody took away and a `pending` one is an invite that has
   * never been run — its `labels` are still the empty default. Counting either as proof
   * that a capability exists here would suppress the one message that fits, on the
   * strength of a machine that cannot run anything.
   */
  test('a revoked or never-joined runner is not evidence that anything can run', async () => {
    await truncate(h.db)
    await h.db.insert(schema.projects).values({ slug, defaultBranch: 'main' })
    await h.db.insert(schema.runners).values([
      { name: 'gone', labels: ['claude', 'docker', 'gpu'], revokedAt: new Date() },
      { name: 'invited', labels: ['claude', 'docker', 'gpu'], pending: true },
    ])

    const res = await sync({ 'needs-gpu': worker({ requires: ['gpu'] }) })
    const body = (await res.json()) as { registeredRunners: number }
    assert.equal(body.registeredRunners, 0)

    await queue('needs-gpu')
    assert.equal((await pending()).pending[0]?.reach, 'unmatched')
  })
})
