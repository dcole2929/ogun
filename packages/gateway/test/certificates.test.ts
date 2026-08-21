import { strict as assert } from 'node:assert'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CA_SUBJECT, caState, loadOrCreateCa } from '../src/ca.ts'
import { integer, namedBits, oid, time, unsignedInteger } from '../src/der.ts'

/**
 * The certificates this package mints are hand-encoded ASN.1, so these tests exist to
 * answer one question: would a real TLS client accept them?
 *
 * Node's `X509Certificate` is the arbiter rather than a byte comparison — it parses with
 * OpenSSL, which is the same code path curl, git and every Python client take. A test
 * that asserted our own encoder's bytes against our own expectations would pass with a
 * malformed certificate in it; this one cannot.
 */

const directories: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ogun-ca-'))
  directories.push(dir)
  return dir
}
after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
})

test('a minted leaf is signed by the CA and names its host', () => {
  const ca = loadOrCreateCa(scratch())
  const root = new X509Certificate(ca.certificatePem)
  const leaf = new X509Certificate(ca.leafFor('api.anthropic.com').cert)

  assert.match(root.subject, new RegExp(CA_SUBJECT))
  assert.equal(root.ca, true, 'a CA that is not marked as one signs nothing a client trusts')
  assert.equal(leaf.verify(root.publicKey), true)
  assert.equal(leaf.checkHost('api.anthropic.com'), 'api.anthropic.com')
})

/**
 * CN-as-hostname has not been honoured by Chrome since 2017 or by OpenSSL's default
 * verification for certificates that carry any SAN. A leaf with only a CN parses, prints
 * correctly, and is rejected by every client — which is a whole afternoon if you are
 * reading the certificate rather than the failure.
 */
test('a leaf carries a subjectAltName, not only a common name', () => {
  const ca = loadOrCreateCa(scratch())
  const leaf = new X509Certificate(ca.leafFor('chatgpt.com').cert)
  assert.equal(leaf.subjectAltName, 'DNS:chatgpt.com')
  assert.equal(leaf.checkHost('api.openai.com'), undefined, 'and it names only its own host')
})

/**
 * The chain, not just the leaf. A container that trusts the CA does not need it, but a
 * `curl --cacert` against a different bundle does — and shipping it removes a class of
 * report that reads "works from node, fails from git".
 */
test('a leaf is issued as a chain ending in the CA', () => {
  const ca = loadOrCreateCa(scratch())
  const pem = ca.leafFor('api.github.com').cert
  assert.equal(pem.match(/BEGIN CERTIFICATE/g)?.length, 2)
  assert.ok(pem.endsWith(ca.certificatePem))
})

/**
 * Clock skew between a WSL2 host and a container that resumed from a suspended VM is
 * ordinary, and a not-yet-valid certificate fails a handshake exactly like an expired one
 * — with a date in the error that looks fine to anyone reading it a minute later.
 */
test('a leaf is already valid when it is minted', () => {
  const ca = loadOrCreateCa(scratch())
  const leaf = new X509Certificate(ca.leafFor('api.openai.com').cert)
  assert.ok(new Date(leaf.validFrom).getTime() < Date.now(), 'backdated against clock skew')
  assert.ok(new Date(leaf.validTo).getTime() > Date.now())
})

/**
 * The same property for the root, which is where it was actually missing.
 *
 * The leaf was backdated and the CA was not, and the asymmetry cost roughly one full
 * test run in three to `CERT_NOT_YET_VALID`. The suite was the lucky place to find it:
 * a leaf is minted per connection, so a bad one is retried seconds later, while the CA
 * is generated once and cached for ten years — a single unlucky minute at
 * `ogun runner init` would have made every handshake afterwards fail on a date that
 * looks entirely reasonable to whoever reads the error.
 */
test('the CA is backdated far enough to absorb a clock step', () => {
  const ca = loadOrCreateCa(scratch())
  const root = new X509Certificate(ca.certificatePem)

  /**
   * A margin, not merely a non-future date — and the first version of this test asserted
   * the latter and passed against the bug it was written to catch. `time()` truncates to
   * whole seconds, so a `notBefore` of exactly now encodes as up to a second in the
   * *past* and clears `validFrom < Date.now()` every time. What fails a handshake is a
   * verifier whose clock is behind the minting one, which no comparison against this
   * process's own clock can express.
   */
  const backdatedBy = Date.now() - new Date(root.validFrom).getTime()
  assert.ok(
    backdatedBy >= 30 * 60 * 1000,
    `the root is backdated ${Math.round(backdatedBy / 1000)}s; a verifier running behind ` +
      'this clock rejects it as not-yet-valid, and the CA is cached for years',
  )
  assert.ok(new Date(root.validTo).getTime() > Date.now())
})

/**
 * The CA private key is the most valuable thing this package produces: anything holding
 * it can impersonate every host any Ogun container trusts. `ogun runner doctor` already
 * reports a config file left group-readable; this file is strictly worse to leak.
 */
test('the CA private key is written 0600 and the certificate is not', () => {
  const dir = scratch()
  loadOrCreateCa(dir)
  assert.equal(statSync(join(dir, 'ca.key')).mode & 0o777, 0o600)
  // The certificate is public by design — it is the half that goes into the container.
  assert.equal(statSync(join(dir, 'ca.pem')).mode & 0o777, 0o644)
})

/**
 * Reloading rather than regenerating is what makes the CA usable at all: the container
 * trusts it by content, so a CA that changed on every runner restart would invalidate
 * every already-written trust store and every job in flight at once.
 */
test('a second load reuses the CA on disk rather than minting a new one', () => {
  const dir = scratch()
  const first = loadOrCreateCa(dir)
  const written = readFileSync(join(dir, 'ca.pem'), 'utf8')
  const second = loadOrCreateCa(dir)
  assert.equal(second.certificatePem, written)
  assert.equal(second.certificatePem, first.certificatePem)
  // And leaves minted by the reloaded CA still verify against it, which is the half that
  // breaks if the key and the certificate are reloaded out of step.
  const leaf = new X509Certificate(second.leafFor('api.anthropic.com').cert)
  assert.equal(leaf.verify(new X509Certificate(written).publicKey), true)
})

test('the same host gets the same leaf back rather than a fresh one per connection', () => {
  const ca = loadOrCreateCa(scratch())
  // Minting is tens of milliseconds. Per-connection, that is a latency floor on every
  // request an agent makes, paid for nothing.
  assert.equal(ca.leafFor('api.anthropic.com').cert, ca.leafFor('api.anthropic.com').cert)
  assert.notEqual(ca.leafFor('api.anthropic.com').cert, ca.leafFor('chatgpt.com').cert)
})

/**
 * `ogun runner doctor` reports on a machine; it does not change one.
 *
 * A diagnostic that silently generates a signing key the first time it runs makes "is the
 * CA present?" a question you can never get a false answer to — the first `doctor` on a
 * fresh box would report a CA it had just created, and the report would be about itself.
 */
test('inspecting the CA for doctor does not create one', () => {
  const dir = scratch()
  assert.deepEqual(caState(dir), { state: 'missing', directory: dir })
  loadOrCreateCa(dir)
  const state = caState(dir)
  assert.equal(state.state, 'present')
  assert.equal(state.state === 'present' && state.keyMode, 0o600)
})

// ── The encoder's own sharp edges ───────────────────────────────────────────

/**
 * DER INTEGERs are two's complement. A 16-byte random serial whose first byte is >= 0x80
 * encodes as a *negative* number without a leading zero, and RFC 5280 requires serials to
 * be positive. Some verifiers accept a negative serial and some do not, which is the worst
 * outcome available: it works until a client somewhere does not.
 */
test('a high-bit-first integer is padded so it stays positive', () => {
  assert.deepEqual([...unsignedInteger(Uint8Array.from([0x80, 0x01]))], [0x02, 0x03, 0x00, 0x80, 1])
  assert.deepEqual([...unsignedInteger(Uint8Array.from([0x7f, 0x01]))], [0x02, 0x02, 0x7f, 1])
})

/**
 * KeyUsage is the one BIT STRING where the unused-bit count carries meaning, and DER
 * additionally requires trailing zero bits to be dropped. An encoder that pads to a byte
 * boundary still verifies — but no longer round-trips byte-for-byte, and byte-for-byte is
 * exactly what a signature covers.
 */
test('named bits drop their trailing zeroes', () => {
  // keyCertSign (5) + cRLSign (6): one byte, one unused bit.
  assert.deepEqual([...namedBits([5, 6])], [0x03, 0x02, 0x01, 0x06])
  // digitalSignature (0) + keyEncipherment (2): one byte, five unused bits.
  assert.deepEqual([...namedBits([0, 2])], [0x03, 0x02, 0x05, 0xa0])
})

test('an OID packs its first two arcs into one byte and base-128s the rest', () => {
  // 2.5.29.17 (subjectAltName): 2*40+5 = 85, then 29, then 17.
  assert.deepEqual([...oid('2.5.29.17')], [0x06, 0x03, 85, 29, 17])
  // 1.2.840.10045.4.3.2 (ecdsa-with-SHA256) — 840 and 10045 need continuation bytes.
  assert.deepEqual(
    [...oid('1.2.840.10045.4.3.2')],
    [0x06, 0x08, 42, 0x86, 0x48, 0xce, 0x3d, 4, 3, 2],
  )
})

/**
 * UTCTime has a two-digit year, so RFC 5280 pins it to 1950–2049 and requires
 * GeneralizedTime after that. A cert written with a UTCTime of `50…` reads as *1950* — an
 * expiry silently in the past, presenting as every handshake failing on a date nobody
 * would think to check.
 */
test('a validity bound past 2049 switches to GeneralizedTime', () => {
  assert.equal(String.fromCharCode(...time(new Date('2036-08-20T00:00:00Z')).slice(2)), '360820000000Z')
  assert.equal(
    String.fromCharCode(...time(new Date('2100-01-01T00:00:00Z')).slice(2)),
    '21000101000000Z',
  )
  assert.equal(time(new Date('2036-08-20T00:00:00Z'))[0], 0x17, 'UTCTime')
  assert.equal(time(new Date('2100-01-01T00:00:00Z'))[0], 0x18, 'GeneralizedTime')
})

/**
 * `40*first + second` is itself a subidentifier, so it is base-128 like every other one.
 *
 * Emitting it as a single byte is correct only while the second arc is under 40. At 40 the
 * byte reaches 0x80, whose top bit means "this subidentifier continues" — so a conformant
 * parser swallows the next arc into it and mis-reads the entire OID. Nothing here uses an
 * OID with a second arc that large, which is precisely why it would have sat undiscovered:
 * a wrong OID is not a parse failure, it is a certificate that means something else.
 */
test('an OID with a large second arc does not collide with the continuation bit', () => {
  // 2.100.3 — 40*2 + 100 = 180 (0xB4), which must encode as two base-128 bytes.
  assert.deepEqual([...oid('2.100.3')], [0x06, 0x03, 0x81, 0x34, 0x03])
  // And the small case is unchanged: 2.5.29.17 is still one byte for the first two arcs.
  assert.deepEqual([...oid('2.5.29.17')], [0x06, 0x03, 85, 29, 17])
})

/**
 * `smallInteger` took the low byte and threw the rest away, so 300 encoded as 44 —
 * silently. In a certificate that is not a parse error; a wrong version number produces a
 * v1 certificate whose extensions are all quietly ignored, SAN and basicConstraints
 * included.
 */
test('an integer wider than a byte is encoded, not truncated', () => {
  assert.deepEqual([...integer(2)], [0x02, 0x01, 0x02])
  assert.deepEqual([...integer(300)], [0x02, 0x02, 0x01, 0x2c])
  // Still padded to stay positive, the same as any other unsigned value.
  assert.deepEqual([...integer(200)], [0x02, 0x02, 0x00, 0xc8])
  assert.throws(() => integer(-1))
})

/**
 * The unreachable inputs, kept unreachable. Each of these produced something worse than an
 * error — a zero-length INTEGER that is invalid DER, and a TypedArray allocated with a
 * length of -Infinity — and each is one careless call site away from being reachable.
 */
test('the encoder refuses degenerate input rather than emitting nonsense', () => {
  assert.throws(() => unsignedInteger(new Uint8Array(0)), /at least one byte/)
  assert.throws(() => namedBits([]), /at least one bit/)
})
