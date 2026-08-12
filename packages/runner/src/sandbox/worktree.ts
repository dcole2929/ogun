import { spawnJsonl } from './exec.ts'
import { readContained } from './paths.ts'
import type { Sandbox, SandboxSpec } from './types.ts'

/**
 * Opt-in, fast, and honest about what it is: file-state isolation only, not capability
 * isolation. The agent runs as you, on your machine, with your network (§4.6).
 *
 * A modifier downgrading to this is an agent editing files directly on the host, which
 * is why `allowSandboxDowngrade` gates it.
 */
export function createWorktreeSandbox(spec: SandboxSpec): Sandbox {
  const binary = spec.runtime === 'claude' ? claudeBinary() : 'codex'
  return {
    kind: 'worktree',
    provision: async () => {},
    exec: (argv) =>
      spawnJsonl(binary, argv, {
        cwd: spec.hostWorkspace,
        timeoutMs: spec.timeoutMs,
        env: { ...process.env, ...spec.env },
      }),
    readFile: (relPath) => readContained(spec.hostWorkspace, relPath),
    dispose: async () => {},
  }
}

// A shell function shadows `claude` in interactive shells; the runner needs the binary.
const claudeBinary = (): string => process.env.OGUN_CLAUDE_BIN ?? 'claude'
