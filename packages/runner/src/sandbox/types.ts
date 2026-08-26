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
  /**
   * Resolves once the process exits and `lines` is drained.
   *
   * `timedOut` because the exit code cannot carry it: a killed process reports a null
   * code or a signal, which is indistinguishable from any other abnormal exit. The
   * verify gate has to tell a suite that failed from a suite that never finished, and
   * "exited null" is not a sentence anyone can act on.
   */
  done: Promise<{ code: number | null; stderr: string; timedOut: boolean }>
}

export type ExecOptions = {
  /**
   * Overrides the sandbox's own timeout for this one command.
   *
   * The gate runs after the agent has already spent part of the job's budget, and the
   * sandbox timeout is the *whole* budget — so a verification step that used it would be
   * a second, independent allowance that lets a job outlive the timeout it was given.
   */
  timeoutMs?: number
  /**
   * Run `argv` as the sandbox's own command instead of as arguments to the agent runtime
   * binary.
   *
   * Everything the sandbox ran until now was the runtime, so the runtime was hardcoded
   * as the argv's first element. A verification command is not: `sh -c 'pnpm test'`
   * prefixed with `claude` runs claude, which is neither what the config asked for nor
   * an error anyone would recognise from the output.
   */
  raw?: boolean
  /**
   * Run this command in a different image than the sandbox's own, keeping everything else
   * about the sandbox — the mounts, the gateway session, the memory caps, `--network
   * none`.
   *
   * Exists for exactly one caller: the `project-image` lens, which has just built an image
   * out of the patch it is grading and has to run the patch's own test command *inside
   * it* (ADR-0016). Nothing else should reach for this. The sandbox's image is chosen by
   * `imageFor` from the job, and a second way to choose one is a second answer to "what
   * did this run actually execute in".
   *
   * Only meaningful with `raw`, and only on a container sandbox: a worktree sandbox has no
   * image to override and refuses rather than silently running the command on the host.
   * That refusal is the point — a gate that ran the project's proposed suite outside the
   * proposed image would report a pass that proves nothing about the image.
   */
  image?: string
}

export type Sandbox = {
  kind: 'container' | 'worktree'
  /** Provisioned ONCE per job, not per round — a retry reuses it (§5.2). */
  provision: () => Promise<void>
  exec: (argv: string[], opts?: ExecOptions) => ExecHandle
  /** Read a file the agent wrote, relative to the workspace. Path-checked. */
  readFile: (relPath: string) => Promise<string | null>
  dispose: () => Promise<void>
}
