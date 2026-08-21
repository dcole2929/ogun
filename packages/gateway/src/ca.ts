import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bitString,
  boolean,
  explicit,
  implicit,
  integer,
  namedBits,
  octetString,
  oid,
  seq,
  set,
  time,
  toPem,
  unsignedInteger,
  utf8String,
} from './der.ts'

/**
 * A local certificate authority, and a leaf per hostname minted on demand.
 *
 * Intercepting TLS means presenting the sandbox a certificate for `api.anthropic.com`
 * that the sandbox believes. There is exactly one honest way to do that: a CA whose
 * private key never leaves this host, trusted *only* inside the container, signing a
 * short-lived leaf for each host the agent reaches.
 *
 * The key stays on the runner host and is never mounted into a sandbox. Only the
 * certificate goes in. That asymmetry is the whole design: a container that got hold of
 * the CA *certificate* can verify the gateway; a container that got hold of the CA *key*
 * could impersonate every site on the internet to anything else that trusts it.
 */

/** Ten years. This is a machine-local root nobody rotates; a short one is a 3am outage. */
const CA_VALIDITY_DAYS = 3650

/**
 * Leaves live a day, and are re-minted an hour before they lapse.
 *
 * The buffer matters more than the lifetime. A cached leaf handed out at T-1s is used by
 * a connection that may run for minutes (a streaming completion), and a certificate that
 * expires *mid-handshake* fails in the client with a date error rather than anything that
 * points at this file.
 */
const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REMINT_BEFORE_MS = 60 * 60 * 1000

const COMMON_NAME = '2.5.4.3'
const ORGANIZATION_NAME = '2.5.4.10'
const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const EXT_SUBJECT_KEY_ID = '2.5.29.14'
const EXT_KEY_USAGE = '2.5.29.15'
const EXT_SUBJECT_ALT_NAME = '2.5.29.17'
const EXT_BASIC_CONSTRAINTS = '2.5.29.19'
const EXT_AUTHORITY_KEY_ID = '2.5.29.35'
const EXT_EXT_KEY_USAGE = '2.5.29.37'
const EKU_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

// KeyUsage bit positions, from RFC 5280 §4.2.1.3.
const KU_DIGITAL_SIGNATURE = 0
const KU_KEY_ENCIPHERMENT = 2
const KU_KEY_CERT_SIGN = 5
const KU_CRL_SIGN = 6

export const CA_SUBJECT = 'Ogun Sandbox Gateway CA'

export type Leaf = { key: string; cert: string }

export type CertificateAuthority = {
  /** PEM, and the only half of the CA that is ever allowed near a container. */
  certificatePem: string
  /** Where the certificate is on disk, so the runner can bind-mount it. */
  certificatePath: string
  /** A key+chain pair valid for `hostname`, minted on first use and cached. */
  leafFor: (hostname: string) => Leaf
}

export const defaultCaDirectory = (): string => join(homedir(), '.ogun', 'gateway')

/**
 * Where the runner listens for sandboxes, by default.
 *
 * A fixed, predictable path rather than a per-run temporary one: `container.ts` has to
 * bind-mount it, `ogun runner doctor` has to look at it, and a path that moved every start
 * would make both of those a lookup instead of a constant.
 */
export const defaultSocketPath = (): string => join(defaultCaDirectory(), 'proxy.sock')

export type CaState =
  | { state: 'missing'; directory: string }
  | { state: 'present'; keyPath: string; keyMode: number }

/**
 * What `ogun runner doctor` can say about the CA without creating one.
 *
 * Deliberately not `loadOrCreateCa`. Doctor reports on a machine, it does not change it,
 * and a diagnostic that silently generates a signing key the first time you run it makes
 * "is the CA present?" a question you can never get a false answer to.
 */
export function caState(directory = defaultCaDirectory()): CaState {
  const keyPath = join(directory, 'ca.key')
  if (!existsSync(keyPath) || !existsSync(join(directory, 'ca.pem'))) {
    return { state: 'missing', directory }
  }
  return { state: 'present', keyPath, keyMode: statSync(keyPath).mode & 0o777 }
}

/**
 * Load the CA from disk, or create one on first use.
 *
 * Persisted rather than generated per start, because the container trusts it by content:
 * a CA regenerated on every runner restart would make every previously-written CA file,
 * every cached image layer, and every in-flight job's trust store wrong at once. It also
 * means `ogun runner doctor` can check a real file's mode.
 */
export function loadOrCreateCa(directory = defaultCaDirectory()): CertificateAuthority {
  const keyPath = join(directory, 'ca.key')
  const certPath = join(directory, 'ca.pem')

  if (!existsSync(keyPath) || !existsSync(certPath)) generateCa(keyPath, certPath)

  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
  const certificatePem = readFileSync(certPath, 'utf8')
  const issuer = caName()
  const issuerKeyId = keyIdentifier(createPublicKey(privateKey))

  const cache = new Map<string, { leaf: Leaf; remintAt: number }>()

  return {
    certificatePem,
    certificatePath: certPath,
    leafFor: (hostname) => {
      const hit = cache.get(hostname)
      if (hit && Date.now() < hit.remintAt) return hit.leaf
      const leaf = mintLeaf(hostname, privateKey, issuer, issuerKeyId, certificatePem)
      cache.set(hostname, { leaf, remintAt: Date.now() + LEAF_VALIDITY_MS - LEAF_REMINT_BEFORE_MS })
      return leaf
    },
  }
}

function generateCa(keyPath: string, certPath: string): void {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const now = new Date()
  const der = signCertificate({
    subject: caName(),
    issuer: caName(),
    subjectPublicKey: publicKey,
    notBefore: now,
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    extensions: [
      // `critical` on basicConstraints and keyUsage: a verifier that does not understand
      // them must refuse the certificate rather than treat this as an ordinary leaf.
      extension(EXT_BASIC_CONSTRAINTS, true, seq(boolean(true))),
      extension(EXT_KEY_USAGE, true, namedBits([KU_KEY_CERT_SIGN, KU_CRL_SIGN])),
      extension(EXT_SUBJECT_KEY_ID, false, octetString(keyIdentifier(publicKey))),
    ],
    signingKey: privateKey,
  })

  // 0600 before anything is written into it, not after. The window between `writeFileSync`
  // and a later `chmod` is short, but this is a CA private key on a multi-user-capable
  // host and `ogun runner doctor` already reports a config file left group-readable.
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, {
    mode: 0o600,
  })
  writeFileSync(certPath, toPem('CERTIFICATE', der), { mode: 0o644 })
}

function mintLeaf(
  hostname: string,
  caKey: KeyObject,
  issuer: Uint8Array,
  issuerKeyId: Uint8Array,
  caCertPem: string,
): Leaf {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const now = new Date()

  const der = signCertificate({
    // The CN is legacy — every verifier written this decade reads the SAN — but a CN of
    // the hostname costs nothing and keeps `openssl s_client` output readable when
    // somebody is debugging why a container will not connect.
    subject: seq(set(seq(oid(COMMON_NAME), utf8String(hostname)))),
    issuer,
    subjectPublicKey: publicKey,
    // Backdated an hour. Clock skew between a WSL2 host and a container that resumed
    // from a suspended VM is real, and a not-yet-valid certificate fails identically to
    // an expired one.
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + LEAF_VALIDITY_MS),
    extensions: [
      extension(EXT_BASIC_CONSTRAINTS, true, seq()),
      extension(EXT_KEY_USAGE, true, namedBits([KU_DIGITAL_SIGNATURE, KU_KEY_ENCIPHERMENT])),
      extension(EXT_EXT_KEY_USAGE, false, seq(oid(EKU_SERVER_AUTH))),
      // Without this the certificate is nameless to anything modern: CN-as-hostname was
      // removed from Chrome in 2017 and from Node's default checkServerIdentity behaviour
      // for certs that carry any SAN. `dNSName` is `[2] IMPLICIT IA5String`.
      extension(EXT_SUBJECT_ALT_NAME, false, seq(implicit(2, ia5(hostname)))),
      extension(EXT_AUTHORITY_KEY_ID, false, seq(implicit(0, issuerKeyId))),
    ],
    signingKey: caKey,
  })

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    // Leaf first, then the CA. A container that trusts the CA does not need it in the
    // chain, but a `curl --cacert` invocation against a different bundle does, and
    // shipping it removes a whole class of "works for node, fails for git" report.
    cert: toPem('CERTIFICATE', der) + caCertPem,
  }
}

/**
 * A `dNSName` is an IA5String — ASCII, and only ASCII.
 *
 * `Buffer.from(s, 'ascii')` does not reject a non-ASCII name, it masks each code unit to
 * seven bits: `xn--` is what a real client sends for an internationalised domain, and
 * anything else here would produce a certificate naming a *different, corrupted* host that
 * still parses and still verifies. Refusing is the only safe answer, and it is unreachable
 * for a hostname that arrived over the wire in a CONNECT line.
 */
function ia5(value: string): Uint8Array {
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`not an ASCII hostname: ${value}`)
  return Buffer.from(value, 'ascii')
}

const caName = (): Uint8Array =>
  seq(
    set(seq(oid(ORGANIZATION_NAME), utf8String('Ogun'))),
    set(seq(oid(COMMON_NAME), utf8String(CA_SUBJECT))),
  )

const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array =>
  // `critical` is DEFAULT FALSE, and DER forbids encoding a field that holds its default.
  // Emitting `BOOLEAN FALSE` produces a certificate that still verifies but is not DER,
  // which some strict verifiers reject outright.
  critical
    ? seq(oid(id), boolean(true), octetString(value))
    : seq(oid(id), octetString(value))

type CertificateSpec = {
  subject: Uint8Array
  issuer: Uint8Array
  subjectPublicKey: KeyObject
  notBefore: Date
  notAfter: Date
  extensions: Uint8Array[]
  signingKey: KeyObject
}

function signCertificate(spec: CertificateSpec): Uint8Array {
  const algorithm = seq(oid(ECDSA_WITH_SHA256))

  const tbs = seq(
    // `[0] EXPLICIT INTEGER 2` — v3. Certificates without it are v1, and a v1 cert may
    // not carry extensions at all, so every extension above would be silently dropped.
    explicit(0, integer(2)),
    unsignedInteger(randomBytes(16)),
    algorithm,
    spec.issuer,
    seq(time(spec.notBefore), time(spec.notAfter)),
    spec.subject,
    spec.subjectPublicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...spec.extensions)),
  )

  // Default `dsaEncoding` is 'der', which is what X.509 wants: the ECDSA-Sig-Value
  // SEQUENCE { r, s }. The 'ieee-p1363' fixed-width form is what WebCrypto and JWS use,
  // and a certificate signed with it verifies nowhere.
  const signature = sign('sha256', tbs, spec.signingKey)

  return seq(tbs, algorithm, bitString(signature))
}

/**
 * RFC 5280's first suggested key identifier: SHA-1 over the public key BIT STRING —
 * here the uncompressed EC point, `04 || x || y`, reassembled from the JWK export so
 * this module needs no DER *reader*.
 *
 * SHA-1 is not a security choice. A key identifier is a lookup hint for chain building;
 * nothing trusts it, and RFC 5280 still specifies exactly this.
 */
function keyIdentifier(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([
    Uint8Array.from([0x04]),
    Buffer.from(jwk.x ?? '', 'base64url'),
    Buffer.from(jwk.y ?? '', 'base64url'),
  ])
  return createHash('sha1').update(point).digest()
}

