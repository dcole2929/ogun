import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

/**
 * A reviewer re-filing something a person dismissed gets nothing for the row — the
 * control plane suppresses it — so the one useful moment to say so is here, while the
 * agent can still spend the finding on a `duplicate-of` verdict instead.
 *
 * Deliberately a remark and not a refusal. Failing the write would push an agent into
 * dropping a finding it believes in, and the mechanism does not need the agent's
 * cooperation to work: the suppression happens either way (ADR-0011).
 */
test('re-filing a dismissed finding is remarked on rather than refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-dismissed-'))
  await mkdir(join(dir, '.ogun-in'), { recursive: true })
  await writeFile(
    join(dir, '.ogun-in/history.json'),
    JSON.stringify({
      findings: [
        {
          fingerprint: 'security/public-orders/account-isolation/cross-account-id-swap',
          status: 'wontfix',
          severity: 'high',
          title: 'already decided',
          seenCount: 4,
          lastSeenAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    }),
  )

  const printed = execFileSync(
    process.execPath,
    [cli, 'findings', 'write', '--out', join(dir, '.ogun-out/findings.json')],
    { input: DOC, encoding: 'utf8', cwd: dir },
  )

  assert.match(printed, /already dismissed/)
  assert.match(printed, /cross-account-id-swap/)
  assert.match(printed, /suppressed rather than published/)
  // And the document is still written: the remark is information, not a gate.
  assert.match(await readFile(join(dir, '.ogun-out/findings.json'), 'utf8'), /cross-account/)
})

/**
 * The inbox the remarks read is the one beside the document being written, and nothing
 * else. They used to locate it from the module-level default instead of from `--out`, so
 * the two disagreed the moment those were not the same place — and `OGUN_OUTPUT_PATH` is
 * exactly that moment: the sandbox image sets it to an absolute
 * `/workspace/.ogun-out/findings.json`, so a `--out` under a temp directory still read
 * `/workspace/.ogun-in/`. That is why the test above passed on a laptop and failed inside
 * the container that runs this suite as a modifier's gate.
 *
 * Pinned with the variable set to somewhere else entirely, so this stands whether or not
 * the machine running it happens to be a sandbox.
 */
test('the inbox is found beside the document written, not beside the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-out-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'ogun-elsewhere-'))
  await mkdir(join(dir, '.ogun-in'), { recursive: true })
  await writeFile(
    join(dir, '.ogun-in/history.json'),
    JSON.stringify({
      findings: [
        {
          fingerprint: 'security/public-orders/account-isolation/cross-account-id-swap',
          status: 'wontfix',
          severity: 'high',
          title: 'already decided',
          seenCount: 4,
          lastSeenAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    }),
  )

  const printed = execFileSync(
    process.execPath,
    [cli, 'findings', 'write', '--out', join(dir, '.ogun-out/findings.json')],
    {
      input: DOC,
      encoding: 'utf8',
      cwd: elsewhere,
      env: { ...process.env, OGUN_OUTPUT_PATH: join(elsewhere, '.ogun-out/findings.json') },
    },
  )

  assert.match(printed, /already dismissed/)
})
