import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildRunArgs, GUEST_WORKSPACE } from '../src/sandbox/container.ts'

/**
 * `env:` puts a project's own variables into `docker run`, and `docker run` resolves a
 * repeated name by taking the last one. That makes the *order* of two blocks of `--env`
 * arguments a containment property rather than a formatting detail: everything Ogun sets
 * — the egress socket, the proxy variables four TLS stacks are pointed at, the connection
 * placeholders, `OGUN_PERMISSIONS` — is a variable a modifier would like to choose, and
 * `.ogun/config.yaml` is a file a modifier can write.
 *
 * `env.ts` refuses `OGUN_*` at parse time, which catches the accident and says why. This
 * is the part that has to hold when the refusal does not: the proxy variables are not
 * `OGUN_`-prefixed, and the list of them is not a list core can know.
 */

const args = (env: Record<string, string>) =>
  buildRunArgs(
    {
      name: 'ogun-test',
      hostWorkspace: '/tmp/ws',
      guestWorkspace: GUEST_WORKSPACE,
      permissions: 'reviewer',
      runtime: 'claude',
      timeoutMs: 1000,
      image: 'ogun/base:latest',
      env,
    } as Parameters<typeof buildRunArgs>[0],
    'ogun/base:latest',
  )

/** Every `--env NAME=…` in order, so "which one wins" is answerable. */
const envValues = (argv: string[], name: string): string[] =>
  argv
    .flatMap((value, index) => (argv[index - 1] === '--env' ? [value] : []))
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1))

test('a project env value reaches the container', () => {
  assert.deepEqual(envValues(args({ MONITOR_PASSWORD: 'generated' }), 'MONITOR_PASSWORD'), [
    'generated',
  ])
})

test('a project cannot displace a variable Ogun sets, because Ogun sets it last', () => {
  const argv = args({ OGUN_PERMISSIONS: 'modifier' })
  const seen = envValues(argv, 'OGUN_PERMISSIONS')
  assert.equal(seen.at(-1), 'reviewer', 'the last --env wins, and it is Ogun\'s')
  assert.equal(seen.includes('modifier'), true, 'the project\'s is present but overridden')
})

test('the project block is emitted before anything Ogun adds', () => {
  const argv = args({ A_PROJECT_VALUE: '1' })
  const project = argv.indexOf('A_PROJECT_VALUE=1')
  const ogun = argv.findIndex((value) => value.startsWith('OGUN_PERMISSIONS='))
  assert.ok(project > 0 && ogun > 0)
  assert.ok(project < ogun, 'project env must precede Ogun\'s own')
})

test('no env means no stray --env beyond what Ogun sets for itself', () => {
  const argv = args({})
  const names = argv.flatMap((value, index) =>
    argv[index - 1] === '--env' ? [value.split('=')[0]] : [],
  )
  assert.deepEqual(names, ['OGUN_PERMISSIONS'])
})
