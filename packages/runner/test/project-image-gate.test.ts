import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import { type ImageBuild, type ImageBuilder } from '../src/bootstrap.ts'
import type { PatchFacts } from '../src/patch.ts'
import type { Sandbox } from '../src/sandbox/index.ts'

/**
 * The gate that replaces the tests lens for a `bootstrap: project-image` worker (§4.10,
 * ADR-0016): build the `.ogun/Dockerfile` the patch proposes, then run the
 * `tests.command` the patch proposes inside the image it just built.
 *
 * The property most of these protect is not "does the gate work" but **"is the exemption
 * still narrow"**. `bootstrap:` lets a modifier run against a project with no image and no
 * test command, and the only thing standing between that and a general way to publish
 * unverified code is that this gate refuses any patch which is not a containerisation. A
 * change that loosened it would look, from every other angle in the codebase, entirely
 * reasonable.
 */

type Recorded = { command?: string; image?: string }

/**
 * A container sandbox whose `readFile` returns the config the patch proposes and whose
 * `exec` records what it was asked to run in which image.
 *
 * The image is recorded because the whole claim this gate makes is "the suite passed
 * *inside the image this patch builds*". Running it in the sandbox's own image would be a
 * pass that proves nothing, and it is the kind of mistake that leaves no trace anywhere
 * else.
 */
const sandboxWith = (input: {
  config: string | null
  code?: number
  recorded?: Recorded
  kind?: 'container' | 'worktree'
}): Sandbox =>
  ({
    kind: input.kind ?? 'container',
    provision: async () => {},
    exec: (argv: string[], opts?: { image?: string }) => {
      if (input.recorded) {
        input.recorded.command = argv.at(-1) as string
        input.recorded.image = opts?.image as string
      }
      return {
        lines: (async function* () {
          yield 'suite output'
        })(),
        done: Promise.resolve({ code: input.code ?? 0, stderr: '', timedOut: false }),
      }
    },
    readFile: async () => input.config,
    dispose: async () => {},
  }) as unknown as Sandbox

const builderWith = (over: Partial<ImageBuild> = {}, declares = true): ImageBuilder & {
  removed: string[]
  builtTags: string[]
} => {
  const removed: string[] = []
  const builtTags: string[] = []
  return {
    removed,
    builtTags,
    build: async ({ tag }) => {
      builtTags.push(tag)
      return { ok: true, timedOut: false, durationMs: 4000, output: '', ...over }
    },
    declares: async () => declares,
    remove: async (tag) => void removed.push(tag),
  }
}

const CONFIG = 'tests:\n  command: pnpm -s test\n'

const facts = (over: Partial<PatchFacts> = {}): PatchFacts => ({
  messages: ['Add a project image for this repository'],
  paths: ['.ogun/Dockerfile', '.ogun/config.yaml'],
  sweptUp: false,
  ...over,
})

const gate = async (input: {
  patch?: PatchFacts
  sandbox?: Sandbox
  builder?: ImageBuilder
  previous?: { image: boolean; testCommand?: string }
  deadline?: number
}) =>
  runVerifyGate({
    config: undefined,
    permissions: 'modifier',
    output: undefined,
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox: input.sandbox ?? sandboxWith({ config: CONFIG }),
    ...(input.patch ? { patch: input.patch } : {}),
    deadline: input.deadline ?? Date.now() + 30 * 60_000,
    bootstrap: {
      workspace: '/tmp/workspace',
      tag: 'ogun/project-thing:candidate-abc123',
      builder: input.builder ?? builderWith(),
      previous: input.previous ?? { image: false },
    },
  })

const named = (gates: Awaited<ReturnType<typeof gate>>['gates'], name: string) =>
  gates.find((g) => g.name === name)

/**
 * The lens is swapped, not added. A bootstrap worker has no project image, so the ordinary
 * tests lens has nothing to run in — running both would mean a mandatory lens that always
 * fails, which is a gate nobody can pass.
 *
 * The two patch lenses stay, and `self-gating` in particular: a containerisation patch
 * edits `.ogun/config.yaml` on every single run, because writing the `tests:` block is half
 * of what it is for. That is the case that lens was built for — the one legitimate patch
 * that changes its own gates — and it must announce it every time rather than being
 * suppressed for the worker that trips it most.
 */
test('a bootstrap run is graded by project-image instead of tests, and still by self-gating', async () => {
  const { gates } = await gate({ patch: facts() })
  assert.equal(named(gates, 'tests'), undefined, 'the tests lens has no image to run in')
  assert.equal(named(gates, 'project-image')?.passed, true)
  assert.equal(named(gates, 'commit-message')?.passed, true)

  const selfGating = named(gates, 'self-gating')
  assert.equal(selfGating?.passed, true, 'it warns, it never refuses')
  assert.match(
    selfGating?.detail ?? '',
    /\.ogun\/config\.yaml/,
    'the ledger has to say so on every one of these runs',
  )
})

/**
 * The claim this gate makes is about the image the patch proposes, so the suite has to run
 * in that image and in no other. A suite run in the sandbox's own `ogun/base` would pass or
 * fail for reasons that have nothing to do with the patch, and nothing downstream would be
 * able to tell.
 */
test('the proposed suite runs in the image the patch proposes', async () => {
  const recorded: Recorded = {}
  await gate({ patch: facts(), sandbox: sandboxWith({ config: CONFIG, recorded }) })
  assert.equal(recorded.command, 'pnpm -s test')
  assert.equal(recorded.image, 'ogun/project-thing:candidate-abc123')
})

/**
 * The narrowness property, and the one worth breaking a build over.
 *
 * `bootstrap:` exempts a worker from needing an image and a test command. If that exemption
 * also let a patch carry application code, it would be a general way to publish code no
 * suite has been run over — because the only suite available here is the one this same
 * patch wrote, in an image this same patch built. So anything outside `.ogun/` refuses,
 * naming the file.
 */
test('a patch that touches anything outside .ogun/ is refused, naming the file', async () => {
  const { gates } = await gate({
    patch: facts({ paths: ['.ogun/Dockerfile', '.ogun/config.yaml', 'src/server.ts'] }),
  })
  const lens = named(gates, 'project-image')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /src\/server\.ts/)
})

/**
 * A `.dockerignore` at the root is the one exception, and it exists because a build context
 * is the whole repository: a monorepo with `node_modules` in it sends a gigabyte to the
 * daemon before the first instruction, out of the same budget the job wrote the patch in.
 */
test('a root .dockerignore is allowed, because the build context is the repository', async () => {
  const { gates } = await gate({
    patch: facts({ paths: ['.ogun/Dockerfile', '.ogun/config.yaml', '.dockerignore'] }),
  })
  assert.equal(named(gates, 'project-image')?.passed, true)
})

/** The one file this worker exists to write. Without it there is nothing to build. */
test('a patch with no Dockerfile in it is refused', async () => {
  const { gates, image } = await gate({ patch: facts({ paths: ['.ogun/config.yaml'] }) })
  assert.equal(named(gates, 'project-image')?.passed, false)
  assert.equal(image?.ran, false, 'nothing was built, so nothing was measured')
})

/**
 * The image and the command that runs in it are one piece of work. An image with no command
 * leaves the next modifier refused for the second half of the same reason this run was
 * admitted for the first — which is the circle this whole mechanism exists to break, closed
 * again one file later.
 */
test('a patch that declares no tests.command is refused', async () => {
  const { gates } = await gate({
    patch: facts(),
    sandbox: sandboxWith({ config: 'project:\n  name: thing\n' }),
  })
  const lens = named(gates, 'project-image')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /tests\.command/)
})

/**
 * The worst artefact this path can produce: a project registered with a gate that passes
 * forever, so every future modifier's patch is "proved" by a command that proves nothing.
 *
 * The check catches the accident rather than an adversary — an agent that could not get a
 * suite green and wrote something that exits zero — and it is deliberately anchored, so a
 * real command that happens to begin with a no-op is not caught by it.
 */
test('a tests.command that cannot fail is refused by name', async () => {
  for (const command of ['true', ':', 'exit 0', 'echo ok']) {
    const { gates } = await gate({
      patch: facts(),
      sandbox: sandboxWith({ config: `tests:\n  command: "${command}"\n` }),
    })
    assert.equal(named(gates, 'project-image')?.passed, false, `${command} must be refused`)
  }
  const { gates } = await gate({
    patch: facts(),
    sandbox: sandboxWith({ config: 'tests:\n  command: true && pnpm -s test\n' }),
  })
  assert.equal(named(gates, 'project-image')?.passed, true, 'a real command must not be caught')
})

/**
 * An image that builds and is not `FROM ogun/base` is wrong in the quietest possible way:
 * its suite can pass, and what it silently lacks is the entrypoint that seeds credentials
 * and strips the git remote, the bundled `ogun` CLI, and the egress forwarder — so every
 * later job in it is a total airgap that reports itself as an authentication failure.
 *
 * Asked as the same question the runner already asks before it will enforce an allowlist,
 * and asked *before* the suite runs, so the failure lands on the agent that can still fix
 * it rather than on somebody else's run weeks later.
 */
test('an image that does not inherit ogun/base is refused before its suite runs', async () => {
  const recorded: Recorded = {}
  const { gates } = await gate({
    patch: facts(),
    sandbox: sandboxWith({ config: CONFIG, recorded }),
    builder: builderWith({}, false),
  })
  const lens = named(gates, 'project-image')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /FROM ogun\/base/)
  assert.equal(recorded.command, undefined, 'no suite should have been attempted')
})

/**
 * `tests` is filled by this lens as well as by the ordinary one, on purpose: the publisher
 * refuses anything whose `changes.tests_passed` is not true, and the `changes` row is what
 * a person reads a fortnight later. A containerisation patch whose suite passed inside its
 * own image has met that bar in the strongest sense available, and it should not have to
 * announce it through a channel nothing downstream knows to consult.
 */
test('a green run reports the suite through the same field the publisher already reads', async () => {
  const { tests, image } = await gate({ patch: facts() })
  assert.equal(tests?.ran, true)
  assert.equal(tests?.passed, true)
  assert.equal(image?.built, true)
  assert.equal(image?.durationMs, 4000, 'the build is measured, because the retry holds it back')
  assert.equal(image?.command, 'pnpm -s test')
})

/** A red suite inside a built image is the ordinary rejection: measured, and retryable. */
test('a suite that fails inside the built image fails the gate and stays measured', async () => {
  const { gates, tests, image } = await gate({
    patch: facts(),
    sandbox: sandboxWith({ config: CONFIG, code: 1 }),
  })
  assert.equal(named(gates, 'project-image')?.passed, false)
  assert.equal(tests?.ran, true)
  assert.equal(tests?.passed, false)
  assert.equal(image?.built, true)
})

/**
 * A build that failed is the most valuable rejection this gate produces, because it is the
 * only sight of a build log the agent will ever get — it has no docker socket and is not in
 * the image it is describing. So the log goes into the detail, and the build's duration is
 * kept, which is what lets `retryDecision` grant the round.
 */
test('a failed build keeps its output and its measurement', async () => {
  const { gates, image } = await gate({
    patch: facts(),
    builder: builderWith({ ok: false, output: ':\nE: Unable to locate package postgresqll' }),
  })
  const lens = named(gates, 'project-image')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /Unable to locate package/)
  assert.equal(image?.ran, true)
  assert.equal(image?.built, false)
  assert.equal(image?.durationMs, 4000)
})

/**
 * A build killed at the deadline measured how much time was *left*, not how long a build
 * takes — so it reports no duration, and the retry loop refuses rather than granting a
 * round out of a number that is really the budget quoted back at itself.
 */
test('a build killed at the deadline reports no measurement', async () => {
  const { gates, image } = await gate({
    patch: facts(),
    builder: builderWith({ ok: false, timedOut: true, durationMs: undefined }),
  })
  assert.equal(named(gates, 'project-image')?.passed, false)
  assert.equal(image?.durationMs, undefined)
})

/**
 * Declining is a legitimate and expected result for this worker: a repository whose suite
 * needs a credential, or a service nothing can put in an image, should be reported rather
 * than half-containerised. So a run that changed nothing passes — and says which it was,
 * because "there was nothing to build" and "the image built and the suite passed" are the
 * two most different facts this gate can hold and must not wear the same value.
 */
test('a run that produced no patch passes, and says so', async () => {
  const { gates, image } = await gate({})
  const lens = named(gates, 'project-image')
  assert.equal(lens?.passed, true)
  assert.match(lens?.detail ?? '', /no patch/)
  assert.equal(image?.ran, false)
})

/**
 * A lens that cannot run fails, on `reviewCheck`'s rule: the alternative is publishing an
 * unverified image from the worker whose entire product is the verification. A worktree
 * sandbox has no image to run a suite in, and a suite run on the host under the claim
 * "inside the image this patch proposes" would be the most misleading pass this system
 * could record.
 */
test('a bootstrap worker outside a container is refused rather than skipped', async () => {
  const { gates } = await gate({
    patch: facts(),
    sandbox: sandboxWith({ config: CONFIG, kind: 'worktree' }),
  })
  assert.equal(named(gates, 'project-image')?.passed, false)
})

/**
 * The candidate image is removed whatever happened, and it is never tagged as the project's
 * real image. Tagging it would install an image built from an unmerged branch as the one
 * every future modifier is verified in — a change to the machine made by a run whose patch
 * a person may then reject. Building it is the operator's step after the merge, and the
 * pull request says so.
 */
test('the candidate image is tagged for this run and removed afterwards', async () => {
  const builder = builderWith()
  await gate({ patch: facts(), builder })
  assert.deepEqual(builder.builtTags, ['ogun/project-thing:candidate-abc123'])
  assert.deepEqual(builder.removed, ['ogun/project-thing:candidate-abc123'])
  assert.equal(
    builder.builtTags[0]?.endsWith(':latest'),
    false,
    'an unreviewed image must never take the tag jobs actually run',
  )

  const failing = builderWith({ ok: false })
  await gate({ patch: facts(), builder: failing })
  assert.deepEqual(failing.removed, ['ogun/project-thing:candidate-abc123'])
})

/**
 * A first image and a replacement are the same judgement and different facts. The diff
 * shows a Dockerfile being rewritten and says nothing about what depended on the old one,
 * so the run says which it was — this is what makes the answer to "should the exemption
 * expire" ("it expires by construction; the second run is an upgrade") legible in the
 * ledger rather than only in an ADR.
 */
test('the gate says whether this is a project first image or a replacement', async () => {
  const first = await gate({ patch: facts(), previous: { image: false } })
  assert.match(named(first.gates, 'project-image')?.detail ?? '', /first image/)

  const again = await gate({ patch: facts(), previous: { image: true } })
  assert.match(named(again.gates, 'project-image')?.detail ?? '', /replaced/)
})

/**
 * The step nothing else would ever tell the operator. §4.6 builds images at project-add
 * time and never during a run, so a merged Dockerfile with no `ogun image build` behind it
 * leaves the next modifier failing on an image docker cannot find — an error about a thing
 * nobody built, arriving days later on somebody who never saw this run.
 */
test('a passing gate says the image still has to be built after the merge', async () => {
  const { gates } = await gate({ patch: facts() })
  assert.match(named(gates, 'project-image')?.detail ?? '', /ogun image build/)
})

/**
 * An upgrade can change the test command quietly, and must not. The diff shows it — and
 * the diff also shows a rewritten Dockerfile, so the line that decides how every future
 * patch in this repository is judged is easy to read past. It goes in the sentence, and
 * only when it moved, because a note that fires every time is one nobody reads.
 */
test('a replacement that also changes the test command says which command it replaced', async () => {
  const changed = await gate({
    patch: facts(),
    previous: { image: true, testCommand: 'npm test' },
  })
  assert.match(named(changed.gates, 'project-image')?.detail ?? '', /was `npm test`/)

  const same = await gate({
    patch: facts(),
    previous: { image: true, testCommand: 'pnpm -s test' },
  })
  assert.doesNotMatch(named(same.gates, 'project-image')?.detail ?? '', /tests\.command, which was/)
})
