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
import type { CertificateAuthority } from './ca.ts'
import { loadOrCreateCa } from './ca.ts'
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
  /** Called when the job ends. The token stops working immediately. */
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
   * Mint a token for one job.
   *
   * `containerAuthority` is the `host:port` the *container* reaches the proxy at, which is
   * not always where the gateway listens: over a unix socket it is the in-image forwarder's
   * loopback address, because `HTTPS_PROXY` has no syntax for a socket path. Omitted, the
   * bound TCP address is used.
   */
  open: (containerAuthority?: string, allow?: readonly string[]) => GatewaySession
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
   * Token → the hosts that token may reach.
   *
   * A map rather than a set because the allowlist is a property of the *worker*, not of
   * the gateway (§4.6): one runner serves every job on the machine, and a reviewer that
   * declared `egress: [docs.example.com]` must not inherit the reach of a modifier
   * running beside it. Holding one global list would have quietly widened every worker to
   * the union of all of them, which is the kind of regression that never fails a test —
   * it just stops refusing things.
   */
  const sessions = new Map<string, readonly string[]>()

  /**
   * The intercepted-request handler. One instance, fed sockets from every tunnel.
   *
   * `node:http` will happily serve a socket it did not accept itself, which is what makes
   * TLS interception a dozen lines rather than an HTTP implementation: terminate TLS on
   * the CONNECT socket, then hand the plaintext duplex to a server as a connection.
   */
  const intercepted = createHttpServer((req, res) => {
    const authority = (req.socket as TLSSocket & { ogunAuthority?: Authority }).ogunAuthority
    if (!authority) return refuse(res, 500, 'internal', 'intercepted socket has no host')
    // The port from the CONNECT line, not a hardcoded 443. An allowlisted host reached on
    // a non-standard port would otherwise be silently retargeted at 443, which either
    // works against the wrong service or fails as a connection refused nobody can explain.
    void forward(authority.hostname, authority.port, req, res)
  })
  intercepted.on('clientError', (_err, socket) => socket.destroy())

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
    const allow = sessionAllow(req.headers, sessions)
    if (!allow) return challenge(res)
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
    void forward(target.hostname, port, req, res)
  })

  proxy.on('connect', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined)

    const allow = sessionAllow(req.headers, sessions)
    if (!allow) {
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
    ;(tls as TLSSocket & { ogunAuthority?: Authority }).ogunAuthority = authority
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

  async function forward(
    hostname: string,
    port: number,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

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
      return refuse(
        res,
        403,
        'push_refused',
        'the sandbox never pushes (ADR-0005) — a modifier commits locally and the runner ' +
          'extracts a patch on the host',
      )
    }

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
      return refuse(
        res,
        502,
        'no_credential',
        `no ${provider} credential is available on this host — the sandbox holds only a ` +
          'placeholder, so the request cannot be completed. Run `ogun runner doctor`.',
      )
    }

    const headers = applyInjections(
      stripHopByHop(req.headers as Record<string, string | string[] | undefined>),
      injectionsFor(hostname, credentials),
    )
    // `host` is rewritten to the real target rather than passed through: the client set it
    // from the URL it thinks it is talking to, which is the same name, but a request that
    // was retargeted would otherwise carry the wrong one silently.
    headers.host = port === 443 ? hostname : `${hostname}:${port}`

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

    // Same reasoning on the way out: a client that hangs up mid-request must not leave the
    // upstream half-open holding a socket, and an upstream that refuses the body must not
    // leave the request stream dangling.
    pipeline(req, upstream, () => undefined)
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
    open: (containerAuthority?: string, allow?: readonly string[]) => {
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
      sessions.set(token, allow ?? allowedHosts)
      const authority =
        containerAuthority ??
        (listening.kind === 'tcp' ? `${listening.host}:${listening.port}` : '')
      return {
        token,
        proxyUrl: `http://x:${token}@${authority}`,
        revoke: () => sessions.delete(token),
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
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
 * The hosts the presented token is allowed to reach, or `undefined` for no valid token.
 *
 * Returning the allowlist rather than a boolean is deliberate: it makes it impossible to
 * authenticate against one session and then check the host against something else, which
 * is exactly the bug the previous global `allowedHosts` would have reintroduced the first
 * time two workers wanted different reach.
 */
const sessionAllow = (
  headers: IncomingHttpHeaders,
  sessions: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined => {
  const token = proxyToken(headers)
  return token === undefined ? undefined : sessions.get(token)
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
