import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import type { Sandbox } from '../src/sandbox/index.ts'

/**
 * The boot gate, exercised through a real shell.
 *
 * The gate's substance is a shell script it composes: background the project's command,
 * poll its readiness endpoint with curl, notice if the process died, and quote the right
 * thing when it did. A mock sandbox that returns `{ code: 0 }` would assert that
 * `runVerifyGate` reads a number, and nothing about the script — which is the whole of
 * what can be wrong here. So the sandbox below runs the script for real, and the
 * application it starts is a real server on a real socket.
 *
 * The port is fixed rather than allocated because the URL is config, and the suite runs
 * with `--test-concurrency=1`.
 */

const PORT = 45087
const URL = `http://127.0.0.1:${PORT}/readyz`

/** A sandbox that runs what it is given, in a shell, on this machine. */
const shellSandbox = (env: NodeJS.ProcessEnv = {}) =>
  ({
    kind: 'container',
    provision: async () => {},
    exec: (argv: string[]) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        env: { ...process.env, ...env },
      })
      const stderr: string[] = []
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
      return {
        lines: createInterface({ input: child.stdout }),
        done: new Promise((resolve) =>
          child.on('close', (code) =>
            resolve({ code: code ?? 1, stderr: stderr.join(''), timedOut: false }),
          ),
        ),
      }
    },
    readFile: async () => null,
    dispose: async () => {},
  }) as unknown as Sandbox

/** A one-line server, so the "application" under test is a real listener. */
const server = (status: number, body: string) =>
  `node -e "require('http').createServer((q,s)=>{s.writeHead(${status},{'content-type':'application/json'});s.end('${body}')}).listen(${PORT})"`

const bootGate = async (command: string, env: NodeJS.ProcessEnv = {}, timeoutMs = 15_000) => {
  const outcome = await runVerifyGate({
    config: undefined,
    permissions: 'modifier',
    output: undefined,
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox: shellSandbox(env),
    // Passes without running anything, so the boot lens is what this asserts on.
    testCommand: 'true',
    boot: { command, probe: { url: URL, status: 200, timeoutMs } },
    deadline: Date.now() + 60_000,
  })
  return outcome.gates.find((g) => g.name === 'boot')
}

test('the gate passes when the application answers its readiness endpoint', async () => {
  const gate = await bootGate(server(200, '{\\"status\\":\\"ok\\"}'))
  assert.equal(gate?.passed, true)
  assert.match(gate?.detail ?? '', /answered 200/)
})

test('an application that starts but is not ready fails, and the body is quoted', async () => {
  // The case the gate exists for: the process is up, and what it depends on is not.
  // heirchive-api answers exactly this when it cannot reach Supabase.
  const gate = await bootGate(
    server(503, '{\\"status\\":\\"error\\",\\"reason\\":\\"supabase unreachable\\"}'),
    {},
    4_000,
  )
  assert.equal(gate?.passed, false)
  assert.match(gate?.detail ?? '', /did not answer 200/)
  assert.match(gate?.detail ?? '', /supabase unreachable/)
})

test('a command that dies is reported as a crash, not as a timeout', async () => {
  const started = Date.now()
  const gate = await bootGate('echo "Error: MONITOR_PASSWORD must be set" >&2; exit 1', {}, 30_000)
  assert.equal(gate?.passed, false)
  assert.match(gate?.detail ?? '', /exited before/)
  // The point of watching the pid: this returns at once rather than waiting out the probe.
  assert.ok(Date.now() - started < 15_000, 'a dead process is noticed, not waited on')
  assert.match(gate?.detail ?? '', /MONITOR_PASSWORD/, 'and its output is what gets quoted')
})

/**
 * A PATH holding everything the gate's script needs except `curl`.
 *
 * Emptying PATH outright would stop the shell itself from being spawned, and the gate
 * would fail for a reason that has nothing to do with the thing under test — the same
 * confusion this whole gate exists to remove.
 */
const pathWithoutCurl = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ogun-nocurl-'))
  for (const tool of ['sh', 'sleep', 'head', 'tail', 'node']) {
    const real = execFileSync('sh', ['-c', `command -v ${tool}`]).toString().trim()
    symlinkSync(real, join(dir, tool))
  }
  return dir
}

test('an image with no curl says so, rather than failing as if the app were broken', async () => {
  const gate = await bootGate(server(200, 'ok'), { PATH: pathWithoutCurl() })
  assert.equal(gate?.passed, false)
  assert.match(gate?.detail ?? '', /no `curl`/)
})

test('a project that declares no boot gate does not get one', async () => {
  const outcome = await runVerifyGate({
    config: undefined,
    permissions: 'modifier',
    output: undefined,
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox: shellSandbox(),
    testCommand: 'true',
    deadline: Date.now() + 60_000,
  })
  assert.equal(
    outcome.gates.some((g) => g.name === 'boot'),
    false,
  )
})
