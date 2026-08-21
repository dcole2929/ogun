import { createContainerSandbox, GUEST_WORKSPACE } from './container.ts'
import { createWorktreeSandbox } from './worktree.ts'
import type { EgressPolicy } from '@ogun/core'
import type { Sandbox, SandboxSpec } from './types.ts'

export type CreateSandboxInput = SandboxSpec & {
  kind: 'container' | 'worktree'
  name: string
  allowSandboxDowngrade: boolean
  /** Container sandboxes only — see `ContainerOptions.egress` (§4.6). */
  egress?: EgressPolicy
}

export function createSandbox(input: CreateSandboxInput): Sandbox {
  if (input.kind === 'worktree') {
    // A modifier on a worktree is an agent editing files directly on the host, with no
    // capability isolation at all. Refuse unless the project has said otherwise (§4.6).
    if (input.permissions === 'modifier' && !input.allowSandboxDowngrade) {
      throw new Error(
        'a modifier worker may not use the worktree sandbox unless policies.allowSandboxDowngrade is true',
      )
    }
    /**
     * A worktree sandbox has no network namespace of its own, so `egress` cannot mean
     * anything here — the agent runs as the runner, on the runner's network. Dropping it
     * silently is the honest option only because the downgrade itself is already the
     * loud one: a `modifier` needs `allowSandboxDowngrade` to get here at all, and what
     * that policy is agreeing to is exactly "no capability isolation".
     */
    return createWorktreeSandbox(input)
  }
  return createContainerSandbox({ ...input, guestWorkspace: GUEST_WORKSPACE })
}

export { GUEST_WORKSPACE }
export * from './types.ts'
export { egressSocketPath, GUEST_EGRESS_SOCKET, GUEST_PROXY_PORT } from './egress-proxy.ts'
export { containedTarget, readContained, safeJoin, UnsafeReadback, UnsafeWrite } from './paths.ts'
