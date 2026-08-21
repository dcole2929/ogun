/**
 * The container half of the egress allowlist (§4.6): TCP on loopback in, unix socket out.
 *
 * The sandbox runs `--network none`, so it has exactly one interface — `lo` — and one
 * route to anywhere, which is a unix socket the runner bind-mounted in at
 * `OGUN_EGRESS_SOCKET`. On the far side of that socket is a forward proxy on the host
 * that allows CONNECT only to the worker's allowlisted hosts.
 *
 * This file exists solely because `HTTPS_PROXY` cannot name a unix socket. curl, undici
 * and reqwest all want `http://host:port`, so something inside the namespace has to
 * present the proxy as a TCP endpoint. It does nothing else: no parsing, no buffering
 * decisions, no policy. Bytes in, bytes out. Every decision about *where* those bytes may
 * go is made on the host, by a process this container cannot reach or restart.
 *
 * Written in node rather than `socat` on purpose. Adding socat means an apt package in
 * the base image for 20 lines of pipe, and node is already here — it is what the image is
 * built on.
 *
 * Deliberately not a security boundary. Anything in the container can talk to the socket
 * directly and skip this file entirely; that changes nothing, because the allowlist is
 * enforced on the other end. This is a convenience adapter, and if it were subverted the
 * worst outcome is that the agent reaches exactly the hosts it was already allowed to.
 */
import { createServer, connect } from 'node:net'
import { writeFileSync } from 'node:fs'

const socketPath = process.env.OGUN_EGRESS_SOCKET
const port = Number(process.env.OGUN_EGRESS_PORT ?? 8118)
const readyFile = process.env.OGUN_EGRESS_READY ?? '/tmp/.ogun-egress-ready'

if (!socketPath) {
  console.error('ogun-egress: OGUN_EGRESS_SOCKET is not set')
  process.exit(1)
}

const server = createServer((client) => {
  const upstream = connect(socketPath)
  // Destroy the peer on either error rather than letting one half linger half-open. A
  // stuck socket here holds the container open past the agent's exit, and `docker run`
  // does not return until the container does.
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
  client.pipe(upstream)
  upstream.pipe(client)
})

server.on('error', (err) => {
  console.error(`ogun-egress: ${err.message}`)
  process.exit(1)
})

/**
 * 127.0.0.1 only. `--network none` means there is no other interface to bind, but saying
 * so explicitly keeps that true if a future sandbox ever runs on a real network — where
 * a 0.0.0.0 bind would publish an open relay to the allowlist onto whatever that network
 * is.
 */
server.listen(port, '127.0.0.1', () => {
  /**
   * The entrypoint blocks on this file before exec'ing the agent. Without it the agent
   * starts first on a fast machine, makes its first API call into a port nothing is
   * listening on yet, and reports an authentication failure — a race that would appear
   * roughly never on a laptop and reliably at 3am on a loaded runner.
   */
  try {
    writeFileSync(readyFile, String(port))
  } catch (err) {
    console.error(`ogun-egress: could not write ${readyFile}: ${err.message}`)
    process.exit(1)
  }
})
