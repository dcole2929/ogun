import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import {
  openRawTunnel,
  proxySocket,
  speakUpgrade,
  startHarness,
  webSocketAccept,
} from './harness.ts'
import type { Harness } from './harness.ts'
import { PLACEHOLDER } from '../src/stubs.ts'

/**
 * The third door: HTTP Upgrade, and every check it must run.
 *
 * `node:http` delivers a request carrying `Connection: Upgrade` to an `'upgrade'` event,
 * never to `'request'`. A server with no `'upgrade'` listener destroys the socket, and
 * that is what this gateway did — so Codex, which runs its model turn over
 * `wss://chatgpt.com/backend-api/codex/responses`, had every turn's socket dropped
 * mid-handshake and reported it as a credential problem.
 *
 * The naive fix is a listener that pipes the socket at the named host and stops there.
 * That would be the third copy of a bug this component has already had twice: a second
 * entrance that skips the checks the first one makes. So the happy path here is one test
 * out of nine, and the other eight are the refusals — a door that relays perfectly and
 * enforces nothing passes exactly one of them.
 */

const harnesses: Harness[] = []
after(async () => {
  for (const harness of harnesses) await harness.cleanup()
})

const openai = async (allowedHosts?: readonly string[]): Promise<Harness> => {
  const harness = await startHarness({
    hostname: 'chatgpt.com',
    credentials: {
      openai: {
        provider: 'openai',
        mode: 'oauth',
        accessToken: 'oai-REAL-ACCESS-TOKEN',
        accountId: 'acct-REAL',
      },
    },
    ...(allowedHosts ? { allowedHosts } : {}),
  })
  harnesses.push(harness)
  return harness
}

/** The handshake a container's CLI actually sends, minus the frames. */
const CODEX_PATH = '/backend-api/codex/responses'

test('a websocket handshake completes through the tunnel and relays bytes both ways', async () => {
  /**
   * The property: an Upgrade inside an intercepted TLS tunnel reaches the upstream, comes
   * back as a 101 the client accepts, and then carries opaque bytes in both directions.
   *
   * `Sec-WebSocket-Accept` is asserted against the key *this client* chose rather than
   * against a fixed string, because that is what catches a proxy that dropped or rewrote
   * `sec-websocket-key`. The gateway strips hop-by-hop headers on the way out, and
   * `sec-websocket-key` sits one line away in the same header bag from the ones it is
   * right to strip; a version that took the whole family with it would still produce a
   * 101 — from an upstream that had no idea which key it was answering — and every
   * WebSocket client would then close the connection as a failed handshake.
   */
  const harness = await openai()
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const tunnel = await openRawTunnel(harness, { token: session.token, hostname: 'chatgpt.com' })

  const result = await speakUpgrade(tunnel, CODEX_PATH, { host: 'chatgpt.com' })
  assert.equal(result.status, 101)
  assert.equal(result.headers.upgrade, 'websocket')
  assert.equal(result.headers['sec-websocket-accept'], webSocketAccept(result.key))

  // Bytes after the switch, in both directions. The upstream echoes, so a payload that
  // comes back is a payload that crossed the gateway twice.
  const frames = result.next()
  result.socket.write('OPAQUE-FRAME-BYTES')
  assert.equal((await frames).toString('utf8'), 'OPAQUE-FRAME-BYTES')
  tunnel.destroy()
})

test('the real credential is spliced into the handshake and the placeholder never leaves', async () => {
  /**
   * The reason the gateway exists, on the door that had no injection at all.
   *
   * A WebSocket is authenticated once, in the handshake — there is no second chance in a
   * frame. So an upgrade door that relays the request untouched sends the *placeholder*
   * to OpenAI and gets a 401, which is indistinguishable from an expired host credential
   * and sends whoever reads the transcript to re-authenticate something that was fine.
   *
   * `chatgpt-account-id` is asserted alongside the token because a ChatGPT-subscription
   * Codex is billed per account and the account id is a separate header; injecting one
   * without the other authenticates and then fails on entitlement.
   */
  const harness = await openai()
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const tunnel = await openRawTunnel(harness, { token: session.token, hostname: 'chatgpt.com' })

  await speakUpgrade(tunnel, CODEX_PATH, {
    host: 'chatgpt.com',
    headers: {
      authorization: `Bearer ${PLACEHOLDER}`,
      'chatgpt-account-id': PLACEHOLDER,
    },
  })

  const seen = harness.upstream.upgraded.at(-1)
  assert.ok(seen, 'the upstream saw the upgrade')
  assert.equal(seen.headers.authorization, 'Bearer oai-REAL-ACCESS-TOKEN')
  assert.equal(seen.headers['chatgpt-account-id'], 'acct-REAL')
  assert.equal(JSON.stringify(seen.headers).includes(PLACEHOLDER), false)
  tunnel.destroy()
})

test('the proxy token is not forwarded upstream on an upgrade', async () => {
  /**
   * `proxy-authorization` carries the per-job token that opens this gateway. Forwarding it
   * publishes it to whoever is on the other end — and on this door it arrives on the same
   * request as the headers that must be *kept* (`connection`, `upgrade`), so the obvious
   * implementation of "put the hop-by-hop headers back" puts this one back too.
   */
  const harness = await openai()
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const socket = await proxySocket(harness)
  await speakUpgrade(socket, 'https://chatgpt.com/socket', {
    host: 'chatgpt.com',
    proxyToken: session.token,
  })

  const seen = harness.upstream.upgraded.at(-1)
  assert.ok(seen)
  assert.equal(seen.headers['proxy-authorization'], undefined)
  socket.destroy()
})

test('an upgrade with no valid token is challenged, not relayed', async () => {
  /**
   * The first of the four checks the other doors run. A door that relays before
   * authenticating is an open relay reachable by anything that can open the socket —
   * which, over the sandbox's unix socket, is anything in any container the runner
   * mounted it into.
   *
   * A 407 with the challenge header, rather than a destroyed socket, because a client that
   * never sees the challenge reports "the proxy hung up" and the next person debugs the
   * network instead of the token.
   */
  const harness = await openai()
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, 'https://chatgpt.com/socket', {
    host: 'chatgpt.com',
    proxyToken: 'not-a-token-this-gateway-minted',
  })
  assert.equal(result.status, 407)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('an upgrade to a host off the session allowlist is refused', async () => {
  /**
   * The allowlist is a property of the *worker*, not of the gateway: a session opened for
   * `chatgpt.com` must not reach `api.anthropic.com` merely because some other session
   * may. The `dial.rewrite` seam points every hostname at the one local upstream, so if
   * this check were missing the request would succeed and the assertion on
   * `upgraded.length` is what notices.
   */
  const harness = await openai(['chatgpt.com', 'api.anthropic.com'])
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, 'https://api.anthropic.com/socket', {
    host: 'api.anthropic.com',
    proxyToken: session.token,
  })
  assert.equal(result.status, 403)
  assert.match(result.body, /not on the sandbox egress allowlist/)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('an upgrade to an allowlisted host on another port is refused', async () => {
  /**
   * The allowlist matches on hostname alone, so without a separate port check
   * `chatgpt.com:22` is an allowlisted name pointing at somebody else's SSH port — reached
   * through a door that then injects the host's real OAuth token into the first bytes it
   * sends.
   */
  const harness = await openai()
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, 'https://chatgpt.com:22/socket', {
    host: 'chatgpt.com:22',
    proxyToken: session.token,
  })
  assert.equal(result.status, 403)
  assert.match(result.body, /reaches 443/)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('a cleartext upgrade is refused rather than carrying a credential in the open', async () => {
  /**
   * `ws://` is the scheme a WebSocket client reaches for first, and its absolute-form
   * request URI arrives here as `http:`. The gateway splices a live OAuth token into the
   * handshake; putting that on an unencrypted connection is the same bug the `request`
   * door already refuses, and an upgrade door that upgraded the scheme silently would
   * leave the rule true in one place and false in the other.
   */
  const harness = await openai()
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, 'http://chatgpt.com/socket', {
    host: 'chatgpt.com',
    proxyToken: session.token,
  })
  assert.equal(result.status, 403)
  assert.match(result.body, /cleartext_refused/)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('a git push dressed as an upgrade is still a push', async () => {
  /**
   * ADR-0005: the sandbox never pushes, and the refusal is unconditional rather than a
   * consequence of the allowlist or of whether a GitHub credential happens to exist.
   *
   * The door is what makes this worth its own test. `isGitPushRequest` is called from the
   * request path, and an upgrade never reaches that path — so a `GET
   * /owner/repo/info/refs?service=git-receive-pack` with `Connection: Upgrade` on it is a
   * one-header walk around the ADR unless this door calls the check itself. Nothing about
   * an upgrade makes a push *work*; what matters is that the rule is not addressable by
   * choosing a different entrance.
   */
  const harness = await startHarness({
    hostname: 'github.com',
    credentials: { github: { provider: 'github', token: 'ghp-REAL' } },
  })
  harnesses.push(harness)
  const session = harness.gateway.open(undefined, ['github.com'])
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(
    socket,
    'https://github.com/owner/repo/info/refs?service=git-receive-pack',
    { host: 'github.com', proxyToken: session.token },
  )
  assert.equal(result.status, 403)
  assert.match(result.body, /push_refused/)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('an upgrade with no host credential is answered by the gateway, not by the provider', async () => {
  /**
   * The same courtesy the request path already extends. Without it the handshake goes out
   * carrying a placeholder, OpenAI answers 401, and Codex reports "your access token could
   * not be refreshed" — which is a true statement about the placeholder and a completely
   * misleading one about the host.
   */
  const harness = await startHarness({ hostname: 'chatgpt.com', credentials: {} })
  harnesses.push(harness)
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const socket = await proxySocket(harness)
  const result = await speakUpgrade(socket, 'https://chatgpt.com/socket', {
    host: 'chatgpt.com',
    proxyToken: session.token,
  })
  assert.equal(result.status, 502)
  assert.match(result.body, /no_credential/)
  assert.equal(harness.upstream.upgraded.length, 0)
  socket.destroy()
})

test('an upstream that declines to upgrade is reported as its own status, not as a dropped socket', async () => {
  /**
   * A 401 from the upstream handshake has to arrive at the client as a 401.
   *
   * There is no `ServerResponse` on this door, so the status line is written by hand — and
   * the framing is the trap. `node:http` has already decoded a chunked body by the time it
   * reaches us, so relaying the upstream's `Transfer-Encoding: chunked` verbatim would
   * advertise an encoding the bytes no longer carry and the client would wait for a
   * terminating chunk that never comes. The body here is deliberately chunked for that
   * reason: a gateway that forwarded the framing headers hangs this test rather than
   * failing it, and a gateway that dropped the response entirely fails on the status.
   */
  const harness = await openai()
  const refusal = '{"error":"token_invalidated"}'
  harness.upstream.onUpgrade((_req, socket) => {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
        'content-type: application/json\r\n' +
        'transfer-encoding: chunked\r\n\r\n' +
        `${Buffer.byteLength(refusal).toString(16)}\r\n${refusal}\r\n0\r\n\r\n`,
    )
  })
  const session = harness.gateway.open(undefined, ['chatgpt.com'])
  const tunnel = await openRawTunnel(harness, { token: session.token, hostname: 'chatgpt.com' })
  const result = await speakUpgrade(tunnel, CODEX_PATH, { host: 'chatgpt.com' })

  assert.equal(result.status, 401)
  assert.equal(result.headers['transfer-encoding'], undefined)
  assert.equal(result.headers.connection, 'close')
  const body = result.body.length > 0 ? result.body : (await result.next()).toString('utf8')
  assert.match(body, /token_invalidated/)
  tunnel.destroy()
})
