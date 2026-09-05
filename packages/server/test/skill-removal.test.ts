import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness, truncate } from './harness.ts'

/**
 * A skill that is no longer on disk loses its row.
 *
 * The upsert has always overwritten wholesale, "including nulling fields that
 * disappeared", on the grounds that the row is an index of a file and a stale half of it
 * is worse than none. Nothing applied that to the row itself, so a deleted skill was
 * indexed forever: `fix-a-finding` was removed from `skills/` in one commit and was still
 * in the table two syncs later, bound to nothing, indistinguishable in the UI from a
 * skill somebody had written and not yet wired up.
 *
 * It is the quiet kind of wrong. Nothing errors, nothing is missing, and the only visible
 * trace is a `no worker uses this` pill that reads as a to-do rather than as a ghost.
 */
describe('a skill that is gone from disk goes from the index', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  const slug = 'skillrm'

  const skill = (name: string) => ({
    name,
    sourcePath: `.agents/skills/${name}`,
    versionHash: `${name}-v1`,
  })

  const sync = (skills: Array<ReturnType<typeof skill>>, workers: Record<string, unknown> = {}) =>
    h.fetch('/api/projects/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug,
        defaultBranch: 'main',
        configHash: `h-${Math.random()}`,
        workers,
        policies: { maxConcurrentModifiers: 1, failureBreakerThreshold: 3 },
        skills,
      }),
    })

  const worker = (skillName: string) => ({
    skill: skillName,
    runtime: 'claude',
    model: 'worker',
    permissions: 'reviewer',
    sandbox: 'container',
    onMissed: 'skip',
    enabled: true,
    timeoutMs: 600_000,
  })

  const indexed = async (): Promise<string[]> =>
    (await h.db.select().from(schema.skills))
      .map((s) => s.name)
      .sort()

  before(async () => {
    h = await startHarness()
  })

  after(async () => {
    await h.stop()
  })

  test('a skill dropped from the payload loses its row, and the rest survive', async () => {
    await truncate(h.db)
    await sync([skill('review'), skill('triage'), skill('fix-a-finding')])
    assert.deepEqual(await indexed(), ['fix-a-finding', 'review', 'triage'])

    const res = await sync([skill('review'), skill('triage')])
    assert.equal(res.status, 200)

    assert.deepEqual(await indexed(), ['review', 'triage'], 'only the deleted one goes')
    // Said out loud, because a sync that deletes quietly is a sync you cannot check.
    const body = (await res.json()) as { removedSkills?: string[] }
    assert.deepEqual(body.removedSkills, ['fix-a-finding'])
  })

  /**
   * The consequence for anything still pointing at it. `workers.skill_id` is
   * `ON DELETE SET NULL`, so the binding goes and the *reference* stays — which is the
   * honest description of a worker naming a skill nothing has indexed, and is what the
   * Workers page filters as "not indexed".
   */
  test('a worker still naming it keeps the reference and loses the binding', async () => {
    await truncate(h.db)
    await sync([skill('review')], { nightly: worker('review') })

    const before = await h.db.query.workers.findFirst({ where: eq(schema.workers.name, 'nightly') })
    assert.ok(before?.skillId, 'bound while the skill is indexed')

    // The skill goes; the worker in config.yaml still names it.
    await sync([], { nightly: worker('review') })

    const after = await h.db.query.workers.findFirst({ where: eq(schema.workers.name, 'nightly') })
    assert.equal(after?.skillId, null, 'the binding is dropped rather than dangling')
    assert.equal(after?.skillRef, 'review', 'and what it asked for is still recorded')
  })

  /**
   * Discovering nothing indexes nothing, which follows `reindexProject`'s removal of
   * workers deliberately. It is not reachable through the CLI — `discoverSkills` is
   * always handed Ogun's own built-in root — but an exception for it would mean a project
   * could never lose its last skill, and `inArray` with an empty list is not valid SQL,
   * so the case has to be handled either way. Better handled than accidentally.
   */
  test('an empty skill set empties the index rather than being ignored', async () => {
    await truncate(h.db)
    await sync([skill('review'), skill('triage')])
    assert.equal((await indexed()).length, 2)

    await sync([])
    assert.deepEqual(await indexed(), [])
  })

  /** One project's sync must not reach into another's rows. */
  test('removal is scoped to the project being synced', async () => {
    await truncate(h.db)
    await sync([skill('review'), skill('shared')])

    await h.fetch('/api/projects/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'other',
        defaultBranch: 'main',
        configHash: 'o1',
        workers: {},
        policies: { maxConcurrentModifiers: 1, failureBreakerThreshold: 3 },
        skills: [skill('shared')],
      }),
    })

    // `other` has never had `review`; syncing it must not delete the one `skillrm` has.
    const rows = await h.db.select().from(schema.skills)
    const project = await h.db.query.projects.findFirst({ where: eq(schema.projects.slug, slug) })
    const mine = rows.filter((r) => r.projectId === project?.id).map((r) => r.name).sort()
    assert.deepEqual(mine, ['review', 'shared'])
  })
})
