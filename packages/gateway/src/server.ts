import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import type { CertificateAuthority } from './ca.ts'
import { loadOrCreateCa } from './ca.ts'
import type { CredentialSet } from './credentials.ts'
import { credentialReader } from './credentials.ts'
import { DEFAULT_ALLOWED_HOSTS, isAllowedHost, isGitPushRequest, parseAuthority } from './hosts.ts'
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

export type Gateway = {
  address: { host: string; port: number }
  caCertificatePath: string
  caCertificatePem: string
  /** Mint a token for one job. */
  open: () => GatewaySession
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
  dial?: Dial
  onWarning?: (message: string) => void
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const ca = options.ca ?? loadOrCreateCa()
  const readCredentials = options.credentials ?? credentialReader()
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  const dial = options.dial ?? {}
  const warn = options.onWarning ?? ((message: string) => console.error(`[gateway] ${message}`))

  const tokens = new Set<string>()

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
    if (!authorized(req.headers, tokens)) return challenge(res)
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      return refuse(res, 400, 'not_a_proxy_request', 'expected an absolute-form request URI')
    }
    if (!target.protocol.startsWith('http')) {
      return refuse(res, 400, 'not_a_proxy_request', `unsupported scheme ${target.protocol}`)
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
    if (!isAllowedHost(target.hostname, allowedHosts)) {
      return refuseHost(res, target.hostname)
    }
    req.url = target.pathname + target.search
    void forward(target.hostname, port, req, res, target.protocol === 'https:')
  })

  proxy.on('connect', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined)

    if (!authorized(req.headers, tokens)) {
      // A CONNECT with no valid token is refused rather than tunnelled. Serving it would
      // mean copying bytes to any host the client names, with no allowlist and no
      // injection — an open relay reachable from every container on this host's bridge
      // network, which is precisely what the gateway exists to not be.
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
    if (!isAllowedHost(authority.hostname, allowedHosts)) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n` +
          `ogun-gateway: ${authority.hostname} is not on the sandbox egress allowlist\r\n`,
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
    secure = true,
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
    headers.host = port === (secure ? 443 : 80) ? hostname : `${hostname}:${port}`

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

    const send = secure ? httpsRequest : httpRequest
    const upstream = send(upstreamOptions)

    upstream.on('response', (upstreamRes) => {
      // Hop-by-hop only on the way back: `content-length` is preserved, because it is
      // required for correct HTTP/1.1 framing and is the only body length a HEAD response
      // has. Stripping it here produces responses that appear truncated at random.
      const responseHeaders = stripHopByHop(
        upstreamRes.headers as Record<string, string | string[] | undefined>,
      )
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders as IncomingHttpHeaders)
      // Piped, never buffered. A completion is a Server-Sent Events stream that runs for
      // minutes; a gateway that collected the body before answering would turn every
      // streaming run into a single silent block at the end, and would hold the whole
      // response in memory besides.
      upstreamRes.pipe(res)
    })

    upstream.on('error', (err) => {
      warn(`${hostname}${path.split('?')[0]}: ${err.message}`)
      refuse(res, 502, 'upstream_unreachable', `${hostname}: ${err.message}`)
    })

    req.pipe(upstream)
    // A client that hangs up mid-request must not leave the upstream half-open holding a
    // socket in the pool.
    req.on('aborted', () => upstream.destroy())
  }

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(options.port ?? 0, host, () => {
      proxy.off('error', reject)
      resolve()
    })
  })

  // What was actually bound, not what was asked for: with port 0 the kernel picks, and
  // reporting the request would leave `:0` in every container's HTTPS_PROXY.
  const bound = proxy.address()
  if (bound === null || typeof bound === 'string') throw new Error('gateway did not bind a port')

  return {
    address: { host, port: bound.port },
    caCertificatePath: ca.certificatePath,
    caCertificatePem: ca.certificatePem,
    open: () => {
      /**
       * A token per job, not one per gateway.
       *
       * The listener is reachable from every container on the host's bridge network, not
       * only from the one it was started for, so "is this the gateway?" is not the same
       * question as "may this caller use it?". A per-job token that is revoked when the
       * job ends means a container that somehow outlives its job — a leaked `docker run`,
       * a `--rm` that did not fire — cannot keep spending the host's credentials.
       *
       * 256 bits from the CSPRNG, compared by set membership. There is no timing oracle
       * worth defending against on a full-entropy secret that is never partially matched.
       */
      const token = randomBytes(32).toString('base64url')
      tokens.add(token)
      return {
        token,
        proxyUrl: `http://x:${token}@${host}:${bound.port}`,
        revoke: () => tokens.delete(token),
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        tokens.clear()
        intercepted.close()
        proxy.close(() => resolve())
        proxy.closeAllConnections()
      }),
  }
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

const authorized = (headers: IncomingHttpHeaders, tokens: ReadonlySet<string>): boolean => {
  const token = proxyToken(headers)
  return token !== undefined && tokens.has(token)
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
    res.end()
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
