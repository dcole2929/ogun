import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defaultCaDirectory } from './ca.ts'

const run = promisify(execFile)

/**
 * Where the gateway has to listen for a container to reach it.
 *
 * Not `127.0.0.1`: a container's loopback is its own, and a listener bound to the host's
 * loopback is unreachable from inside one. Not `0.0.0.0` either — that publishes a
 * credential-injecting proxy to every interface on the machine, including the LAN, and
 * the per-job token would be the only thing between it and the network.
 *
 * The docker bridge's gateway address (usually `172.17.0.1`) is the narrow answer: it is
 * a host address, it is reachable from every container on the default network, and it is
 * reachable from nothing else.
 *
 * Returns `undefined` when docker cannot be asked, which is an ordinary state — a
 * worktree sandbox needs no bridge, and `ogun runner doctor` reports docker's absence
 * already. The caller falls back to loopback rather than failing.
 */
export async function dockerBridgeAddress(): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      'docker',
      [
        'network',
        'inspect',
        'bridge',
        '--format',
        // One line, no jq: the format string is the whole parser.
        '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
      ],
      { timeout: 15_000 },
    )
    const address = stdout.trim()
    return address.length > 0 ? address : undefined
  } catch {
    return undefined
  }
}

export type CaState =
  | { state: 'missing'; directory: string }
  | { state: 'present'; keyPath: string; keyMode: number }

/**
 * What `ogun runner doctor` can say about the CA without creating one.
 *
 * Deliberately not `loadOrCreateCa`. Doctor reports on a machine, it does not change it,
 * and a diagnostic that silently generates a signing key the first time you run it makes
 * "is the CA present?" a question you can never get a false answer to.
 */
export function caState(directory = defaultCaDirectory()): CaState {
  const keyPath = join(directory, 'ca.key')
  if (!existsSync(keyPath) || !existsSync(join(directory, 'ca.pem'))) {
    return { state: 'missing', directory }
  }
  return { state: 'present', keyPath, keyMode: statSync(keyPath).mode & 0o777 }
}
