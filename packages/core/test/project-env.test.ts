import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  envSchema,
  generate,
  projectConfigSchema,
  readEnv,
  resolveEnv,
} from '../src/config/index.ts'

/**
 * `env:` exists because of one afternoon: a migration requiring `MONITOR_PASSWORD` landed
 * in heirchive-api, the project image was a snapshot pinned before it and had no such
 * variable, and every job on that project began dying in the entrypoint with a Postgres
 * exception before its first command ran.
 *
 * These tests are shaped around the failure mode that produced that, not around the happy
 * path: a declaration that is accepted and then quietly does nothing.
 */

const config = (yaml: string) =>
  projectConfigSchema.parse(parseYaml(`project:\n  name: demo\n  slug: demo\n  repo: /tmp/demo\n${yaml}`))

const noSecrets = async () => undefined

test('a config written before env: existed parses, and declares nothing', () => {
  assert.deepEqual(config('tests:\n  command: pnpm test\n').env, {})
  assert.equal(readEnv('tests:\n  command: pnpm test\n')?.constructor, Object)
  assert.deepEqual(readEnv('tests:\n  command: pnpm test\n'), {})
})

test('readEnv tells "declared nothing" apart from "could not be read"', () => {
  // The distinction the runner acts on: {} starts normally, undefined refuses the run.
  assert.deepEqual(readEnv('env:\n  A: 1\n'), { A: '1' })
  assert.equal(readEnv('env:\n  1BAD: x\n'), undefined)
  assert.equal(readEnv('\tnot: [valid'), undefined)
})

test('a literal is a bare scalar, and YAML numbers and booleans survive as strings', () => {
  const env = config('env:\n  SUPABASE_URL: http://127.0.0.1:54321\n  PORT: 9000\n  DEBUG: false\n').env
  assert.deepEqual(env, { SUPABASE_URL: 'http://127.0.0.1:54321', PORT: '9000', DEBUG: 'false' })
})

test('an empty value is refused rather than becoming the empty string', () => {
  // `FOO:` with nothing after it reads as "configured" downstream and behaves as "missing".
  assert.equal(envSchema.safeParse({ FOO: null }).success, false)
})

test('a knob that belongs to another generator is a parse error, not a no-op', () => {
  assert.equal(envSchema.safeParse({ A: { generate: 'uuid', bytes: 4 } }).success, false)
  assert.equal(envSchema.safeParse({ A: { generate: 'password', bytes: 4 } }).success, false)
  assert.equal(envSchema.safeParse({ A: { generate: 'nope' } }).success, false)
})

test('OGUN_* is refused, because those are the variables the sandbox is built from', () => {
  for (const name of ['OGUN_PERMISSIONS', 'OGUN_EGRESS_SOCKET', 'OGUN_']) {
    assert.equal(envSchema.safeParse({ [name]: 'x' }).success, false, name)
  }
  assert.equal(envSchema.safeParse({ NOT_OGUN_PREFIXED: 'x' }).success, true)
})

test('a name the record parser would silently drop is refused instead', () => {
  // `__proto__` is a legal environment variable and an illegal object key. Accepted, it
  // would be declared and absent — the silent drop this whole module is shaped against.
  assert.equal(envSchema.safeParse({ ['__proto__']: 'x' }).success, false)
})

test('names that cannot become environment variables are refused', () => {
  // `docker run --env 'a b=c'` does not fail; it creates a variable no shell can read.
  for (const name of ['1BAD', 'a b', 'has-dash', '']) {
    assert.equal(envSchema.safeParse({ [name]: 'x' }).success, false, name)
  }
})

test('generated values have the shape their consumer decodes', async () => {
  // heirchive-api's DOC_ENCRYPTION_KEY has to decode to exactly 32 bytes or the app throws.
  assert.equal(Buffer.from(generate({ generate: 'base64', bytes: 32 }), 'base64').length, 32)
  assert.equal(generate({ generate: 'hex', bytes: 16 }).length, 32)
  assert.match(generate({ generate: 'uuid' }), /^[0-9a-f-]{36}$/)
})

test('a generated password survives SQL, shell and URL quoting, and is not repeated', () => {
  const drawn = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const pw = generate({ generate: 'password', length: 32 })
    assert.equal(pw.length, 32)
    // The characters that quote, escape, delimit or substitute somewhere on its path.
    assert.doesNotMatch(pw, /['"\\$`:/@&?#%;|<>(){}[\],*!~^ ]/)
    assert.match(pw[0] as string, /[A-Za-z0-9]/, 'a leading - or . reads as an option')
    drawn.add(pw)
  }
  assert.equal(drawn.size, 200, 'every draw is its own value')
})

test('resolveEnv reports where each value came from, and never the values', async () => {
  const declared = config(
    'env:\n  URL: http://x\n  PW: { generate: password }\n  K: { secret: stripe-test }\n',
  ).env
  const resolved = await resolveEnv(declared, async (name) =>
    name === 'stripe-test' ? 'sk_test_value' : undefined,
  )
  assert.equal(resolved.state, 'resolved')
  if (resolved.state !== 'resolved') return
  assert.deepEqual({ ...resolved.sources }, { URL: 'literal', PW: 'generate', K: 'secret' })
  assert.equal(resolved.env.K, 'sk_test_value')
  assert.equal(JSON.stringify(resolved.sources).includes('sk_test_value'), false)
})

test('a missing secret refuses the run instead of dropping one variable', async () => {
  const declared = config('env:\n  A: literal\n  K: { secret: stripe-test }\n').env
  const resolved = await resolveEnv(declared, noSecrets)
  assert.equal(resolved.state, 'refused')
  if (resolved.state !== 'refused') return
  assert.match(resolved.reason, /stripe-test/)
  assert.match(resolved.reason, /ogun secret set/)
})

test('a secret stored as whitespace is missing, not present', async () => {
  const declared = config('env:\n  K: { secret: k }\n').env
  assert.equal((await resolveEnv(declared, async () => '   ')).state, 'refused')
})

test('resolveEnv builds its result without a prototype to inherit from', async () => {
  const resolved = await resolveEnv(config('env:\n  A: 1\n').env, noSecrets)
  if (resolved.state !== 'resolved') return assert.fail('expected resolved')
  assert.equal(Object.getPrototypeOf(resolved.env), null)
})
