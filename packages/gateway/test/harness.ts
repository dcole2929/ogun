import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { loadOrCreateCa } from '../src/ca.ts'
import type { CredentialSet } from '../src/credentials.ts'
import { startGateway } from '../src/server.ts'
import type { Gateway } from '../src/server.ts'

/**
 * A whole gateway, a whole TLS upstream, and a client that only trusts the gateway's CA.
 *
 * The pure functions elsewhere can be unit-tested, but the property this component exists
 * for is not expressible in them: *does a client that speaks real TLS through a real
 * CONNECT tunnel end up sending the real credential upstream, having never held it?* That
 * needs the whole path, so the harness builds it.
 *
 * The upstream is signed by a second, independent CA. That is deliberate: it means the
 * gateway's upstream leg is doing genuine certificate verification (against `dial.ca`)
 * rather than the test accidentally passing because verification was off.
 */

export type Upstream = {
  origin: { host: string; port: number }
  ca: string
  /** Every request the upstream actually received, headers and all. */
  received: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }>
  respond: (handler: (req: IncomingMessage, res: ServerResponse) => void) => void
  close: () => Promise<void>
}

export type Harness = {
  gateway: Gateway
  /** Where the tests dial. Always TCP here — the socket transport is the sandbox's. */
  address: { host: string; port: number }
  upstream: Upstream
  /** The CA the *sandbox* would trust — the only certificate a container gets. */
  sandboxCa: string
  cleanup: () => Promise<void>
}

const temporaryDirectories: string[] = []

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ogun-gateway-'))
  temporaryDirectories.push(dir)
  return dir
}

export async function startUpstream(hostname: string): Promise<Upstream> {
  const ca = loadOrCreateCa(scratch())
  const leaf = ca.leafFor(hostname)
  const received: Upstream['received'] = []
  let handler = (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  }

  const server = createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      handler(req, res)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    origin: { host: '127.0.0.1', port: address.port },
    ca: ca.certificatePem,
    received,
    respond: (next) => {
      handler = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export async function startHarness(options: {
  hostname: string
  credentials: CredentialSet
  allowedHosts?: readonly string[]
}): Promise<Harness> {
  const upstream = await startUpstream(options.hostname)
  const ca = loadOrCreateCa(scratch())

  const gateway = await startGateway({
    ca,
    credentials: () => options.credentials,
    allowedHosts: options.allowedHosts ?? [options.hostname],
    // Every hostname resolves to the one local upstream. `servername` is untouched, so
    // the gateway still verifies the certificate against the *real* name.
    dial: { rewrite: () => upstream.origin, ca: upstream.ca },
    onWarning: () => undefined,
  })

  if (gateway.listening.kind !== 'tcp') throw new Error('the harness listens on TCP')

  return {
    gateway,
    address: { host: gateway.listening.host, port: gateway.listening.port },
    upstream,
    sandboxCa: ca.certificatePem,
    cleanup: async () => {
      await gateway.close()
      await upstream.close()
      for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A client that does not wait for `200 Connection Established` before starting TLS.
 *
 * The ordinary client above sends CONNECT, reads the status line, and only then begins the
 * handshake — which means Node's `'connect'` event hands the gateway an empty `head`, and
 * every mistake in how `head` is replayed is invisible. This one puts the CONNECT request
 * and the ClientHello in a single write, so `head` carries real ciphertext.
 *
 * Built out of a `Duplex` that fronts the socket, because there is no way to make
 * `tls.connect` hold its ClientHello: the bridge is what lets the first chunk it writes be
 * concatenated onto the CONNECT line rather than following it.
 */
export function pipelinedTunnel(
  harness: Harness,
  options: { token: string; hostname: string },
): Promise<TLSSocket> {
  const { host, port } = harness.address
  const authority = `${options.hostname}:443`
  const connectRequest =
    `CONNECT ${authority} HTTP/1.1\r\n` +
    `Host: ${authority}\r\n` +
    `Proxy-Authorization: Basic ${Buffer.from(`x:${options.token}`).toString('base64')}\r\n` +
    '\r\n'

  return new Promise<TLSSocket>((resolve, reject) => {
    const wire = connect(port, host)
    wire.on('error', reject)

    let sentConnect = false
    let statusSeen = false
    let preamble = Buffer.alloc(0)

    const bridge = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        if (!sentConnect) {
          sentConnect = true
          // The one line this helper exists for: one TCP write, so the gateway's HTTP
          // parser finds the ClientHello sitting behind the CONNECT request.
          wire.write(Buffer.concat([Buffer.from(connectRequest, 'ascii'), chunk]))
        } else {
          wire.write(chunk)
        }
        callback()
      },
    })

    wire.on('data', (chunk: Buffer) => {
      if (statusSeen) {
        bridge.push(chunk)
        return
      }
      preamble = Buffer.concat([preamble, chunk])
      const end = preamble.indexOf('\r\n\r\n')
      if (end === -1) return
      statusSeen = true
      const status = Number(preamble.subarray(0, end).toString('utf8').split(' ')[1])
      if (status !== 200) {
        wire.destroy()
        reject(new Error(`CONNECT answered ${status}`))
        return
      }
      const rest = preamble.subarray(end + 4)
      if (rest.length > 0) bridge.push(rest)
    })

    const tls = connectTls({
      socket: bridge,
      ca: harness.sandboxCa,
      servername: options.hostname,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    })
    tls.on('error', reject)
    tls.once('secureConnect', () => resolve(tls))
  })
}

export type ProxyResponse = {
  /** The CONNECT status, before any TLS happened. */
  connect: number
  status?: number
  headers?: IncomingHttpHeaders
  body?: string
}

/**
 * Speak to the gateway exactly as a container's HTTP client would.
 *
 * Written by hand rather than with a proxy-agent library, because the wire sequence *is*
 * the thing under test: `CONNECT host:443`, a `Proxy-Authorization` header, a status line,
 * and only then a TLS handshake in which the client trusts nothing but the gateway's CA.
 * A library would hide precisely the step that could be wrong.
 */
export function requestThroughProxy(
  harness: Harness,
  options: {
    token: string
    hostname: string
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: string
    port?: number
  },
): Promise<ProxyResponse> {
  const { host, port } = harness.address
  const authority = `${options.hostname}:${options.port ?? 443}`

  return new Promise<ProxyResponse>((resolve, reject) => {
    const socket = connect(port, host, () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\n` +
          `Host: ${authority}\r\n` +
          `Proxy-Authorization: Basic ${Buffer.from(`x:${options.token}`).toString('base64')}\r\n` +
          '\r\n',
      )
    })
    socket.on('error', reject)

    const tunnel = (connectStatus: number): void => {
      // `tls.connect` over the existing socket rather than `new TLSSocket`: it is the
      // documented way to hand SNI to a client handshake, and SNI is what the gateway's
      // leaf is presented against.
      const tls = connectTls({
        socket,
        ca: harness.sandboxCa,
        servername: options.hostname,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
      })
      tls.on('error', reject)

      const req = request({
        createConnection: () => tls,
        host: options.hostname,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: { host: options.hostname, ...options.headers },
        // No `agent`, and deliberately not `agent: false` either. `false` means "make a
        // fresh default Agent", and an https.Agent supplies its OWN `createConnection` —
        // which dials api.anthropic.com directly and ignores the tunnel entirely. The
        // test then passes against the real internet, which is the worst way to fail.
      })
      req.on('error', reject)
      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          tls.destroy()
          resolve({
            connect: connectStatus,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      if (options.body !== undefined) req.write(options.body)
      req.end()
    }

    let preamble = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      preamble = Buffer.concat([preamble, chunk])
      const end = preamble.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const status = Number(preamble.subarray(0, end).toString('utf8').split(' ')[1])
      if (status !== 200) {
        socket.destroy()
        resolve({ connect: status })
        return
      }
      const rest = preamble.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      tunnel(status)
    }
    socket.on('data', onData)
  })
}
