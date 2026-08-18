import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness, type Harness } from './harness.ts'
import { ConfigConflict, createLocalConfigStore, workerToYamlBlock } from '../src/config-store.ts'
import { reindexProject } from '../src/reindex.ts'
import type { WorkerConfig } from '@ogun/core'


const CONFIG = `project:
  name: SLUG
  defaultBranch: main

workers:
  nightly:
    skill: review
    runtime: claude
    # A comment a human wrote, against a field nothing is going to touch.
    schedule: "0 3 * * *"

policies:
  directPush: false
`

const defaults: WorkerConfig = {
  skill: 'review',
  runtime: 'claude',
  model: 'worker',
  permissions: 'reviewer',
  sandbox: 'container',
  onMissed: 'skip',
  enabled: true,
  timeoutMs: 1_800_000,
}

/**
 * The control plane edits a repo's config.yaml on behalf of the UI. These guard the two
 * things that would make that untrustworthy: mangling a file you hand-wrote, and
 * changing something you did not ask it to change.
 */
describe('config store', () => {
  let root = ''
  const slug = 'demo'
  const store = () => createLocalConfigStore(join(root, 'projects.json'))
  const configPath = () => join(root, 'repo', '.ogun', 'config.yaml')

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogun-config-'))
    await mkdir(join(root, 'repo', '.ogun'), { recursive: true })
    await writeFile(configPath(), CONFIG.replace('SLUG', slug))
    await writeFile(
      join(root, 'projects.json'),
      JSON.stringify({ projects: { [slug]: join(root, 'repo') } }),
    )
  })

  test('comments, ordering, and quoting survive a write', async () => {
    await store().mutate(slug, undefined, (doc) => {
      doc.setIn(['workers', 'added'], { skill: 'review', runtime: 'codex' })
    })
    const text = await readFile(configPath(), 'utf8')

    assert.match(text, /# A comment a human wrote/, 'a comment was lost')
    assert.match(text, /schedule: "0 3 \* \* \*"/, 'quoting style changed')
    assert.ok(text.indexOf('project:') < text.indexOf('workers:'), 'key order changed')
    assert.match(text, /^ {2}added:$/m)
  })

  test('a stale hash is refused rather than silently overwriting', async () => {
    await assert.rejects(() => store().mutate(slug, 'notthecurrenthash', () => {}), ConfigConflict)
  })

  test('an invalid result is refused and the file is left untouched', async () => {
    const before = await readFile(configPath(), 'utf8')
    await assert.rejects(
      () =>
        store().mutate(slug, undefined, (doc) => {
          // runtime must be claude | codex. The UI must not be able to leave a file the
          // next `ogun project sync` refuses to load.
          doc.setIn(['workers', 'bad'], { skill: 'review', runtime: 'perl' })
        }),
      /refusing to write an invalid config\.yaml/,
    )
    assert.equal(await readFile(configPath(), 'utf8'), before)
  })

  test('an unreachable project is reported, not thrown away', async () => {
    // The hosted-control-plane case: no local repo, so the caller renders yaml instead.
    assert.equal(await store().writable('not-a-project'), false)
  })

  test('fields left at their default do not clutter the file', async () => {
    const yaml = workerToYamlBlock('tidy', defaults)
    assert.equal(yaml, '  tidy:\n    skill: review')
  })

  test('fields that differ from the default are written', async () => {
    const yaml = workerToYamlBlock('busy', { ...defaults, runtime: 'codex', model: 'reviewer' })
    assert.match(yaml, /runtime: codex/)
    assert.match(yaml, /model: reviewer/)
  })
})

describe('worker api', () => {
  let h: Awaited<ReturnType<typeof startHarness>>
  let db: Awaited<ReturnType<typeof startHarness>>['db']
  const slug = `wtest-${Date.now()}`
  let root = ''
  let configPath = ''

  const send = (path: string, body: unknown, method = 'POST') =>
    h.fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const errorOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error?: string }).error ?? ''


  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogun-api-'))
    configPath = join(root, '.ogun', 'config.yaml')
    await mkdir(join(root, '.ogun'), { recursive: true })
    await writeFile(configPath, CONFIG.replace('SLUG', slug))

    // A project map scoped to this test, so editing config.yaml on behalf of the UI
    // cannot reach a repository you actually work in.
    const mapPath = join(root, 'projects.json')
    await writeFile(mapPath, JSON.stringify({ projects: { [slug]: root } }))
    h = await startHarness(createLocalConfigStore(mapPath))
    db = h.db

    await send('/api/projects/sync', {
      slug,
      defaultBranch: 'main',
      configHash: 'h1',
      workers: { nightly: defaults },
      policies: {
        directPush: false,
        allowSandboxDowngrade: false,
        maxConcurrentModifiers: 1,
        failureBreakerThreshold: 3,
      },
      skills: [{ name: 'review', sourcePath: '.agents/skills/review', versionHash: 'sv1' }],
    })
  })

  after(async () => {
    await h.stop()
  })

  const state = async (name: string) => {
    const res = await h.fetch(`/api/workers?project=${slug}`)
    const body = (await res.json()) as {
      workers: Array<{ worker: { id: string; name: string; runtime: string; modelRole: string } }>
      editable: Record<string, boolean>
      hashes: Record<string, string>
    }
    return {
      worker: body.workers.find((w) => w.worker.name === name)?.worker,
      editable: body.editable[slug],
      hash: body.hashes[slug],
    }
  }

  test('the control plane reports whether it can edit this project', async () => {
    assert.equal((await state('nightly')).editable, true)
  })

  test('creating a worker writes it into config.yaml and indexes it', async () => {
    const res = await send('/api/workers', {
      projectSlug: slug,
      name: 'from-ui',
      skill: 'review',
      runtime: 'codex',
      model: 'reviewer',
      prompt: 'Look at the auth boundary.',
    })
    assert.equal(res.status, 201)

    const text = await readFile(configPath, 'utf8')
    assert.match(text, /^ {2}from-ui:$/m)
    assert.match(text, /runtime: codex/)
    assert.ok((await state('from-ui')).worker, 'it should be triggerable immediately')
  })

  test('a patch does not reset fields it never mentioned', async () => {
    // zod's .partial() keeps .default() in place, so an update schema built that way
    // arrives fully populated and quietly rewrites the fields you left alone.
    const { worker } = await state('from-ui')
    await send(`/api/workers/${worker!.id}`, { sandbox: 'worktree' }, 'PATCH')

    const after = (await state('from-ui')).worker
    assert.equal(after?.runtime, 'codex', 'runtime was reset')
    assert.equal(after?.modelRole, 'reviewer', 'model role was reset')
    assert.match(await readFile(configPath, 'utf8'), /prompt: Look at the auth boundary\./)
  })

  test('a stale hash from the client is refused', async () => {
    const { worker } = await state('from-ui')
    const res = await send(
      `/api/workers/${worker!.id}`,
      { runtime: 'claude', expectedHash: 'stale000stale000' },
      'PATCH',
    )
    assert.equal(res.status, 409)
    assert.match(await errorOf(res), /changed since/)
  })

  test('deleting removes it from the file and from the index', async () => {
    const { worker } = await state('from-ui')
    const res = await h.fetch(`/api/workers/${worker!.id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.ok(!(await readFile(configPath, 'utf8')).includes('from-ui'))
    assert.equal((await state('from-ui')).worker, undefined)
  })

  test('a hand-edit reaching reindex converges with what the api produces', async () => {
    // The two write paths have to meet, or the file and the index drift apart.
    await reindexProject(db, slug, {
      hash: 'h2',
      workers: { nightly: defaults, 'by-hand': defaults },
    })
    assert.ok((await state('by-hand')).worker)

    // And a worker gone from the file is gone from the index.
    await reindexProject(db, slug, { hash: 'h3', workers: { nightly: defaults } })
    assert.equal((await state('by-hand')).worker, undefined)
  })

  test('a worker pointing at a missing skill is refused before the file is touched', async () => {
    const before = await readFile(configPath, 'utf8')
    const res = await send('/api/workers', {
      projectSlug: slug,
      name: 'ghost',
      skill: 'not-a-skill',
    })
    assert.equal(res.status, 400)
    assert.match(await errorOf(res), /no skill named/)
    assert.equal(await readFile(configPath, 'utf8'), before)
  })

  test('a modifier cannot be put on a worktree sandbox', async () => {
    const res = await send('/api/workers', {
      projectSlug: slug,
      name: 'risky',
      skill: 'review',
      permissions: 'modifier',
      sandbox: 'worktree',
    })
    assert.equal(res.status, 400)
    assert.match(await errorOf(res), /directly on the host/)
  })
})

/**
 * A cycle is defined in the same file as the workers it runs, and `reindexProject`
 * deletes any named cycle the file it is handed does not mention. So every path that
 * hands it a file has to carry the cycles too — the UI's write-through as much as
 * `ogun project sync`.
 *
 * It did not. `ConfigStore` returned workers only, so one PATCH from the Workers page
 * deleted `nightly` and, by `schedules.cycle_id`'s cascade, the 3am schedule with it,
 * while leaving the `cycles:` block in config.yaml looking untouched. Nothing failed and
 * nothing ran.
 */
describe('a ui edit does not disturb the cycles in the same file', () => {
  const slug = 'cyc'
  const CYCLE_CONFIG = `project:
  name: ${slug}
  defaultBranch: main

workers:
  reviewer-a:
    skill: review
  reviewer-b:
    skill: review
  triage:
    skill: review

cycles:
  nightly:
    workers: [reviewer-a, reviewer-b]
    then: triage
    schedule: "0 3 * * *"
`

  let h: Harness
  let root = ''
  let configPath = ''

  const cyclesNow = async (): Promise<Array<{ name: string; nodes: number; cron: string | null }>> => {
    const res = await h.fetch(`/api/projects/${slug}/cycles`)
    const body = (await res.json()) as {
      cycles: Array<{ id: string; name: string; definition: { nodes: unknown[] } }>
    }
    const rows = await h.db.select().from(schema.schedules)
    return body.cycles.map((c) => ({
      name: c.name,
      nodes: c.definition.nodes.length,
      cron: rows.find((s) => s.cycleId === c.id)?.cron ?? null,
    }))
  }

  /** What `ogun project sync` posts — sugar already expanded, as the CLI expands it. */
  const sync = (cycles: unknown, configHash = 'c1') =>
    h.fetch('/api/projects/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug,
        defaultBranch: 'main',
        configHash,
        workers: {
          'reviewer-a': defaults,
          'reviewer-b': defaults,
          triage: defaults,
        },
        cycles,
        policies: {
          directPush: false,
          allowSandboxDowngrade: false,
          maxConcurrentModifiers: 1,
          failureBreakerThreshold: 3,
        },
        skills: [{ name: 'review', sourcePath: '.agents/skills/review', versionHash: 'sv1' }],
      }),
    })

  const fanIn = {
    nodes: [
      { key: 'reviewer-a', worker: 'reviewer-a' },
      { key: 'reviewer-b', worker: 'reviewer-b' },
      { key: 'triage', worker: 'triage' },
    ],
    edges: [
      { from: 'reviewer-a', to: 'triage', onDepFailure: 'degrade' },
      { from: 'reviewer-b', to: 'triage', onDepFailure: 'degrade' },
    ],
    schedule: '0 3 * * *',
    onMissed: 'skip',
    enabled: true,
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogun-cycles-'))
    configPath = join(root, '.ogun', 'config.yaml')
    await mkdir(join(root, '.ogun'), { recursive: true })
    await writeFile(configPath, CYCLE_CONFIG)

    const mapPath = join(root, 'projects.json')
    await writeFile(mapPath, JSON.stringify({ projects: { [slug]: root } }))
    h = await startHarness(createLocalConfigStore(mapPath))

    await sync({ nightly: fanIn })
  })

  after(async () => {
    await h.stop()
  })

  test('the cycle and its schedule survive a worker patch', async () => {
    const before = await cyclesNow()
    const nightly = before.find((c) => c.name === 'nightly')
    assert.equal(nightly?.nodes, 3, 'precondition: the fan-in is registered')
    assert.equal(nightly?.cron, '0 3 * * *', 'precondition: the cycle owns the schedule')

    const list = (await (await h.fetch(`/api/workers?project=${slug}`)).json()) as {
      workers: Array<{ worker: { id: string; name: string } }>
      hashes: Record<string, string>
    }
    const target = list.workers.find((w) => w.worker.name === 'reviewer-a')!.worker

    const res = await h.fetch(`/api/workers/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedHash: list.hashes[slug], enabled: true }),
    })
    assert.equal(res.status, 200)

    const after = (await cyclesNow()).find((c) => c.name === 'nightly')
    assert.equal(after?.nodes, 3, 'the ui edit deleted the cycle')
    assert.equal(after?.cron, '0 3 * * *', 'the cycle survived but its schedule cascaded away')
  })

  test('a graph that could never finish is refused, and nothing is written', async () => {
    /**
     * The payload schema checks the shape of a definition, not what its graph does, so a
     * loop can still arrive here from an older CLI or anything posting by hand. Stored,
     * it becomes a 3am run with every job `blocked` and no error to find in the morning.
     *
     * The refusal has to come before any write: this payload also drops `nightly`, and
     * `reindexProject` deletes cycles a file does not mention. A half-applied sync would
     * take the working fan-in down with the broken graph.
     */
    const res = await sync(
      {
        knotted: {
          nodes: [
            { key: 'reviewer-a', worker: 'reviewer-a' },
            { key: 'reviewer-b', worker: 'reviewer-b' },
          ],
          edges: [
            { from: 'reviewer-a', to: 'reviewer-b', onDepFailure: 'block' },
            { from: 'reviewer-b', to: 'reviewer-a', onDepFailure: 'block' },
          ],
          onMissed: 'skip',
          enabled: true,
        },
      },
      'c2',
    )
    // 400, not 500: the graph is wrong because of what someone typed, and the message
    // names the loop to go and cut. Reported as an internal error, it reads as "the
    // control plane is broken" and the one useful sentence looks like a stack trace.
    assert.equal(res.status, 400, 'a config someone mistyped was reported as a server fault')
    assert.match(
      ((await res.json()) as { error?: string }).error ?? '',
      /cycle "knotted" could never finish — a loop, so nothing in it can ever start: reviewer-a → reviewer-b → reviewer-a/,
    )

    const after = await cyclesNow()
    assert.ok(!after.some((c) => c.name === 'knotted'), 'the loop was stored anyway')
    assert.equal(after.find((c) => c.name === 'nightly')?.cron, '0 3 * * *', 'the sync half-applied')
  })

  test('an edge naming a node that does not exist is refused as well', async () => {
    // Same hang, quieter cause: reviewer-b waits on a key nothing will ever report against.
    const res = await sync(
      {
        dangling: {
          nodes: [{ key: 'reviewer-b', worker: 'reviewer-b' }],
          edges: [{ from: 'triaje', to: 'reviewer-b', onDepFailure: 'block' }],
          onMissed: 'skip',
          enabled: true,
        },
      },
      'c3',
    )
    assert.equal(res.status, 400, 'a config someone mistyped was reported as a server fault')
    assert.match(
      ((await res.json()) as { error?: string }).error ?? '',
      /no node has the key "triaje"/,
    )
  })

  /**
   * The CLI has always refused this before posting, but nothing on the server did, so a
   * payload from an older CLI or from the UI's own sync was stored and only failed when
   * someone pressed run — `startCycleRun` throwing `cycle references unknown worker`,
   * hours later and nowhere near the file that says it.
   */
  test('a cycle naming a worker that does not exist is refused at sync, not at trigger', async () => {
    const res = await sync(
      {
        typo: {
          nodes: [
            { key: 'reviewer-a', worker: 'reviewer-a' },
            { key: 'triage', worker: 'triaje' },
          ],
          edges: [{ from: 'reviewer-a', to: 'triage', onDepFailure: 'block' }],
          onMissed: 'skip',
          enabled: true,
        },
      },
      'c4',
    )
    assert.equal(res.status, 400, 'a cycle pointing at a worker that does not exist was stored')
    assert.match(
      ((await res.json()) as { error?: string }).error ?? '',
      /cycle "typo" refers to worker "triaje", which is not defined/,
    )

    const after = await cyclesNow()
    assert.ok(!after.some((c) => c.name === 'typo'), 'the broken cycle was stored anyway')
    assert.equal(after.find((c) => c.name === 'nightly')?.cron, '0 3 * * *', 'the sync half-applied')
  })

  /**
   * The same refusal reached through the Workers page, which catches its own errors
   * rather than falling through to `app.onError` — the two have to agree, or the fix
   * holds for `ogun project sync` and not for the UI that writes the same file.
   */
  test('a worker whose name a cycle already has is a 400 from the workers route', async () => {
    const res = await h.fetch('/api/workers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectSlug: slug, name: 'nightly', skill: 'review' }),
    })
    assert.equal(res.status, 400, 'a name collision in the file was reported as a server fault')
    assert.match(
      ((await res.json()) as { error?: string }).error ?? '',
      /cycle "nightly" has the same name as a worker — rename one/,
    )

    // Refused before anything is written, so the collision does not also leave a worker
    // row behind for a worker the page just told you it would not create.
    const list = (await (await h.fetch(`/api/workers?project=${slug}`)).json()) as {
      workers: Array<{ worker: { name: string } }>
    }
    assert.ok(
      !list.workers.some((w) => w.worker.name === 'nightly'),
      'the refused worker was inserted anyway',
    )
  })

  test('the cycles block in config.yaml is left exactly as written', async () => {
    const text = await readFile(configPath, 'utf8')
    assert.match(text, /workers: \[reviewer-a, reviewer-b\]/)
    assert.match(text, /then: triage/)
  })
})
