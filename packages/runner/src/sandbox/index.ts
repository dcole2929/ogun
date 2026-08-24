import { createContainerSandbox, GUEST_WORKSPACE } from './container.ts'
import { createWorktreeSandbox } from './worktree.ts'
import type { EgressPolicy } from '@ogun/core'
import type { Gateway } from '@ogun/gateway'
import type { Sandbox, SandboxSpec } from './types.ts'

export type CreateSandboxInput = SandboxSpec & {
  kind: 'container' | 'worktree'
  name: string
  /**
   * `policies.allowSandboxDowngrade`, as the *project* set it at the commit the workspace
   * was pinned to — never a constant, and never anything read out of the workspace, which
   * is a tree the agent this gate contains can write. `sandboxDowngrade` in pipeline.ts
   * establishes it and refuses the run with a reason; by the time a value arrives here it
   * has already been decided, and the throw below is the backstop for a future caller
   * that skips that step.
   */
  allowSandboxDowngrade: boolean
  /** Container sandboxes only — see `ContainerOptions.egress` (§4.6). */
  egress?: EgressPolicy
  /**
   * The runner's egress gateway. Container sandboxes only, and not optional for one:
   * a container authenticates through it and has no other route out (ADR-0010).
   */
  gateway?: Gateway
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
     *
     * The gateway goes the same way and for the same reason. A worktree agent runs as the
     * runner, on the runner's network, reading the runner's home — so pointing it at a
     * gateway would inject a credential into a process that can already read the file the
     * gateway reads it from. It would be theatre, and theatre is worse than nothing here
     * because it reads like a protection.
     */
    return createWorktreeSandbox(input)
  }
  return createContainerSandbox({ ...input, guestWorkspace: GUEST_WORKSPACE })
}

export { buildRunArgs, GUEST_WORKSPACE } from './container.ts'
export type { ContainerOptions, SandboxEgress } from './container.ts'
export * from './types.ts'
export { GUEST_EGRESS_SOCKET, GUEST_PROXY_AUTHORITY, GUEST_PROXY_PORT } from './egress.ts'
export { containedTarget, readContained, safeJoin, UnsafeReadback, UnsafeWrite } from './paths.ts'
