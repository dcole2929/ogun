import type { RunEvent } from '@ogun/core'
import { nextSeq, type JobCtx, type ParserState, type RuntimeSpec } from './types.ts'

/**
 * Claude Code headless is API-message shaped: one JSONL line per message, content
 * blocks inside. A tool call and its result arrive on two separate lines joined by
 * tool_use.id -> tool_result.tool_use_id.
 */
export const claudeRuntime: RuntimeSpec = {
  provider: 'claude',

  start: (ctx) => [
    '-p',
    ctx.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(ctx.model ? ['--model', ctx.model] : []),
    /**
     * The container is the boundary (§4.6), so in-agent permission prompts are both
     * unanswerable and redundant.
     *
     * A non-modifier also loses the edit tools — kept, but no longer load-bearing: it
     * never restricted `Bash`, so it never stopped a reviewer writing, and codex has no
     * equivalent. Enforcement is the read-only mount in `container.ts`. This stays
     * because it costs nothing and makes the intent legible to the agent itself, which
     * is a better failure than a write that dies on a read-only filesystem mid-task.
     */
    '--dangerously-skip-permissions',
    ...(ctx.permissions === 'modifier'
      ? []
      : ['--disallowedTools', 'Edit,Write,NotebookEdit,MultiEdit']),
  ],

  resume: (ctx, sessionId) => [
    '--resume',
    sessionId,
    '-p',
    ctx.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ],

  resultFile: false,
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
      case 'system':
        if (d.subtype === 'init') {
          state.sessionId = d.session_id
          emit('run.started', {
            runtime: 'claude',
            sessionId: d.session_id,
            model: d.model,
            tools: d.tools?.length,
          })
        }
        // `thinking_tokens` fires several times per turn and carries nothing a timeline
        // can show. Dropping it keeps the event table from being mostly noise.
        break

      case 'rate_limit_event':
        // A real signal of remaining subscription headroom, unlike our token proxy.
        emit('rate_limit', { info: d.rate_limit_info })
        break

      case 'assistant':
        for (const block of d.message?.content ?? []) {
          if (block.type === 'text' && block.text) emit('agent.message', { text: block.text })
          else if (block.type === 'thinking' && block.thinking)
            emit('agent.reasoning', { text: block.thinking })
          else if (block.type === 'tool_use') {
            state.toolNames.set(block.id, block.name)
            emit('tool.started', { callId: block.id, name: block.name, input: block.input })
          }
        }
        break

      case 'user':
        for (const block of d.message?.content ?? []) {
          if (block.type !== 'tool_result') continue
          const name = state.toolNames.get(block.tool_use_id)
          emit('tool.completed', {
            callId: block.tool_use_id,
            ...(name ? { name } : {}),
            isError: block.is_error === true,
            output: stringifyContent(block.content),
          })
        }
        break

      case 'result':
        emit(d.subtype === 'success' ? 'run.completed' : 'run.failed', {
          result: typeof d.result === 'string' ? d.result : undefined,
          usage: {
            inputTokens: d.usage?.input_tokens,
            outputTokens: d.usage?.output_tokens,
            cacheReadTokens: d.usage?.cache_read_input_tokens,
            cacheWriteTokens: d.usage?.cache_creation_input_tokens,
            // A list-price estimate, not a charge (§4.7). Relative signal only.
            costUsdEstimate: d.total_cost_usd,
          },
        })
        break
    }
    return out
  },
}

const stringifyContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
      .join('')
  return ''
}
