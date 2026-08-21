/**
 * The smallest DER writer that can emit an X.509 certificate.
 *
 * Node can *parse* certificates (`crypto.X509Certificate`) and *sign* bytes, but it
 * cannot issue a certificate — there is no API for it. The gateway has to mint a leaf
 * per hostname on the fly, so something has to lay out the ASN.1.
 *
 * Written here rather than pulled in, for one reason: this module is what holds the
 * shape of a signing CA's certificates, and the CA's private key is the single most
 * valuable thing on the runner host after the credentials themselves. A dependency in
 * this position is a supply-chain hole aimed directly at the thing the gateway exists to
 * protect. It is ~150 lines of type-length-value, it never parses attacker-controlled
 * input (every byte it touches is one we produced), and Node's own X.509 parser plus a
 * real TLS handshake check the output in the tests — so it is cheaper to own than to
 * audit somebody else's.
 *
 * Only the subset X.509 needs. No parser, no indefinite lengths, no BER.
 */

// ── Tags ────────────────────────────────────────────────────────────────────

const BOOLEAN = 0x01
const INTEGER = 0x02
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const OBJECT_IDENTIFIER = 0x06
const UTF8_STRING = 0x0c
const SEQUENCE = 0x30
const SET = 0x31
const UTC_TIME = 0x17
const GENERALIZED_TIME = 0x18

// ── Primitives ──────────────────────────────────────────────────────────────

/**
 * Tag-length-value. Definite lengths only: the short form under 128, otherwise the long
 * form with a leading byte counting the length's own bytes.
 *
 * DER (unlike BER) forbids the indefinite form, and a certificate that uses it is
 * rejected by OpenSSL rather than merely frowned at — so there is no branch for it.
 */
export function tlv(tag: number, body: Uint8Array): Uint8Array {
  if (body.length < 0x80) return Uint8Array.from([tag, body.length, ...body])
  const len: number[] = []
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256)
  return Uint8Array.from([tag, 0x80 | len.length, ...len, ...body])
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const seq = (...parts: Uint8Array[]): Uint8Array => tlv(SEQUENCE, concat(parts))
export const set = (...parts: Uint8Array[]): Uint8Array => tlv(SET, concat(parts))
export const octetString = (body: Uint8Array): Uint8Array => tlv(OCTET_STRING, body)
export const utf8String = (s: string): Uint8Array => tlv(UTF8_STRING, Buffer.from(s, 'utf8'))
export const boolean = (v: boolean): Uint8Array => tlv(BOOLEAN, Uint8Array.from([v ? 0xff : 0x00]))

/**
 * An unsigned quantity as a DER INTEGER.
 *
 * The leading zero is not decoration. DER INTEGERs are two's complement, so a serial
 * number whose first byte is >= 0x80 encodes as *negative* without it. RFC 5280 requires
 * serials to be positive; a negative one is accepted by some verifiers and rejected by
 * others, which is the worst possible outcome — it works until it does not.
 */
export function unsignedInteger(bytes: Uint8Array): Uint8Array {
  let at = 0
  while (at < bytes.length - 1 && bytes[at] === 0) at++
  const trimmed = bytes.subarray(at)
  const body = (trimmed[0] ?? 0) & 0x80 ? Uint8Array.from([0, ...trimmed]) : trimmed
  return tlv(INTEGER, body)
}

export const smallInteger = (n: number): Uint8Array => unsignedInteger(Uint8Array.from([n]))

/** A BIT STRING carrying whole bytes — the leading 0 is the "no unused bits" count. */
export const bitString = (bytes: Uint8Array): Uint8Array =>
  tlv(BIT_STRING, Uint8Array.from([0, ...bytes]))

/**
 * A BIT STRING of named bits (KeyUsage), which is the one place the unused-bit count
 * carries meaning rather than always being zero.
 *
 * DER additionally requires trailing zero bits to be *dropped*, so `keyCertSign|cRLSign`
 * is one byte with 1 unused bit, not two bytes with 8. An encoder that pads to a byte
 * boundary produces a certificate OpenSSL will still verify but that no longer round-trips
 * byte-for-byte — and byte-for-byte is what a signature covers.
 */
export function namedBits(bits: number[]): Uint8Array {
  const highest = Math.max(...bits)
  const bytes = new Uint8Array(Math.floor(highest / 8) + 1)
  for (const bit of bits) bytes[Math.floor(bit / 8)]! |= 0x80 >> bit % 8
  return tlv(BIT_STRING, Uint8Array.from([7 - highest % 8, ...bytes]))
}

/**
 * A dotted OID. The first two arcs share a byte (40*a + b); every arc after that is
 * base-128, big-endian, with the continuation bit set on all but the last byte.
 */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map(Number)
  const [first, second, ...rest] = arcs
  if (first === undefined || second === undefined) throw new Error(`not an OID: ${dotted}`)
  const body: number[] = [first * 40 + second]
  for (const arc of rest) {
    const chunks: number[] = []
    for (let n = arc; ; n = Math.floor(n / 128)) {
      chunks.unshift(n % 128)
      if (n < 128) break
    }
    for (let i = 0; i < chunks.length - 1; i++) chunks[i]! |= 0x80
    body.push(...chunks)
  }
  return tlv(OBJECT_IDENTIFIER, Uint8Array.from(body))
}

/**
 * A validity bound.
 *
 * UTCTime has a two-digit year, so RFC 5280 pins it to 1950–2049 and requires
 * GeneralizedTime beyond that. Nothing here currently issues past 2049, but a cert with a
 * UTCTime of `50…` reads as *1950* — an expiry silently in the past, which would present
 * as every TLS handshake failing on a date nobody would think to check.
 */
export function time(date: Date): Uint8Array {
  const iso = date.toISOString()
  const digits = iso.replace(/[-:T]/g, '').slice(0, 14) // YYYYMMDDHHMMSS
  const year = date.getUTCFullYear()
  return year >= 1950 && year <= 2049
    ? tlv(UTC_TIME, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(GENERALIZED_TIME, Buffer.from(`${digits}Z`, 'ascii'))
}

/** `[n] EXPLICIT` — a context-tagged constructed wrapper around a complete element. */
export const explicit = (n: number, body: Uint8Array): Uint8Array => tlv(0xa0 | n, body)

/** `[n] IMPLICIT` primitive — the context tag replaces the element's own tag. */
export const implicit = (n: number, body: Uint8Array): Uint8Array => tlv(0x80 | n, body)

// ── PEM ─────────────────────────────────────────────────────────────────────

export function toPem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}
