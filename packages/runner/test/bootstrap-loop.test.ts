import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { ClaimedJob, RunReport } from '@ogun/core'
import { executeJob, imageFor, type RunnerContext } from '../src/pipeline.ts'
import type { ControlPlane } from '../src/client.ts'
import type { ImageBuilder } from '../src/bootstrap.ts'
import type { ExecOptions, Sandbox } from '../src/sandbox/index.ts'

/**
 * A containerisation run as the runner actually runs it (ADR-0016).
 *
 * `project-image-gate.test.ts` covers the gate's own decisions. This covers the wiring
 * around it, which is where the whole slice can be broken invisibly: `job.bootstrap` has
 * to reach three separate places — `imageFor`, the pre-flight that refuses a modifier
 * whose pinned commit declares no `tests.command`, and the spread that swaps the lens in.
 * Miss any one and the run fails for a reason that sounds like a configuration problem
 * with the project rather than a bug here.
 *
 * The fixture is the shape this worker exists for and no other test in the tree has: a
 * repository with **no `.ogun/Dockerfile` and no `tests.command`**. Every other modifier
 * test starts from a project that is already ready.
 */

const run = promisify(execFile)
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args])

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-bootstrap-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.ogun'), { recursive: true })
  await mkdir(join(repo, '.claude', 'skills', 'containerise-a-project'), { recursive: true })
  await writeFile(join(repo, 'app.ts'), 'export const answer = 42\n')
  // No `tests:` block and no Dockerfile. This is the state that refuses every other
  // modifier, and the state this worker is dispatched into.
  await writeFile(
    join(repo, '.ogun', 'config.yaml'),
    'project:\n  name: thing\n  defaultBranch: main\n',
  )
  await writeFile(
    join(repo, '.claude', 'skills', 'containerise-a-project', 'SKILL.md'),
    '# containerise\n',
  )
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['add', '-A'])
  await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Base'])
  return { root, repo, scratch: join(root, 'scratch') }
}

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob =>
  ({
    jobId: 'job-1',
    runId: '11111111-2222-3333-4444-555555555555',
    projectSlug: 'thing',
    projectDefaultBranch: 'main',
    workerName: 'containerise',
    prompt: 'Use the containerise-a-project skill.',
    runtime: 'claude',
    model: 'worker',
    permissions: 'modifier',
    sandbox: 'container',
    timeoutMs: 30 * 60_000,
    skillRef: 'containerise-a-project',
    bootstrap: 'project-image',
    attempt: 0,
    ...over,
  }) as ClaimedJob

type Recorded = { argv: string[]; opts?: ExecOptions }

/** What the agent writes: the two files, committed, exactly as the skill asks for. */
const writesTheImage = (command: string) => async (ws: string) => {
  await writeFile(join(ws, '.ogun', 'Dockerfile'), 'FROM ogun/base:latest\n')
  await writeFile(
    join(ws, '.ogun', 'config.yaml'),
    `project:\n  name: thing\n  defaultBranch: main\ntests:\n  command: ${command}\n`,
  )
  await git(ws, ['add', '-A'])
  await git(ws, [
    '-c',
    'user.name=a',
    '-c',
    'user.email=a@t',
    'commit',
    '-qm',
    'Give this repository an image its suite can run in',
  ])
}

const scriptedSandbox = (
  workspace: string,
  input: { write?: (ws: string) => Promise<void>; suiteExit?: number },
) => {
  const calls: Recorded[] = []
  const sandbox: Sandbox = {
    kind: 'container',
    provision: async () => {},
    exec: (argv: string[], opts?: ExecOptions) => {
      calls.push({ argv, ...(opts ? { opts } : {}) })
      if (opts?.raw === true) {
        return {
          lines: (async function* () {
            yield 'not ok 1 - the suite'
          })(),
          done: Promise.resolve({ code: input.suiteExit ?? 0, stderr: '', timedOut: false }),
        }
      }
      return {
        lines: (async function* () {
          if (input.write) await input.write(workspace)
          yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })
          yield JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
        })(),
        done: Promise.resolve({ code: 0, stderr: '', timedOut: false }),
      }
    },
    readFile: async (rel: string) => readFile(join(workspace, rel), 'utf8').catch(() => null),
    dispose: async () => {},
  }
  return { sandbox, calls }
}

const fakeBuilder = (over: { ok?: boolean; declares?: boolean } = {}) => {
  const built: string[] = []
  const builder: ImageBuilder = {
    build: async ({ tag, context, dockerfile }) => {
      built.push(`${tag} ${dockerfile.startsWith(context) ? 'in-workspace' : 'elsewhere'}`)
      return { ok: over.ok ?? true, timedOut: false, durationMs: 1000, output: '' }
    },
    declares: async () => over.declares ?? true,
    remove: async () => {},
  }
  return { builder, built }
}

const controlPlane = () => {
  const reports: RunReport[] = []
  const cp = {
    inputs: async () => null,
    history: async () => null,
    started: async () => {},
    events: async () => {},
    // `changes-requested`, so `publishIfReady` refuses on the outcome before it can reach
    // `gh`. What is asserted here is the report, not the publication.
    report: async (r: RunReport) => {
      reports.push(r)
      return { outcome: 'changes-requested' }
    },
    published: async () => {},
  } as unknown as ControlPlane
  return { cp, reports }
}

const drive = async (
  turn: { write?: (ws: string) => Promise<void>; suiteExit?: number },
  builderOpts: { ok?: boolean; declares?: boolean } = {},
  over: Partial<ClaimedJob> = {},
) => {
  const { repo, scratch } = await fixture()
  const { cp, reports } = controlPlane()
  const { builder, built } = fakeBuilder(builderOpts)
  let calls: Recorded[] = []
  const config: RunnerContext = {
    projects: { thing: repo },
    scratch,
    sandboxes: (input) => {
      const made = scriptedSandbox(input.hostWorkspace, turn)
      calls = made.calls
      return made.sandbox
    },
    imageBuilder: () => builder,
  }
  const outcome = await executeJob(cp, config, job(over))
  return { outcome, report: reports.at(-1)!, calls: () => calls, built }
}

/**
 * The whole slice, in the state that refuses every other modifier: no Dockerfile, no test
 * command, and a run that succeeds anyway because the gate it is held to is the one that
 * builds what the patch proposes.
 *
 * The pre-flight refusal is the specific thing being protected here. `executeJob` refuses
 * a modifier whose pinned `.ogun/config.yaml` declares no `tests.command`, *before the
 * agent starts* — which is correct for every other modifier and would make this worker
 * impossible. A regression there is not subtle at run time and is completely invisible in
 * review: the run is refused with a sentence about the project's configuration that is
 * perfectly true and entirely beside the point.
 */
test('a containerise run succeeds against a project with neither of the two files', async () => {
  const { report, built } = await drive({ write: writesTheImage('pnpm -s test') })

  assert.equal(report.outcome, 'dispatched')
  assert.deepEqual(report.gates.filter((g) => !g.passed), [])
  assert.equal(report.change?.testsPassed, true, 'the publisher reads this field and no other')
  assert.deepEqual(built, ['ogun/project-thing:candidate-11111111-222 in-workspace'])
})

/**
 * The lens is swapped, not skipped, and the run's own record has to show it. A bootstrap
 * job that quietly fell through to the ordinary tests lens would be refused for having no
 * `tests.command` — the very condition it was admitted under — so the presence of
 * `project-image` in the gate array is the one bit that distinguishes "wired" from
 * "wired and then lost in a spread".
 */
test('the run is graded by project-image, and self-gating still announces the config edit', async () => {
  const { report } = await drive({ write: writesTheImage('pnpm -s test') })
  const names = report.gates.map((g) => g.name)
  assert.ok(names.includes('project-image'), `graded by ${names.join(', ')}`)
  assert.equal(names.includes('tests'), false)

  const selfGating = report.gates.find((g) => g.name === 'self-gating')
  assert.equal(selfGating?.passed, true)
  assert.match(
    selfGating?.detail ?? '',
    /\.ogun\/config\.yaml/,
    'the one legitimate patch that changes its own gates has to say so, every time',
  )
})

/**
 * The agent runs in `ogun/base` — there is no project image, which is the condition it was
 * dispatched to fix — and the *suite* runs in the image the gate just built. Two different
 * images in one job, and getting either wrong is a run that proves the wrong thing.
 */
test('the agent runs in the base image and the suite runs in the candidate', async () => {
  const { calls } = await drive({ write: writesTheImage('pnpm -s test') })
  assert.equal(
    imageFor({ permissions: 'modifier', projectSlug: 'thing', bootstrap: 'project-image' }),
    'ogun/base:latest',
  )
  const suite = calls().find((c) => c.opts?.raw === true)
  assert.equal(suite?.opts?.image, 'ogun/project-thing:candidate-11111111-222')
  assert.deepEqual(suite?.argv, ['sh', '-c', 'pnpm -s test'])
})

/**
 * Declining is a result, and for this worker a common one: a repository whose suite needs
 * a credential should be reported rather than half-containerised. A run that changed
 * nothing is `approved` and builds nothing — there is no Dockerfile to build, and a gate
 * that failed on the absence would make declining impossible.
 */
test('a run that wrote nothing is approved, and nothing is built', async () => {
  const { report, built } = await drive({})
  assert.equal(report.outcome, 'approved')
  assert.deepEqual(built, [])
  assert.deepEqual(report.gates.filter((g) => !g.passed), [])
})

/**
 * And the narrowness property, end to end rather than at the lens: a patch carrying
 * application code is refused, whatever else it does. This is what makes the exemption
 * safe to have at all — spelled on the wrong worker it buys no ability to publish
 * unverified code, because the gate it swaps in refuses everything that is not a
 * containerisation.
 */
test('a containerisation patch that also changes code is refused', async () => {
  const { report } = await drive({
    write: async (ws) => {
      await writesTheImage('pnpm -s test')(ws)
      await writeFile(join(ws, 'app.ts'), 'export const answer = 0\n')
      await git(ws, ['add', '-A'])
      await git(ws, ['-c', 'user.name=a', '-c', 'user.email=a@t', 'commit', '-qm', 'And this'])
    },
  })
  /**
   * The runner still *proposes* `dispatched` — it produced a patch — and the control plane
   * derives that down to `changes-requested` on any failed gate (`finalizeRun`). So the
   * gate array is what is asserted: that is the artefact the derivation reads, and asserting
   * the outcome here would be asserting the mock's answer rather than this run's.
   */
  const lens = report.gates.find((g) => g.name === 'project-image')
  assert.equal(lens?.passed, false)
  assert.match(lens?.detail ?? '', /app\.ts/)
})
