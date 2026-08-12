import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { createDb, schema } from '@ogun/core/db'

const base = process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'
const url = process.env.DATABASE_URL ?? 'postgres://ogun:ogun@localhost:5433/ogun'
const reachable = await fetch(`${base}/api/health`).then(
  () => true,
  () => false,
)

const errorOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { error?: string }).error ?? ''

const post = (path: string, body: unknown, method = 'POST') =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * The config/ui split is the whole design of worker editing, and it only holds if sync
 * genuinely refuses to touch a UI worker. These tests are the guard on that.
 */
describe('worker origin', { skip: reachable ? false : 'no control plane running' }, () => {
  const { db, close } = createDb(url)
  const slug = `wtest-${Date.now()}`

  const syncBody = (workers: Record<string, unknown>) => ({
    slug,
    defaultBranch: 'main',
    configHash: 'h1',
    workers,
    policies: {
      directPush: false,
      allowSandboxDowngrade: false,
      maxConcurrentModifiers: 1,
      failureBreakerThreshold: 3,
    },
    skills: [
      { name: 'review', sourcePath: '.agents/skills/review', versionHash: 'sv1', body: '# hi' },
    ],
  })

  const configWorker = {
    skill: 'review',
    runtime: 'claude',
    model: 'worker',
    permissions: 'reviewer',
    sandbox: 'container',
    onMissed: 'skip',
    enabled: true,
    timeoutMs: 60_000,
  }

  before(async () => {
    await post('/api/projects/sync', syncBody({ 'from-config': configWorker }))
  })

  after(async () => {
    await db.delete(schema.projects).where(eq(schema.projects.slug, slug))
    await close()
  })

  const workerNamed = async (name: string) => {
    const res = await fetch(`${base}/api/workers?project=${slug}`)
    const { workers } = (await res.json()) as {
      workers: Array<{ worker: { id: string; name: string; origin: string; runtime: string } }>
    }
    return workers.find((w) => w.worker.name === name)?.worker
  }

  test('a synced worker is owned by config', async () => {
    assert.equal((await workerNamed('from-config'))?.origin, 'config')
  })

  test('a config worker cannot be edited or deleted through the api', async () => {
    const w = await workerNamed('from-config')
    const patch = await post(`/api/workers/${w!.id}`, { runtime: 'codex' }, 'PATCH')
    assert.equal(patch.status, 409)
    assert.match(await errorOf(patch), /config\.yaml/)

    const del = await fetch(`${base}/api/workers/${w!.id}`, { method: 'DELETE' })
    assert.equal(del.status, 409)
  })

  test('a ui worker can be created and edited', async () => {
    const created = await post('/api/workers', {
      projectSlug: slug,
      name: 'from-ui',
      skill: 'review',
      runtime: 'codex',
    })
    assert.equal(created.status, 201)
    const body = (await created.json()) as { worker: { origin: string } }
    assert.equal(body.worker.origin, 'ui')

    const w = await workerNamed('from-ui')
    const patched = await post(`/api/workers/${w!.id}`, { runtime: 'claude' }, 'PATCH')
    assert.equal(patched.status, 200)
    assert.equal((await workerNamed('from-ui'))?.runtime, 'claude')
  })

  test('editing a ui worker bumps its version so findings stay attributable', async () => {
    const before = await workerNamed('from-ui')
    const [row] = await db
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.id, before!.id))
    const firstHash = row!.versionHash
    await post(`/api/workers/${before!.id}`, { model: 'reviewer' }, 'PATCH')
    const [after] = await db
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.id, before!.id))
    assert.notEqual(after!.versionHash, firstHash)
  })

  test('sync does not clobber a ui worker sharing a name', async () => {
    // The dangerous case: config later declares a worker with the same name.
    const res = await post(
      '/api/projects/sync',
      syncBody({ 'from-config': configWorker, 'from-ui': { ...configWorker, runtime: 'claude' } }),
    )
    const body = (await res.json()) as { shadowed: string[] }
    assert.deepEqual(body.shadowed, ['from-ui'], 'the collision must be reported, not silent')
    assert.equal((await workerNamed('from-ui'))?.origin, 'ui')
  })

  test('a worker removed from config is removed here, and ui workers survive it', async () => {
    await post('/api/projects/sync', syncBody({}))
    assert.equal(await workerNamed('from-config'), undefined)
    assert.ok(await workerNamed('from-ui'), 'a ui worker was never in the file to be removed from')
  })

  test('a worker pointing at a skill that does not exist is refused', async () => {
    const res = await post('/api/workers', {
      projectSlug: slug,
      name: 'ghost',
      skill: 'not-a-skill',
    })
    assert.equal(res.status, 400)
    assert.match(await errorOf(res), /no skill named/)
  })

  test('a modifier cannot be put on a worktree sandbox', async () => {
    const res = await post('/api/workers', {
      projectSlug: slug,
      name: 'risky',
      skill: 'review',
      permissions: 'modifier',
      sandbox: 'worktree',
    })
    assert.equal(res.status, 400)
    assert.match(await errorOf(res), /directly on the host/)
  })

  test('a duplicate name is refused rather than silently overwriting', async () => {
    const res = await post('/api/workers', {
      projectSlug: slug,
      name: 'from-ui',
      skill: 'review',
    })
    assert.equal(res.status, 409)
  })

  test('the yaml export round-trips the fields config.yaml needs', async () => {
    const w = await workerNamed('from-ui')
    const { yaml } = (await (await fetch(`${base}/api/workers/${w!.id}/yaml`)).json()) as {
      yaml: string
    }
    assert.match(yaml, /^ {2}from-ui:$/m)
    assert.match(yaml, /^ {4}skill: review$/m)
    assert.match(yaml, /^ {4}permissions: reviewer$/m)
  })
})
