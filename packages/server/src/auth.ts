import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Env } from './context.ts'

/**
 * The control plane can trigger jobs and, since it edits `.ogun/config.yaml`, define
 * what those jobs run. An unauthenticated instance reachable from the network is
 * therefore remote code execution on this machine — not merely a data-exposure problem.
 *
 * So the posture is: **localhost with no token, or a wider bind with one.** Never wide
 * and open, which is what a default of 0.0.0.0 with no auth quietly produced.
 */
export const LOCAL_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])

export type AuthConfig = { bind: string; token: string | undefined }

export function resolveAuth(env = process.env): AuthConfig {
  return {
    // Localhost by default. Reaching this from another machine should be a decision you
    // made, not something that happened because a framework defaults to all interfaces.
    bind: env.OGUN_BIND ?? '127.0.0.1',
    token: env.OGUN_TOKEN?.trim() || undefined,
  }
}

export class InsecureBind extends Error {}

/** Called at boot. Refuses rather than warns: a warning in a systemd log is not read. */
export function assertBindIsSafe(config: AuthConfig): void {
  if (LOCAL_BINDS.has(config.bind) || config.token) return
  throw new InsecureBind(
    [
      `refusing to listen on ${config.bind} without OGUN_TOKEN.`,
      '',
      'This API can create workers and trigger runs, so an open one on a shared network',
      'is remote code execution on this machine.',
      '',
      'Either bind to localhost (unset OGUN_BIND), or set a shared secret:',
      '',
      "  OGUN_TOKEN=$(openssl rand -hex 32) OGUN_BIND=0.0.0.0 pnpm server",
      '',
      'Runners and the CLI on other machines then need the same OGUN_TOKEN.',
    ].join('\n'),
  )
}

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * No-op when no token is configured, which is the localhost case. Health is always open
 * so a probe does not need the secret.
 */
export function bearerAuth(token: string | undefined): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!token) return next()
    if (c.req.path === '/api/health') return next()

    const header = c.req.header('authorization') ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : c.req.header('x-ogun-token')
    if (!presented || !constantTimeEqual(presented, token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  }
}
