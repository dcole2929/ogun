export type SandboxSpec = {
  /** Host path to the materialized workspace. */
  hostWorkspace: string
  /** Where that workspace appears to the agent. Same path for worktree sandboxes. */
  guestWorkspace: string
  image?: string
  permissions: 'observer' | 'reviewer' | 'modifier'
  runtime: 'claude' | 'codex'
  timeoutMs: number
  env?: Record<string, string>
}

export type ExecHandle = {
  /** JSONL lines from the agent's stdout, as they arrive. */
  lines: AsyncIterable<string>
  /** Resolves once the process exits and `lines` is drained. */
  done: Promise<{ code: number | null; stderr: string }>
}

export type Sandbox = {
  kind: 'container' | 'worktree'
  /** Provisioned ONCE per job, not per round — a retry reuses it (§5.2). */
  provision: () => Promise<void>
  exec: (argv: string[]) => ExecHandle
  /** Read a file the agent wrote, relative to the workspace. Path-checked. */
  readFile: (relPath: string) => Promise<string | null>
  dispose: () => Promise<void>
}
