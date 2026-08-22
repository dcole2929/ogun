import { strict as assert } from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { materializeWorkspace, redactUrlCredentials } from '../src/workspace.ts'

/**
 * A remote clone is the one place a credential is handed to a subprocess as argv, and a
 * failed one is the one place that argv comes back as a string the runner reports and the
 * control plane keeps forever.
 */

test('userinfo is stripped from every url in a message, and nothing else is touched', () => {
  assert.equal(
    redactUrlCredentials("fatal: unable to access 'https://x-access-token:ghp_secret@host/r.git/'"),
    "fatal: unable to access 'https://***@host/r.git/'",
  )
  // The username half is a secret on its own in GitHub's `<token>:x-oauth-basic` form.
  assert.equal(redactUrlCredentials('https://ghp_secret:x-oauth-basic@host/r'), 'https://***@host/r')
  assert.equal(redactUrlCredentials('ssh://git:pw@host/r and https://host/r'), 'ssh://***@host/r and https://host/r')
  assert.equal(redactUrlCredentials('cloned https://host/r.git ok'), 'cloned https://host/r.git ok')
})

/** Port 1 on loopback is refused immediately, so this needs no network and no fixture. */
test('a failed remote clone does not report the credential it was given', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ogun-clone-'))
  await assert.rejects(
    () =>
      materializeWorkspace({
        remoteUrl: 'https://x-access-token:ghp_s3cr3t@127.0.0.1:1/repo.git',
        scratch,
        runId: 'run-1',
      }),
    (err: Error) => {
      assert.ok(!err.message.includes('ghp_s3cr3t'), `credential in error: ${err.message}`)
      assert.ok(!err.message.includes('x-access-token'), `credential in error: ${err.message}`)
      // Redacting must not cost the reader the reason the clone failed.
      assert.match(err.message, /127\.0\.0\.1/)
      return true
    },
  )
})
