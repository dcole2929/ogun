import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { egressSchema, projectConfigSchema, workerSchema } from '../src/config/index.ts'

/**
 * `egress:` is a new key in a file that is checked into every project using Ogun, so the
 * property this protects is mostly negative: a config written before it existed must
 * parse unchanged, and the two values that already shipped must keep meaning what they
 * meant.
 *
 * The failure this guards against is not a thrown error — that would at least be visible.
 * It is a schema change that quietly reinterprets an existing file, which for this field
 * means quietly changing what a container may reach. `egress: open` in someone's config
 * has to keep being `open` even though `open` is no longer the default, precisely because
 * whoever wrote it was making a decision.
 */

const worker = (yaml: string) => workerSchema.parse(parseYaml(yaml))

test('a config written before egress existed still parses, and says nothing about egress', () => {
  const parsed = projectConfigSchema.parse(
    parseYaml(`project:
  name: demo
workers:
  reviewer:
    skill: adversarial-review
    runtime: claude
    permissions: reviewer
    sandbox: container
`),
  )
  assert.equal(parsed.workers.reviewer?.egress, undefined)
})

/**
 * Absent is deliberately not `.default(...)`. "The worker said nothing" and "the worker
 * asked for exactly the defaults" are the same policy today, but only the first can be
 * told apart from a deliberate declaration when the UI round-trips this config back into
 * yaml — and a default materialised into the file would write an allowlist into every
 * project's git history that nobody chose.
 */
test('an absent egress stays absent rather than being materialised into the file', () => {
  const parsed = worker('skill: s\n')
  assert.ok(!('egress' in parsed) || parsed.egress === undefined)
})

test('the two values that already shipped keep working', () => {
  assert.equal(worker('skill: s\negress: none\n').egress, 'none')
  assert.equal(worker('skill: s\negress: open\n').egress, 'open')
})

test('a worker can declare a list of extra hosts', () => {
  assert.deepEqual(worker('skill: s\negress:\n  - proxy.golang.org\n  - "*.crates.io"\n').egress, [
    'proxy.golang.org',
    '*.crates.io',
  ])
})

/**
 * Rejected at parse rather than at match time, which is the whole reason to validate a
 * hostname at all. A matcher that simply never matches `https://api.example.com/v1` turns
 * a typo into a connection refused inside a container at 3am, reported by the agent as
 * "could not reach the API" — a sentence that points at everything except the config line
 * that caused it.
 */
test('an entry that is a URL, not a hostname, is refused at parse time', () => {
  for (const bad of [
    'https://api.example.com',
    'api.example.com/v1',
    'api.example.com:443',
    'api example.com',
    '',
  ]) {
    assert.equal(
      egressSchema.safeParse([bad]).success,
      false,
      `${JSON.stringify(bad)} should not be a legal allowlist entry`,
    )
  }
})

/** `*` is `open` spelled in a way that does not read as an opt-out. Someone scanning a
 *  diff for "which workers have unrestricted egress" greps for `open`, and a bare
 *  wildcard would not answer. */
test('a bare wildcard is refused — `open` is how you say "anywhere"', () => {
  assert.equal(egressSchema.safeParse(['*']).success, false)
  assert.equal(egressSchema.safeParse(['*.']).success, false)
  assert.equal(egressSchema.safeParse(['*.example.com']).success, true)
})

/** An empty list means "the defaults", which is what absent already means. Two spellings
 *  of one policy is a thing to explain forever; the second one is refused. */
test('an empty list is refused rather than being a third way to spell "the defaults"', () => {
  assert.equal(egressSchema.safeParse([]).success, false)
})

/**
 * A value this build does not understand must fail loudly here, at the control plane,
 * where a person is looking at the file. The alternative — tolerating it and falling back
 * to something — means a typo in an egress rule silently produces a container with a
 * policy nobody wrote.
 */
test('an unrecognised egress value is refused rather than interpreted', () => {
  assert.equal(egressSchema.safeParse('everything').success, false)
  assert.equal(egressSchema.safeParse(true).success, false)
  assert.equal(egressSchema.safeParse({ allow: ['a.com'] }).success, false)
})
