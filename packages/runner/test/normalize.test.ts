import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claudeRuntime, codexRuntime, newParserState } from '../src/runtimes/index.ts'
import type { RunEvent } from '@ogun/core'
import type { RuntimeSpec } from '../src/runtimes/types.ts'
import { failureMessage } from '../src/pipeline.ts'

/**
 * Both fixtures are real captures from `claude -p --output-format stream-json` and
 * `codex exec --json` running the same task against the same file. The point of these
 * tests is that two dissimilar formats produce one comparable timeline.
 */
const replay = (spec: RuntimeSpec, file: string): RunEvent[] => {
  const state = newParserState()
  const raw = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => spec.parseLine(line, state))
}

const types = (events: RunEvent[]) => events.map((e) => e.type)

test('claude: session id, tool correlation, and usage survive normalization', () => {
  const events = replay(claudeRuntime, 'claude-review.jsonl')
  const started = events.find((e) => e.type === 'run.started')
  assert.equal(started?.payload.runtime, 'claude')
  assert.ok(started?.payload.sessionId, 'session id is needed for --resume')

  const call = events.find((e) => e.type === 'tool.started')
  const result = events.find((e) => e.type === 'tool.completed')
  assert.equal(call?.payload.name, 'Read')
  assert.equal(
    result?.payload.callId,
    call?.payload.callId,
    'tool_use.id must join to tool_result.tool_use_id',
  )
  assert.equal(result?.payload.name, 'Read', 'the completion should know its tool name')

  const done = events.at(-1)
  assert.equal(done?.type, 'run.completed')
  const usage = done?.payload.usage as { inputTokens?: number; outputTokens?: number }
  assert.ok((usage.inputTokens ?? 0) > 0)
  assert.ok((usage.outputTokens ?? 0) > 0)
})

test('claude: thinking_tokens noise is dropped, real thinking is kept', () => {
  const events = replay(claudeRuntime, 'claude-review.jsonl')
  assert.ok(events.some((e) => e.type === 'agent.reasoning'))
  // Ten of the eighteen fixture lines are system/thinking_tokens carrying nothing.
  assert.ok(events.length < 12, `expected the noise dropped, got ${events.length} events`)
})

test('codex: item.id correlates a command to its exit code', () => {
  const events = replay(codexRuntime, 'codex-review.jsonl')
  const call = events.find((e) => e.type === 'tool.started')
  const result = events.find((e) => e.type === 'tool.completed')
  assert.equal(call?.payload.callId, result?.payload.callId)
  assert.equal(result?.payload.exitCode, 0)
  assert.equal(result?.payload.isError, false)
  assert.match(String(result?.payload.output), /export const add/)
})

test('both runtimes produce the same timeline skeleton', () => {
  const skeleton = (events: RunEvent[]) =>
    types(events).filter((t) => t !== 'agent.reasoning' && t !== 'rate_limit')
  assert.deepEqual(skeleton(replay(claudeRuntime, 'claude-review.jsonl')), [
    'run.started',
    'tool.started',
    'tool.completed',
    'agent.message',
    'run.completed',
  ])
  assert.deepEqual(skeleton(replay(codexRuntime, 'codex-review.jsonl')), [
    'run.started',
    'agent.message',
    'tool.started',
    'tool.completed',
    'agent.message',
    'run.completed',
  ])
})

test('sequence numbers are dense and monotonic per run', () => {
  for (const [spec, file] of [
    [claudeRuntime, 'claude-review.jsonl'],
    [codexRuntime, 'codex-review.jsonl'],
  ] as const) {
    const seqs = replay(spec, file).map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs.keys()], `${file}: a gap would read as a dropped event`)
  }
})

test('a truncated or non-JSON line is ignored rather than killing the run', () => {
  const state = newParserState()
  assert.deepEqual(claudeRuntime.parseLine('{"type":"assis', state), [])
  assert.deepEqual(codexRuntime.parseLine('', state), [])
  assert.equal(state.seq, 0)
})

/**
 * When a runtime exits non-zero, the run record has to say why in a sentence a person
 * can act on. The stderr tail is not that: codex prints "Reading additional input from
 * stdin…" on every invocation, so a run killed by a 400 from the model API reported
 * that line — pointing at §4.7's stdin gotcha, which is fixed, instead of at the model
 * name, which was wrong. These are the real payload shapes both runtimes emit.
 */
test('a failure reason is dug out of whatever the runtime nested it in', () => {
  // Codex: the provider's response body arrives as a *string* of JSON.
  assert.equal(
    failureMessage({
      error: {
        message:
          '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.1-codex\' model is not supported when using Codex with a ChatGPT account."}}',
      },
    }),
    "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.",
  )

  // Claude: nested objects, no string-encoded layer.
  assert.equal(
    failureMessage({ error: { message: 'Credit balance is too low' } }),
    'Credit balance is too low',
  )

  // A plain string is already the answer.
  assert.equal(failureMessage({ error: 'sandbox failed to provision' }), 'sandbox failed to provision')

  // Nothing usable must stay undefined so the caller falls back to stderr rather than
  // reporting a confidently empty reason.
  assert.equal(failureMessage({}), undefined)
  assert.equal(failureMessage(undefined), undefined)

  // Unparseable JSON is still better than nothing.
  assert.equal(failureMessage({ error: '{not json' }), '{not json')
})
