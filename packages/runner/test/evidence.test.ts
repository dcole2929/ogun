import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkDismissals, gatherEvidence } from '../src/evidence.ts'
import { writeHistory, HISTORY_DIR, HISTORY_INDEX_PATH } from '../src/pipeline.ts'

/**
 * The host's half of re-adjudication (§4.11): reading the tree so the control plane can
 * decide whether a dismissal still applies.
 *
 * Everything here runs in the runner process, after the container has exited. That
 * placement is the property, not an implementation detail — a basis an agent could write
 * is a basis an agent could anchor to code it knows will never change, buying permanent
 * silence about its own surface with one sentence in a JSON file.
 */

const source = `export function claim(runner: string) {
  const slots = Math.min(runner.capacity, remaining())
  if (slots <= 0) return []
  return take(slots)
}
`

const workspace = async (): Promise<string> => {
  const ws = await mkdtemp(join(tmpdir(), 'ogun-evidence-'))
  await mkdir(join(ws, 'src'), { recursive: true })
  await writeFile(join(ws, 'src/claim.ts'), source)
  return ws
}

const document = (over: Record<string, unknown> = {}) => ({
  findings: [
    {
      fingerprint: 'foreman/claim/capacity/per-runner-cap',
      title: 'the cap is per runner, not per machine',
      body: 'the argument',
      severity: 'high',
      citations: [{ path: 'src/claim.ts', line: 2 }],
    },
  ],
  ...over,
})

test('the excerpt comes off the disk, not out of the agent document', async () => {
  const ws = await workspace()
  const evidence = await gatherEvidence(ws, document())

  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]?.path, 'src/claim.ts')
  assert.match(evidence[0]?.snippet ?? '', /Math\.min\(runner\.capacity, remaining\(\)\)/)
  assert.ok(
    !/the argument/.test(evidence[0]?.snippet ?? ''),
    'the body an agent wrote must not end up anywhere near the basis',
  )
})

/**
 * A citation the grounding gate would have caught anyway, and a document that never
 * parsed. Neither is a reason to fail the run: losing evidence costs a dismissal made
 * tomorrow its anchor, and a review that refuses to finish reports nothing at all (§4.11).
 */
test('a citation that points nowhere produces no basis rather than an error', async () => {
  const ws = await workspace()
  const missing = document({
    findings: [
      {
        fingerprint: 'a/b/c/d',
        title: 't',
        body: 'b',
        severity: 'low',
        citations: [{ path: 'src/does-not-exist.ts', line: 3 }],
      },
    ],
  })
  assert.deepEqual(await gatherEvidence(ws, missing), [])
  assert.deepEqual(await gatherEvidence(ws, { nonsense: true }), [])
  assert.deepEqual(await gatherEvidence(ws, undefined), [])
})

/**
 * The three states, and why they are three. `absent` and `unreadable` both fail to find
 * the basis, and treating them alike would either hold a dismissal over a file somebody
 * deleted or lapse a person's decision because of an I/O error.
 */
test('a dismissal is intact, moved, or unreadable — never merely false', async () => {
  const ws = await workspace()
  const basis = 'const slots = Math.min(runner.capacity, remaining())'

  assert.deepEqual(
    await checkDismissals(ws, [
      { fingerprint: 'a/b/c/intact', path: 'src/claim.ts', basis },
      { fingerprint: 'a/b/c/rewritten', path: 'src/claim.ts', basis: 'const slots = runner.capacity' },
      { fingerprint: 'a/b/c/deleted', path: 'src/gone.ts', basis },
    ]),
    [
      { fingerprint: 'a/b/c/intact', basis: 'intact' },
      { fingerprint: 'a/b/c/rewritten', basis: 'moved' },
      { fingerprint: 'a/b/c/deleted', basis: 'moved' },
    ],
  )
})

/**
 * A citation that came out of a sandbox is attacker-adjacent. Reading it with `readFile`
 * would follow a symlink the agent planted and pull a host file into a basis that is
 * stored in postgres and shipped back into the next workspace.
 */
test('a symlinked citation is refused rather than followed', async () => {
  const ws = await workspace()
  const outside = join(await mkdtemp(join(tmpdir(), 'ogun-host-')), 'credentials.json')
  await writeFile(outside, '{"accessToken":"sk-ant-oat01-REAL-AND-LONG-ENOUGH"}\n')
  await symlink(outside, join(ws, 'src/linked.ts'))

  const evidence = await gatherEvidence(
    ws,
    document({
      findings: [
        {
          fingerprint: 'a/b/c/d',
          title: 't',
          body: 'b',
          severity: 'low',
          citations: [{ path: 'src/linked.ts', line: 1 }],
        },
      ],
    }),
  )
  assert.deepEqual(evidence, [], 'nothing outside the workspace becomes a basis')

  // And the check reports that it established nothing, rather than lapsing the dismissal.
  assert.deepEqual(
    await checkDismissals(ws, [{ fingerprint: 'a/b/c/d', path: 'src/linked.ts', basis: 'x'.repeat(40) }]),
    [{ fingerprint: 'a/b/c/d', basis: 'unreadable' }],
  )
})

/**
 * The basis is the one input to a dismissal's fate that no agent may influence, and the
 * cheapest way to lose that property is to lay it out in the workspace beside the rest of
 * the inbox. It is not a secret — it is the project's own source, which the agent is
 * reading anyway — but a copy inside the sandbox is a copy some future skill starts
 * reading, and then arguing with.
 */
test('a dismissal basis never reaches the workspace', async () => {
  const ws = await workspace()
  await writeHistory(ws, {
    index: [
      {
        fingerprint: 'a/b/c/d',
        status: 'wontfix',
        severity: 'low',
        title: 'dismissed',
        seenCount: 3,
        lastSeenAt: '2026-08-20T00:00:00.000Z',
      },
    ],
    details: { 'a/b/c/d': 'the argument' },
    bases: [{ fingerprint: 'a/b/c/d', path: 'src/claim.ts', basis: 'THE-SECRET-ANCHOR-TEXT' }],
  })

  const index = await readFile(join(ws, HISTORY_INDEX_PATH), 'utf8')
  const bodies = await Promise.all(
    (await readdir(join(ws, HISTORY_DIR, 'a', 'b', 'c'))).map((f) =>
      readFile(join(ws, HISTORY_DIR, 'a', 'b', 'c', f), 'utf8'),
    ),
  )
  for (const written of [index, ...bodies]) {
    assert.ok(!written.includes('THE-SECRET-ANCHOR-TEXT'), 'the anchor was laid out for the agent')
  }
})
