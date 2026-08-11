import { claudeRuntime } from './claude.ts'
import { codexRuntime } from './codex.ts'
import type { RuntimeSpec } from './types.ts'

export const RUNTIMES: Record<string, RuntimeSpec> = {
  claude: claudeRuntime,
  codex: codexRuntime,
}

export const resolveRuntime = (name: string): RuntimeSpec => {
  const spec = RUNTIMES[name]
  if (!spec) throw new Error(`unknown runtime: ${name}`)
  return spec
}

/**
 * Model roles map to concrete models here (§4.7). The worker burns most of the tokens
 * and most of the clock; the reviewer runs several times per job and one bad approve
 * costs a bad PR. So: strong model on judgment, cheap model on the work.
 */
export const MODEL_ROUTER: Record<string, Record<string, string>> = {
  claude: {
    worker: process.env.OGUN_CLAUDE_WORKER_MODEL ?? 'claude-sonnet-5',
    reviewer: process.env.OGUN_CLAUDE_REVIEWER_MODEL ?? 'claude-opus-5',
  },
  codex: {
    worker: process.env.OGUN_CODEX_WORKER_MODEL ?? 'gpt-5.1-codex',
    reviewer: process.env.OGUN_CODEX_REVIEWER_MODEL ?? 'gpt-5.1-codex',
  },
}

export const resolveModel = (runtime: string, role: string): string | undefined =>
  MODEL_ROUTER[runtime]?.[role] ?? (role.includes('-') ? role : undefined)

export * from './types.ts'
export { claudeRuntime, codexRuntime }
