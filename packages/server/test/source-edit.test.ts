import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness, type Harness } from './harness.ts'
import { createLocalConfigStore } from '../src/config-store.ts'

/**
 * Editing a source from the UI, which writes `.ogun/config.yaml` and reindexes — the
 * same contract the worker routes keep, because it is the same file.
 */
describe('a source can be edited from the ui', () => {
  const slug = 'srcedit'
  // Deliberately the *old* shape, because migrating one by saving it is the case most
  // likely to be wrong and the one every existing project is in.
  const CONFIG = `project:
  name: ${slug}
  defaultBranch: main

workers:
  scope:
    skill: review

sources:
  tickets:
    kind: linear
    cycle: scope
    team: ENG
    pollMinutes: 5
    filter:
      status: [Todo]
      labels: [ogun]
`

  let h: Harness
  let configPath = ''
  let projectId = ''

  /** The source node as the file now holds it. */
  const readSource = async (): Promise<Record<string, unknown>> => {
    const file = parseYaml(await readFile(configPath, 'utf8')) as {
      sources?: Record<string, Record<string, unknown>>
    }
    const source = file.sources?.tickets
    assert.ok(source, 'the source is still in the file')
    return source
  }

  const row = async () =>
    h.db.query.sources.findFirst({ where: eq(schema.sources.projectId, projectId) })

  const edit = (body: unknown) =>
    h.fetch(`/api/projects/${slug}/sources/tickets`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const valid = {
    cycle: 'scope',
    pollMinutes: 15,
    maxPerPoll: 3,
    maxPages: 4,
    enabled: true,
    conditions: {
      team: ['EXC', 'HEI'],
      status: ['Todo', 'In Progress'],
      label: { all_of: [], any_of: ['admin', 'agent-ready'], none_of: ['wip'] },
      notBlocked: true,
    },
  }

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ogun-srcedit-'))
    configPath = join(root, '.ogun', 'config.yaml')
    await mkdir(join(root, '.ogun'), { recursive: true })
    await writeFile(configPath, CONFIG)
    await mkdir(join(root, '.agents', 'skills', 'review'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: a review skill\n---\n\nReview.\n',
    )
    const mapPath = join(root, 'projects.json')
    await writeFile(mapPath, JSON.stringify({ projects: { [slug]: root } }))
    h = await startHarness(createLocalConfigStore(mapPath))
    await h.fetch(`/api/projects/${slug}/sync-local`, { method: 'POST' })
    projectId = (await h.db.query.projects.findFirst({
      where: eq(schema.projects.slug, slug),
    }))!.id
  })

  after(async () => {
    await h.stop()
  })

  test('the edit reaches the file and the index together', async () => {
    const res = await edit(valid)
    assert.equal(res.status, 200, await res.text())

    const source = await readSource()
    assert.equal(source.pollMinutes, 15)
    assert.deepEqual((source.conditions as Record<string, unknown>).team, ['EXC', 'HEI'])

    const indexed = await row()
    assert.equal((indexed?.config as { pollMinutes: number }).pollMinutes, 15, 'and the row')
  })

  /**
   * Saving migrates the node. Setting keys individually — which is what the worker edit
   * does, to preserve comments — would leave `team:` and `filter:` beside the new
   * `conditions:`, and the lift only reads them when `conditions` is absent. A file whose
   * meaning depends on which of two blocks the reader notices is worse than a lost
   * comment.
   */
  test('saving replaces the legacy shape rather than layering on top of it', async () => {
    const source = await readSource()
    assert.ok(!('filter' in source), 'the old filter block is gone')
    assert.ok(!('team' in source), 'and the old top-level team with it')
    assert.ok('conditions' in source)
  })

  test('the poll cursor survives an edit', async () => {
    const polledAt = new Date('2026-02-02T00:00:00.000Z')
    await h.db
      .update(schema.sources)
      .set({ lastPolledAt: polledAt })
      .where(eq(schema.sources.projectId, projectId))

    const res = await edit({ ...valid, pollMinutes: 9 })
    assert.equal(res.status, 200)
    assert.equal(
      (await row())?.lastPolledAt?.toISOString(),
      polledAt.toISOString(),
      'an edit must not re-poll immediately — that is a rate limit spent per keystroke',
    )
  })

  test('disabling it stops the poll without deleting the definition', async () => {
    const res = await edit({ ...valid, enabled: false })
    assert.equal(res.status, 200)
    assert.equal((await row())?.enabled, false)
    const source = await readSource()
    assert.equal(source.enabled, false, 'and the file says so, since the file is the truth')
  })

  test('a cycle that does not exist is refused here, not five minutes later in a table', async () => {
    const res = await edit({ ...valid, cycle: 'nope' })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as { error: string }).error, /no worker or cycle named "nope"/)
  })

  test('conditions with no status are refused', async () => {
    const res = await edit({ ...valid, conditions: { ...valid.conditions, status: [] } })
    assert.equal(res.status, 400, 'a source with no status fires on the whole team')
  })

  test('a stale hash is a conflict rather than a silent overwrite', async () => {
    const res = await edit({ ...valid, expectedHash: 'not-the-current-hash' })
    assert.equal(res.status, 409)
  })

  /**
   * The suggestions endpoint, on a project with no Linear credential — which is every
   * project in these tests, and more importantly the state that matters most in real use.
   *
   * **A 200, deliberately.** The suggestions are an aid to a form, not its content, and
   * every way they can be missing (never connected, grant lapsed, Linear down) is a
   * reason to type the value instead. A 4xx here would put the client's error path in
   * charge of whether a source can be edited, and the source whose credential just died
   * is precisely the one somebody is opening the editor to fix.
   *
   * No network reaches Linear: `readProjectSecret` finds nothing for this slug, so the
   * refusal is decided locally and the request never leaves the process.
   */
  test('the suggestions endpoint answers without a credential, and says why it is empty', async () => {
    const res = await h.fetch(`/api/projects/${slug}/linear-options`)
    assert.equal(res.status, 200)

    const body = (await res.json()) as {
      teams: unknown[]
      states: unknown[]
      labels: unknown[]
      reachable: boolean
      reason: string
    }
    assert.equal(body.reachable, false)
    // The lists are present and the right type even when unreachable, so a form can map
    // over them without a guard — the flag is what says whether to believe them.
    assert.deepEqual([body.teams, body.states, body.labels], [[], [], []])
    // And the reason carries the command that fixes it, rather than "could not fetch".
    assert.match(body.reason, /not connected to linear/)
    assert.match(body.reason, /ogun connect linear --project srcedit/)
  })

  test('the suggestions endpoint 404s for a project that does not exist', async () => {
    const res = await h.fetch('/api/projects/no-such-project/linear-options')
    assert.equal(res.status, 404)
  })

  /**
   * Every field the editor writes is also a field it can read.
   *
   * This is the regression test for a bug that every stubbed test missed: `maxPerPoll`
   * and `maxPages` were saved by the form and never returned by the listing, so the card
   * rendered "at most  per poll" with a hole in it and the editor seeded its input with
   * the string "undefined". The e2e fixture happened to include both keys, so the browser
   * tests passed against a server that did not exist. It took pointing the page at a real
   * one to see it.
   *
   * Asserted as a round trip rather than as two field checks, because the property that
   * matters is the pairing — a form that cannot read what it saves overwrites it.
   */
  test('everything the editor saves comes back in the listing', async () => {
    const res = await edit({ ...valid, maxPerPoll: 7, maxPages: 2, pollMinutes: 11 })
    assert.equal(res.status, 200, await res.text())

    const listed = await (await h.fetch(`/api/projects/${slug}/sources`)).json()
    const source = (listed as { sources: Record<string, unknown>[] }).sources[0]!

    for (const [key, expected] of Object.entries({
      cycle: 'scope',
      pollMinutes: 11,
      maxPerPoll: 7,
      maxPages: 2,
      enabled: true,
    })) {
      assert.equal(source[key], expected, `the listing carries ${key}`)
    }
    assert.deepEqual(source.conditions, valid.conditions, 'and the conditions, unchanged')
  })
})

