import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  PROJECT_CONFIG_PATH,
  PROJECT_DOCKERFILE_PATH,
  readTestCommand,
  type GateResult,
} from '@ogun/core'
import { outputOf, pushTail } from './gate-detail.ts'
import type { PatchFacts } from './patch.ts'
import type { Sandbox } from './sandbox/index.ts'
import { spawnJsonl } from './sandbox/exec.ts'

/**
 * The alternate gate: build the `.ogun/Dockerfile` a patch proposes, then run the
 * `tests.command` that patch proposes **inside the image it just built** (§4.10,
 * ADR-0016).
 *
 * ### Why there is a second gate at all
 *
 * The ordinary modifier gate runs the project's own suite in the project's own image, and
 * that is the right gate for every patch except one: the patch that *creates* the image.
 * There is no toolchain to run a suite in yet, which is precisely why the project has no
 * image, which is why admission refuses the modifier that would write one. This is the
 * only door out of that circle, and it is not a hole in the wall — it is a stronger gate
 * than the one it replaces, because it proves the image and the suite *together*. The
 * ordinary gate assumes the image works; this one is the only thing in Ogun that ever
 * checks.
 *
 * ### Why it is host-side
 *
 * `docker build` is, for the same reason `git push` is (ADR-0005): the socket is never
 * mounted into a sandbox, because anything holding it can start a privileged container
 * mounting `/`. So this runs in the runner process after the container has exited, on the
 * pattern `publish.ts` established — and, like the publisher, it takes its one dangerous
 * capability as a parameter (`ImageBuilder`) so that every decision above it can be
 * exercised without a daemon.
 *
 * ### The exposure this adds, stated plainly
 *
 * A `docker build` runs commands an agent wrote, on the runner's own daemon, with the
 * network the daemon has. The sandbox is `--network none` and this is not, and it cannot
 * be: an image that installs a toolchain has to reach a package index. So a project image
 * Dockerfile can `RUN curl … | sh` during a build, with the workspace as its build
 * context.
 *
 * What bounds it: the build is an unprivileged container like any other, it runs *after*
 * the patch has been extracted so nothing it writes can reach the artefact, its context
 * is a repository the agent already had in full, and the `only .ogun/` rule below means
 * the reviewer's diff is two or three files — one of which is the Dockerfile — rather
 * than a change buried in a hundred. What does not bound it is anything technical, and it
 * would be dishonest to imply otherwise: the real defence is the same as everywhere else
 * in this system, which is that nothing merges and a person reads the draft.
 */

/**
 * The only directory a containerisation patch may touch, and the one exception to it.
 *
 * This is what makes the exemption safe rather than merely narrow. `bootstrap:
 * project-image` swaps which gate a patch is held to, and the obvious abuse is to declare
 * it on a worker that writes application code — so the swapped-in gate refuses *any*
 * patch that is not a containerisation. A run that edits `src/` under this worker fails,
 * naming the file. There is no path here that publishes code no suite has been run over.
 *
 * `.dockerignore` is the exception and it is a grudging one. A build context is the whole
 * repository, and a monorepo with `node_modules` in it sends a gigabyte to the daemon
 * before the first `RUN` — which turns a two-minute build into a twenty-minute one, out of
 * a budget the job also has to write a patch in. Against that: it is a file at the root
 * that every *other* docker build in that repository also reads, so this worker changing
 * it is a change to somebody else's build. Allowed, because the alternative is a gate that
 * routinely times out; and safe enough because a two-file diff is one a person actually
 * reads.
 */
const ALLOWED_PREFIX = '.ogun/'
const ALLOWED_EXACT = new Set(['.dockerignore'])

/**
 * A `tests.command` that cannot fail, refused by name.
 *
 * The failure this catches is not an adversary — an agent that wanted to cheat has a
 * hundred spellings and this list would be theatre against it. It is the *accident*: an
 * agent that could not get a suite green, or could not work out how to run one, and wrote
 * something that exits zero so that its run would finish. That produces the single worst
 * artefact this whole path can emit — a project registered with Ogun whose test gate
 * passes forever, so every future modifier's patch is "proved" by a command that proves
 * nothing.
 *
 * The real defences are the two beside it: the gate reports how long the command took, on
 * the timeline and in the pull request, which is how a person notices a suite that
 * "passed in 0s"; and the `self-gating` lens announces that this patch edits the file
 * where the command lives, so nobody reviews it without being told to look.
 *
 * Anchored and whole-string, so `true && pnpm test` — a real command that starts with a
 * no-op — is not caught by it.
 */
const NO_OP_COMMAND = /^(?:\/(?:usr\/)?bin\/)?(?:true|:|exit\s+0|echo\b.*)$/

/**
 * What a build produced, as the gate needs to talk about it.
 *
 * `ok` and `timedOut` are separate because the reasons a build did not finish are not
 * interchangeable — one is a Dockerfile another round can fix, the other is a budget no
 * round can get back — and `durationMs` is absent for the second on the same rule the
 * suite follows: a build killed at the deadline measured how much time was left, not how
 * long a build takes, and handing that number to the retry loop would be quoting the
 * budget back at itself.
 */
export type ImageBuild = {
  ok: boolean
  timedOut: boolean
  durationMs?: number
  /** The tail of what docker said, already trimmed for a `runs.detail` column. */
  output: string
}

/**
 * The one dangerous capability this gate holds, as an interface with one implementation —
 * the shape `publishPatch` takes its `PublishRemote` in, and for the same reason. Every
 * decision in `runProjectImageLens` is about what a patch is allowed to be, and a
 * decision that can only be exercised by starting a docker daemon is a decision nothing
 * exercises.
 */
export type ImageBuilder = {
  build(input: {
    /** The build context, which is the workspace root: a project Dockerfile `COPY`s from it. */
    context: string
    dockerfile: string
    tag: string
    timeoutMs: number
  }): Promise<ImageBuild>
  /** Whether the built image carries an `ENV` marker — see `inheritsBase` below. */
  declares(tag: string, key: string): Promise<boolean>
  /** Best-effort. A tag left behind costs disk; a throw here would fail a passing gate. */
  remove(tag: string): Promise<void>
}

export const dockerBuilder = (): ImageBuilder => ({
  build: async ({ context, dockerfile, tag, timeoutMs }) => {
    const startedAt = Date.now()
    /**
     * `--network` is deliberately not passed, so the build gets the daemon's default.
     * `none` would be the posture this system takes everywhere else and it is wrong here:
     * an image whose whole purpose is to carry a project's toolchain has to install one,
     * and a build that cannot reach a package index fails on every honest Dockerfile ever
     * written. The exposure that leaves is stated at the top of this file rather than
     * hidden behind a flag that looks like it handles it.
     */
    const { lines, done } = spawnJsonl(
      'docker',
      ['build', '--tag', tag, '--file', dockerfile, context],
      { timeoutMs },
    )
    const tail: string[] = []
    // Drained, not discarded: a full pipe blocks the child, and buildkit is chatty.
    for await (const line of lines) pushTail(tail, line)
    const { code, stderr, timedOut } = await done.catch((err: Error) => ({
      code: 1,
      stderr: err.message,
      timedOut: false,
    }))
    return {
      ok: code === 0,
      timedOut,
      // Absent when it did not finish, for the reason `ImageBuild` gives.
      ...(timedOut ? {} : { durationMs: Date.now() - startedAt }),
      output: outputOf(tail, stderr),
    }
  },
  declares: async (tag, key) => {
    const { lines, done } = spawnJsonl(
      'docker',
      ['image', 'inspect', tag, '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      { timeoutMs: 15_000 },
    )
    let found = false
    for await (const line of lines) if (line.trim().startsWith(`${key}=`)) found = true
    const { code } = await done.catch(() => ({ code: 1 }))
    return code === 0 && found
  },
  remove: async (tag) => {
    await new Promise<void>((resolve) => {
      const child = spawn('docker', ['image', 'rm', '-f', tag], { stdio: 'ignore' })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
  },
})

/**
 * What the gate learned, in the two shapes the rest of the pipeline already reads.
 *
 * `tests` is the *same* field the ordinary gate fills, on purpose: the publisher refuses
 * anything whose `changes.tests_passed` is not true, and the `changes` row is what a
 * person reads a fortnight later. A containerisation patch whose suite passed inside its
 * own image has met that bar in the strongest sense available, so it reports it through
 * the same channel rather than through a second one nothing downstream would know to
 * consult.
 *
 * `image` is new, and it is what the retry loop needs. The reserve `retryDecision` holds
 * back is a *measurement of what the gate just cost*, never a constant, and for a
 * bootstrap run half of that cost is the build.
 */
export type ProjectImageOutcome = {
  gate: GateResult
  tests?: { ran: boolean; passed: boolean; durationMs?: number }
  image: { ran: boolean; built: boolean; durationMs?: number; command?: string }
}

export type ProjectImageInput = {
  /** The agent's sandbox, whose `exec` runs the suite in the candidate image. */
  sandbox: Sandbox
  /** Host path to the workspace: the build context, and where the proposed config is read. */
  workspace: string
  /** What the candidate image is tagged. Never `projectImage(slug)` — see `candidateImage`. */
  tag: string
  builder: ImageBuilder
  /** Absent for a run that changed nothing, which is an ordinary and passing outcome. */
  patch?: PatchFacts
  /**
   * What the pinned base already had, so the gate can say whether this is a project's
   * first image or a replacement for one — the difference between a bootstrap and an
   * upgrade, which is a fact about the run and not a difference in how it is judged.
   */
  previous: { image: boolean; testCommand?: string }
  /** `startedAt + timeoutMs`, the job's one clock. See `testsCheck` for why there is one. */
  deadline: number
}

const lens = (passed: boolean, detail: string): GateResult => ({
  name: PROJECT_IMAGE_LENS,
  method: 'tool',
  passed,
  detail,
})

/** The lens that replaces `tests` for a `bootstrap: project-image` worker. */
export const PROJECT_IMAGE_LENS = 'project-image'

export async function runProjectImageLens(
  input: ProjectImageInput,
): Promise<ProjectImageOutcome> {
  /** Nothing built, nothing measured — the shape every refusal before the build wears. */
  const unbuilt = { ran: false, built: false }

  /**
   * A run that changed nothing passes, and says which it was.
   *
   * Declining is a legitimate result for this worker and a common one: a repository whose
   * suite needs a credential, or a service nobody can put in an image, is a repository
   * that should be reported rather than half-containerised. Reporting `passed: true` with
   * no detail would leave "there was nothing to build" wearing the same value as "the
   * image built and the suite passed" (principle 6), and those are the two most different
   * facts this gate can hold.
   */
  if (!input.patch) {
    return {
      gate: lens(true, 'this run produced no patch, so there was no Dockerfile to build'),
      image: unbuilt,
    }
  }

  /**
   * A lens that cannot run fails, on `reviewCheck`'s rule and for the same reason: the
   * honest alternatives are to skip — which publishes an unverified image from a worker
   * whose whole product is the verification — or to refuse.
   */
  if (input.sandbox.kind !== 'container') {
    return {
      gate: lens(
        false,
        'this gate runs the proposed suite inside the image it just built, and a ' +
          `\`${input.sandbox.kind}\` sandbox has no image to run it in. A bootstrap worker ` +
          'needs `sandbox: container`',
      ),
      image: unbuilt,
    }
  }

  const stray = input.patch.paths.filter(
    (p) => !p.startsWith(ALLOWED_PREFIX) && !ALLOWED_EXACT.has(p),
  )
  if (stray.length > 0) {
    return {
      gate: lens(
        false,
        `this worker may only write the files that make a project runnable, and this patch ` +
          `changes ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? `, and ${stray.length - 5} more` : ''}. ` +
          'Nothing here can prove a change to that code: the gate builds the proposed ' +
          'image and runs the proposed suite in it, which is a suite this same patch ' +
          `wrote. Keep the patch to ${ALLOWED_PREFIX} (and .dockerignore) and file ` +
          'anything else you noticed as a finding',
      ),
      image: unbuilt,
    }
  }

  if (!input.patch.paths.includes(PROJECT_DOCKERFILE_PATH)) {
    return {
      gate: lens(
        false,
        `this patch contains no ${PROJECT_DOCKERFILE_PATH}, which is the one file this worker ` +
          'exists to write. Without it there is nothing to build, and nothing to run this ' +
          "project's suite in",
      ),
      image: unbuilt,
    }
  }

  /**
   * Read from the *workspace*, which is the exact reverse of every other gate in this
   * system, and the reversal is the whole point rather than an oversight.
   *
   * `tests.command` is normally read from the blob at the pinned base, because a modifier
   * can write to its checkout and a gate the agent sets for itself is not a gate. Here
   * there is no command at the pinned base to read — writing one is the job — so the gate
   * has to read the agent's own proposal. What makes that safe is that the proposal is not
   * taken on trust: it is *executed*, inside an image this patch also proposed, and a
   * command that does not exit zero fails the run. The agent is not grading itself; it is
   * being made to demonstrate.
   *
   * What that leaves is the command that passes for the wrong reason, and `NO_OP_COMMAND`
   * plus the measured duration on the timeline are the two answers to it.
   */
  const proposed = await input.sandbox.readFile(PROJECT_CONFIG_PATH).catch(() => null)
  const command = proposed === null ? undefined : readTestCommand(proposed)
  if (!command) {
    return {
      gate: lens(
        false,
        `this patch declares no tests.command in ${PROJECT_CONFIG_PATH}, so an image built from ` +
          'it would have nothing to prove. A project image and the command that runs in it ' +
          'are one piece of work: without both, the next modifier is refused for the ' +
          'second half of the same reason this run was admitted for the first',
      ),
      image: unbuilt,
    }
  }
  if (NO_OP_COMMAND.test(command.trim())) {
    return {
      gate: lens(
        false,
        `\`${command}\` cannot fail, so declaring it as tests.command would give this ` +
          'project a test gate that passes forever — every future modifier\'s patch ' +
          '"proved" by a command that proves nothing. If this project\'s suite cannot be ' +
          'made to run in an image, that is a run to decline and report, not a command to ' +
          'write',
      ),
      image: unbuilt,
    }
  }

  const buildBudgetMs = input.deadline - Date.now()
  if (buildBudgetMs <= 0) {
    return {
      gate: lens(
        false,
        "the job's timeout was already spent when the gate began, so the proposed image " +
          'was never built — the patch is unproved rather than broken',
      ),
      image: unbuilt,
    }
  }

  const built = await input.builder.build({
    context: input.workspace,
    dockerfile: join(input.workspace, PROJECT_DOCKERFILE_PATH),
    tag: input.tag,
    timeoutMs: buildBudgetMs,
  })
  /** Everything from here on has an image on this machine that has to be removed. */
  try {
    const buildSeconds = built.durationMs === undefined ? undefined : Math.round(built.durationMs / 1000)
    if (built.timedOut) {
      return {
        gate: lens(
          false,
          `\`docker build\` was still running after ${Math.round(buildBudgetMs / 1000)}s, ` +
            "which is all that remained of the job's timeout, and was killed. An image that " +
            'does not finish building cannot be proved, and nothing here measured how long ' +
            'it would take, so there is no second attempt either — give this worker a ' +
            'longer `timeoutMs`, or move the slow layers earlier in the Dockerfile so a ' +
            'rebuild reuses them' +
            built.output,
        ),
        image: { ran: true, built: false },
      }
    }
    if (!built.ok) {
      return {
        gate: lens(
          false,
          `\`docker build\` failed after ${buildSeconds}s${built.output}`,
        ),
        image: { ran: true, built: false, ...(built.durationMs ? { durationMs: built.durationMs } : {}) },
      }
    }

    /**
     * Does the image actually inherit `ogun/base`?
     *
     * Asked as "does it carry the marker the base sets", which is the same question the
     * runner already asks before it will enforce an allowlist against an image — so an
     * image that fails here is one every future modifier job would refuse to start in.
     * Catching it now means the failure lands on the agent that can fix it, in a round it
     * still has, rather than at 3am on somebody else's run.
     *
     * It also catches the wrong-in-a-quiet-way case. A `FROM node:24` image can build and
     * its suite can pass, and what it silently lacks is the entrypoint that seeds
     * credentials and strips the git remote, the `ogun` CLI the skills shell out to, the
     * egress forwarder, and the uid-1000 `dev` user the workspace mount assumes. None of
     * those failures look like "your Dockerfile is wrong" when they arrive.
     */
    if (!(await input.builder.declares(input.tag, 'OGUN_EGRESS_FORWARDER'))) {
      return {
        gate: lens(
          false,
          'the image built, and it is not `FROM ogun/base` — it carries none of the ' +
            'markers the base sets. A project image that does not inherit the base has no ' +
            'entrypoint to seed credentials or strip the git remote, no bundled `ogun` ' +
            'CLI, no egress forwarder (so every job in it would be a silent airgap), and ' +
            'no uid-1000 `dev` user for the workspace mount. Start the Dockerfile with ' +
            '`FROM ogun/base:latest`. If it already does, the base on this machine is ' +
            'older than the forwarder and needs `ogun image build` first',
        ),
        image: { ran: true, built: true, ...(built.durationMs ? { durationMs: built.durationMs } : {}) },
      }
    }

    const image = {
      ran: true,
      built: true,
      ...(built.durationMs ? { durationMs: built.durationMs } : {}),
      command,
    }
    const suiteBudgetMs = input.deadline - Date.now()
    if (suiteBudgetMs <= 0) {
      return {
        gate: lens(
          false,
          `the image built in ${buildSeconds}s, which was the rest of the job's timeout, so ` +
            `\`${command}\` never ran in it. The image is unproved rather than broken`,
        ),
        image,
        tests: { ran: false, passed: false },
      }
    }

    /**
     * The suite, inside the image this patch proposes, in the sandbox this project's jobs
     * will actually get: the same read-write workspace mount, the same gateway session and
     * allowlist, the same memory caps — and `--network none`, which is the part that
     * decides whether this proves anything.
     *
     * A suite run on a normal network passes by reaching a postgres on the *host*, and
     * then fails every night from a container that has no route to it. §4.6's rule that a
     * suite needing a service gets it inside the image is only true if something enforces
     * it, and this is the something: the gate's own run is airgapped exactly as the
     * nightly one will be, so "it passed here" and "it will pass there" are the same
     * claim.
     */
    const startedAt = Date.now()
    const handle = input.sandbox.exec(['sh', '-c', command], {
      timeoutMs: suiteBudgetMs,
      raw: true,
      image: input.tag,
    })
    const tail: string[] = []
    for await (const line of handle.lines) pushTail(tail, line)
    const suite = await handle.done.catch((err: Error) => ({
      code: 1,
      stderr: err.message,
      timedOut: false,
    }))
    const suiteMs = Date.now() - startedAt
    const suiteSeconds = Math.round(suiteMs / 1000)

    if (suite.timedOut) {
      return {
        gate: lens(
          false,
          `the image built in ${buildSeconds}s, and \`${command}\` was still running in it ` +
            `after ${suiteSeconds}s, which is all that remained of the job's timeout. A ` +
            'suite that does not finish has not passed' +
            outputOf(tail, suite.stderr),
        ),
        image,
        tests: { ran: true, passed: false },
      }
    }
    if (suite.code !== 0) {
      return {
        gate: lens(
          false,
          `the image built in ${buildSeconds}s, and \`${command}\` exited ` +
            `${suite.code ?? 'on a signal'} inside it after ${suiteSeconds}s` +
            outputOf(tail, suite.stderr),
        ),
        image,
        tests: { ran: true, passed: false, durationMs: suiteMs },
      }
    }

    /**
     * A test command that *changed* is the one thing an upgrade can do quietly and should
     * not. The diff shows it, but the diff also shows a rewritten Dockerfile, and the
     * command is the line that decides how every future patch in this repository is
     * judged — so it goes in the sentence rather than being left for somebody to spot.
     * Only said when it moved: a note that fires every time is one nobody reads.
     */
    const replaced =
      input.previous.testCommand && input.previous.testCommand !== command
        ? ` It also changes tests.command, which was \`${input.previous.testCommand}\`.`
        : ''
    return {
      gate: lens(
        true,
        `${input.previous.image ? 'replaced this project\'s image' : "this project's first image"}: ` +
          `${PROJECT_DOCKERFILE_PATH} built in ${buildSeconds}s and \`${command}\` passed inside ` +
          `it in ${suiteSeconds}s, on \`--network none\` — so the suite needs nothing this ` +
          'sandbox will not have at 3am. The image is not installed on this machine: run ' +
          '`ogun image build <dir>` after the pull request merges.' +
          replaced,
      ),
      image,
      tests: { ran: true, passed: true, durationMs: suiteMs },
    }
  } finally {
    /**
     * The candidate tag goes, whatever happened, and the layers stay.
     *
     * Removing the tag is what stops a rejected patch's image accumulating on the runner —
     * one per refused round, each carrying a whole toolchain. The build *cache* is
     * deliberately left alone: it is what makes a retry's rebuild seconds rather than
     * minutes, which is the difference between a second round that can act on the build
     * log and one that spends its budget re-downloading a package index.
     */
    await input.builder.remove(input.tag).catch(() => undefined)
  }
}
