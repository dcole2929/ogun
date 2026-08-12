import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createDb, schema } from '@ogun/core/db'
import { ConfigConflict, createLocalConfigStore, workerToYamlBlock } from '../src/config-store.ts'
import { reindexProject } from '../src/reindex.ts'
import { loadLocalConfig, updateLocalConfig, type WorkerConfig } from '@ogun/core'

const url = process.env.DATABASE_URL ?? 'postgres://ogun:ogun@localhost:5433/ogun'
const reachable = await fetch('http://localhost:7777/api/health').then(
  () => true,
  () => false,
)

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

describe('worker api', { skip: reachable ? false : 'no control plane running' }, () => {
  const base = 'http://localhost:7777'
  const { db, close } = createDb(url)
  const slug = `wtest-${Date.now()}`

  let root = ''
  let configPath = ''

  // Resolved exactly as the CLI does: env, then the machine-local config the server
  // writes. A test that only read the env would fail against a control plane whose
  // token was generated rather than exported.
  let auth: Record<string, string> = {}

  const send = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
    })

  const errorOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error?: string }).error ?? ''

  const editMap = (fn: (projects: Record<string, string>) => void) =>
    updateLocalConfig((c) => {
      const projects = { ...c.projects }
      fn(projects)
      return { ...c, projects }
    })

  before(async () => {
    const token = process.env.OGUN_TOKEN?.trim() || (await loadLocalConfig()).server.token
    if (token) auth = { authorization: `Bearer ${token}` }

    root = await mkdtemp(join(tmpdir(), 'ogun-api-'))
    configPath = join(root, '.ogun', 'config.yaml')
    await mkdir(join(root, '.ogun'), { recursive: true })
    await writeFile(configPath, CONFIG.replace('SLUG', slug))
    // The server re-reads the map on every call, so a project added here is visible with
    // no restart — which is itself behaviour worth relying on.
    await editMap((p) => {
      p[slug] = root
    })

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
    await db.delete(schema.projects).where(eq(schema.projects.slug, slug))
    await editMap((p) => {
      delete p[slug]
    })
    await close()
  })

  const state = async (name: string) => {
    const res = await fetch(`${base}/api/workers?project=${slug}`, { headers: auth })
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
    const res = await fetch(`${base}/api/workers/${worker!.id}`, {
      method: 'DELETE',
      headers: auth,
    })
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
