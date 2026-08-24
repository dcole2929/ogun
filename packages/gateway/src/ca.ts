import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
 * How long a runner will wait for another process that is already generating the CA, and
 * how old an abandoned claim has to be before it is broken.
 *
 * Generation is one P-256 keypair and one signature — single-digit milliseconds. Five
 * seconds is therefore not a tuning parameter, it is "the holder is not coming back", and
 * a claim naming a pid that is gone is broken immediately without waiting at all. The
 * timeout only ever fires for a live holder that is genuinely stuck, and a runner start
 * that fails with a message naming the lock is better than one that hangs before it
 * listens.
 */
const CA_LOCK_WAIT_MS = 5_000
const CA_LOCK_STALE_MS = 30_000

/** A private key and the certificate that was minted for *that* key. */
type CaMaterial = { privateKey: KeyObject; certificatePem: string }

/**
 * Load the CA from disk, or create one on first use.
 *
 * Persisted rather than generated per start, because the container trusts it by content:
 * a CA regenerated on every runner restart would make every previously-written CA file,
 * every cached image layer, and every in-flight job's trust store wrong at once. It also
 * means `ogun runner doctor` can check a real file's mode.
 *
 * ### The race this used to lose
 *
 * It was `if (!exists) generate()`, then two separate `readFileSync` calls. A CA is two
 * files that only mean anything as a pair, and nothing tied them together:
 *
 *  - Two first-ever runner starts on a fresh box both saw no key, both generated, and the
 *    second overwrote the first. A start that had already read `ca.key` from generation A
 *    then read `ca.pem` from generation B.
 *  - Every leaf that CA signs is then signed by a key the certificate does not name.
 *    Nothing detects it here — minting succeeds, the gateway starts, the socket listens —
 *    and it surfaces inside a container as a TLS verification failure against
 *    `api.anthropic.com`, which reads as an expired credential or a broken proxy. Nothing
 *    in the message names a certificate authority, let alone this file.
 *  - It is benign after the first success, because after that the files exist and nobody
 *    regenerates. That is what makes it expensive: it can only happen on a machine nobody
 *    has debugged before, and it cannot be reproduced on one that works.
 *
 * ### What replaces it
 *
 * Two things, and the second is the one that matters:
 *
 *  - Generation happens under an exclusive `ca.lock`, so only one process generates. A
 *    lock rather than exclusive-creating `ca.key` itself, because the lock has to be
 *    breakable and `ca.key` must never be.
 *  - Every load *verifies the pair*, with `X509Certificate#checkPrivateKey`. A lock is a
 *    convention between processes that agree to take it; the check is a property of the
 *    bytes. It also catches the cases no lock covers — half a directory restored from a
 *    backup, a `ca.pem` copied off another machine — and turns them into a clear failure
 *    instead of a chain that silently verifies nowhere.
 */
export function loadOrCreateCa(directory = defaultCaDirectory()): CertificateAuthority {
  const keyPath = join(directory, 'ca.key')
  const certPath = join(directory, 'ca.pem')

  const { privateKey, certificatePem } = loadPair(keyPath, certPath) ?? createCa(keyPath, certPath)
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

/**
 * The two files as a pair, or nothing — never one of them, and never two that do not go
 * together.
 *
 * `checkPrivateKey` is the whole point. Reading both files proves only that two files
 * exist; a key from generation A and a certificate from generation B both parse, and the
 * CA built from them signs leaves that verify against nothing. OpenSSL answers the
 * question directly, so the mismatch is caught here rather than in a container.
 *
 * Anything unreadable, truncated, or unparseable is `undefined` rather than a throw: a
 * partially-written pair is the *expected* state while another process is mid-generation,
 * and the caller's job is to wait for it or replace it.
 */
function loadPair(keyPath: string, certPath: string): CaMaterial | undefined {
  try {
    if (!existsSync(keyPath) || !existsSync(certPath)) return undefined
    const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
    const certificatePem = readFileSync(certPath, 'utf8')
    if (!new X509Certificate(certificatePem).checkPrivateKey(privateKey)) return undefined
    return { privateKey, certificatePem }
  } catch {
    return undefined
  }
}

/**
 * Generate the CA, or wait for whoever is already generating it.
 *
 * The claim is `ca.lock`, created with `wx` — the one filesystem operation that is
 * atomic across processes without a filesystem that supports anything special. The holder
 * writes its pid into it, which is what makes the claim breakable without a timeout: a
 * lock naming a pid that no longer exists cannot be held by anybody, and a crashed
 * `runner start` must not be able to wedge every later start on the machine forever.
 *
 * The timeout is the second half of that, for the case the pid check cannot decide — a pid
 * recycled by an unrelated process, or a lock left by a container that shared the mount
 * and not the pid namespace. Thirty seconds against a generation that takes single-digit
 * milliseconds.
 *
 * Two processes can in principle break one stale lock together and both generate, which is
 * the original bug at a thousandth of the frequency and only after a crash. It is not left
 * to luck: `loadPair` still checks, so the loser reloads a mismatched pair as `undefined`
 * and takes the lock again rather than building a CA out of halves.
 */
function createCa(keyPath: string, certPath: string): CaMaterial {
  const lockPath = join(dirname(keyPath), 'ca.lock')
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })

  const deadline = Date.now() + CA_LOCK_WAIT_MS
  for (;;) {
    if (claim(lockPath)) {
      try {
        // Re-read under the lock. Losing the race to claim and then being handed the lock
        // as the winner releases it is the common path, not an edge case.
        return loadPair(keyPath, certPath) ?? generateCa(keyPath, certPath)
      } finally {
        rmSync(lockPath, { force: true })
      }
    }

    const pair = loadPair(keyPath, certPath)
    if (pair) return pair
    if (breakIfAbandoned(lockPath)) continue
    if (Date.now() > deadline) {
      throw new Error(
        `another process has held ${lockPath} for over ${CA_LOCK_WAIT_MS}ms without ` +
          'writing a certificate authority. Delete it if nothing is generating one.',
      )
    }
    // Synchronous by necessity: this function is called from a synchronous constructor
    // whose result the gateway needs before it can listen. `Atomics.wait` is the only
    // sleep Node offers that does not require the event loop to turn.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}

const claim = (lockPath: string): boolean => {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** True if a lock was removed because nothing could still be holding it. */
function breakIfAbandoned(lockPath: string): boolean {
  let owner: number
  let age: number
  try {
    owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    age = Date.now() - statSync(lockPath).mtimeMs
  } catch {
    // Gone underneath us, which means the holder finished. Retrying is the right move
    // and reporting a break is not — nothing was broken.
    return false
  }
  // `kill(pid, 0)` asks whether the pid exists without touching it. EPERM means it exists
  // and belongs to somebody else, which still counts as alive.
  const alive = Number.isInteger(owner) && processExists(owner)
  if (alive && age < CA_LOCK_STALE_MS) return false
  rmSync(lockPath, { force: true })
  return true
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Both halves written to unique temporary paths and renamed into place.
 *
 * Rename because a reader does *not* take the lock — the fast path is a plain `loadPair`,
 * and it has to be, or every gateway start would serialise on a file that will exist for
 * the machine's lifetime. So the reader must never see a half-written `ca.pem`, and
 * `writeFileSync` straight to the real path guarantees it eventually will. Rename makes
 * each file appear whole; `loadPair`'s pair check covers the remaining window between the
 * two renames, which is the part no single rename can fix.
 */
function generateCa(keyPath: string, certPath: string): CaMaterial {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const now = new Date()
  const der = signCertificate({
    subject: caName(),
    issuer: caName(),
    subjectPublicKey: publicKey,
    /**
     * Backdated for the same reason `mintLeaf` backdates, which this did not do and
     * should have. A CA minted with `notBefore: now` is not-yet-valid to any verifier
     * whose clock sits even slightly behind the minting one, and WSL2 clocks step
     * backwards on resume. It surfaced as `CERT_NOT_YET_VALID` in roughly one full test
     * run in three — and because the leaf is backdated an hour, the CA was the only
     * certificate in the chain that could have produced it.
     *
     * Worse in production than in the suite: the CA is generated once and cached, so a
     * bad minute is not retried, it is persisted for ten years and every handshake
     * afterwards fails on a date nobody thinks to check.
     */
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
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

  const suffix = `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const keyTmp = keyPath + suffix
  const certTmp = certPath + suffix
  const certificatePem = toPem('CERTIFICATE', der)
  try {
    // 0600 before anything is written into it, not after. The window between
    // `writeFileSync` and a later `chmod` is short, but this is a CA private key on a
    // multi-user-capable host and `ogun runner doctor` already reports a config file left
    // group-readable. `wx` so the mode is a property of every write and not only of the
    // first: `writeFileSync`'s `mode` reaches `open(2)` and is applied on create, so a
    // temp file left behind by a killed process — with a pid the OS has since recycled
    // back to us — would otherwise be written into at whatever mode it already carried.
    writeFileSync(keyTmp, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, {
      flag: 'wx',
      mode: 0o600,
    })
    writeFileSync(certTmp, certificatePem, { flag: 'wx', mode: 0o644 })
    // The certificate first. Both orders leave a window, but this one leaves the harmless
    // half of it: a `ca.pem` with no `ca.key` beside it is ignored by `caState` and by
    // `loadPair`, whereas a `ca.key` alone is a private key on disk that nothing will ever
    // use and nothing will ever clean up.
    renameSync(certTmp, certPath)
    renameSync(keyTmp, keyPath)
  } catch (err) {
    rmSync(keyTmp, { force: true })
    rmSync(certTmp, { force: true })
    throw err
  }
  return { privateKey, certificatePem }
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

