import { strict as assert } from 'node:assert'
import { X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, test } from 'node:test'
import { caState, loadOrCreateCa } from '../src/ca.ts'

/**
 * The CA is two files that only mean anything together, created lazily, on a machine that
 * starts several things at once.
 *
 * The property under test is not "a CA exists". It is that **every leaf the loaded CA
 * mints verifies against the certificate that same load reports** — which is the only
 * thing anybody downstream depends on, and the thing a check-then-generate-then-read
 * sequence cannot promise. A naive implementation asks `existsSync` and then reads the two
 * files separately, so it can read a key from one generation and a certificate from
 * another and hand back a CA that signs nothing verifiable. Nothing throws: minting works,
 * the gateway listens, and the failure appears inside a container as a TLS error against
 * `api.anthropic.com` that names no certificate authority at all.
 *
 * It is also self-healing after one success, which is why it has to be tested rather than
 * noticed: once a good pair is on disk nobody regenerates, so the window exists only on a
 * machine nobody has debugged before.
 */

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const caModule = join(here, '..', 'src', 'ca.ts')

const directories: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ogun-ca-race-'))
  directories.push(dir)
  return dir
}
after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
})

/** The one property every caller of `loadOrCreateCa` relies on. */
const mintsVerifiableLeaves = (dir: string): boolean => {
  const ca = loadOrCreateCa(dir)
  const leaf = new X509Certificate(ca.leafFor('api.anthropic.com').cert)
  return leaf.verify(new X509Certificate(ca.certificatePem).publicKey)
}

/**
 * The torn read, staged directly rather than raced for.
 *
 * This is the exact state two simultaneous first-ever starts could leave — or a `ca.pem`
 * restored from a backup taken before the key was rotated, or half a directory copied off
 * another machine. Reproducing it deterministically is the point: the race that produces
 * it is rare and unrepeatable, and the *consequence* is neither.
 */
test('a key and a certificate from different generations are not loaded as a CA', () => {
  const mine = scratch()
  const other = scratch()
  loadOrCreateCa(mine)
  loadOrCreateCa(other)
  // Generation A's key, generation B's certificate. Both files parse; they are simply
  // not a pair, and only asking OpenSSL can tell.
  copyFileSync(join(other, 'ca.pem'), join(mine, 'ca.pem'))

  assert.ok(
    mintsVerifiableLeaves(mine),
    'the CA signed a leaf with a key its own certificate does not name — every ' +
      'container trusting it would fail TLS with an error naming no CA',
  )
})

/**
 * A `ca.key` with no certificate beside it, which is what a process killed mid-generation
 * leaves. It must not be adopted, and it must not wedge the machine either.
 */
test('half a CA is replaced rather than adopted', () => {
  const dir = scratch()
  loadOrCreateCa(dir)
  rmSync(join(dir, 'ca.pem'))
  assert.ok(mintsVerifiableLeaves(dir))
  assert.equal(caState(dir).state, 'present')
})

/**
 * A claim left by a process that is gone must not stop the next start.
 *
 * A lockfile with no timeout and no liveness check turns one crashed `runner start` into
 * a machine where the gateway never comes up again — a strictly worse failure than the
 * race it was added to fix, because it is permanent.
 */
test('a lock left by a dead process does not wedge the next start', () => {
  const dir = scratch()
  // pid 2^31-1: reserved above every pid_max Linux ships, so it cannot be alive.
  writeFileSync(join(dir, 'ca.lock'), '2147483647\n')
  assert.ok(mintsVerifiableLeaves(dir))
})

/**
 * The real thing: separate OS processes, no shared memory, all reaching a fresh directory
 * at once — which is what a machine restarting several runners after a reboot does, and
 * the only configuration in which the original bug could occur at all.
 *
 * Every child mints a leaf and reports whether it verifies against the certificate its own
 * load reported. The suite then re-checks all of them against the single `ca.pem` left on
 * disk, because a child could be internally consistent and still have written a CA that
 * the next process to start will not have.
 */
test('eight simultaneous first-ever starts agree on one certificate authority', async () => {
  const dir = scratch()
  const startAt = Date.now() + 400

  const child = async (): Promise<{ selfConsistent: boolean; leaf: string }> => {
    const { stdout } = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { X509Certificate } from 'node:crypto'
        import { loadOrCreateCa } from ${JSON.stringify(caModule)}
        // A common start instant, so the children collide instead of queueing behind each
        // other's module loading — which takes far longer than generating a CA does.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startAt} - Date.now())
        const ca = loadOrCreateCa(${JSON.stringify(dir)})
        const leaf = ca.leafFor('api.anthropic.com').cert
        process.stdout.write(JSON.stringify({
          selfConsistent: new X509Certificate(leaf).verify(
            new X509Certificate(ca.certificatePem).publicKey,
          ),
          leaf,
        }))
        `,
      ],
      { maxBuffer: 1024 * 1024 },
    )
    return JSON.parse(stdout) as { selfConsistent: boolean; leaf: string }
  }

  const results = await Promise.all(Array.from({ length: 8 }, child))

  const settled = new X509Certificate(readFileSync(join(dir, 'ca.pem'), 'utf8')).publicKey
  for (const [i, result] of results.entries()) {
    assert.ok(result.selfConsistent, `child ${i} minted a leaf its own CA cannot verify`)
    assert.ok(
      new X509Certificate(result.leaf).verify(settled),
      `child ${i} signed against a CA that is no longer the one on disk`,
    )
  }
})
