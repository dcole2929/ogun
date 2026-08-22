import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  EVIDENCE_MIN_CHARS,
  basisIsIntact,
  excerptEvidence,
  normalizeEvidence,
} from '../src/evidence.ts'

/**
 * The identity function underneath a dismissal.
 *
 * A fingerprint answers "is this the same finding". A basis answers a different and
 * harder question — "is this still about the same code" — and it is the one that decides
 * whether the factory stays silent. Getting it too tight means every dismissal lapses on
 * the next commit and the noise comes back; too loose means a dismissal outlives the code
 * it was about and a real bug is silenced by a decision nobody made about it.
 *
 * The naive implementations, and what each gets wrong:
 *
 *   - **Hash the file.** Any edit anywhere in the module lapses every dismissal in it, so
 *     a dismissal on a file somebody is working in survives one day.
 *   - **Store `path:line` and read that line back.** Inserting anything above it reports a
 *     rewrite. §4.11 already excludes line numbers from a fingerprint for this reason.
 *   - **Compare the raw text.** A formatter run across the repository lapses everything,
 *     and nobody re-decided anything.
 */

const file = `export async function redeem(code: string) {
  const invite = await db.query.invites.findFirst({ where: eq(invites.code, code) })
  if (!invite || invite.usedAt) return null

  await db.update(invites).set({ usedAt: new Date() }).where(eq(invites.id, invite.id))
  return invite
}
`

test('an excerpt is a region, not a line, and carries no line numbers', () => {
  const basis = excerptEvidence(file, 3)
  assert.ok(basis)
  assert.match(basis, /invite\.usedAt/)
  // Context either side is what makes a short line identifiable at all — `return null`
  // on its own occurs in half the repository.
  assert.match(basis, /findFirst/)
  assert.ok(!/^\d+/.test(basis), 'a line number in the basis would defeat the whole design')
})

test('the code moving down the file does not lapse a dismissal', () => {
  const basis = excerptEvidence(file, 3)!
  const shifted = `import { eq } from 'drizzle-orm'\n\n// forty lines of new imports\n${file}`
  assert.equal(
    basisIsIntact(shifted, basis),
    true,
    'the basis is searched for, not read at an offset — a rebase is not a rewrite',
  )
})

test('reindenting and reflowing does not lapse a dismissal', () => {
  const basis = excerptEvidence(file, 3)!
  const reformatted = file
    .split('\n')
    .map((line) => `        ${line.trim()}`)
    .join('\n\n')
  assert.equal(
    basisIsIntact(reformatted, basis),
    true,
    'a formatter run must not re-open every finding anybody ever dismissed',
  )
})

test('an unrelated edit elsewhere in the file does not lapse a dismissal', () => {
  const basis = excerptEvidence(file, 3)!
  const edited = `${file}\nexport function unrelated() { return 1 }\n`
  assert.equal(
    basisIsIntact(edited, basis),
    true,
    'a whole-file hash would call this a rewrite, which is why it is not a whole-file hash',
  )
})

/** The property the whole mechanism exists for: the dismissed code being rewritten. */
test('rewriting the cited code does lapse a dismissal', () => {
  const basis = excerptEvidence(file, 3)!
  const rewritten = file.replace('if (!invite || invite.usedAt) return null', 'if (!invite) return null')
  assert.equal(basisIsIntact(rewritten, basis), false)
})

test('deleting the code lapses it, and so does deleting everything around it', () => {
  const basis = excerptEvidence(file, 3)!
  assert.equal(basisIsIntact('', basis), false)
  assert.equal(basisIsIntact('export const nothing = true\n', basis), false)
})

/**
 * A one-line excerpt is frequently `}` or `return null`, and a basis that matches almost
 * any version of almost any file would report `intact` forever — pinning a dismissal open
 * past every rewrite, which is the exact silent failure the basis exists to prevent.
 * Refusing to record one is the safe answer: no basis is a state the ledger names, and a
 * useless basis is one it cannot.
 */
test('a region too slight to identify anything is no basis at all', () => {
  const trivial = 'a\n}\n)\n'
  assert.equal(excerptEvidence(trivial, 2), null)
  assert.equal(basisIsIntact(file, '}'), false, 'and it is refused on the way back in too')
  assert.ok(EVIDENCE_MIN_CHARS > 1)
})

test('a citation with no line, or one past the end of the file, yields no basis', () => {
  assert.equal(excerptEvidence(file, undefined), null)
  assert.equal(excerptEvidence(file, 0), null)
  assert.equal(excerptEvidence(file, 9_000), null)
})

/** Normalization has to be identical on both sides or `includes` means nothing. */
test('the same normalization runs over the stored basis and the file it is sought in', () => {
  assert.equal(normalizeEvidence('  a   b  \n\n\n   c '), 'a b\nc')
  const basis = normalizeEvidence('const x   =  1\n\n\nconst yyyyyyyy = 2')
  assert.equal(basisIsIntact('...\nconst x = 1\nconst yyyyyyyy = 2\n...', basis), true)
})

/** A finding citing a nine-hundred-line range must not store the file in postgres. */
test('a huge cited range is capped', () => {
  const long = Array.from({ length: 500 }, (_, i) => `const line${i} = ${i}`).join('\n')
  const basis = excerptEvidence(long, 10, 480)!
  assert.ok(basis.split('\n').length <= 14)
  assert.ok(basis.length <= 1600)
})
