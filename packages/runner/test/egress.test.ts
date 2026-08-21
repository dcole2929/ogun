import { strict as assert } from 'node:assert'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultEgressAllow, resolveEgressAllow } from '@ogun/core'
import {
  CA_CONTAINER_PATH,
  isAllowedHost,
  loadOrCreateCa,
  PLACEHOLDER,
  startGateway,
} from '@ogun/gateway'
import { buildRunArgs, GUEST_WORKSPACE, type SandboxEgress } from '../src/sandbox/container.ts'
import {
  GUEST_EGRESS_SOCKET,
  GUEST_PROXY_AUTHORITY,
  GUEST_PROXY_PORT,
} from '../src/sandbox/egress.ts'

/**
 * Egress was `open | none`, defaulting to `open`, while §4.6 specified a host allowlist
 * and §9 recorded the gap as an open question. `open` is unrestricted internet, and the
 * sandbox was mounted a live OAuth credential — so the shipped default was an agent that
 * could read its own credential and POST it anywhere. The motivating failure is not a
 * malicious agent; it is prompt injection out of the repository an `adversarial-review`
 * worker is aimed at on purpose.
 *
 * Everything here is about what a container *cannot* do. A proxy that forwards is easy;
 * a proxy that refuses, and that cannot be walked around, is the whole point — so each
 * case below is a way the enforcement could be quietly hollow while still looking
 * configured.
 *
 * The enforcement point moved once already, and that is why the behavioural half of this
 * file now speaks to `@ogun/gateway` rather than to a proxy in `packages/runner`. There
 * were two implementations of it — a small allowlist-only proxy here, and the
 * credential-injecting gateway beside it — and two implementations of one rule is one
 * place for it to be true and one place for it to quietly stop being. The smaller one was
 * deleted; every property it protected is asserted below, against the survivor.
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

/** A resolved session, as `provision()` would have built one. Fixed rather than random so
 *  the assertions can name what they expect to see in the argv. */
const session = (over: Partial<SandboxEgress> = {}): SandboxEgress => ({
  socketPath: '/home/dev/.ogun/gateway/proxy.sock',
  caCertificatePath: '/home/dev/.ogun/gateway/ca.pem',
  proxyUrl: `http://x:tok3n@${GUEST_PROXY_AUTHORITY}`,
  stubs: [
    {
      hostPath: '/tmp/ogun-credentials/ogun-test/.credentials.json',
      containerPath: '/host-credentials/claude/.credentials.json',
    },
  ],
  ...over,
})

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
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  assert.deepEqual(flagValues(args, '--network'), ['none'], 'the container must have no network')
  assert.ok(
    args.some((a) => a === `/home/dev/.ogun/gateway/proxy.sock:${GUEST_EGRESS_SOCKET}`),
    'the gateway socket must be mounted in',
  )
})

/**
 * The socket is mounted as a *file*, and the reason got sharper when the gateway became
 * one-per-runner.
 *
 * It used to be that each sandbox had its own socket under one shared directory, so
 * mounting the directory would have handed every container its neighbours' sockets. Now
 * there is one socket, and its directory is `~/.ogun/gateway/` — which also holds
 * `ca.key`, the signing key that can impersonate every host every Ogun container trusts.
 * Mounting the directory would put that key inside the sandbox, which is a strictly worse
 * leak than the credential mount this whole change exists to remove.
 */
test('a container is mounted the socket file, never the directory holding the CA key', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  const mount = args.find((a) => a.includes(GUEST_EGRESS_SOCKET))
  assert.ok(mount?.endsWith(`proxy.sock:${GUEST_EGRESS_SOCKET}`), `mount was ${mount}`)
  assert.ok(
    !args.some((a) => a.startsWith('/home/dev/.ogun/gateway:')),
    'the gateway directory holds ca.key and must never be mounted',
  )
})

/**
 * The socket mount is read-*write*, and it is the one mount that has to be.
 *
 * Connecting to a unix socket requires write permission on the inode. A `:ro` here
 * produces a container that cannot connect at all, and the symptom is not "permission
 * denied on a mount" — it is an agent reporting that it cannot reach its model API.
 */
test('the socket is mounted writable, because a read-only socket cannot be connected to', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  const mount = args.find((a) => a.includes(GUEST_EGRESS_SOCKET))
  assert.ok(mount && !mount.endsWith(':ro'), `socket mount must not be read-only: ${mount}`)
})

/**
 * Failing closed when the runner's own lifecycle is wrong.
 *
 * `provision()` opens the gateway session and sets `egressSession`; if it did not run, the
 * honest options are "no network" or "unrestricted network". Choosing the second would let
 * a bug in the runner silently restore exactly the posture this change exists to remove,
 * and it would do so without a single log line.
 */
test('an allowlist with no gateway session behind it is an airgap, never open internet', () => {
  const args = argsFor({ egress: ['example.com'] })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(!args.some((a) => a.includes(GUEST_EGRESS_SOCKET)), 'nothing to mount')
  assert.equal(envOf(args, 'HTTPS_PROXY'), undefined, 'no proxy to point at')
})

// ---------------------------------------------------------------------------
// Backward compatibility: the four spellings that shipped must keep working
// ---------------------------------------------------------------------------

test('`egress: none` is still a genuine airgap', () => {
  const args = argsFor({ egress: 'none', egressSession: session() })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(!args.some((a) => a.includes(GUEST_EGRESS_SOCKET)), 'none mounts no escape hatch')
  assert.equal(envOf(args, 'HTTPS_PROXY'), undefined)
})

/**
 * `open` stays available as an explicit opt-out — a project whose suite pulls from a dozen
 * hosts needs an answer that is not "give up on egress control". It gets a normal bridge
 * network and no proxy, exactly as before.
 *
 * And, exactly as before, a real credential: `open` is the one path with no gateway to
 * splice one in at, so the choice there is a mounted token or an agent that cannot
 * authenticate at all. That is why `provision()` warns on every run that says it, and why
 * this test asserts the credential is there rather than quietly letting the opt-out become
 * a broken configuration nobody would diagnose.
 */
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
  const args = argsFor({ egressSession: session() })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(args.some((a) => a.includes(GUEST_EGRESS_SOCKET)))
})

// ---------------------------------------------------------------------------
// Credentials: what is at /host-credentials, and under which policy
// ---------------------------------------------------------------------------

/**
 * The property this component exists for, asserted at the mount rather than trusted.
 *
 * A sandbox running through the gateway must be handed the *placeholder* file at the path
 * the real credential used to occupy, and the real one must not appear anywhere in the
 * argv. The naive version of this change adds the stub mount and forgets to remove the
 * other, and docker does not complain — it refuses the duplicate destination, or worse,
 * the paths differ by a component and both land.
 */
test('a gateway-backed container is mounted a placeholder, never the host credential', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  const mounts = flagValues(args, '--volume')
  assert.ok(
    mounts.some((m) => m.endsWith('/host-credentials/claude/.credentials.json:ro')),
    'the stub must land at the path entrypoint.sh copies from',
  )
  assert.ok(
    mounts.every((m) => !m.startsWith(join(process.env.HOME ?? '~', '.claude', '.credentials'))),
    "the host's real credential file must not be mounted anywhere",
  )
})

/**
 * The CA is the other half of the placeholder: without it every TLS handshake through the
 * gateway fails certificate verification, and the run dies looking like a network fault.
 * `CA_CONTAINER_PATH` is the constant, spelled once, in the package that also writes the
 * environment variables pointing at it.
 */
test('the gateway CA is mounted read-only at the one path the environment names', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  assert.ok(
    args.some((a) => a === `/home/dev/.ogun/gateway/ca.pem:${CA_CONTAINER_PATH}:ro`),
    'the CA must be mounted, read-only',
  )
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']) {
    assert.equal(envOf(args, key), CA_CONTAINER_PATH, `${key} points somewhere else`)
  }
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
 *
 * The value is the container's own view of the proxy — the in-image forwarder's loopback
 * address, not where the gateway listens, because `HTTPS_PROXY` has no syntax for a socket
 * path — and it carries this job's session token as basic credentials.
 */
test('both spellings of every proxy variable are set', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  const expected = `http://x:tok3n@${GUEST_PROXY_AUTHORITY}`
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    assert.equal(envOf(args, key), expected, `${key} was not set to the in-container proxy`)
  }
  assert.ok(expected.includes(`:${GUEST_PROXY_PORT}`), 'and it names the forwarder, not the socket')
})

/**
 * `NO_PROXY` must name loopback, in both spellings. The forwarder *is* on loopback, so
 * without the exemption a client that resolves the proxy's own address through the proxy
 * is asking it to CONNECT to itself. All three spellings of loopback, because which one a
 * client compares against depends on whether it normalises the host first — and the ones
 * that do not normalise are exactly the ones that would loop.
 */
test("both spellings of NO_PROXY exempt the container's own loopback", () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = envOf(args, key)
    assert.ok(value, `${key} was not set at all`)
    for (const local of ['localhost', '127.0.0.1', '::1']) {
      assert.ok(value.includes(local), `${key} does not exempt ${local}: ${value}`)
    }
  }
})

/**
 * Node 24 stopped honouring `HTTPS_PROXY` in `fetch` unless told to. The claude CLI is
 * Node, so omitting this is the quietest possible failure: the container talks *straight
 * past* the gateway carrying a placeholder token, every run 401s against the real API, and
 * the gateway sits idle looking perfectly healthy.
 */
test('node is told to honour the proxy environment at all', () => {
  const args = argsFor({ egress: ['example.com'], egressSession: session() })
  assert.equal(envOf(args, 'NODE_USE_ENV_PROXY'), '1')
})

// ---------------------------------------------------------------------------
// The verification container shares the session and holds no credential
// ---------------------------------------------------------------------------

/**
 * The test gate runs in a second container, and it needs egress: a project's suite begins
 * `pnpm install`, and a gate with no route out fails as a red suite that gets blamed on
 * the modifier whose patch it was gating.
 *
 * It does not need a credential — no agent runs in it. Not even a placeholder, and not
 * `settings.json` either, which is the file ADR-0010 records as still able to carry
 * secrets in an `env` block.
 */
test('the verification container shares the egress and holds no credential file', () => {
  // Built the way `exec({ raw: true })` builds it: the same options, under the verify
  // name, with credentials switched off.
  const args = argsFor({
    name: 'ogun-test-verify',
    egress: ['example.com'],
    egressSession: { ...session(), stubs: [] },
    credentials: 'none',
    env: { CI: '1' },
  })
  assert.deepEqual(flagValues(args, '--network'), ['none'])
  assert.ok(args.some((a) => a.includes(GUEST_EGRESS_SOCKET)), 'the gate needs the registry')
  assert.ok(
    !flagValues(args, '--volume').some((m) => m.includes('/host-credentials/')),
    'nothing under /host-credentials belongs in a container that runs a test suite',
  )
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
 *
 * Asserted against `@ogun/gateway`'s matcher, because that is the one that decides. There
 * used to be a second copy in `@ogun/core` and this test used to point at it; when the
 * proxy that called it was deleted, it would have kept passing while enforcing nothing.
 */
test('a wildcard matches subdomains only, at a label boundary', () => {
  const allow = ['*.anthropic.com', 'anthropic.com', 'registry.npmjs.org']
  assert.ok(isAllowedHost('api.anthropic.com', allow))
  assert.ok(isAllowedHost('statsig.anthropic.com', allow))
  assert.ok(isAllowedHost('anthropic.com', allow), 'the parent is listed separately')
  assert.ok(isAllowedHost('registry.npmjs.org', allow))

  assert.ok(!isAllowedHost('notanthropic.com', allow), 'suffix must start at a label boundary')
  assert.ok(!isAllowedHost('anthropic.com.evil.example', allow), 'a prefix is not a match')
  assert.ok(!isAllowedHost('evil.example', allow))
  assert.ok(!isAllowedHost('npmjs.org', allow), 'a parent is not implied by its child')
})

/** Hosts arrive from a CONNECT line, where casing and the root's trailing dot are both
 *  legal and neither is meaningful. `API.Anthropic.Com.` is the same host as
 *  `api.anthropic.com`, and only one of them survives a naive string compare. Refusing the
 *  fully-qualified spelling fails closed rather than open, so it is not a hole — it is an
 *  agent that cannot reach its model API for a reason nothing in the error mentions. */
test('host matching ignores case and the root dot', () => {
  assert.ok(isAllowedHost('API.Anthropic.Com.', ['*.anthropic.com']))
  assert.ok(isAllowedHost('Registry.NPMJS.org', ['registry.npmjs.org']))
  assert.ok(isAllowedHost('registry.npmjs.org', ['registry.npmjs.org.']), 'and in the pattern')
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
  assert.ok(isAllowedHost('api.anthropic.com', defaultEgressAllow('claude')))
  assert.ok(!isAllowedHost('api.openai.com', defaultEgressAllow('claude')))
  assert.ok(isAllowedHost('api.openai.com', defaultEgressAllow('codex')))
  assert.ok(!isAllowedHost('api.anthropic.com', defaultEgressAllow('codex')))
})

/** `open` and `none` are not allowlists, and a caller has to branch on them anyway.
 *  Returning `[]` for `none` would be a second way of spelling "allow nothing" that a
 *  caller could mistake for "no policy configured". */
test('open and none resolve to no allowlist at all', () => {
  assert.equal(resolveEgressAllow('open', 'claude'), undefined)
  assert.equal(resolveEgressAllow('none', 'claude'), undefined)
})

// ---------------------------------------------------------------------------
// The gateway on its socket, for real
// ---------------------------------------------------------------------------

/**
 * The refusal, against a live socket rather than a mock.
 *
 * This starts the actual gateway on the actual transport a sandbox gets and speaks the
 * actual protocol at it, because the thing being protected is a wire format: a CONNECT
 * handler that returned the right verdict but wrote a malformed response would pass any
 * test of the matcher and still hand the container a tunnel. No network is needed — a
 * refusal is decided before anything is dialled, which is exactly why the refusal path is
 * the one that can be tested offline.
 *
 * `packages/gateway/test/gateway.test.ts` covers refusal semantics over TCP in depth. What
 * is here is the same enforcement reached the way a sandbox reaches it, plus the three
 * facts about the socket *file* that only exist in socket mode.
 */
const onSocket = async (
  t: { after: (fn: () => unknown) => void },
  allow: readonly string[],
): Promise<{ socketPath: string; token: string; refusals: string[] }> => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-egress-test-'))
  const refusals: string[] = []
  const gateway = await startGateway({
    ca: loadOrCreateCa(dir),
    socketPath: join(dir, 'proxy.sock'),
    credentials: () => ({}),
    onWarning: () => undefined,
    onRefused: (host) => refusals.push(host),
  })
  t.after(async () => {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  const session = gateway.open(GUEST_PROXY_AUTHORITY, allow)
  assert.equal(gateway.listening.kind, 'socket')
  return {
    socketPath: gateway.listening.kind === 'socket' ? gateway.listening.path : '',
    token: session.token,
    refusals,
  }
}

const speak = (socketPath: string, request: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const client = connect(socketPath, () => client.write(request))
    let out = ''
    client.on('data', (d: Buffer) => {
      out += d.toString()
      // The refusal closes the connection, but a test that waited for `end` would hang
      // forever on the day the gateway stops closing it.
      if (out.includes('\r\n\r\n')) {
        client.destroy()
        resolvePromise(out)
      }
    })
    client.on('error', rejectPromise)
    setTimeout(() => {
      client.destroy()
      rejectPromise(new Error(`gateway did not answer: ${JSON.stringify(out)}`))
    }, 5_000).unref()
  })

const authorized = (token: string): string =>
  `Proxy-Authorization: Basic ${Buffer.from(`x:${token}`).toString('base64')}\r\n`

test('the gateway refuses CONNECT to a host that is not on the session allowlist', async (t) => {
  const { socketPath, token, refusals } = await onSocket(t, ['api.anthropic.com'])

  const response = await speak(
    socketPath,
    `CONNECT evil.example:443 HTTP/1.1\r\n${authorized(token)}\r\n`,
  )
  assert.match(response, /^HTTP\/1\.1 403 /, `expected a refusal, got: ${response}`)
  // The body is the only explanation the container gets — it surfaces in curl's output and
  // in an agent's error message, where "ECONNREFUSED" would send someone hunting a network
  // fault that does not exist.
  assert.match(response, /evil\.example/, 'the refusal must name the host it refused')
  assert.match(response, /allowlist/, 'and must say why')
  // And on the host, once, at the moment it happens. The per-sandbox proxy this replaced
  // reported denials to the runner's log; a container's stderr is an agent transcript, and
  // "the agent could not reach X" is a sentence somebody has to go looking for.
  assert.deepEqual(refusals, ['evil.example'], 'a refusal is recorded for the run log')
})

/** A lookalike is the case worth a dedicated test: it is the one a suffix match lets
 *  through, and the one an attacker can actually buy. */
test('the gateway refuses a host that merely looks like an allowlisted one', async (t) => {
  const { socketPath, token } = await onSocket(t, ['*.anthropic.com', 'anthropic.com'])

  for (const host of ['notanthropic.com', 'anthropic.com.evil.example']) {
    const response = await speak(
      socketPath,
      `CONNECT ${host}:443 HTTP/1.1\r\n${authorized(token)}\r\n`,
    )
    assert.match(response, /^HTTP\/1\.1 403 /, `${host} should not have been allowed`)
  }
})

/**
 * Plain HTTP through the proxy is refused outright, which is stricter than what this
 * replaced and deliberately so.
 *
 * The old proxy relayed `http://` in absolute form, on the reasoning that a scheme that
 * hangs while `https://` works is a difference nobody diagnoses from inside a container.
 * That reasoning does not survive credential injection: the gateway splices the host's
 * real OAuth token into the request, and forwarding cleartext would put that token on
 * plaintext TCP/80 — one `curl` away from anyone on the path. The container still never
 * held it; it would simply be readable on the wire. Every host on the allowlist is an
 * HTTPS API, so cleartext has no legitimate use here.
 */
test('the gateway refuses plain HTTP even to an allowlisted host', async (t) => {
  const { socketPath, token } = await onSocket(t, ['api.anthropic.com'])

  const response = await speak(
    socketPath,
    'GET http://api.anthropic.com/v1/messages HTTP/1.1\r\n' +
      `Host: api.anthropic.com\r\n${authorized(token)}` +
      `Authorization: Bearer ${PLACEHOLDER}\r\n\r\n`,
  )
  assert.match(response, /^HTTP\/1\.1 403 /, `expected a refusal, got: ${response}`)
  assert.match(response, /cleartext_refused/, 'and it must say why, not just refuse')
})

/** A request that is not in absolute form did not come from a proxy client, so there is
 *  no host to check. Guessing one from the `Host:` header would mean the allowlist could
 *  be steered by a header rather than by the connection's actual destination. */
test('the gateway refuses a request with no absolute URL to check', async (t) => {
  const { socketPath, token } = await onSocket(t, ['registry.npmjs.org'])

  const response = await speak(
    socketPath,
    `GET /steal HTTP/1.1\r\nHost: registry.npmjs.org\r\n${authorized(token)}\r\n`,
  )
  assert.match(response, /^HTTP\/1\.1 400 /, `expected a refusal, got: ${response}`)
  assert.match(response, /not_a_proxy_request/)
})

/**
 * The socket is how the container reaches out, so its mode is part of the boundary — and
 * more so now than before, because on the far side of it is not merely an allowlist but
 * the host's real credentials. Connecting to a unix socket needs *write* permission, so
 * any mode wider than 0600 makes this an unauthenticated credential oracle for every
 * local account on the box.
 */
test('the gateway socket is not connectable by other accounts on the host', async (t) => {
  const { socketPath } = await onSocket(t, ['api.anthropic.com'])
  const mode = (await stat(socketPath)).mode & 0o777
  assert.equal(mode, 0o600, `socket mode was ${mode.toString(8)}`)
})

/**
 * And the directory above it, before the socket exists.
 *
 * A unix socket cannot be chmod'd until `listen` has created it, so for a moment it sits
 * at the process umask — on a machine with a permissive umask, that moment is a
 * world-writable route to every credential the host holds. A 0700 parent is what covers
 * the window, and it is the same directory `ca.key` lives in.
 */
test('the directory the socket and the CA key share is closed to other accounts', async (t) => {
  const { socketPath } = await onSocket(t, ['api.anthropic.com'])
  const mode = statSync(join(socketPath, '..')).mode & 0o777
  assert.equal(mode, 0o700, `gateway directory mode was ${mode.toString(8)}`)
})

/** Closing has to remove the socket file. A leftover looks to the next runner exactly
 *  like a live gateway does — `listen` answers EADDRINUSE either way — so it reads as
 *  "another ogun-runner is running on this host" when nothing is. */
test('closing the gateway leaves no socket behind for the next runner to trip over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-egress-close-'))
  const socketPath = join(dir, 'proxy.sock')
  const gateway = await startGateway({
    ca: loadOrCreateCa(dir),
    socketPath,
    credentials: () => ({}),
    onWarning: () => undefined,
  })
  assert.ok(existsSync(socketPath))
  await gateway.close()
  assert.ok(!existsSync(socketPath), 'the socket file outlived the gateway')
  await rm(dir, { recursive: true, force: true })
})

/**
 * A socket that is still being served is not stale, and stealing it is silent.
 *
 * `listen` answers EADDRINUSE for a live socket and for an abandoned one alike, so the
 * tempting fix is an unconditional `rm` before listening. That lets a second runner take
 * the path from a first that is still serving containers: the first keeps working against
 * an unlinked inode, every new sandbox reaches the second, and nothing anywhere reports
 * the split brain. Knock first; unlink only if nobody answers.
 */
test('a second gateway refuses the socket a first is still serving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-egress-steal-'))
  const socketPath = join(dir, 'proxy.sock')
  const first = await startGateway({
    ca: loadOrCreateCa(dir),
    socketPath,
    credentials: () => ({}),
    onWarning: () => undefined,
  })
  await assert.rejects(
    () => startGateway({ ca: loadOrCreateCa(dir), socketPath, credentials: () => ({}) }),
    /another ogun-runner is running/,
  )
  await first.close()
  await rm(dir, { recursive: true, force: true })
})
