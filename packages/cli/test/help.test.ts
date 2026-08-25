import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { helpFor } from '../src/help.ts'

/**
 * A help topic is the one thing a person reads *before* they know what they are doing,
 * and the worked example is the part they copy. The renderer used to destroy both.
 *
 * `wrap` was `text.split(/\s+/)`, which treats a newline as one more space — so every
 * line break an author wrote was thrown away and the entry re-flowed into one paragraph.
 * `ogun connect` showed the cost: its two examples ran together into the sentence above
 * them, so the copyable part was the part that stopped being copyable.
 */
test('a line break an author wrote survives to the reader', () => {
  const rendered = helpFor(['connect'])
  assert.ok(rendered, 'ogun connect has a help topic')

  // The examples are laid out by their author, one per line, aligned. Each has to arrive
  // as its own line — a wrapped command line is not merely ugly, it is wrong if copied.
  assert.match(rendered, /^\s+ogun connect linear\s+prompts for both$/m)
  assert.match(rendered, /^\s+printf 'lin_api_…' \| ogun connect linear --api-key$/m)
})

/**
 * The other half, and the reason "any indent means verbatim" is not the rule: a
 * continuation line indented two spaces to keep the *source* readable is still prose, and
 * emitting it verbatim pushes it past the width instead of wrapping it. Four spaces is an
 * example, by the convention Markdown already uses for a code block.
 */
test('prose is still wrapped, however its source happened to be indented', () => {
  const rendered = helpFor(['connect'])
  assert.ok(rendered)

  const overlong = rendered
    .split('\n')
    .filter((line) => !/^\s{4,}/.test(line))
    .filter((line) => line.length > 92)
  assert.deepEqual(overlong, [], 'prose lines must wrap; only author-laid-out examples may run long')
})
