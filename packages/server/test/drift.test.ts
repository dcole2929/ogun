import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { schema } from '@ogun/core/db'
import { startHarness, type Harness } from './harness.ts'
import { createLocalConfigStore } from '../src/config-store.ts'
import { driftOf } from '../src/drift.ts'

const CONFIG = `project:
  name: SLUG
  defaultBranch: main

workers:
  reviewer:
    skill: review
    schedule: "0 3 * * *"
`

/**
 * `.ogun/config.yaml` is the definition; the database is what the foreman reads at fire
 * time (§5.1). Only the UI publishes on its own — a hand-edit or a `git pull` leaves the
 * factory running the previous definition, and nothing said so. The triage fan-in merged
 * and ran nothing for fourteen hours exactly that way.
 */
describe('config drift', () => {
  const slug = `drift-${Date.now()}`
  let h: Harness
  let root = ''
  let configPath = ''
  let store: ReturnType<typeof createLocalConfigStore>

  const send = (path: string, body: unknown) =>
    h.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const stateNow = async () => (await driftOf(h.db, store, slug)).state

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ogun-drift-'))
    configPath = join(root, '.ogun', 'config.yaml')
    await mkdir(join(root, '.ogun'), { recursive: true })
    await writeFile(configPath, CONFIG.replace('SLUG', slug))
    const mapPath = join(root, 'projects.json')
    await writeFile(mapPath, JSON.stringify({ projects: { [slug]: root } }))
    store = createLocalConfigStore(mapPath)
    h = await startHarness(store)
  })

  after(async () => {
    await h.db.delete(schema.projects).where(eq(schema.projects.slug, slug))
    await h.stop()
  })

  const sync = async () => {
    const text = await readFile(configPath, 'utf8')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
    return send('/api/projects/sync', {
      slug,
      defaultBranch: 'main',
      configHash: hash,
      workers: {
        reviewer: {
          skill: 'review',
          runtime: 'claude',
          model: 'worker',
          permissions: 'reviewer',
          sandbox: 'container',
          onMissed: 'skip',
          enabled: true,
          timeoutMs: 1_800_000,
        },
      },
      policies: {
        directPush: false,
        allowSandboxDowngrade: false,
        maxConcurrentModifiers: 1,
        failureBreakerThreshold: 3,
      },
      skills: [{ name: 'review', sourcePath: '.agents/skills/review', versionHash: 'sv1' }],
    })
  }

  test('a project indexed before the hash existed reads as unknown, not as drift', async () => {
    await h.db.insert(schema.projects).values({ slug })
    assert.equal(await stateNow(), 'unknown', 'absence of evidence is not evidence of drift')
  })

  test('a freshly synced project is current', async () => {
    assert.equal((await sync()).status, 200)
    assert.equal(await stateNow(), 'current')
  })

  test('editing the file behind the control plane is drift', async () => {
    await writeFile(configPath, `${CONFIG.replace('SLUG', slug)}\n  second:\n    skill: review\n`)
    assert.equal(await stateNow(), 'drifted')
  })

  test('publishing from the UI resolves it, and reads the same file the CLI would', async () => {
    const res = await send(`/api/projects/${slug}/sync-local`, {})
    assert.equal(res.status, 200)
    const body = (await res.json()) as { workers: string[] }
    assert.deepEqual(body.workers.sort(), ['reviewer', 'second'], 'the new worker is indexed')
    assert.equal(await stateNow(), 'current')
  })

  /**
   * The trap this design has to avoid. The UI writes `config.yaml` and re-indexes in one
   * request; if only the sync route recorded the hash, every UI edit would land on disk,
   * land in the database, and then immediately read as drifted against a hash from before
   * it — a warning that appears whenever you use the feature correctly.
   */
  test('a worker edited through the UI does not read as drift', async () => {
    const list = (await (await h.fetch(`/api/workers?project=${slug}`)).json()) as {
      workers: Array<{ worker: { id: string; name: string } }>
      hashes: Record<string, string>
    }
    const target = list.workers.find((w) => w.worker.name === 'reviewer')!.worker

    const res = await h.fetch(`/api/workers/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedHash: list.hashes[slug], runtime: 'codex' }),
    })
    assert.equal(res.status, 200)
    assert.equal(await stateNow(), 'current', 'using the UI must not raise a drift warning')
  })

  test('no local checkout is unreachable, which is not a problem to report', async () => {
    const empty = createLocalConfigStore(join(root, 'no-such-map.json'))
    assert.equal((await driftOf(h.db, empty, slug)).state, 'unreachable')
  })
})
