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
  for (const page of [
    ['connect'],
    ['connect', 'list'],
    ['secret'],
    ['secret', 'set'],
    ['sources'],
  ]) {
    const rendered = helpFor(page)
    assert.ok(rendered, page.join(' '))

    const overlong = rendered
      .split('\n')
      .filter((line) => !/^\s{4,}/.test(line))
      .filter((line) => line.length > 92)
    assert.deepEqual(
      overlong,
      [],
      `prose lines must wrap; only author-laid-out examples may run long (${page.join(' ')})`,
    )
  }
})

/**
 * The acceptance bar, asserted against the data rather than against a subprocess: **every
 * input a command needs is in a usage line, including the ones that are not positional.**
 *
 * It has been missed four times on this CLI, most recently by a shape that named the
 * credentials as two positionals — which is in the usage line and is still wrong, because
 * two opaque strings from the same page in a fixed order is a coin flip. So the check is
 * that the *flag names* are there, and that the value each one carries is shown beside it.
 */
test('every credential a command collects is named in one of its usage lines', () => {
  const cases: Array<[string[], RegExp[]]> = [
    [
      ['connect'],
      [
        /ogun connect <integration> --client-id <id> --client-secret <secret>/,
        /ogun connect <integration> --consent --client-id <id> --client-secret <secret>/,
        /ogun connect <integration> --api-key \[<key>\]/,
      ],
    ],
    [['secret', 'set'], [/ogun secret set <name> <key>/]],
    [['secret', 'rm'], [/ogun secret rm <name>/]],
    [['connect', 'list'], [/ogun connect list \[--project <slug>\]/]],
    /**
     * `ogun sources` collects no credential, and the bar is not about credentials — it is
     * that a reader can see every input from the usage line alone. Two of these are the
     * whole command: `--source` is how you name one, `--ticket` is how you ask about one
     * ticket, and neither is a positional, so neither appears anywhere a reader would
     * infer it from. The prose below the line explains them; the line has to *have* them.
     */
    [
      ['sources'],
      [/ogun sources \[--project <slug>\] \[--source <name>\] \[--ticket <key>\]/],
    ],
  ]
  for (const [page, expected] of cases) {
    const rendered = helpFor(page)
    assert.ok(rendered, page.join(' '))
    for (const pattern of expected) assert.match(rendered, pattern, page.join(' '))
  }
})

/**
 * The two-level flag structure is *rendered* as two levels.
 *
 * `--api-key` and `--consent` in one alphabetical block read as alternatives, which is
 * exactly the flattening the command was reshaped to undo: one names a kind of integration
 * and the other selects a grant inside the other kind. The headings are how a reader who
 * skips the prose still sees it.
 */
test('connect renders what you are connecting apart from which grant', () => {
  const rendered = helpFor(['connect'])
  assert.ok(rendered)

  const kinds = rendered.indexOf('what you are connecting')
  const grants = rendered.indexOf('which OAuth grant')
  assert.ok(kinds > 0, 'the kinds have their own heading')
  assert.ok(grants > kinds, 'the grant modifier comes after the kind it modifies')
  assert.match(rendered, /which OAuth grant \(only with --oauth, which it implies\)/)
})
