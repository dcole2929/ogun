import { createContainerSandbox, GUEST_WORKSPACE } from './container.ts'
import { createWorktreeSandbox } from './worktree.ts'
import type { Sandbox, SandboxSpec } from './types.ts'

export type CreateSandboxInput = SandboxSpec & {
  kind: 'container' | 'worktree'
  name: string
  allowSandboxDowngrade: boolean
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
    return createWorktreeSandbox(input)
  }
  return createContainerSandbox({ ...input, guestWorkspace: GUEST_WORKSPACE })
}

export { GUEST_WORKSPACE }
export * from './types.ts'
export { containedTarget, readContained, safeJoin, UnsafeReadback, UnsafeWrite } from './paths.ts'
