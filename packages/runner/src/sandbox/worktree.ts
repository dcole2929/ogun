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
    /**
     * A `raw` command runs as itself, on the host, in the workspace — which is what this
     * sandbox is, and why a modifier needs `allowSandboxDowngrade` to reach it at all.
     * There is nothing weaker about it than the agent invocation it sits beside: the same
     * process, the same user, the same machine.
     */
    exec: (argv, exec = {}) => {
      /**
       * There is no image here to override, and running the command anyway would be the
       * wrong kind of wrong. `exec.image` is only ever set by the `project-image` lens,
       * whose entire claim is "this suite passed *inside the image this patch proposes*";
       * honoured on a worktree it would run on the host instead and report that claim
       * about a machine nobody will ever run the project on.
       *
       * A backstop rather than the message a person sees: the gate refuses a bootstrap
       * worker that is not in a container before it builds anything, and `workerSchema`
       * refuses the worker before that. This is here for the third caller.
       */
      if (exec.image) {
        throw new Error(
          `the worktree sandbox has no image to run \`${exec.image}\` in — it runs on the ` +
            'host, as the runner, so a suite run here would prove nothing about that image',
        )
      }
      return spawnJsonl(exec.raw ? (argv[0] ?? '') : binary, exec.raw ? argv.slice(1) : argv, {
        cwd: spec.hostWorkspace,
        timeoutMs: exec.timeoutMs ?? spec.timeoutMs,
        env: { ...process.env, ...(exec.raw ? { CI: '1' } : {}), ...spec.env },
      })
    },
    readFile: (relPath) => readContained(spec.hostWorkspace, relPath),
    dispose: async () => {},
  }
}

// A shell function shadows `claude` in interactive shells; the runner needs the binary.
const claudeBinary = (): string => process.env.OGUN_CLAUDE_BIN ?? 'claude'
