import type { RunEvent } from '@ogun/core'
import { nextSeq, type ParserState, type RuntimeSpec } from './types.ts'

/**
 * Codex headless is item-lifecycle shaped: a thread containing turns containing items,
 * each with started/completed. A call and its result share one item.id, so correlation
 * is a different key than claude's but no harder.
 */
export const codexRuntime: RuntimeSpec = {
  provider: 'codex',

  start: (ctx) => [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // The authoritative final answer. Codex's --output-schema constrains *every*
    // assistant message, so a harness that parses the first schema-valid line gets a
    // confidently empty result — observed directly during the spike (§4.7).
    '-o',
    ctx.outputFile,
    ...(ctx.model ? ['-m', ctx.model] : []),
    // Codex ships its own landlock/seccomp sandbox. Nesting it inside our container is
    // redundant at best; the container is the boundary, so we bypass it here.
    '--dangerously-bypass-approvals-and-sandbox',
    ctx.prompt,
  ],

  // Codex resumes with a subcommand, not a flag. This is why RuntimeSpec takes argv
  // builders rather than a `sessionFlag` string (§4.7).
  resume: (ctx, sessionId) => [
    'exec',
    'resume',
    sessionId,
    '--json',
    '--skip-git-repo-check',
    '-o',
    ctx.outputFile,
    '--dangerously-bypass-approvals-and-sandbox',
    ctx.prompt,
  ],

  resultFile: true,
  stdin: 'close',

  parseLine: (line, state) => {
    let d: Record<string, any>
    try {
      d = JSON.parse(line)
    } catch {
      return []
    }
    const ts = new Date().toISOString()
    const out: RunEvent[] = []
    const emit = (type: RunEvent['type'], payload: Record<string, unknown>) =>
      out.push({ type, ts, seq: nextSeq(state), payload })

    switch (d.type) {
      case 'thread.started':
        state.sessionId = d.thread_id
        emit('run.started', { runtime: 'codex', sessionId: d.thread_id })
        break

      case 'item.started': {
        const item = d.item ?? {}
        if (item.type === 'command_execution') {
          state.toolNames.set(item.id, 'command_execution')
          emit('tool.started', {
            callId: item.id,
            name: 'command_execution',
            input: { command: item.command },
          })
        }
        break
      }

      case 'item.completed': {
        const item = d.item ?? {}
        if (item.type === 'agent_message') emit('agent.message', { text: item.text ?? '' })
        else if (item.type === 'reasoning') emit('agent.reasoning', { text: item.text ?? '' })
        else if (item.type === 'command_execution') {
          // A command that finishes fast can complete without ever emitting started.
          if (!state.toolNames.has(item.id)) {
            emit('tool.started', {
              callId: item.id,
              name: 'command_execution',
              input: { command: item.command },
            })
          }
          emit('tool.completed', {
            callId: item.id,
            name: 'command_execution',
            exitCode: item.exit_code ?? undefined,
            isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
            output: item.aggregated_output ?? '',
          })
        }
        break
      }

      case 'turn.completed':
        emit('run.completed', {
          usage: {
            inputTokens: d.usage?.input_tokens,
            outputTokens: d.usage?.output_tokens,
            cacheReadTokens: d.usage?.cached_input_tokens,
            cacheWriteTokens: d.usage?.cache_write_input_tokens,
            // Codex reports no cost at all — another reason budgets count tokens (§4.3).
          },
        })
        break

      case 'turn.failed':
      case 'error':
        emit('run.failed', { error: d.error ?? d.message ?? 'codex reported a failure' })
        break
    }
    void (state as ParserState)
    return out
  },
}
