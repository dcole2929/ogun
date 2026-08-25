import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parse } from '../src/args.ts'

/**
 * `optional-string` — a flag that names a kind and may also carry its value.
 *
 * It exists for `--api-key`, which is both: the flag says *what you are connecting*, and
 * the key is the one value that kind takes. Neither of Node's two option types can be
 * both, and each fails in its own way on the invocation where the value is a live
 * credential:
 *
 *  - as a `boolean` with the key as a positional, `--api-key=<key>` — which is what the
 *    usage line `--api-key <key>` invites — dies with *"Option '--api-key' does not take
 *    an argument"*;
 *  - as a `string`, the bare `--api-key` that means "prompt me, or read the pipe" dies
 *    with *"argument missing"*, which removes the recommended path.
 *
 * So the four spellings below all have to work, and the difference between "the flag was
 * absent" and "the flag was given without a value" has to survive — it is the difference
 * between *"connect with an application"* and *"connect with a key, and ask me for it"*.
 */
const SPEC = { '--api-key': 'optional-string', '--project': 'string' } as const

test('a flag that may carry its value keeps absent apart from empty', () => {
  assert.equal(parse(['linear'], SPEC, 'usage').flags['api-key'], undefined)
  assert.equal(parse(['linear', '--api-key'], SPEC, 'usage').flags['api-key'], '')
  assert.equal(parse(['linear', '--api-key', 'lin_api_x'], SPEC, 'usage').flags['api-key'], 'lin_api_x')
  assert.equal(parse(['linear', '--api-key=lin_api_x'], SPEC, 'usage').flags['api-key'], 'lin_api_x')
})

test('a bare optional flag does not swallow the flag after it', () => {
  /**
   * The failure this prevents: `ogun connect linear --api-key --project ogun` storing the
   * string `--project` as a credential and then treating `ogun` as a positional. A plain
   * `string` option in Node refuses that case rather than guessing, and the rewrite here
   * has to preserve the refusal by rewriting *before* the parser sees it.
   */
  const parsed = parse(['linear', '--api-key', '--project', 'ogun'], SPEC, 'usage')
  assert.equal(parsed.flags['api-key'], '')
  assert.equal(parsed.flags.project, 'ogun')
  assert.deepEqual(parsed.positionals, ['linear'])
})

test('the positional escape hatch is not rewritten', () => {
  /**
   * Everything after `--` is a positional by promise, including a word that happens to
   * spell an option this command declares. Rewriting inside it would break the one thing
   * `--` guarantees, and this is the only place the rewrite could have reached.
   */
  const parsed = parse(['--api-key', 'k', '--', '--api-key'], SPEC, 'usage')
  assert.equal(parsed.flags['api-key'], 'k')
  assert.deepEqual(parsed.positionals, ['--api-key'])
})
