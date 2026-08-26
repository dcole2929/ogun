import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness } from './harness.ts'
import { admit, modifierReadiness } from '../src/foreman/admission.ts'

/**
 * The one exemption from modifier readiness, and the two properties that keep it from
 * being a hole (§4.3, ADR-0016).
 *
 * A modifier is refused unless its project has a `.ogun/Dockerfile` and a
 * `tests.command`. Both are files in the repository, which makes the refusal circular for
 * the repository that has neither: the fix is a patch, a patch needs a modifier, and a
 * modifier needs the fix. `bootstrap: project-image` is the door out.
 *
 * What is asserted here is admission's half. The other half — that the swapped-in gate
 * refuses any patch that is not a containerisation, so the exemption buys nothing on an
 * ordinary worker — is `runner/test/project-image-gate.test.ts`, and the third half is
 * `workerSchema`, which refuses the field on a worker that is not the one it was written
 * for.
 */

const policies = { maxConcurrentModifiers: 1, failureBreakerThreshold: 3 }

describe('the bootstrap exemption', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `bootstrap-${Date.now()}`
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
        name: 'containerise',
        skillRef: 'containerise-a-project',
        runtime: 'claude',
        versionHash: 'v1',
        permissions: 'modifier',
        config: { bootstrap: 'project-image' },
      })
      .returning()
    workerId = w!.id
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId))
    await h.stop()
  })

  /**
   * The whole point of the slice: the project that has neither file is exactly the project
   * this worker exists for, and it is the one an ordinary modifier is refused against.
   */
  test('a project with no image and no test command admits the worker that would write them', async () => {
    const readiness = modifierReadiness(slug, { root: '/repo', hasImage: false })
    assert.equal(readiness.ready, false)

    const ordinary = await admit(db, { id: workerId, permissions: 'modifier' }, policies, readiness)
    assert.equal(ordinary.allowed, false, 'an ordinary modifier is still refused')

    const bootstrap = await admit(
      db,
      { id: workerId, permissions: 'modifier', bootstrap: 'project-image' },
      policies,
      readiness,
    )
    assert.equal(bootstrap.allowed, true)
  })

  /**
   * The exemption covers the two files and nothing else. A control plane with no local
   * path for the project cannot confirm *anything* about it — including what is missing —
   * so the honest answer is the one every other modifier gets, and the fix is
   * `ogun project sync` rather than a worker. Waving this through would have the worker
   * dispatched against a repository the runner then cannot publish from either.
   */
  test('a project this control plane cannot find on disk is refused, exemption or not', async () => {
    const readiness = modifierReadiness(slug, { hasImage: false })
    assert.equal(readiness.ready, false)
    assert.notEqual(
      readiness.ready === false ? readiness.bootstrappable : true,
      true,
      'an unreachable repository is not something a worker can write its way out of',
    )

    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier', bootstrap: 'project-image' },
      policies,
      readiness,
    )
    assert.equal(verdict.allowed, false)
    assert.match(verdict.allowed === false ? verdict.reason : '', /project sync/)
  })

  /**
   * Whether the exemption expires: it does, by construction rather than by rule.
   *
   * A project that already has both files passes ordinary readiness, so the branch that
   * consults `bootstrappable` is never reached and no exemption is spent. That makes a
   * second run an *upgrade* — a legitimate thing to want, since a toolchain moves — still
   * held to the `project-image` gate, which builds the new Dockerfile and runs the new
   * command inside it. The alternative, refusing outright once a project is ready, would
   * make the only way to change a project image the hand-written edit this whole mechanism
   * exists to remove.
   */
  test('a project that is already ready spends no exemption, and the worker still runs', async () => {
    const readiness = modifierReadiness(slug, {
      root: '/repo',
      hasImage: true,
      testCommand: 'pnpm -s test',
    })
    assert.deepEqual(readiness, { ready: true })

    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier', bootstrap: 'project-image' },
      policies,
      readiness,
    )
    assert.equal(verdict.allowed, true)
  })

  /**
   * The exemption is spelled as one name, compared against one name. A worker whose stored
   * config carries something else — an older build, a value written into the jsonb column
   * by hand — must not match, because "I do not recognise this" and "this is the exemption"
   * are the two answers that must never be confused in the admitting direction.
   */
  test('an unrecognised bootstrap value does not exempt anything', async () => {
    const readiness = modifierReadiness(slug, { root: '/repo', hasImage: false })
    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier', bootstrap: 'everything' },
      policies,
      readiness,
    )
    assert.equal(verdict.allowed, false)
  })

  /**
   * Order of refusals. `maxConcurrentModifiers: 0` is the project saying no modifier runs
   * here at all, and it is answered ahead of readiness for a reason the exemption does not
   * change: several refusals can be true at once and the first one is the sentence a person
   * is left holding. Told instead that its project has no Dockerfile, somebody writes one
   * and the worker still does not run.
   */
  test('a project that has switched modifiers off says so, exemption or not', async () => {
    const verdict = await admit(
      db,
      { id: workerId, permissions: 'modifier', bootstrap: 'project-image' },
      { maxConcurrentModifiers: 0, failureBreakerThreshold: 3 },
      modifierReadiness(slug, { root: '/repo', hasImage: false }),
    )
    assert.equal(verdict.allowed, false)
    assert.match(verdict.allowed === false ? verdict.reason : '', /maxConcurrentModifiers: 0/)
  })
})
