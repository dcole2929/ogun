import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { ClaimedJob, RunReport } from '@ogun/core'
import { executeJob, type RunnerContext } from '../src/pipeline.ts'
import type { ControlPlane } from '../src/client.ts'
import type { ExecOptions, Sandbox } from '../src/sandbox/index.ts'

/**
 * The retry loop as the runner actually runs it (§5.2, §9 phase 3).
 *
 * `retry.test.ts` covers the decision in isolation, which is the half a pure function can
 * carry. This file covers the half it cannot: that the loop *acts* on the decision — that
 * a rejected patch is re-delivered into the same session with a bounded budget, that a
 * refusal ends the run there, and that what the control plane is told afterwards can tell
 * a first-round pass from a second-round one (principle 6).
 *
 * The seam is `RunnerContext.sandboxes`. Everything else is real: a real clone of a real
 * fixture repository, real `git format-patch` extraction, the real verify gate. Only the
 * agent and the suite are scripted, because the alternative is a model call and a
 * container per assertion.
 */

const run = promisify(execFile)
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args])

/** A repository a modifier could be dispatched against: a suite, a skill, a policy block. */
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ogun-retry-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.ogun'), { recursive: true })
  await mkdir(join(repo, '.claude', 'skills', 'fixer'), { recursive: true })
  await writeFile(join(repo, 'app.ts'), 'export const answer = 41\n')
  await writeFile(
    join(repo, '.ogun', 'config.yaml'),
    'project:\n  name: fix\n  defaultBranch: main\ntests:\n  command: run-the-suite\n',
  )
  await writeFile(join(repo, '.claude', 'skills', 'fixer', 'SKILL.md'), '# fixer\n')
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['add', '-A'])
  await git(repo, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'Base',
  ])
  return { root, repo, scratch: join(root, 'scratch') }
}

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob =>
  ({
    jobId: 'job-1',
    runId: '11111111-2222-3333-4444-555555555555',
    projectSlug: 'fix',
    projectDefaultBranch: 'main',
    workerName: 'fixer',
    prompt: 'Use the fixer skill.',
    runtime: 'claude',
    model: 'worker',
    permissions: 'modifier',
    sandbox: 'container',
    timeoutMs: 30 * 60_000,
    skillRef: 'fixer',
    attempt: 0,
    ...over,
  }) as ClaimedJob

/**
 * One scripted agent turn. `write` runs on the host against the workspace, because that
 * is exactly what the agent does inside the container — the workspace is a bind mount,
 * and extraction reads whatever is there when the process exits.
 */
type Turn = {
  write?: (workspace: string) => Promise<void>
  suiteExit: number
  /**
   * What the review of this round's diff writes as its verdict, for a job that asked for
   * one. `null` scripts a reviewer that produced nothing, which is the fail-closed case;
   * absent means this job declared no review lens and none should be invoked.
   */
  review?: string | null
}

/** The one string that tells the review lens's invocation from the modifier's. */
const REVIEW_MARKER = 'You are reviewing one change'

type Recorded = { argv: string[]; opts?: ExecOptions }

const scriptedSandbox = (turns: Turn[], workspace: string) => {
  const calls: Recorded[] = []
  let turn = 0
  const sandbox: Sandbox = {
    kind: 'container',
    provision: async () => {},
    exec: (argv: string[], opts?: ExecOptions) => {
      calls.push({ argv, ...(opts ? { opts } : {}) })
      const raw = opts?.raw === true
      const current = turns[Math.min(turn, turns.length - 1)]!
      if (raw) {
        // The gate running the project's suite. Advancing here rather than on the agent
        // call keeps a turn meaning "one deliver-and-grade".
        turn += 1
        return {
          lines: (async function* () {
            yield 'not ok 1 - the fix'
          })(),
          done: Promise.resolve({ code: current.suiteExit, stderr: '', timedOut: false }),
        }
      }
      /**
       * The review lens, invoked in the same container as the agent it is judging but as
       * its own session (`review.ts`). It runs after the suite, so `turn` has already
       * advanced past the round being graded — which is also the round number its verdict
       * file is named for.
       */
      if (argv.some((a) => a.includes(REVIEW_MARKER))) {
        const graded = turns[Math.min(turn - 1, turns.length - 1)]!
        return {
          lines: (async function* () {
            if (graded.review != null) {
              await mkdir(join(workspace, '.ogun-out'), { recursive: true })
              await writeFile(join(workspace, '.ogun-out', `review-${turn}.json`), graded.review)
            }
            yield JSON.stringify({ type: 'result', subtype: 'success', result: 'reviewed' })
          })(),
          done: Promise.resolve({ code: 0, stderr: '', timedOut: false }),
        }
      }

      const write = current.write
      return {
        lines: (async function* () {
          if (write) await write(workspace)
          // Real claude JSONL, so the runner's own parser produces the session id the
          // retry resumes into rather than a value this test handed it.
          yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })
          yield JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'done',
            usage: { input_tokens: 10, output_tokens: 5 },
          })
        })(),
        done: Promise.resolve({ code: 0, stderr: '', timedOut: false }),
      }
    },
    /**
     * Read off the real workspace, not stubbed. The findings document is a file the agent
     * writes into the bind mount, and whether it survives the sweep between rounds is a
     * property of `.git/info/exclude` meeting `git clean -fd` — which is precisely the
     * kind of coupling a stub would hide.
     */
    readFile: async (rel: string) => readFile(join(workspace, rel), 'utf8').catch(() => null),
    dispose: async () => {},
  }
  return { sandbox, calls }
}

const controlPlane = () => {
  const reports: RunReport[] = []
  const cp = {
    inputs: async () => null,
    history: async () => null,
    started: async () => {},
    events: async () => {},
    // `changes-requested`, so `publishIfReady` refuses on the outcome before it can reach
    // `gh`. What this test asserts is the report, not the publish.
    report: async (r: RunReport) => {
      reports.push(r)
      return { outcome: 'changes-requested' }
    },
    published: async () => {},
  } as unknown as ControlPlane
  return { cp, reports }
}

const drive = async (turns: Turn[], over: Partial<ClaimedJob> = {}) => {
  const { repo, scratch } = await fixture()
  const { cp, reports } = controlPlane()
  let calls: Recorded[] = []
  const config: RunnerContext = {
    projects: { fix: repo },
    scratch,
    sandboxes: (input) => {
      const made = scriptedSandbox(turns, input.hostWorkspace)
      calls = made.calls
      return made.sandbox
    },
  }
  const outcome = await executeJob(cp, config, job(over))
  return { outcome, report: reports.at(-1)!, calls: () => calls, repo }
}

const commitInWorkspace = (file: string, body: string, message: string) => async (ws: string) => {
  await writeFile(join(ws, file), body)
  await git(ws, ['add', '-A'])
  await git(ws, ['-c', 'user.name=a', '-c', 'user.email=a@t', 'commit', '-qm', message])
}

/**
 * The case the loop exists for: the gate refuses a red patch, the agent is handed the
 * refusal, and the second round's patch passes.
 *
 * The report has to say `rounds: 2` *and* carry only the passing verdict. Both halves
 * matter and they pull against each other — `finalizeRun` reads any failed gate in the
 * array as the gate's answer, so folding round one's rejection into `gates` would derive
 * a run that recovered down to `changes-requested`, and dropping the count entirely would
 * make it indistinguishable from a run that never needed a second go.
 */
test('a gate rejection produces a second round, and the ledger says so', async () => {
  const { report, calls } = await drive([
    { write: commitInWorkspace('app.ts', 'export const answer = 0\n', 'A first try'), suiteExit: 1 },
    { write: commitInWorkspace('app.ts', 'export const answer = 42\n', 'Fix it'), suiteExit: 0 },
  ])

  assert.equal(report.rounds, 2)
  assert.equal(report.outcome, 'dispatched')
  assert.deepEqual(
    report.gates.filter((g) => !g.passed),
    [],
    'the failed round leaked into the final verdict',
  )
  assert.equal(report.change?.testsPassed, true)

  const agentCalls = calls().filter((c) => c.opts?.raw !== true)
  assert.equal(agentCalls.length, 2)
  // §5.2: the provider session carries forward, so the retry continues the conversation
  // rather than re-reading the repository cold out of a budget it is already short of.
  assert.ok(agentCalls[1]!.argv.includes('--resume'))
  assert.ok(agentCalls[1]!.argv.includes('sess-1'))
  /**
   * And it is given a timeout of its own. Without one, `sandbox.exec` applies the
   * sandbox's, which is the *whole* `job.timeoutMs` — a second full helping of a budget
   * the first round already spent part of, leaving the gate after it with nothing.
   */
  assert.equal(typeof agentCalls[1]!.opts?.timeoutMs, 'number')
  assert.ok(agentCalls[1]!.opts!.timeoutMs! < 30 * 60_000)

  // Both rounds' usage, not just the retry's. The retry is the cheap one — the expensive
  // reading happened in round one — so reporting `lastEvent` alone under-charges a
  // subscription somebody is spending (principle 1).
  assert.equal(report.usage?.inputTokens, 20)
})

/** A run that never needed a second go is not the same row as one that did. */
test('a run whose first round passes reports one round', async () => {
  const { report } = await drive([
    { write: commitInWorkspace('app.ts', 'export const answer = 42\n', 'Fix it'), suiteExit: 0 },
  ])
  assert.equal(report.rounds, 1)
  assert.equal(report.outcome, 'dispatched')
})

/**
 * Two red rounds end the run, and the report is the *last* round's — a run that was
 * retried and still refused is not an error and not a success, and `rounds` is the only
 * thing that says it tried twice.
 */
test('a run refused twice reports two rounds and a failed gate', async () => {
  const { report } = await drive([
    { write: commitInWorkspace('app.ts', 'export const answer = 0\n', 'A first try'), suiteExit: 1 },
    { write: commitInWorkspace('app.ts', 'export const answer = 1\n', 'Another'), suiteExit: 1 },
  ])
  assert.equal(report.rounds, 2)
  assert.equal(report.gates.find((g) => g.name === 'tests')?.passed, false)
  // The runner still proposes `dispatched`; the control plane derives it down. That split
  // is the point of ADR-0009's ordering and it must survive the retry loop.
  assert.equal(report.outcome, 'dispatched')
})

/**
 * An unextractable patch produces no retry, and this is the case where a retry would be
 * actively harmful: the workspace it would run in is the one the agent just broke, and
 * `git am` cannot express `base..HEAD` against a base the agent moved away from. It is a
 * fact about the run in exactly the sense `admission.ts` means — no round changes it.
 *
 * `rounds: 1` on an errored run is the other half: the failure happened *during* a round,
 * and a report that said nothing about rounds would read like a run that failed before
 * the agent ever started.
 */
test('an agent that rewrote history is not retried', async () => {
  const { outcome, report, calls } = await drive([
    {
      write: async (ws) => {
        await writeFile(join(ws, 'app.ts'), 'export const answer = 42\n')
        await git(ws, ['add', '-A'])
        await git(ws, [
          '-c',
          'user.name=a',
          '-c',
          'user.email=a@t',
          'commit',
          '-q',
          '--amend',
          '-m',
          'Rewritten base',
        ])
      },
      suiteExit: 1,
    },
    { suiteExit: 0 },
  ])

  assert.equal(outcome, 'error')
  assert.equal(report.rounds, 1)
  assert.match(report.detail ?? '', /not a descendant/)
  // Never graded and never re-delivered: running the suite would spend the rest of the
  // budget on work that cannot leave this machine either way.
  assert.equal(calls().filter((c) => c.opts?.raw === true).length, 0)
  assert.equal(calls().filter((c) => c.opts?.raw !== true).length, 1)
  // The file count survives, because after the workspace is deleted it is the only record
  // of how much work was lost.
  assert.equal(report.change?.filesChanged, 1)
})

/**
 * A patch whose commit message closes an issue is refused and not retried — the only
 * repair is rewriting history, which is the thing above. The suite is never run, which is
 * the point of ordering the cheap lens first.
 */
test('a closing keyword refuses the run without spending the suite', async () => {
  const { report, calls } = await drive([
    {
      write: commitInWorkspace(
        'app.ts',
        'export const answer = 42\n',
        'Fix the answer\n\nCloses #14\n',
      ),
      suiteExit: 0,
    },
    { suiteExit: 0 },
  ])

  assert.equal(report.rounds, 1)
  assert.equal(report.gates.find((g) => g.name === 'commit-message')?.passed, false)
  assert.equal(calls().filter((c) => c.opts?.raw === true).length, 0, 'the suite ran anyway')
  // Null, not false. Nobody said anything about tests, and the publisher's three refusals
  // are three different sentences for exactly that reason.
  assert.equal(report.change?.testsPassed, undefined)
})

/** Retry is a modifier concept (§5.2). A reviewer's gate decides persistence, once. */
test('a reviewer whose gate fails is not retried', async () => {
  const { report, calls } = await drive(
    [{ suiteExit: 1 }, { suiteExit: 0 }],
    { permissions: 'reviewer' },
  )
  assert.equal(report.rounds, 1)
  assert.equal(calls().filter((c) => c.opts?.raw !== true).length, 1)
})

/**
 * Budget exhaustion, from the end that matters: the gate found nothing left of the job's
 * timeout, so the suite never started — and a retry into a budget that is already gone
 * would produce the same refusal a round later, having spent a model call to do it.
 *
 * This is also the refusal the whole loop is built to avoid causing. "The suite never ran"
 * reads like a broken harness rather than a bad patch, which is why `retryDecision` holds
 * back what the suite just cost rather than handing the agent everything that is left.
 */
test('a job with no budget left is refused rather than retried', async () => {
  const { report, calls } = await drive(
    [
      {
        write: commitInWorkspace('app.ts', 'export const answer = 42\n', 'Fix it'),
        suiteExit: 0,
      },
      { suiteExit: 0 },
    ],
    { timeoutMs: 1 },
  )

  assert.equal(report.rounds, 1)
  assert.equal(report.change?.testsRun, false)
  // False and undefined are both refusals downstream and they are different sentences:
  // this one is "nothing proved the patch", not "the patch was disproved".
  assert.equal(report.change?.testsPassed, false)
  assert.equal(calls().filter((c) => c.opts?.raw !== true).length, 1)
})

/**
 * The agent's account of the run survives a retry, and the reason it is not obvious is
 * what makes it worth a test.
 *
 * Between rounds the runner cleans the gate's suite output back out of the workspace —
 * and `.ogun-out/findings.json` is an untracked file sitting in that same tree. What saves
 * it is that the pipeline wrote `/.ogun-out/` into `.git/info/exclude` before the first
 * round, so the clean leaves it alone. Two pieces of the runner meeting at a distance, and
 * the failure would be silent: a modifier that wrote its notes in round one and spent
 * round two on code would be recorded as having said nothing.
 */
test('findings written in the first round survive into the second', async () => {
  const notes = 'I fixed the port check; the lockfile change nearby is deliberately untouched.'
  const { report } = await drive([
    {
      write: async (ws) => {
        await mkdir(join(ws, '.ogun-out'), { recursive: true })
        await writeFile(
          join(ws, '.ogun-out', 'findings.json'),
          JSON.stringify({ findings: [], notes }),
        )
        await commitInWorkspace('app.ts', 'export const answer = 0\n', 'A first try')(ws)
      },
      suiteExit: 1,
    },
    { write: commitInWorkspace('app.ts', 'export const answer = 42\n', 'Fix it'), suiteExit: 0 },
  ])

  assert.equal(report.rounds, 2)
  assert.equal((report.findings as { notes?: string } | undefined)?.notes, notes)
  // And nothing the runner swept between rounds reached the patch, which is the other
  // half of the same mechanism.
  assert.equal(report.change?.filesChanged, 1)
})

/**
 * The review lens inside the loop it feeds (§4.10, §9's phase 4).
 *
 * `review-lens.test.ts` covers the verdict and the decision in isolation. What can only
 * be seen from here is that the two meet: a review that refuses a patch which the suite
 * was perfectly happy with still ends the round, still costs the run its pull request,
 * and still buys the agent a second attempt with the reviewer's words in its prompt.
 */
const REVIEWED = {
  verify: { expectations: [{ name: 'review', method: 'agent' }] },
} satisfies Partial<ClaimedJob>

const rejection = (title: string) =>
  JSON.stringify({
    findings: [
      {
        fingerprint: 'review/app/one-change/scope-creep',
        title,
        body: 'Two unrelated things in one diff; a person cannot merge half of it.',
        severity: 'high',
        citations: [{ path: 'app.ts', line: 1 }],
      },
    ],
  })

/**
 * A green suite is not a publishable patch.
 *
 * This is the whole reason the review is a lens rather than a fourth node: the refusal has
 * to arrive before `publishIfReady`, and it has to arrive somewhere `retryDecision` can
 * read it. Round one's suite passes and the review refuses; round two is delivered the
 * refusal and the review clears it; the run ends `dispatched` carrying only the final
 * verdict, exactly as a recovered test failure does.
 */
test('a review that refuses a green patch costs the round and buys another', async () => {
  const { report, calls } = await drive(
    [
      {
        write: commitInWorkspace(
          'app.ts',
          'export const answer = 42\nexport const tidied = true\n',
          'Fix it and tidy up',
        ),
        suiteExit: 0,
        review: rejection('This patch does two things'),
      },
      {
        // A second commit rather than an amended first one, which is what the retry
        // prompt tells a modifier to do and what keeps the patch extractable.
        write: commitInWorkspace(
          'app.ts',
          'export const answer = 42\n',
          'Undo the tidying and keep the fix',
        ),
        suiteExit: 0,
        review: JSON.stringify({ findings: [], notes: 'one change, proved by a test' }),
      },
    ],
    REVIEWED,
  )

  assert.equal(report.rounds, 2)
  assert.equal(report.outcome, 'dispatched')
  assert.deepEqual(
    report.gates.filter((g) => !g.passed),
    [],
  )

  /**
   * And the second round was told what the reviewer said, verbatim. A retry handed
   * "your patch was refused" and nothing else spends its budget guessing at which of the
   * things it did was the problem.
   */
  const rounds = calls().filter(
    (c) => c.opts?.raw !== true && !c.argv.some((a) => a.includes(REVIEW_MARKER)),
  )
  assert.equal(rounds.length, 2)
  assert.ok(rounds[1]!.argv.some((a) => a.includes('This patch does two things')))
})

/**
 * A patch nobody could review is refused, and it is refused *once*.
 *
 * The reviewer here writes no verdict at all — a crash, a runtime that exited early, a
 * model that answered in prose. Passing would publish an unreviewed patch from a worker
 * that asked to be reviewed. Retrying would spend a round asking a modifier to repair
 * somebody else's silence, so `permanence` ends the run instead, and the report carries a
 * failed gate that keeps `finalizeRun` from deriving anything publishable.
 */
test('a patch nothing could review is refused, with no second attempt', async () => {
  const { report, calls } = await drive(
    [
      {
        write: commitInWorkspace('app.ts', 'export const answer = 42\n', 'Fix it'),
        suiteExit: 0,
        review: null,
      },
    ],
    REVIEWED,
  )

  assert.equal(report.rounds, 1)
  assert.equal(report.gates.find((g) => g.name === 'review')?.passed, false)
  // The suite passed, so the only thing standing between this patch and a pull request is
  // the review — which is the arrangement, stated as an assertion.
  assert.equal(report.change?.testsPassed, true)
  assert.equal(
    calls().filter((c) => c.opts?.raw !== true && !c.argv.some((a) => a.includes(REVIEW_MARKER)))
      .length,
    1,
  )
})
