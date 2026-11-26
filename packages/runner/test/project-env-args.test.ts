import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildRunArgs, GUEST_WORKSPACE } from '../src/sandbox/container.ts'
import { imageFor, runsInProjectImage } from '../src/pipeline.ts'

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

/**
 * The services signal is sent only to take them away.
 *
 * `.ogun/project-entrypoint.sh` reads it as `${OGUN_PROJECT_SERVICES:-1}`, so unset and
 * `1` mean the same thing — and a project image written before this existed, which checks
 * nothing, keeps starting its stack either way. Sending `1` would put a variable on every
 * container to say "as usual", and would make an absent one look like a decision.
 */
const withServices = (services?: boolean): string[] =>
  buildRunArgs(
    {
      name: 'ogun-test',
      hostWorkspace: '/tmp/ws',
      guestWorkspace: GUEST_WORKSPACE,
      permissions: 'reviewer',
      runtime: 'claude',
      timeoutMs: 1000,
      image: 'ogun/base:latest',
      ...(services === undefined ? {} : { services }),
    } as Parameters<typeof buildRunArgs>[0],
    'ogun/base:latest',
  )

test('a worker that needs no services says so, and one that does says nothing', () => {
  assert.deepEqual(
    envValues(withServices(false), 'OGUN_PROJECT_SERVICES'),
    ['0'],
    'the only value ever sent is the one that withholds',
  )
  assert.deepEqual(envValues(withServices(true), 'OGUN_PROJECT_SERVICES'), [])
  assert.deepEqual(
    envValues(withServices(undefined), 'OGUN_PROJECT_SERVICES'),
    [],
    'absent means yes, so an older runner and an older image both keep working',
  )
})

/**
 * Which jobs get the project's services, and why it is not a setting.
 *
 * It was one: `services: true | false` on the worker, defaulting to true, refused on a
 * modifier. That check was the tell — the field had exactly one legal value per
 * permission profile, which is a derivation wearing a knob's clothes.
 *
 * The rule is already written down in `imageFor`: a modifier that is not bootstrapping
 * runs in the project's image, and everything else runs in `ogun/base`. The project's
 * image is where the project's stack lives, and the job that needs that stack is the job
 * that runs `tests.command` — which `verify.ts` makes mandatory for a modifier and gives
 * to nobody else.
 *
 * So one predicate answers both, and a job cannot be handed the project's image with its
 * database switched off.
 */
test('the project image and the project services are one decision', () => {
  const job = (over: { permissions?: string; bootstrap?: string }) =>
    ({ permissions: 'reviewer', projectSlug: 'acme', ...over }) as Parameters<typeof imageFor>[0]

  // A modifier runs the suite, in the project's image, with the stack up.
  assert.equal(runsInProjectImage(job({ permissions: 'modifier' })), true)
  assert.match(imageFor(job({ permissions: 'modifier' })), /acme/)

  // A reviewer reads a diff in ogun/base. There is no stack in there to start.
  for (const permissions of ['reviewer', 'observer']) {
    assert.equal(runsInProjectImage(job({ permissions })), false, permissions)
    assert.ok(!imageFor(job({ permissions })).includes('acme'), permissions)
  }

  /**
   * And the one that would be easy to get wrong in either direction: a worker whose job
   * is to *create* the project image has none to run in yet, so its suite runs inside the
   * image its own patch proposes. The outer container is `ogun/base`.
   */
  const bootstrapping = job({ permissions: 'modifier', bootstrap: 'project-image' })
  assert.equal(runsInProjectImage(bootstrapping), false)
  assert.ok(!imageFor(bootstrapping).includes('acme'))
})
