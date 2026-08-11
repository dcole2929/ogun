import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  fingerprintMatches,
  fingerprintPrefixes,
  parseFingerprint,
} from '../src/fingerprint.ts'
import { rawFindingSchema } from '../src/findings.ts'

test('accepts a four-segment kebab-case path', () => {
  const r = parseFingerprint('security/public-orders/account-isolation/cross-account-id-swap')
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.value, {
    area: 'security',
    surface: 'public-orders',
    invariant: 'account-isolation',
    technique: 'cross-account-id-swap',
  })
})

test('rejects the shapes that would break prefix matching', () => {
  for (const bad of [
    'security/public-orders/account-isolation',
    'security/public-orders/account-isolation/swap/extra',
    'Security/Public-Orders/account-isolation/swap',
    'security//account-isolation/swap',
    'security/public orders/account-isolation/swap',
  ]) {
    assert.equal(parseFingerprint(bad).ok, false, `should reject ${bad}`)
  }
})

test('a line number cannot enter the fingerprint', () => {
  // The whole point of excluding it: a rebase must not mint a new identity.
  assert.equal(parseFingerprint('security/orders/isolation/swap:42').ok, false)
})

test('prefixes are longest-first so cooldown matching short-circuits', () => {
  assert.deepEqual(fingerprintPrefixes('a/b/c/d'), ['a/b/c/d', 'a/b/c', 'a/b', 'a'])
})

test('a prefix pattern covers a whole surface but not a sibling', () => {
  assert.equal(fingerprintMatches('security/orders', 'security/orders/isolation/swap'), true)
  assert.equal(fingerprintMatches('security/orders', 'security/orders-v2/isolation/swap'), false)
  assert.equal(fingerprintMatches('security/orders/isolation/swap', 'security/orders/isolation/swap'), true)
})

test('a finding must cite something', () => {
  const base = {
    fingerprint: 'security/orders/isolation/swap',
    title: 't',
    body: 'b',
    severity: 'high',
  }
  assert.equal(rawFindingSchema.safeParse({ ...base, citations: [] }).success, false)
  assert.equal(
    rawFindingSchema.safeParse({ ...base, citations: [{ path: 'src/a.ts', line: 3 }] }).success,
    true,
  )
})
