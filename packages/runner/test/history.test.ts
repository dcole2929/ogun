import { strict as assert } from 'node:assert'
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeHistory, HISTORY_INDEX_PATH, HISTORY_DIR } from '../src/pipeline.ts'
import type { FindingsHistory } from '../src/client.ts'

const entry = (fingerprint: string, over: Record<string, unknown> = {}) => ({
  fingerprint,
  status: 'open',
  severity: 'high',
  title: `problem in ${fingerprint}`,
  seenCount: 1,
  lastSeenAt: '2026-08-17T07:00:00.000Z',
  ...over,
})

const history: FindingsHistory = {
  index: [
    entry('security/runner-enrollment/single-use-invite/parallel-redemption', {
      path: 'packages/server/src/routes/runners.ts',
    }),
    entry('security/runner-enrollment/invite-single-use/toctou-double-redeem'),
    entry('foreman/cycle-fan-in/dependency-snapshot/live-definition-reread', {
      status: 'fixed',
      severity: 'medium',
    }),
  ],
  details: {
    'security/runner-enrollment/single-use-invite/parallel-redemption': 'the argument, at length',
    'security/runner-enrollment/invite-single-use/toctou-double-redeem': 'a second argument',
    'foreman/cycle-fan-in/dependency-snapshot/live-definition-reread': 'a third',
  },
}

const workspace = async () => await mkdtemp(join(tmpdir(), 'ogun-history-'))

test('the index is one flat file, readable whole', async () => {
  const ws = await workspace()
  await writeHistory(ws, history)

  const parsed = JSON.parse(await readFile(join(ws, HISTORY_INDEX_PATH), 'utf8')) as {
    findings: Array<{ fingerprint: string; title: string; status: string }>
  }
  assert.equal(parsed.findings.length, 3)
  assert.equal(parsed.findings[0]?.status, 'open')

  // The index answers "is this surface taken", so it carries no bodies — that is the
  // whole reason it is separate from the write-ups.
  assert.ok(
    !JSON.stringify(parsed).includes('the argument, at length'),
    'a body leaked into the index, which defeats the split',
  )
})

/**
 * The fingerprint is a path by design (§4.11), so a surface is a directory and
 * `<area>/<surface>/` covers every finding on it by prefix. This is the property the
 * hierarchical fingerprint exists for.
 */
test('write-ups nest by fingerprint, so a surface is one directory', async () => {
  const ws = await workspace()
  await writeHistory(ws, history)

  const surface = join(ws, HISTORY_DIR, 'security', 'runner-enrollment')
  const onThatSurface = await readdir(surface)
  assert.deepEqual(
    onThatSurface.sort(),
    ['invite-single-use', 'single-use-invite'],
    'both invite findings should sit under the one surface',
  )

  const body = await readFile(
    join(surface, 'single-use-invite', 'parallel-redemption.md'),
    'utf8',
  )
  assert.match(body, /the argument, at length/)
  // The header makes a body self-describing when opened on its own.
  assert.match(body, /status: open/)
  assert.match(body, /packages\/server\/src\/routes\/runners\.ts/)
})

/**
 * Fingerprints are authored by a previous agent, and they are about to become paths.
 * `parseFingerprint` rejects anything that is not four kebab-case segments, so traversal
 * is impossible — but this is the place where that would stop being an abstract property,
 * so it is checked here rather than assumed.
 */
test('a fingerprint that is not a fingerprint never becomes a path', async () => {
  const ws = await workspace()
  await writeHistory(ws, {
    index: [entry('../../../../etc/passwd'), entry('a/b/c/d')],
    details: {
      '../../../../etc/passwd': 'traversal',
      'a/b/c/d': 'legitimate',
      '/absolute/x/y/z': 'absolute',
      'UPPER/Case/Is/Rejected': 'case',
    },
  })

  assert.ok(existsSync(join(ws, HISTORY_DIR, 'a', 'b', 'c', 'd.md')), 'the valid one is written')
  const written = await readdir(join(ws, HISTORY_DIR))
  assert.deepEqual(written, ['a'], 'nothing else should have produced a file')

  // The rejected records still appear in the index — a malformed fingerprint is not a
  // reason to hide that the surface was looked at.
  const parsed = JSON.parse(await readFile(join(ws, HISTORY_INDEX_PATH), 'utf8')) as {
    findings: unknown[]
  }
  assert.equal(parsed.findings.length, 2)
})

const modeOf = async (path: string): Promise<string> => ((await stat(path)).mode & 0o777).toString(8)

/**
 * The inbox is a list of problems nobody has fixed yet, laid out on the host before the
 * sandbox exists. `writeFile`'s `mode` reaches `open(2)` and is honoured only when it
 * creates the file, so one of these paths already present in the clone — a repository
 * that tracks `.ogun-in/` — kept git's 0644 and published the inbox to every other user
 * on the runner.
 */
test('an inbox file the clone already carried is rewritten owner-only', async () => {
  const ws = await workspace()
  await mkdir(join(ws, HISTORY_DIR, 'a', 'b', 'c'), { recursive: true })
  const body = join(ws, HISTORY_DIR, 'a', 'b', 'c', 'd.md')
  const index = join(ws, HISTORY_INDEX_PATH)
  for (const path of [body, index]) {
    await writeFile(path, 'from the repository\n')
    await chmod(path, 0o644)
  }

  await writeHistory(ws, { index: [entry('a/b/c/d')], details: { 'a/b/c/d': 'the argument' } })

  assert.equal(await modeOf(index), '600', 'the index kept the mode it was cloned with')
  assert.equal(await modeOf(body), '600', 'the write-up kept the mode it was cloned with')
  assert.match(await readFile(body, 'utf8'), /the argument/)
})

/**
 * Reading back out of a workspace already refuses to follow a symlink (§5.3), because a
 * path inside the workspace is resolved by the *runner*, on the *host*. Writing into one
 * did not: a repository that tracks `.ogun-in/history.json` as a link to a host file had
 * that file overwritten by the runner, with the runner's privileges, before anything was
 * sandboxed.
 */
test('a symlink in the clone does not redirect the write onto a host file', async () => {
  const ws = await workspace()
  const outside = join(await mkdtemp(join(tmpdir(), 'ogun-host-')), 'config.json')
  await writeFile(outside, 'the machine credential\n')
  await mkdir(join(ws, '.ogun-in'), { recursive: true })
  await symlink(outside, join(ws, HISTORY_INDEX_PATH))

  await writeHistory(ws, history)

  assert.equal(await readFile(outside, 'utf8'), 'the machine credential\n')
  // The run still gets its inbox — the link is replaced, not honoured and not refused.
  assert.match(await readFile(join(ws, HISTORY_INDEX_PATH), 'utf8'), /parallel-redemption/)
})
