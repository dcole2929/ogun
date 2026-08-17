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
 *
 * **A pinned model is an account-compatibility claim, and it is the one that broke.**
 * Codex on a ChatGPT subscription — which is Ogun's whole cost model (principle 1) —
 * rejects every `-m` this router used to send, with a 400 that names the account type
 * rather than the model:
 *
 *     The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.
 *
 * So a codex worker never ran on this machine, and the failure breaker was three nights
 * from latching it off permanently as though that were policy.
 *
 * Setting either variable to the empty string sends no `-m` at all and lets the runtime
 * pick its own account default, which is the portable choice when a pin turns out to be
 * wrong on a new machine — every preset's argv builder already omits the flag when the
 * model is falsy.
 */
export const MODEL_ROUTER: Record<string, Record<string, string>> = {
  claude: {
    worker: process.env.OGUN_CLAUDE_WORKER_MODEL ?? 'claude-sonnet-5',
    reviewer: process.env.OGUN_CLAUDE_REVIEWER_MODEL ?? 'claude-opus-5',
  },
  /**
   * Both roles resolve to the same model because a ChatGPT account is offered exactly
   * one. Probed against codex-cli 0.147.0: `gpt-5.1-codex`, `gpt-5.1-codex-max`,
   * `gpt-5-codex`, `gpt-5.1`, `gpt-5`, `codex-mini-latest` and the `gpt-5.6-*` siblings
   * are all refused; `gpt-5.6-sol` is what the account resolves to on its own. There is
   * no cheap/strong split to spend here until an API-key runtime exists.
   */
  codex: {
    worker: process.env.OGUN_CODEX_WORKER_MODEL ?? 'gpt-5.6-sol',
    reviewer: process.env.OGUN_CODEX_REVIEWER_MODEL ?? 'gpt-5.6-sol',
  },
}

export const resolveModel = (runtime: string, role: string): string | undefined =>
  MODEL_ROUTER[runtime]?.[role] ?? (role.includes('-') ? role : undefined)

export * from './types.ts'
export { claudeRuntime, codexRuntime }
