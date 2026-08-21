import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHostAllowed } from '@ogun/core'

/**
 * The one hole in a `--network none` container, and the only route out of it.
 *
 * ## Why a proxy at all, and why this shape
 *
 * §4.6 always said "host allowlist" and the implementation said `open | none`, because
 * every obvious mechanism is wrong in a way that takes a paragraph to explain:
 *
 * - **iptables against resolved IPs.** `api.anthropic.com` is a rotating set of CDN
 *   addresses shared with hosts nobody allowlisted. A rule written at container start is
 *   stale by the time the agent uses it, and it is simultaneously too narrow (the API
 *   moves and the job fails) and far too wide (the whole CDN is allowed). It also needs
 *   `NET_ADMIN`, which `--cap-drop ALL` plus `no-new-privileges` exists to deny.
 * - **A DNS-based allowlist.** Resolve-time filtering only stops a client that asks DNS.
 *   `curl https://1.2.3.4/ -H 'Host: …'` never asks, and neither does anything holding a
 *   literal address. It filters the honest.
 * - **A dedicated docker network with masquerade disabled.** Genuinely close, and it was
 *   the runner-up: containers on it have no NAT and so no route out, but can still reach
 *   the host. It fails on *reachability*, not on filtering — the host end has to bind an
 *   address the container can see, and on Docker Desktop under WSL2 the bridge gateway
 *   lives in the engine's VM rather than in the distro the runner runs in. Making it work
 *   everywhere means binding `0.0.0.0` and putting an unauthenticated forward proxy on
 *   the LAN.
 * - **A sibling proxy container.** Ruled out by ADR-0006, which is the reason ADR-0005
 *   gave for the allowlist having "no cheap implementation".
 *
 * What is actually used: `--network none`, plus this proxy listening on a **unix socket
 * on the host** that is bind-mounted into the container. A unix socket is a file, so it
 * crosses the boundary docker already crosses for the workspace, and it needs no network
 * at all. The container therefore has *zero* IP connectivity — not filtered connectivity,
 * none — and one file descriptor that reaches a host process which enforces the
 * allowlist. ADR-0006 stays intact because there is no sibling container; the proxy is
 * the runner, which was already going to be running.
 *
 * That also makes the enforcement non-advisory, which is the part every proxy-by-env-var
 * design gets wrong. `HTTPS_PROXY` is a *hint*: a prompt-injected agent runs
 * `curl --noproxy '*' https://evil.example` and walks straight past it. Here the hint is
 * the only thing that works, because there is no other route.
 *
 * ## What this deliberately is not
 *
 * No TLS interception, no credential injection, no policy engine. CONNECT is allowlisted
 * by hostname and the bytes are piped through untouched — this process cannot read what
 * flows over the tunnel and should not be able to.
 *
 * **The seam.** A credential-injecting gateway is being built alongside this, and it will
 * subsume this enforcement point: same socket, same env vars, same `--network none`
 * container, with `allowed()` growing into a policy decision and the tunnel growing a TLS
 * terminator so a credential can be attached host-side and never mounted into a sandbox
 * at all. Everything above this comment is deliberately arranged so that the *only* thing
 * that has to change is what happens between "a host was named" and "bytes are piped".
 * When that lands, `credentialMounts()` in container.ts is what stops existing.
 */
export type EgressProxy = {
  /** The host path of the listening socket. Bind-mounted into the container. */
  socketPath: string
  /** Hostnames refused, in order, for the run record. */
  denied: () => string[]
  close: () => Promise<void>
}

/**
 * Where a container's socket lives on the host.
 *
 * Pure and derived from the container name so `buildRunArgs` can stay a pure function of
 * its options — the mount flag is asserted in tests without starting anything, and that
 * only works if the path does not come from the running proxy.
 *
 * Under `tmpdir()` rather than the runner's scratch because a unix socket path is capped
 * at ~108 bytes by the kernel, silently truncated past it, and a scratch directory is
 * user-configurable and can be arbitrarily deep. A run named `ogun-` plus twelve hex
 * characters leaves plenty of room here and none there.
 */
export const egressSocketDir = (): string => join(tmpdir(), 'ogun-egress')
export const egressSocketPath = (containerName: string): string =>
  join(egressSocketDir(), `${containerName}.sock`)

/** Where the socket is mounted inside the container. */
export const GUEST_EGRESS_SOCKET = '/run/ogun/egress.sock'

/** The loopback port the in-container forwarder listens on, bridging TCP to the socket
 *  above. Fixed rather than allocated: it is inside a network namespace of its own with
 *  nothing else in it, so there is nothing to collide with. */
export const GUEST_PROXY_PORT = 8118

export async function startEgressProxy(input: {
  containerName: string
  allow: readonly string[]
  /** Called for every refusal, so a run's log says which host was blocked rather than
   *  leaving a connection error to be diagnosed from the agent's side. */
  onDenied?: (host: string) => void
}): Promise<EgressProxy> {
  const socketPath = egressSocketPath(input.containerName)
  await mkdir(egressSocketDir(), { recursive: true })
  // A stale socket file from a killed runner makes listen() fail with EADDRINUSE, which
  // reads as "another proxy is running" when nothing is.
  await rm(socketPath, { force: true })

  const denied: string[] = []
  const refuse = (host: string): void => {
    denied.push(host)
    input.onDenied?.(host)
  }
  const allowed = (host: string): boolean => isHostAllowed(host, input.allow)

  const server = createServer()
  const sockets = new Set<Socket>()
  const track = (s: Socket): void => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  }

  /**
   * HTTPS, and everything else worth having: `CONNECT host:port`, allowlisted on the
   * host half only.
   *
   * The port is not checked, and that is a decision rather than an omission. A port rule
   * is policy, and the thing being defended against is reaching an attacker's *host* —
   * an attacker who already controls the host controls which port it listens on.
   */
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client)
    client.on('error', () => client.destroy())
    const target = parseAuthority(req.url ?? '')
    if (!target || !allowed(target.host)) {
      if (target) refuse(target.host)
      // A body, not a bare status line. This text is the only explanation anyone gets:
      // it surfaces in curl's output, in an agent's error message, and in a stack trace
      // from undici — all places where "ECONNREFUSED" would send someone hunting for a
      // network fault that does not exist.
      client.end(denialResponse(target?.host ?? req.url ?? '<unparseable>'))
      return
    }
    const upstream = connect(target.port, target.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    track(upstream)
    upstream.on('error', () => {
      // 502 rather than a silent close: the host was allowed and the connection still
      // failed, which is a different problem from a refusal and must not look like one.
      client.end(
        'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n' +
          `ogun egress: ${target.host} is allowed but could not be reached.\n`,
      )
    })
  })

  /**
   * Plain HTTP, in absolute form (`GET http://host/path HTTP/1.1`), which is what a
   * client sends to a proxy when the scheme is not https.
   *
   * Supported rather than refused because the alternative is a class of failure nobody
   * diagnoses correctly: `http://` URLs would hang or fail with an unrelated error while
   * `https://` worked, and the difference is invisible in a lockfile or a redirect chain.
   * Nothing here inspects or rewrites the request — headers and body are forwarded as
   * they arrived. It is a relay with an allowlist, not a gateway.
   */
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const host = hostOfAbsoluteRequest(req)
    if (!host || !allowed(host.host)) {
      if (host) refuse(host.host)
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end(denialBody(host?.host ?? req.url ?? '<unparseable>'))
      return
    }
    // Imported lazily: `node:http`'s request function is only needed on this path, and
    // hoisting it would put a second live client in every process that merely starts a
    // proxy.
    void import('node:http').then(({ request }) => {
      const upstream = request(
        {
          host: host.host,
          port: host.port,
          method: req.method ?? 'GET',
          path: host.path,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`ogun egress: ${host.host} is allowed but could not be reached.\n`)
      })
      req.pipe(upstream)
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(socketPath, () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  /**
   * 0600, relying on the same uid assumption the workspace bind-mount already relies on:
   * `ogun/base` creates its user at uid 1000 explicitly so a mounted workspace is
   * writable without chowning the host's files. Connecting to a unix socket needs *write*
   * permission on the inode, so a mode any wider would make this an unauthenticated
   * forward proxy for every local account on the host. If the runner is not uid 1000 a
   * modifier could not write its own workspace either, so this fails in company.
   */
  await chmod(socketPath, 0o600)

  return {
    socketPath,
    denied: () => [...denied],
    close: async () => {
      // Destroy live sockets first. `server.close()` only stops accepting; a tunnel that
      // is still piping keeps the process alive, and the runner would hang on dispose of
      // a container that was killed mid-request.
      for (const s of sockets) s.destroy()
      await new Promise<void>((done) => closeServer(server, done))
      await rm(socketPath, { force: true }).catch(() => undefined)
    },
  }
}

const closeServer = (server: Server, done: () => void): void => void server.close(() => done())

const denialResponse = (host: string): string =>
  'HTTP/1.1 403 Forbidden\r\nConnection: close\r\ncontent-type: text/plain\r\n\r\n' +
  denialBody(host)

const denialBody = (host: string): string =>
  `ogun egress: ${host} is not on this worker's allowlist.\n` +
  "Add it under the worker's `egress:` in .ogun/config.yaml if it belongs there (§4.6).\n"

/** `host:port` out of a CONNECT request line. IPv6 arrives bracketed. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(authority)
  if (bracketed?.[1] && bracketed[2]) return { host: bracketed[1], port: Number(bracketed[2]) }
  const idx = authority.lastIndexOf(':')
  if (idx <= 0) return undefined
  const host = authority.slice(0, idx)
  const port = Number(authority.slice(idx + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}

function hostOfAbsoluteRequest(
  req: IncomingMessage,
): { host: string; port: number; path: string } | undefined {
  try {
    // Absolute-form is what a proxy is sent. A client that connected here and then used
    // origin-form (`GET /path`) is not talking to a proxy at all — most likely the
    // in-container forwarder was pointed at by something that thought it was an origin
    // server — and there is no host to check, so it gets refused rather than guessed at.
    const url = new URL(req.url ?? '')
    if (url.protocol !== 'http:') return undefined
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 80,
      path: `${url.pathname}${url.search}`,
    }
  } catch {
    return undefined
  }
}
