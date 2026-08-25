import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { connectionHosts } from '@ogun/core/connections'
import type { CertificateAuthority } from './ca.ts'
import { loadOrCreateCa } from './ca.ts'
import {
  connectionForHost,
  connectionInjections,
  connectionRequestRefusal,
  NO_CONNECTIONS,
  type ConnectedApp,
  type SessionConnections,
} from './connections.ts'
import type { CredentialSet } from './credentials.ts'
import { credentialReader } from './credentials.ts'
import {
  ALLOWED_CONNECT_PORT,
  DEFAULT_ALLOWED_HOSTS,
  isAllowedHost,
  isAllowedPort,
  isGitPushRequest,
  parseAuthority,
} from './hosts.ts'
import {
  applyInjections,
  injectionsFor,
  providerForHost,
  requiresCredential,
  stripHopByHop,
} from './inject.ts'
import { bodyIsBufferable, isSyntheticRefreshTarget, syntheticRefresh } from './synthetic.ts'

/**
 * The proxy: CONNECT, TLS interception, allowlist, credential injection.
 *
 * The sandbox is handed `HTTPS_PROXY` and a CA to trust, and nothing else. Every request
 * it makes arrives here carrying a placeholder credential; the real one is spliced in on
 * the way out, on the host, in this process. A container that reads every file it can see
 * finds no token, because there is none to find.
 */

/**
 * Only `http/1.1`, in both directions, and this is load-bearing rather than lazy.
 *
 * If the client-facing TLS handshake advertises `h2`, every modern SDK will take it — and
 * then the bytes inside the tunnel are HTTP/2 frames that `node:http` cannot parse. The
 * symptom is not a clean error: the tunnel establishes, the handshake succeeds, and the
 * connection then hangs until something times out. Pinning `http/1.1` on the socket we
 * present is what makes `node:http` a correct parser for what arrives.
 *
 * The cost is real and accepted: no multiplexing, one request in flight per connection.
 * At one agent per container and a handful of containers, that is not the constraint.
 */
const CLIENT_ALPN = ['http/1.1']

/**
 * A client that opens a tunnel and never starts a handshake would otherwise hold the
 * socket, and its leaf certificate, until the process exits.
 */
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000

type Authority = { hostname: string; port: number }

export type GatewaySession = {
  /** What goes in `HTTPS_PROXY`. Carries the token as HTTP basic credentials. */
  proxyUrl: string
  token: string
  /**
   * Called when the job ends. The token stops working immediately, *and* every connection
   * it opened goes down with it.
   *
   * Both halves, because for most of this component's life it was only the first, and the
   * first alone does not mean what this comment says or what ADR-0010 §3.1 rests on. The
   * token is consulted exactly once, on the CONNECT that builds a tunnel; after that TLS is
   * terminated and the plaintext socket is fed to an HTTP server that reads its target off
   * the socket and calls `prepare()`, which re-reads the host's live credential file on
   * every request. So deleting the token closed the front door and left the window open: a
   * tunnel opened a second before the job ended kept being handed fresh, currently-valid
   * Anthropic/OpenAI/GitHub credentials for as long as it stayed open, and nothing on that
   * path ever looked at `sessions` again. The adversary ADR-0010 names is a prompt-injected
   * agent, which can hold a socket open on purpose with a heartbeat request — so "it will
   * close eventually" was not a mitigation, it was a hope.
   */
  revoke: () => void
}

/**
 * Where the gateway listens.
 *
 * A unix socket is the transport that makes the proxy unavoidable rather than advisory.
 * On any network — bridge, host, a dedicated one — `HTTPS_PROXY` is *advice*, and a
 * prompt-injected agent declines it with `curl --noproxy '*'` and talks to the internet
 * directly. A container run `--network none` has no interface to decline with: the socket
 * is a file crossing the same boundary docker already crosses for the workspace, and it is
 * the container's only route out.
 *
 * TCP stays for the case the socket cannot serve — a `worktree` sandbox, and the tests.
 */
export type Listening =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'socket'; path: string }

export type Gateway = {
  listening: Listening
  caCertificatePath: string
  caCertificatePem: string
  /**
   * Exactly what this gateway would splice onto the next request, memoised for five
   * seconds like every other read of it.
   *
   * Exposed so the runner can *report* its credential state to the control plane without
   * opening the files a second time — and, more to the point, without opening them by a
   * second route. The failure this closes is a control plane and a runner disagreeing
   * about the same machine: an `ANTHROPIC_API_KEY` exported into the runner's systemd unit
   * and not the server's used to have the runner authenticating fine while admission
   * refused every job, because admission read `~/` on its own host. A reporter with its
   * own reader would reintroduce the same class of bug one process further in — a
   * different `process.env`, a different `homedir()`, a different moment. One reader, one
   * answer, and the answer is the one that will actually be injected.
   *
   * A `CredentialSet` and not an outlook: this is the raw fact, and the caller decides
   * what to do with it. Nothing here sends a token anywhere — `credentialOutlook()` is
   * what the runner puts on the wire, and it carries expiries only.
   */
  credentials: () => CredentialSet
  /**
   * Mint a token for one job.
   *
   * `containerAuthority` is the `host:port` the *container* reaches the proxy at, which is
   * not always where the gateway listens: over a unix socket it is the in-image forwarder's
   * loopback address, because `HTTPS_PROXY` has no syntax for a socket path. Omitted, the
   * bound TCP address is used.
   *
   * `connections` is this job's grant to reach a connected application (§4.13). Omitted
   * means none, which is what every worker gets unless it wrote `connections:` — and the
   * default is the point of the parameter existing rather than the hosts sitting on
   * `DEFAULT_ALLOWED_HOSTS`, where every worker on the machine would inherit them.
   *
   * Granting an application also puts its hosts on this session's allowlist, so a caller
   * cannot half-grant one: an allowlist entry with no credential behind it would reach the
   * upstream carrying the container's placeholder, and a credential with no allowlist
   * entry would never be reached at all. Both halves come from one argument.
   */
  open: (
    containerAuthority?: string,
    allow?: readonly string[],
    connections?: SessionConnections,
  ) => GatewaySession
  close: () => Promise<void>
}

/** A test seam: where a hostname is actually dialled, and what CA verifies it. */
export type Dial = {
  rewrite?: (hostname: string, port: number) => { host: string; port: number }
  ca?: string | string[]
}

export type GatewayOptions = {
  ca?: CertificateAuthority
  credentials?: () => CredentialSet
  allowedHosts?: readonly string[]
  host?: string
  port?: number
  /** Listen here instead of on TCP. Takes precedence over `host`/`port`. */
  socketPath?: string
  dial?: Dial
  onWarning?: (message: string) => void
  /**
   * Every refusal the gateway makes on policy grounds, for the runner's log.
   *
   * The per-sandbox proxy this replaced had an `onDenied` callback, and the runner used
   * it to print `egress refused <host> (not on the allowlist)` next to the job it
   * happened in. Losing that would have been the quiet half of a regression: the refusal
   * still reaches the *container* as a 403 with a body naming the host, but a container's
   * stderr is an agent transcript, and "the agent could not reach X" is a sentence
   * somebody has to go looking for. On the host it is one line at the moment it happens.
   *
   * Not given the job's identity, because the gateway deliberately does not know about
   * jobs — it knows sessions, and a session is minted with an allowlist and nothing else.
   * Naming the host is what makes the line actionable; naming the run is the pipeline's
   * job and would mean threading a label through `open()` for a log line.
   */
  onRefused?: (host: string, reason: string) => void
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const ca = options.ca ?? loadOrCreateCa()
  const readCredentials = options.credentials ?? credentialReader()
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  const dial = options.dial ?? {}
  const warn = options.onWarning ?? ((message: string) => console.error(`[gateway] ${message}`))
  const refused =
    options.onRefused ??
    ((host: string, reason: string) => console.warn(`[gateway] refused ${host}: ${reason}`))

  /**
   * One job's grant: what its token may reach, and what that token currently holds open.
   *
   * `allow` is per *worker*, not per gateway (§4.6): one runner serves every job on the
   * machine, and a reviewer that declared `egress: [docs.example.com]` must not inherit the
   * reach of a modifier running beside it. Holding one global list would have quietly
   * widened every worker to the union of all of them, which is the kind of regression that
   * never fails a test — it just stops refusing things.
   *
   * `sockets` is the other half of revocation, and it exists because a token check that
   * runs once cannot revoke anything. Every long-lived connection this gateway hands out
   * is authenticated at the moment it is *opened* and never again — a CONNECT tunnel, an
   * upgraded WebSocket — so without a way back to those sockets, `revoke()` can only
   * refuse the next connection while the current one keeps spending the host's
   * credentials. The set is what makes "the token stops working" true of connections that
   * already exist.
   *
   * `token` is on the record as well as being its key, so a handler holding a session can
   * ask whether it is still *the* session for that token by identity rather than by
   * re-deriving it from a header. That is the check the intercepted doors run.
   */
  type Session = {
    token: string
    allow: readonly string[]
    /**
     * Which connected applications this job was granted, and how to read their current
     * credential (§4.13).
     *
     * On the session for exactly the reason `allow` is: one gateway serves every job on
     * the machine, and a connection held anywhere else would be a connection every worker
     * on the box inherits. `adversarial-review` is aimed at untrusted repository content
     * on purpose — a global here would give the attacker in that story a credentialed path
     * to the project's issue tracker, which is a strictly worse outcome than the mounted
     * model token ADR-0010 removed.
     *
     * `NO_CONNECTIONS` is the default and is what every session that does not ask gets.
     */
    connections: SessionConnections
    sockets: Set<Socket>
  }

  const sessions = new Map<string, Session>()

  /**
   * Which session the caller presented, if any.
   *
   * Returns the whole grant rather than a boolean for the reason it always has: it makes
   * it impossible to authenticate against one session and then check the host against
   * something else, which is exactly the bug a global `allowedHosts` would reintroduce the
   * first time two workers wanted different reach.
   *
   * Three token shapes are accepted because three clients produce three shapes from the
   * same `http://x:TOKEN@host` URL — see `proxyToken`.
   */
  const sessionFor = (headers: IncomingHttpHeaders): Session | undefined => {
    const token = proxyToken(headers)
    return token === undefined ? undefined : sessions.get(token)
  }

  /**
   * Remember a connection for exactly as long as it is open.
   *
   * The bookkeeping is the part of this that can quietly become its own bug: a map of
   * sockets that only ever grows is a memory leak in a process that is meant to run for
   * weeks, and the runner is exactly that process. So there is one rule — an entry is
   * added when the connection is accepted and removed when it closes — and `'close'` is
   * the event to hang it on rather than `'end'`, because `'close'` fires for every way a
   * socket can go away, including the destroy that `revoke()` itself performs.
   *
   * The guard is not defensive noise: on the absolute-form door a keep-alive socket is
   * re-authenticated on every request, so `hold` is called once per request for the same
   * socket, and an unguarded `once('close')` would stack a listener each time and start
   * printing MaxListenersExceeded warnings at the eleventh.
   *
   * The closure keeps the `Session` alive until the socket closes, which is the right
   * lifetime: a revoked session is unreachable from `sessions` and is collected once the
   * last connection it opened has gone.
   */
  const hold = (session: Session, socket: Socket): void => {
    if (session.sockets.has(socket)) return
    session.sockets.add(socket)
    socket.once('close', () => session.sockets.delete(socket))
  }

  /**
   * Is the session this connection was opened under still the session for its token?
   *
   * Compared by identity, not by presence. Tokens are 256 bits from the CSPRNG and are
   * never reissued, so `sessions.has(token)` would answer the same question today — but
   * identity is the question actually being asked ("is *this grant* still in force"), and
   * it stays correct if anything ever mints a session for a token twice.
   */
  const inForce = (session: Session | undefined): session is Session =>
    session !== undefined && sessions.get(session.token) === session

  /**
   * What a CONNECT leaves on the socket it built, for the handlers on the far side of it.
   *
   * `ogunAuthority` was always here: the intercepted server serves sockets it did not
   * accept, so the target has to travel on the socket. `ogunSession` rides along for the
   * same reason and closes the same gap — the token was checked once, at CONNECT, and
   * every request afterwards had no way to ask which grant it was running under.
   */
  type Marked = { ogunAuthority?: Authority; ogunSession?: Session }

  /**
   * The intercepted-request handler. One instance, fed sockets from every tunnel.
   *
   * `node:http` will happily serve a socket it did not accept itself, which is what makes
   * TLS interception a dozen lines rather than an HTTP implementation: terminate TLS on
   * the CONNECT socket, then hand the plaintext duplex to a server as a connection.
   */
  const intercepted = createHttpServer((req, res) => {
    const marked = req.socket as TLSSocket & Marked
    const authority = marked.ogunAuthority
    if (!authority) return refuse(res, 500, 'internal', 'intercepted socket has no host')
    /**
     * The token, again, on every request rather than once per tunnel.
     *
     * `revoke()` tears this socket down, so in the ordinary case this branch never fires —
     * which is precisely why it is here. It is the structural half of the fix: the two
     * failures it covers are a request that crossed the revoke in flight, and a socket
     * that escaped the bookkeeping for any reason at all. Without it, "does this
     * connection still have a grant" is answered by a `Set` being correct, and the
     * original bug was exactly what happens when the only answer to that question is
     * somewhere else. Refused before `prepare()`, so no credential file is read.
     */
    const session = marked.ogunSession
    if (!inForce(session)) return refuseRevoked(res)
    // The port from the CONNECT line, not a hardcoded 443. An allowlisted host reached on
    // a non-standard port would otherwise be silently retargeted at 443, which either
    // works against the wrong service or fails as a connection refused nobody can explain.
    void forward(authority.hostname, authority.port, req, res, session)
  })
  intercepted.on('clientError', (_err, socket) => socket.destroy())

  /**
   * The same door, inside a tunnel.
   *
   * This is where Codex's `wss://chatgpt.com/backend-api/codex/responses` actually lands:
   * the CONNECT already happened, TLS is already terminated, and the handshake arrives on
   * the intercepted connection as a `GET` with `Connection: Upgrade`.
   *
   * The allowlist and the port were checked on the CONNECT that built this socket, and
   * `ogunAuthority` is the evidence of it — exactly as for the `'request'` handler above.
   * The *token* is checked again here, for the same reason and with more at stake: this is
   * the door onto the longest-lived connection the gateway holds. Codex runs its whole
   * model turn over `wss://chatgpt.com/backend-api/codex/responses`, so once the 101 lands
   * this stops being a sequence of requests and becomes two pipelines relaying opaque
   * bytes — nothing after this point will ever consult a session again. A revocation that
   * reached the request path and not this one would leave the connection most likely to
   * still be spending the host's credential as the one it could not touch.
   *
   * What is left is what `forwardUpgrade` does: the push refusal, the credential answer,
   * and the injection.
   */
  intercepted.on('upgrade', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined)
    const marked = socket as TLSSocket & Marked
    const authority = marked.ogunAuthority
    if (!authority) {
      return refuseSocket(socket, 500, 'internal', 'intercepted socket has no host')
    }
    const session = marked.ogunSession
    if (!inForce(session)) {
      return refuseSocket(socket, 403, 'session_revoked', REVOKED_MESSAGE)
    }
    forwardUpgrade(authority.hostname, authority.port, req, socket, head, session)
  })

  const proxy = createHttpServer()

  /**
   * The other door.
   *
   * A proxy is reachable two ways, and an implementation that only handles CONNECT leaves
   * the second one wide open: `GET http://host/path HTTP/1.1` sent straight at the proxy
   * port, in absolute form. Some clients use it for plain HTTP always, and a few use it
   * for HTTPS too. It has to run the same authentication, the same allowlist and the same
   * injection, or it is an unauthenticated open relay sitting next to a governed one.
   */
  proxy.on('request', (req, res) => {
    const session = sessionFor(req.headers)
    if (!session) return challenge(res)
    /**
     * Held even though this door re-authenticates every request anyway.
     *
     * The token check makes the *next* request on this keep-alive socket impossible after a
     * revoke, which is most of it — but not the response already streaming. A completion is
     * Server-Sent Events that runs for minutes, and a job whose token was revoked mid-stream
     * would otherwise go on receiving a response the host is still being billed for. Same
     * rule as every other door: hold on accept, release on close.
     */
    hold(session, req.socket)
    const allow = session.allow
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      return refuse(res, 400, 'not_a_proxy_request', 'expected an absolute-form request URI')
    }
    /**
     * `https:` and nothing else, compared exactly.
     *
     * This was `protocol.startsWith('http')`, which is two bugs wearing one coat. It
     * accepted `httpz:` — anything beginning "http" — and, worse, it accepted `http:` and
     * forwarded it in the clear. A sandbox sending
     * `GET http://api.anthropic.com/v1/messages` at the proxy port passed the allowlist
     * (the hostname is allowlisted), had the host's live OAuth token spliced in, and had
     * it put on plaintext TCP/80. The container still never held the token; the token was
     * simply on the wire unencrypted, one `curl` away from anyone on the path.
     *
     * Every host on the allowlist is an HTTPS API, so cleartext has no legitimate use here
     * and is refused rather than upgraded — an upgrade would work silently and leave the
     * next person to discover the rule by reading this file.
     */
    if (target.protocol !== 'https:') {
      refused(target.hostname, `${target.protocol}// puts a credential in the clear`)
      return refuse(
        res,
        403,
        'cleartext_refused',
        `${target.protocol}// is refused — the gateway splices real credentials into ` +
          'requests and will not put one on an unencrypted connection. Use https.',
      )
    }
    const port = strictPortOf(target) ?? 443
    if (!isAllowedPort(port)) {
      refused(target.hostname, `port ${port} is not ${ALLOWED_CONNECT_PORT}`)
      return refusePort(res, target.hostname, port)
    }
    if (!isAllowedHost(target.hostname, allow)) {
      refused(target.hostname, "not on this worker's allowlist")
      return refuseHost(res, target.hostname)
    }
    req.url = target.pathname + target.search
    void forward(target.hostname, port, req, res, session)
  })

  /**
   * The third door, on the plain side.
   *
   * An `Upgrade` request can arrive in absolute form straight at the proxy port, exactly
   * as a `GET http://host/path` can — and for exactly the same reason it has to run every
   * check the other doors run. Left unhandled it was closed rather than relayed, so this
   * is not fixing a hole; it is refusing to open one while adding the upgrade support the
   * tunnel door needs.
   *
   * Written as its own listener rather than folded into `'request'` because `node:http`
   * will never deliver these to `'request'`: an upgrade is a different event with a raw
   * socket instead of a `ServerResponse`, which is why every refusal below is written by
   * hand onto the wire.
   */
  proxy.on('upgrade', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined)

    const session = sessionFor(req.headers)
    if (!session) return challengeSocket(socket)
    // This socket is checked once and then relays for as long as it likes, exactly like a
    // tunnelled upgrade — and it never becomes a `TLSSocket`, so it carries no marks and
    // the intercepted doors never see it. Holding it here is the only way `revoke()` ever
    // reaches it.
    hold(session, socket)
    const allow = session.allow

    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      return refuseSocket(
        socket,
        400,
        'not_a_proxy_request',
        'expected an absolute-form request URI',
      )
    }
    // `https:` exactly, for the reason written out above `proxy.on('request')`: the
    // gateway splices a real credential into what it forwards and will not put one on an
    // unencrypted connection. `ws:` lands here too and is refused by the same rule.
    if (target.protocol !== 'https:') {
      refused(target.hostname, `${target.protocol}// puts a credential in the clear`)
      return refuseSocket(
        socket,
        403,
        'cleartext_refused',
        `${target.protocol}// is refused — the gateway splices real credentials into ` +
          'requests and will not put one on an unencrypted connection. Use https.',
      )
    }
    const port = strictPortOf(target) ?? 443
    if (!isAllowedPort(port)) {
      refused(target.hostname, `port ${port} is not ${ALLOWED_CONNECT_PORT}`)
      return refuseSocket(
        socket,
        403,
        'port_not_allowed',
        `${target.hostname}:${port} is refused — a sandbox reaches ${ALLOWED_CONNECT_PORT} ` +
          'and nothing else',
      )
    }
    if (!isAllowedHost(target.hostname, allow)) {
      refused(target.hostname, "not on this worker's allowlist")
      return refuseSocket(
        socket,
        403,
        'host_not_allowed',
        `${target.hostname} is not on the sandbox egress allowlist`,
      )
    }
    req.url = target.pathname + target.search
    forwardUpgrade(target.hostname, port, req, socket, head, session)
  })

  proxy.on('connect', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined)

    const session = sessionFor(req.headers)
    if (!session) {
      // A CONNECT with no valid token is refused rather than tunnelled. Serving it would
      // mean copying bytes to any host the client names, with no allowlist and no
      // injection — an open relay reachable by anything that can open the socket, which is
      // precisely what the gateway exists to not be.
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          // Without the challenge header many clients never retry with credentials, and
          // the failure reads as "the proxy hung up" instead of "wrong token".
          'Proxy-Authenticate: Basic realm="ogun-gateway"\r\n' +
          'Connection: close\r\n\r\n',
      )
      return
    }
    const allow = session.allow

    const authority = parseAuthority(req.url ?? '')
    if (!authority) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    if (!isAllowedHost(authority.hostname, allow)) {
      refused(authority.hostname, "not on this worker's allowlist")
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n` +
          `ogun-gateway: ${authority.hostname} is not on the sandbox egress allowlist\r\n`,
      )
      return
    }
    // The allowlist matches on hostname alone, so the port has to be checked separately or
    // `api.anthropic.com:22` is an allowlisted name pointing at somebody else's SSH port —
    // intercepted and credentialed. `parseAuthority` has always returned the port with a
    // comment saying exactly this; nothing acted on it until now.
    if (!isAllowedPort(authority.port)) {
      refused(authority.hostname, `port ${authority.port} is not ${ALLOWED_CONNECT_PORT}`)
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n` +
          `ogun-gateway: port ${authority.port} is refused — a sandbox reaches ` +
          `${ALLOWED_CONNECT_PORT} and nothing else\r\n`,
      )
      return
    }

    /**
     * From here the tunnel exists, so the session has to be able to find it again.
     *
     * The *raw* socket, not the `TLSSocket` that is about to wrap it. Destroying the raw
     * socket is unambiguous — it takes the TLS layer, the intercepted connection and any
     * upgrade riding on it down together — whereas destroying only the wrapper leaves the
     * question of what the underlying socket does next, which is not a question worth
     * having in the teardown path of a security control.
     */
    hold(session, socket)

    // 200 before the handshake, because that is the order the protocol requires: the
    // client will not start TLS until the tunnel is established. Anything that goes wrong
    // from here on surfaces to the client as a TLS error rather than an HTTP status,
    // which is why the checks above all happen first.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    /**
     * The hostname comes from the CONNECT line, never from SNI.
     *
     * An `SNICallback`-shaped design has a hole: a client that sends no SNI — curl to a
     * literal IP, some Go and older Python clients — never fires the callback, and the
     * server falls back to a default certificate with the wrong name. The CONNECT
     * authority is always present and is the name the client is going to verify against.
     */
    /**
     * Bytes the client sent immediately after the CONNECT line, back onto the socket
     * *before* TLS wraps it.
     *
     * `head` is the start of the ClientHello from a client that did not wait for the 200 —
     * still encrypted, still the TLS layer's input. Replaying it into the `TLSSocket`
     * instead injects ciphertext into the plaintext side, where it is read as a mangled
     * HTTP request or as nothing at all. The bug hides completely in testing, because most
     * clients do wait for the 200 and `head` is then empty: it only appears against a
     * pipelining client, as a handshake that stalls or a first request that is garbage.
     */
    if (head.length > 0) socket.unshift(head)

    const leaf = ca.leafFor(authority.hostname)
    const tls = new TLSSocket(socket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ALPNProtocols: CLIENT_ALPN,
    })
    // Both marks, together: where this tunnel is pointed, and under whose grant. The
    // second is what lets every request and every upgrade inside it ask a question the
    // CONNECT used to answer once and for all.
    ;(tls as TLSSocket & Marked).ogunAuthority = authority
    ;(tls as TLSSocket & Marked).ogunSession = session
    tls.on('error', () => tls.destroy())

    const handshakeTimer = setTimeout(() => tls.destroy(), TLS_HANDSHAKE_TIMEOUT_MS)
    tls.once('secure', () => clearTimeout(handshakeTimer))
    handshakeTimer.unref()

    intercepted.emit('connection', tls)
  })

  // A failed accept is almost always transient — EMFILE clears as connections close,
  // ECONNABORTED is a client that gave up mid-handshake. Letting it reach the process's
  // error handler would take down the runner, and with it every job in flight.
  proxy.on('error', (err) => warn(`listener error: ${err.message}`))
  proxy.on('clientError', (_err, socket) => socket.destroy())

  /**
   * Everything that happens to a request between "it is allowed through" and "it goes on
   * the wire", for every door.
   *
   * Extracted rather than repeated, and that is the whole point of it existing. This
   * gateway has already shipped the same bug twice — a second entrance that skipped a
   * check the first one made (see the long comment above `proxy.on('request')`) — and a
   * third entrance was then added for HTTP Upgrade. Three copies of "refuse a push, refuse
   * a missing credential, inject, rewrite Host" is three chances for one of them to drift.
   * One function is a structural answer instead of a promise: a door that forwards without
   * calling this has nothing to forward, because this is where the headers come from.
   */
  type Prepared =
    | { ok: true; headers: Record<string, string | string[] | undefined> }
    | { ok: false; status: number; error: string; message: string }

  function prepare(
    hostname: string,
    port: number,
    method: string,
    path: string,
    requestHeaders: IncomingHttpHeaders,
    session: Session,
  ): Prepared {
    /**
     * ADR-0005, enforced here as well as at the workspace.
     *
     * Refused before the allowlist and before any credential is looked at, because the
     * reason is not "this host is not allowed" or "you were not granted a token" — it is
     * that a proxy cannot tell a push to a topic branch from a force-push to `main`. The
     * refs are in a pkt-line body nothing here parses.
     */
    if (isGitPushRequest(method, path)) {
      refused(hostname, 'a git push (ADR-0005)')
      return {
        ok: false,
        status: 403,
        error: 'push_refused',
        message:
          'the sandbox never pushes (ADR-0005) — a modifier commits locally and the runner ' +
          'extracts a patch on the host',
      }
    }

    /**
     * A connected application (§4.13), which is a different subject from a provider.
     *
     * Before the provider path and before `readCredentials()`, because these hosts belong
     * to no provider and reaching one is decided entirely by *this session's* grant. A
     * request that falls through to the provider path would be forwarded with the
     * container's placeholder and collect somebody else's 401.
     */
    const app = connectionForHost(hostname)
    if (app) return prepareConnection(app, session, hostname, port, method, path, requestHeaders)

    const credentials = readCredentials()
    const provider = providerForHost(hostname)
    if (provider && requiresCredential(provider) && !credentials[provider]) {
      /**
       * Said here rather than forwarded.
       *
       * A request to `api.anthropic.com` with a placeholder token gets a 401 from
       * Anthropic, and the CLI reports it as "your credentials are invalid" — which sends
       * whoever reads the transcript to re-authenticate a host credential that was fine.
       * The gateway knows the actual cause, so it answers with it.
       */
      return {
        ok: false,
        status: 502,
        error: 'no_credential',
        message:
          `no ${provider} credential is available on this host — the sandbox holds only a ` +
          'placeholder, so the request cannot be completed. Run `ogun runner doctor`.',
      }
    }

    const headers = applyInjections(
      stripHopByHop(requestHeaders as Record<string, string | string[] | undefined>),
      injectionsFor(hostname, credentials),
    )
    // `host` is rewritten to the real target rather than passed through: the client set it
    // from the URL it thinks it is talking to, which is the same name, but a request that
    // was retargeted would otherwise carry the wrong one silently.
    headers.host = port === 443 ? hostname : `${hostname}:${port}`
    return { ok: true, headers }
  }

  /**
   * The three checks a request to a connected application passes, in the order their
   * answers stop being guesses.
   *
   * Split out of `prepare()` rather than inlined, and kept behind the same single funnel
   * every door already goes through: `prepare()` exists because this gateway has shipped
   * the "second entrance that skipped a check" bug twice, and a connection is now the
   * fourth kind of thing a door can be asked to forward. A separate function that some
   * door called directly would be that bug again with a new name — so nothing calls this
   * but `prepare()`, and every door calls `prepare()` because it is where headers come
   * from.
   *
   * See `connections.ts` for what each check is for. What is worth repeating here is the
   * ordering: the grant is checked before the request shape, and the request shape before
   * the credential. Checking the credential first would mean a session with no grant at
   * all learns whether the *host* holds a Linear credential for this project, by the
   * difference between two refusal codes — a small oracle, on a machine whose whole job is
   * to hold credentials for things that cannot have them.
   */
  function prepareConnection(
    app: ConnectedApp,
    session: Session,
    hostname: string,
    port: number,
    method: string,
    path: string,
    requestHeaders: IncomingHttpHeaders,
  ): Prepared {
    if (!session.connections.granted.includes(app)) {
      refused(hostname, `no \`${app}\` connection was granted to this job`)
      return {
        ok: false,
        status: 403,
        error: 'connection_not_granted',
        message:
          `${hostname} belongs to the \`${app}\` connection, and this job's worker did not ` +
          `declare one. Add \`connections: [${app}]\` to the worker if its skill genuinely ` +
          'needs to call it — that grant is per worker on purpose, so that a reviewer ' +
          'reading untrusted code does not inherit it',
      }
    }

    const shapeRefusal = connectionRequestRefusal(app, method, path)
    if (shapeRefusal) {
      refused(hostname, `${method} ${path.split('?', 1)[0] ?? ''} is not a ${app} api call`)
      return { ok: false, status: 403, error: 'connection_path_refused', message: shapeRefusal }
    }

    /**
     * Read now, not at `open()`. An access token is renewed by the control plane in place,
     * and a session that captured one when the job started would present a dead token at
     * minute twenty of a thirty-minute job — a 401 blamed on the workspace connection,
     * which was renewed seventeen minutes earlier.
     */
    const credentials = session.connections.read()
    const injections = connectionInjections(app, credentials)
    if (injections.length === 0) {
      /**
       * Granted, and there is nothing to send. Answered here for the same reason
       * `no_credential` is: forwarding a placeholder to Linear produces an
       * `AUTHENTICATION_ERROR` that names the workspace credential, and an operator reads
       * that as "reconnect the application" when the actual cause may be that this
       * machine is not the one holding the store at all.
       */
      return {
        ok: false,
        status: 502,
        error: 'no_connection_credential',
        message:
          `this job was granted the \`${app}\` connection and no ${app} credential is ` +
          'available on this runner, so the request cannot be completed. A connection is ' +
          'read from `~/.ogun/config.json` on the machine running the job (ADR-0012), and ' +
          'only an OAuth grant is injectable — a personal API key is refused. Connect an ' +
          `application for this project, on this machine.`,
      }
    }

    const headers = applyInjections(
      stripHopByHop(requestHeaders as Record<string, string | string[] | undefined>),
      injections,
    )
    headers.host = port === 443 ? hostname : `${hostname}:${port}`
    return { ok: true, headers }
  }

  async function forward(
    hostname: string,
    port: number,
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
  ): Promise<void> {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    const prepared = prepare(hostname, port, method, path, req.headers, session)
    if (!prepared.ok) {
      return refuse(res, prepared.status, prepared.error, prepared.message)
    }
    const headers = prepared.headers

    /**
     * The one request answered here instead of upstream — see `synthetic.ts` for why a
     * placeholder credential cannot be refreshed and what happens to the run when Codex
     * tries.
     *
     * The body is only read when host, method and path already match and the declared
     * length is small. A request that does not match, or that does not say how big it is,
     * is never buffered: this check must not become a way to make the runner hold an
     * arbitrary upload in memory.
     *
     * When the body turns out to be a *real* refresh the buffered bytes are forwarded, so
     * the branch is transparent rather than lossy — hence `bufferedBody` below rather than
     * an early `return` on the miss.
     */
    let bufferedBody: Buffer | undefined
    if (
      isSyntheticRefreshTarget(hostname, method, path) &&
      bodyIsBufferable(req.headers['content-length'])
    ) {
      bufferedBody = await collect(req)
      const answer = syntheticRefresh(bufferedBody.toString('utf8'))
      if (answer) {
        res.writeHead(answer.status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(answer.body),
        })
        res.end(answer.body)
        return
      }
    }

    const target = dial.rewrite?.(hostname, port) ?? { host: hostname, port }
    const upstreamOptions: RequestOptions = {
      host: target.host,
      port: target.port,
      method,
      path,
      headers: headers as IncomingHttpHeaders,
      // The name the upstream certificate is checked against — the *real* hostname, not
      // wherever the test seam pointed the socket. Losing this is how an interception
      // proxy quietly stops verifying anything upstream.
      servername: hostname,
      ...(dial.ca ? { ca: dial.ca } : {}),
    }

    // Always TLS. There is no plaintext leg: the only door that could produce one refuses
    // `http:` above, and a credential must never ride an unencrypted connection.
    const upstream = httpsRequest(upstreamOptions)

    upstream.on('response', (upstreamRes) => {
      /**
       * The client may already be gone, and this is not a hypothetical.
       *
       * A container that is killed mid-turn — a job budget expiring, `docker kill`, an
       * agent that exits while a request is in flight — takes its socket with it, and the
       * upstream's response then arrives for a `ServerResponse` that is already destroyed.
       * `pipeline()` *throws* in that case rather than calling back with the error
       * (`ERR_STREAM_UNABLE_TO_PIPE`), and a throw from a `'response'` handler is an
       * uncaught exception that takes the whole runner down — every other job on the
       * machine with it. Found by killing a container mid-run, not by reading the code.
       *
       * Destroying the upstream response rather than ignoring it is the other half: the
       * provider is still generating, and still billing, for something nobody will read.
       */
      if (res.destroyed || res.writableEnded) {
        upstreamRes.destroy()
        return
      }
      // Hop-by-hop only on the way back: `content-length` is preserved, because it is
      // required for correct HTTP/1.1 framing and is the only body length a HEAD response
      // has. Stripping it here produces responses that appear truncated at random.
      const responseHeaders = stripHopByHop(
        upstreamRes.headers as Record<string, string | string[] | undefined>,
      )
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders as IncomingHttpHeaders)
      /**
       * Streamed, never buffered — and joined with `pipeline` rather than `pipe`.
       *
       * Buffering first is the obvious mistake: a completion is a Server-Sent Events stream
       * that runs for minutes, and collecting it would turn every streaming run into one
       * silent block at the end while holding the whole response in memory.
       *
       * `pipe` is the subtle one. It forwards data and nothing else — not errors, not
       * destruction — so both ends of a broken exchange are left open:
       *
       *  - the client cancels a turn, and the upstream socket stays open and still being
       *    written to, forever, once per cancelled turn, with the provider still generating
       *    and still billing for a response nobody will read;
       *  - the upstream dies mid-body, and the client sits waiting for the rest of a
       *    `content-length` that will never arrive until its own timeout fires — so the run
       *    is filed as a timeout instead of as the upstream failure it was.
       *
       * `pipeline` destroys both ends when either one fails, which is the whole fix, in
       * both directions, in one call.
       */
      pipeline(upstreamRes, res, (err) => {
        if (err && !res.writableEnded) res.destroy()
      })
    })

    upstream.on('error', (err) => {
      warn(`${hostname}${path.split('?')[0]}: ${err.message}`)
      refuse(res, 502, 'upstream_unreachable', `${hostname}: ${err.message}`)
    })

    if (bufferedBody !== undefined) {
      // The interception check already drained `req`, so there is nothing left to pipe.
      // Written back verbatim: `content-length` was never touched and still describes
      // exactly these bytes, which is what makes the buffering invisible to the upstream.
      upstream.end(bufferedBody)
      return
    }

    // Same reasoning on the way out: a client that hangs up mid-request must not leave the
    // upstream half-open holding a socket, and an upstream that refuses the body must not
    // leave the request stream dangling.
    pipeline(req, upstream, () => undefined)
  }

  /**
   * The third door: HTTP Upgrade.
   *
   * `node:http` routes a request carrying `Connection: Upgrade` to an `'upgrade'` event
   * rather than to `'request'`, and a server with no `'upgrade'` listener destroys the
   * socket. That is what this gateway did until now, and the cost was not theoretical:
   * Codex on a ChatGPT subscription runs its model turn over
   * `wss://chatgpt.com/backend-api/codex/responses`, so every turn's socket was dropped
   * mid-handshake. Codex retried five times, fell back to the HTTPS transport, and the run
   * died — with an error naming the *credential*, which is the wrong place to look.
   *
   * This is the same class of hole the absolute-form door was: a second (now third) way in
   * that does not run the first one's checks. So it runs `prepare()` — the push refusal,
   * the missing-credential answer, the injection, the `Host` rewrite — and the callers
   * below do the token, allowlist and port checks before they ever get here.
   */
  function forwardUpgrade(
    hostname: string,
    port: number,
    req: IncomingMessage,
    client: Socket,
    head: Buffer,
    session: Session,
  ): void {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    const prepared = prepare(hostname, port, method, path, req.headers, session)
    if (!prepared.ok) {
      return refuseSocket(client, prepared.status, prepared.error, prepared.message)
    }

    /**
     * `connection` and `upgrade` put back after the hop-by-hop strip.
     *
     * They are hop-by-hop by definition and `stripHopByHop` is right to remove them — on
     * every other request. On this one they *are* the request: strip them and what reaches
     * the upstream is a plain `GET`, which answers 200 with an HTML page and no
     * `Sec-WebSocket-Accept`. The client then fails its handshake against a response that
     * looks perfectly valid, which is a considerably harder thing to debug than a dropped
     * socket. Rebuilt from the client's own values rather than passed through, so a
     * `Connection: Upgrade, X-Trace` that named a third header still loses the third one.
     */
    const headers = prepared.headers
    headers.connection = 'Upgrade'
    headers.upgrade = firstHeader(req.headers.upgrade) ?? 'websocket'

    const target = dial.rewrite?.(hostname, port) ?? { host: hostname, port }
    const upstream = httpsRequest({
      host: target.host,
      port: target.port,
      method,
      path,
      headers: headers as IncomingHttpHeaders,
      servername: hostname,
      // A dedicated socket, never a pooled one. An upgraded connection stops being HTTP
      // the moment the 101 lands, and handing a socket in that state back to a keep-alive
      // pool means the next request on it is parsed as WebSocket frames.
      agent: false,
      ...(dial.ca ? { ca: dial.ca } : {}),
    })

    upstream.on('upgrade', (upstreamRes, upstreamSocket: Socket, upstreamHead: Buffer) => {
      // The client may have hung up while the handshake was in flight — see the note on
      // the response path in `forward()`. `pipeline()` throws on a destroyed destination,
      // and a throw from here is an uncaught exception that ends the runner process.
      if (client.destroyed || client.writableEnded) {
        upstreamSocket.destroy()
        return
      }
      /**
       * The 101 is relayed byte for byte, hop-by-hop headers included.
       *
       * This is the one response where stripping them is wrong: `Connection: Upgrade` and
       * `Upgrade: websocket` are the switch itself, and `Sec-WebSocket-Accept` is a hash
       * of the key the *client* chose — the gateway cannot recompute or omit it. Written
       * from `rawHeaders` so casing and repeated fields survive exactly as sent.
       */
      client.write(rawResponseHead(upstreamRes.statusCode ?? 101, upstreamRes.statusMessage, upstreamRes.rawHeaders))
      // Frames the upstream already sent, ahead of the ones that will arrive as data.
      if (upstreamHead.length > 0) client.write(upstreamHead)
      // ...and frames the client sent before the 101 came back. Both ends are allowed to
      // start writing immediately, and a relay that drops either one loses the first
      // message of the conversation — which for Codex is the whole turn.
      if (head.length > 0) upstreamSocket.write(head)

      /**
       * Two pipelines, not two `pipe`s, for the reason spelled out on the response path
       * above: a WebSocket carries a model turn that runs for minutes, and either end
       * dying must tear the other one down rather than leave it open and waiting.
       */
      pipeline(client, upstreamSocket, () => undefined)
      pipeline(upstreamSocket, client, () => undefined)
    })

    /**
     * The upstream declined to upgrade — a 401, a 403, a redirect.
     *
     * There is no `ServerResponse` here to write through, so the status line is built by
     * hand, and the framing headers are dropped in favour of `Connection: close`. That is
     * deliberate: `node:http` has already decoded any chunked body, so relaying the
     * upstream's `Transfer-Encoding` verbatim would advertise an encoding the bytes no
     * longer carry, and the client would hang waiting for a terminating chunk that never
     * comes. Ending the body at the close is the one framing rule that stays true no
     * matter what the upstream used.
     */
    upstream.on('response', (upstreamRes) => {
      if (client.destroyed || client.writableEnded) {
        upstreamRes.destroy()
        return
      }
      const headersOut = stripHopByHop(
        upstreamRes.headers as Record<string, string | string[] | undefined>,
      )
      delete headersOut['content-length']
      client.write(
        rawResponseHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          flatten(headersOut).concat(['connection', 'close']),
        ),
      )
      pipeline(upstreamRes, client, () => undefined)
    })

    upstream.on('error', (err) => {
      warn(`${hostname}${path.split('?')[0]} (upgrade): ${err.message}`)
      refuseSocket(client, 502, 'upstream_unreachable', `${hostname}: ${err.message}`)
    })

    /**
     * Ended, not piped.
     *
     * A handshake request has no body, and on an `'upgrade'` event `node:http` has already
     * detached the socket from its parser — so `req` is not a stream that will ever emit
     * `'end'`, and piping it leaves the upstream request open forever waiting for a body
     * that cannot arrive. Anything the client did send early is in `head`, which goes to
     * the upstream socket once the 101 lands.
     */
    upstream.end()
  }

  const host = options.host ?? '127.0.0.1'
  const socketPath = options.socketPath

  if (socketPath) {
    // A socket left behind by a killed runner is not a running gateway, and `listen`
    // answers EADDRINUSE either way. Removing a stale one is the difference between a
    // machine that comes back after a kill -9 and one that needs a manual `rm`.
    //
    // But only a stale one. An unconditional unlink lets a second runner silently steal
    // the path from a first that is still serving containers: the first keeps working
    // against an unlinked inode, every new sandbox reaches the second, and nothing anywhere
    // reports the split brain. So: knock first, and unlink only if nobody answers.
    if (await socketIsLive(socketPath)) {
      throw new Error(
        `${socketPath} is already being served — another ogun-runner is running on this host`,
      )
    }
    await rm(socketPath, { force: true })
    // The directory, before the socket exists in it. A unix socket cannot be chmod'd until
    // `listen` has created it, so for a moment it sits at the process umask; a 0700 parent
    // is what covers that window.
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    await chmod(dirname(socketPath), 0o700).catch(() => undefined)
  }

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    const done = (): void => {
      proxy.off('error', reject)
      resolve()
    }
    if (socketPath) proxy.listen(socketPath, done)
    else proxy.listen(options.port ?? 0, host, done)
  })

  if (socketPath) {
    // 0600. The socket is the container's route to every credential the host holds, and
    // its mode is the only thing between that and any other user on the box. Docker's bind
    // mount preserves it, and the container runs as uid 1000 — the same uid the runner
    // does on this host, which is why the mount works at all.
    await chmod(socketPath, 0o600)
  }

  // What was actually bound, not what was asked for: with port 0 the kernel picks, and
  // reporting the request would leave `:0` in every container's HTTPS_PROXY.
  const bound = proxy.address()
  if (!socketPath && (bound === null || typeof bound === 'string')) {
    throw new Error('gateway did not bind a port')
  }
  const port = typeof bound === 'object' && bound !== null ? bound.port : 0

  const listening: Listening = socketPath
    ? { kind: 'socket', path: socketPath }
    : { kind: 'tcp', host, port }

  return {
    listening,
    caCertificatePath: ca.certificatePath,
    caCertificatePem: ca.certificatePem,
    credentials: readCredentials,
    open: (
      containerAuthority?: string,
      allow?: readonly string[],
      connections?: SessionConnections,
    ) => {
      // A socket has no authority to put in a URL. A caller listening on one and not
      // saying where the container reaches it has not finished wiring the sandbox, and a
      // silently wrong `HTTPS_PROXY` is a container that talks to nothing and says nothing
      // about why. Refused before a token is minted, so a caller that recovers from this
      // has not left one behind that never gets revoked.
      if (!containerAuthority && listening.kind === 'socket') {
        throw new Error(
          'the gateway listens on a unix socket — open() needs the authority the ' +
            "container's proxy forwarder listens on",
        )
      }

      /**
       * A token per job, not one per gateway.
       *
       * The socket is 0600 and only the containers the runner mounted it into can reach
       * it, so "can you reach it" is already narrow — but it is not per-*job*. A container
       * that outlives its run (a leaked `docker run`, a `--rm` that did not fire) would
       * otherwise keep spending the host's credentials, and nothing would notice. The
       * token is what ends that at the same moment the job does.
       *
       * 256 bits from the CSPRNG, compared by set membership. There is no timing oracle
       * worth defending against on a full-entropy secret that is never partially matched.
       */
      const token = randomBytes(32).toString('base64url')
      const granted = connections ?? NO_CONNECTIONS
      /**
       * The connection's hosts join *this* session's allowlist, here, rather than being
       * expected from the caller.
       *
       * Composed in one place so the two halves of a grant cannot come apart. A caller
       * that had to remember `allow: [...egress, 'api.linear.app']` beside
       * `connections: {...}` would eventually pass one and not the other, and both
       * mistakes are quiet: an entry with no credential reaches Linear with a placeholder
       * and 401s, and a credential with no entry is a connection that is simply never
       * reachable. `prepareConnection` re-checks the grant anyway, so a hand-composed
       * allowlist carrying the host does not become a way in.
       */
      const session: Session = {
        token,
        allow: [...(allow ?? allowedHosts), ...connectionHosts(granted.granted)],
        connections: granted,
        sockets: new Set(),
      }
      sessions.set(token, session)
      const authority =
        containerAuthority ??
        (listening.kind === 'tcp' ? `${listening.host}:${listening.port}` : '')
      return {
        token,
        proxyUrl: `http://x:${token}@${authority}`,
        /**
         * Forget the token, then close what it opened. In that order, so that a connection
         * racing the teardown finds no grant at the intercepted door either way.
         *
         * Read out of the map rather than closed over, because two `revoke()` calls on one
         * session must be one revocation and one no-op: `dispose()` is best-effort and a
         * caller that retries it must not walk a stale socket set.
         *
         * Destroyed rather than ended. `end()` is a polite FIN that a peer is free to
         * ignore while it goes on writing, and the peer here is a container that has
         * already outlived its run — which, under ADR-0010's threat model, may be
         * deliberately trying to stay connected. There is nothing left to say to it that is
         * worth the risk of it not listening.
         *
         * This is safe on the normal path, and that is not an accident of timing: the
         * pipeline calls `dispose()` in a `finally`, after every `exec()` has resolved,
         * which means every `docker run` for this job has already exited. A socket still
         * open at that moment belongs to a container that outlived its run — the exact
         * thing §3.1 revokes for — and never to a job that is finishing cleanly. The
         * verification container is covered by the same fact: it runs as another `exec()`
         * on this session and has long since exited too.
         *
         * `clear()` after the loop is not redundant with the `'close'` handlers: those fire
         * on a later tick, and leaving the set populated until then would let a second
         * `revoke()` — or `close()` — walk sockets that are already gone.
         */
        revoke: () => {
          const granted = sessions.get(token)
          if (!granted) return
          sessions.delete(token)
          for (const socket of granted.sockets) socket.destroy()
          granted.sockets.clear()
        },
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        /**
         * The same teardown, for every session at once.
         *
         * `proxy.closeAllConnections()` below does not reach these: `node:http` hands a
         * socket to the `'connect'` or `'upgrade'` handler and stops tracking it, so a
         * tunnel and an upgraded relay both survive it. Observed rather than assumed — the
         * test suite hung on exit with the event loop held open by exactly these sockets
         * before this loop existed.
         */
        for (const session of sessions.values()) {
          for (const socket of session.sockets) socket.destroy()
          session.sockets.clear()
        }
        sessions.clear()
        intercepted.close()
        // The socket file goes with it. `server.close()` unlinks it, but only on a clean
        // close — the `rm` at startup is what covers the other path.
        proxy.close(() => resolve())
        proxy.closeAllConnections()
      }),
  }
}

/**
 * Is something already answering on this socket path?
 *
 * `ENOENT` is no file at all, and `ECONNREFUSED` is a file whose server is gone — the two
 * shapes of "nothing is behind this". Anything else, including a connection that opens, is
 * treated as live: the cost of being wrong that way is a refusal to start, and the cost of
 * being wrong the other way is two runners quietly disagreeing about which one the
 * containers are talking to.
 */
const DEAD_SOCKET_CODES = new Set(['ENOENT', 'ECONNREFUSED'])

function socketIsLive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = netConnect(path)
    const settle = (live: boolean): void => {
      probe.destroy()
      resolve(live)
    }
    probe.once('connect', () => settle(true))
    probe.once('error', (err: NodeJS.ErrnoException) =>
      settle(!DEAD_SOCKET_CODES.has(err.code ?? '')),
    )
  })
}

/**
 * Which proxy token the caller presented, if any.
 *
 * Three shapes are accepted because three clients produce three shapes from the same
 * `http://x:TOKEN@host` URL: `x:TOKEN` (a dummy user with the token as the password,
 * which is git's and curl's convention), `TOKEN:` (token as the user, empty password),
 * and a bare `TOKEN` with no colon at all.
 */
export function proxyToken(headers: IncomingHttpHeaders): string | undefined {
  const header = headers['proxy-authorization']
  if (typeof header !== 'string') return undefined
  const [scheme, encoded] = header.split(' ', 2)
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return undefined
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const at = decoded.indexOf(':')
  const candidate = at === -1 ? decoded : decoded.slice(at + 1) || decoded.slice(0, at)
  // An empty credential decodes to an empty string, and an empty string must never be
  // treated as "a token that happens to be blank" — it is the absence of one.
  return candidate.length > 0 ? candidate : undefined
}

/**
 * What a container is told when it speaks on a connection whose grant has been revoked.
 *
 * Said rather than swallowed, and said in the gateway's own refusal shape. A bare
 * `destroy()` would enforce the rule and report nothing, and "the proxy hung up" is the
 * error message half the comments in this file exist because of. Naming the cause is what
 * stops a leaked container's transcript sending somebody to re-authenticate a host
 * credential that is perfectly fine.
 */
const REVOKED_MESSAGE =
  'this proxy session has been revoked — the job that opened it has ended, and the gateway ' +
  'does not splice a host credential into a request from a container that outlived its run ' +
  '(ADR-0010)'

/**
 * A request arriving inside a tunnel whose grant is gone.
 *
 * `403` rather than `407`. Inside the tunnel the client believes it is talking to
 * `api.anthropic.com`, and a proxy-authentication challenge from what looks like the
 * provider is both nonsense and an invitation to retry with credentials that will never
 * work again. `403` with `x-should-retry: false` is the shape every other in-tunnel
 * refusal here already uses — `host_not_allowed`, `push_refused` — and the SDKs honour it.
 *
 * `connection: close` rather than a `destroy()` after the write: it lets `node:http` finish
 * the response and then close the socket, so the client reads the reason it was given
 * instead of a truncated body. In practice `revoke()` has already destroyed this socket and
 * this path is the race and the belt-and-braces; when it does fire, it should still explain
 * itself.
 */
const refuseRevoked = (res: ServerResponse): void => {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ error: 'session_revoked', message: REVOKED_MESSAGE })
  res.writeHead(403, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-should-retry': 'false',
    connection: 'close',
  })
  res.end(body)
}

const challenge = (res: ServerResponse): void => {
  res.writeHead(407, {
    'proxy-authenticate': 'Basic realm="ogun-gateway"',
    'content-type': 'application/json',
  })
  res.end(JSON.stringify({ error: 'proxy_authentication_required' }))
}

const refuseHost = (res: ServerResponse, hostname: string): void =>
  refuse(res, 403, 'host_not_allowed', `${hostname} is not on the sandbox egress allowlist`)

const refusePort = (res: ServerResponse, hostname: string, port: number): void =>
  refuse(
    res,
    403,
    'port_not_allowed',
    `${hostname}:${port} is refused — a sandbox reaches ${ALLOWED_CONNECT_PORT} and nothing else`,
  )

/**
 * A refusal written straight onto a socket, for the doors that have no `ServerResponse`.
 *
 * Deliberately the same shape as `refuse()` — same JSON body, same `x-should-retry: false`
 * so a refusal that will never change is not retried until the job's budget runs out. A
 * door that answered upgrades with a bare `socket.destroy()` would be enforcing the same
 * rules and reporting none of them, and "the proxy hung up" is the error message this
 * whole exercise started from.
 */
function refuseSocket(socket: Socket, status: number, error: string, message: string): void {
  if (socket.writableEnded || socket.destroyed) return
  const body = JSON.stringify({ error, message })
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_REASONS[status] ?? 'Error'}\r\n` +
      'content-type: application/json\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'x-should-retry: false\r\n' +
      'connection: close\r\n\r\n' +
      body,
  )
}

const challengeSocket = (socket: Socket): void => {
  if (socket.writableEnded || socket.destroyed) return
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      // Same reason as on the CONNECT door: without the challenge header many clients
      // never retry with credentials and the failure reads as "the proxy hung up".
      'Proxy-Authenticate: Basic realm="ogun-gateway"\r\n' +
      'Connection: close\r\n\r\n',
  )
}

/**
 * Reason phrases for the statuses the raw-socket doors emit.
 *
 * A status line needs one, and the phrase is advisory — but an empty one produces
 * `HTTP/1.1 403 ` with a trailing space, which some clients parse and some reject, and
 * that difference would show up as a refusal that "works on my machine".
 */
const STATUS_REASONS: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  407: 'Proxy Authentication Required',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
}

/** A status line plus headers, as bytes. `rawHeaders` is name/value alternating. */
function rawResponseHead(
  status: number,
  reason: string | undefined,
  rawHeaders: readonly string[],
): string {
  const lines = [`HTTP/1.1 ${status} ${reason ?? STATUS_REASONS[status] ?? 'OK'}`]
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** A header bag back into the alternating name/value form, repeating multi-valued names. */
function flatten(headers: Record<string, string | string[] | undefined>): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const one of value) out.push(name, one)
    else out.push(name, value)
  }
  return out
}

/**
 * The first value of a header that `node:http` may have joined.
 *
 * A duplicated `Upgrade` is not something a legitimate client sends, and forwarding
 * `websocket, websocket` would fail the handshake at the upstream with no useful message.
 */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : typeof value === 'string' ? value.split(',')[0]?.trim() : undefined

/** A request body, whole. Only ever called on a body whose declared length is bounded. */
const collect = (req: IncomingMessage): Promise<Buffer> =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    // A client that hangs up mid-body has not sent a refresh request, so there is nothing
    // to answer; whatever arrived is handed on and the upstream decides it is truncated.
    req.on('error', () => resolve(Buffer.concat(chunks)))
  })

/** The URL's port, digits only — `new URL` keeps whatever the client wrote. */
const strictPortOf = (target: URL): number | null =>
  target.port === '' ? null : /^\d{1,5}$/.test(target.port) ? Number(target.port) : 0

/**
 * Every refusal the gateway generates itself, in one shape.
 *
 * `x-should-retry: false` is honoured by both the Anthropic and OpenAI SDKs. Without it a
 * refusal that will never change — an unallowlisted host, a push — is retried with
 * exponential backoff until the job's budget runs out, and is then reported as a timeout
 * rather than as the refusal it was.
 */
function refuse(res: ServerResponse, status: number, error: string, message: string): void {
  if (res.headersSent) {
    /**
     * Destroyed, not ended.
     *
     * The status line is already gone, and with it a `content-length` promising bytes that
     * will now never arrive. `res.end()` closes the message cleanly and leaves the
     * connection advertised as reusable — so the client waits for the rest of a body that
     * does not exist until its own timeout fires, and the run is filed as a timeout rather
     * than as the upstream failure it was. Tearing the socket down is what tells the client
     * the message is truncated.
     */
    res.destroy()
    return
  }
  const body = JSON.stringify({ error, message })
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-should-retry': 'false',
  })
  res.end(body)
}
