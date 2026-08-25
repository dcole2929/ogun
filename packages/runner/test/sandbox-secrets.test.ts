import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { claimedJobSchema, localConfigPath } from '@ogun/core'
import { buildRunArgs, GUEST_WORKSPACE, type SandboxEgress } from '../src/sandbox/container.ts'

/**
 * A project's polling secret must be unable to reach a container (ADR-0012, ADR-0010).
 *
 * "The code does not put it there" is not the claim worth making, because the code is
 * what changes. These are the two structural facts underneath it: the wire has no field
 * to carry one to a runner, and nothing the runner mounts contains the file it lives in.
 *
 * The second is the one with a live hazard behind it. `~/.ogun/config.json` now holds a
 * project's API keys alongside the admin token, and it sits one directory above
 * `~/.ogun/gateway/`, which is bind-mounted into every sandbox — as a *file*, deliberately,
 * because that directory also holds `ca.key`. Widening either of those mounts by one path
 * segment hands a container the whole of `~/.ogun`. That is a plausible edit — "mount the
 * directory, it's simpler" — and the reason for the file-level mount is a comment, which
 * an edit can delete. This is the version of it that fails a test run instead.
 */

const store = localConfigPath()

/** A session with the *real* host paths, because the assertion is about those paths and
 *  a fixture under `/tmp` would prove nothing about `~/.ogun`. */
const session = (): SandboxEgress =>
  ({
    socketPath: join(homedir(), '.ogun', 'gateway', 'proxy.sock'),
    caCertificatePath: join(homedir(), '.ogun', 'gateway', 'ca.pem'),
    proxyUrl: 'http://x:tok3n@127.0.0.1:1',
    stubs: [
      {
        hostPath: join(homedir(), '.ogun', 'work', 'run-1', 'stub', '.credentials.json'),
        containerPath: '/host-credentials/claude/.credentials.json',
      },
    ],
    connections: [],
  }) as SandboxEgress

const argsFor = () =>
  buildRunArgs(
    {
      name: 'ogun-test',
      hostWorkspace: join(homedir(), '.ogun', 'work', 'run-1', 'repo'),
      guestWorkspace: GUEST_WORKSPACE,
      permissions: 'modifier',
      runtime: 'claude',
      timeoutMs: 1000,
      image: 'ogun/base:latest',
      egress: ['api.anthropic.com'],
      egressSession: session(),
      env: { OGUN_RUN_ID: 'run-1' },
    } as Parameters<typeof buildRunArgs>[0],
    'ogun/base:latest',
  )

/**
 * The host side of every `--volume`, as an absolute path. Named volumes (`ogun-cache-…`)
 * are not paths and are skipped: a docker volume cannot contain a host file.
 */
const mountedHostPaths = (args: string[]): string[] => {
  const out: string[] = []
  for (const [i, arg] of args.entries()) {
    if (arg !== '--volume') continue
    const source = args[i + 1]?.split(':')[0]
    if (source?.startsWith('/')) out.push(resolve(source))
  }
  return out
}

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}/`)

test('no mount a sandbox gets contains the machine secret store', () => {
  const mounts = mountedHostPaths(argsFor())
  // Non-vacuous: a run with an allowlisted egress really does mount several paths, and
  // two of them are inside `~/.ogun`.
  assert.ok(mounts.length >= 3, `expected several mounts, got ${mounts.join(', ')}`)

  for (const mount of mounts) {
    assert.ok(
      !contains(mount, store),
      `${mount} is mounted into the sandbox and contains ${store}`,
    )
  }
})

test('the gateway directory itself is never mounted, only files inside it', () => {
  /**
   * The specific edit this guards against. `~/.ogun/gateway/` holds `ca.key` — a signing
   * key that can impersonate every host every Ogun container trusts — and now sits beside
   * a config.json holding project API keys. ADR-0010 records the file-level mount as
   * deliberate; without a test, that decision is a paragraph one refactor away from being
   * untrue.
   */
  const gateway = join(homedir(), '.ogun', 'gateway')
  for (const mount of mountedHostPaths(argsFor())) {
    assert.notEqual(mount, gateway)
    assert.notEqual(mount, dirname(gateway))
  }
})

test('no argument to docker carries the store path at all', () => {
  // Belt as well as braces: a mount is not the only way a path reaches a container. An
  // `--env OGUN_CONFIG=…` would be enough on its own, given the sandbox carries a bundled
  // CLI that knows how to read the file.
  for (const arg of argsFor()) {
    assert.ok(!arg.includes(store), `docker argv carried ${store}: ${arg}`)
  }
})

test('a claimed job has no field a secret could ride in on', () => {
  /**
   * The wire half. The runner never opens a database connection (ADR-0001), so everything
   * it knows arrives through `claimedJobSchema` — and zod strips what a schema does not
   * name. A control plane that tried to pass a project's Linear key down to a runner,
   * whether by mistake or by a well-meaning future commit that had not read this, would
   * find it dropped at the door rather than delivered.
   *
   * The same reasoning `syncSchema` uses in the other direction, where narrowing the
   * accepted policy block is the security property rather than an economy.
   */
  const claimed = claimedJobSchema.parse({
    jobId: 'j1',
    runId: 'r1',
    cycleRunId: 'c1',
    projectSlug: 'ogun',
    projectDefaultBranch: 'main',
    workerId: 'w1',
    workerName: 'reviewer',
    workerVersion: 'v1',
    nodeKey: 'n1',
    prompt: 'review',
    runtime: 'claude',
    model: 'sonnet',
    permissions: 'reviewer',
    sandbox: 'container',
    timeoutMs: 1000,
    skillRef: 'skill@1',
    attempt: 0,
    secrets: { linear: 'lin_api_ZZZZZZZZZZZZ' },
  })

  assert.ok(!('secrets' in claimed))
  assert.ok(!JSON.stringify(claimed).includes('lin_api_'))
})
