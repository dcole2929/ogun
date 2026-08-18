import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('../src/main.ts', import.meta.url))

const DOC = JSON.stringify({
  findings: [
    {
      fingerprint: 'security/public-orders/account-isolation/cross-account-id-swap',
      title: 'Order lookup trusts a client-supplied account id',
      body: 'getOrder() reads accountId from the request body and never checks the session.',
      severity: 'high',
      confidence: 0.85,
      citations: [{ path: 'src/routes/orders.ts', line: 44 }],
    },
  ],
})

// Through the real command, in a child process: the document arrives on stdin, which is
// how a skill invokes it and the only part of this that the in-process function cannot
// stand in for.
const write = (out: string): void => {
  execFileSync(process.execPath, [cli, 'findings', 'write', '--out', out], {
    input: DOC,
    stdio: ['pipe', 'ignore', 'inherit'],
  })
}

const modeOf = async (path: string): Promise<string> => ((await stat(path)).mode & 0o777).toString(8)

const outPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'ogun-findings-')), 'findings.json')

test('the findings document is owner-only when the CLI creates it', async () => {
  const out = await outPath()
  write(out)
  assert.equal(await modeOf(out), '600')
})

/**
 * The prompt tells the agent not to hand-write this file, which is exactly why it
 * happens. `writeFile`'s `mode` is honoured only when it creates the file, so a
 * findings.json the agent had already touched at 0644 stayed 0644 — a list of unfixed
 * vulnerabilities, world-readable on the runner for the length of the run.
 */
test('a findings document the agent already touched is rewritten owner-only', async () => {
  const out = await outPath()
  await writeFile(out, '{"findings": []}\n')
  await chmod(out, 0o644)

  write(out)

  assert.equal(await modeOf(out), '600')
  assert.match(await readFile(out, 'utf8'), /cross-account-id-swap/)
})
