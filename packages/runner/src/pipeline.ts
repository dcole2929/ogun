import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  baseImage,
  findingsDocumentSchema,
  parseFingerprint,
  projectImage,
  readPolicies,
  readTestCommand,
  verifySchema,
  writeSecretFile,
  type ClaimedJob,
  type GateResult,
  type PinnedPolicies,
  type RunEvent,
  type RunOutcome,
  type RunReport,
} from '@ogun/core'
import type { Gateway } from '@ogun/gateway'
import { ControlPlane, EventFlusher, type FindingsHistory } from './client.ts'
import {
  containedTarget,
  createSandbox,
  GUEST_WORKSPACE,
  readContained,
  type CreateSandboxInput,
  type Sandbox,
} from './sandbox/index.ts'
import { nextSeq, newParserState, resolveModel, resolveRuntime } from './runtimes/index.ts'
import { checkDismissals, gatherEvidence } from './evidence.ts'
import { extractPatch, type PatchExtraction } from './patch.ts'
import { githubCli, publishPatch } from './publish.ts'
import { MAX_MODIFIER_ROUNDS, retryDecision, retryPrompt } from './retry.ts'
import {
  gitIn,
  materializeWorkspace,
  resolveHeadSha,
  stageAll,
  sweepGateArtifacts,
} from './workspace.ts'
import { runVerifyGate, TESTS_LENS, type VerifyOutcome } from './verify.ts'
import {
  defaultSearchPaths,
  ensureSkillAvailable,
  excludeFromGit,
  listAvailableSkills,
} from './skills.ts'

/** Where a reviewer is told to write its findings, workspace-relative. */
export const OUTPUT_PATH = '.ogun-out/findings.json'

/**
 * Where a node reads what its upstream nodes produced. Only written when there are any,
 * so a reviewer never finds an empty file and wonders whether that means "nothing found"
 * or "nothing ran".
 */
export const INPUT_PATH = '.ogun-in/upstream.json'

/**
 * What the inbox already says. Written only when there is history, for the same reason
 * as above — an empty file and no file mean different things.
 */
export const HISTORY_INDEX_PATH = '.ogun-in/history.json'

/**
 * Full bodies, one file per finding, nested by fingerprint.
 *
 * The fingerprint *is* a path — `<area>/<surface>/<invariant>/<technique>` — so the tree
 * mirrors the taxonomy, and `ls .ogun-in/history/security/runner-enrollment/` scopes an
 * entire surface by prefix. That is the property §4.11 gives as the reason for a
 * hierarchical fingerprint rather than a content hash, and nothing had used it yet.
 *
 * Split out from the index deliberately. The index says *what* was found and is meant to
 * be read whole; a body carries the previous reviewer's *argument*, and a reviewer that
 * reads every argument stops constructing its own attacks and starts recognising
 * someone else's. One file per finding is what makes "open only the records that matter"
 * an actual affordance rather than an instruction to skim.
 */
export const HISTORY_DIR = '.ogun-in/history'

/**
 * What every job on this runner shares: where the repos are, somewhere to work, and the
 * one gateway the sandboxes authenticate through.
 *
 * The gateway is per *runner*, not per job, and that is the decision (ADR-0010). It owns
 * a CA private key capable of impersonating every host every Ogun container trusts, and
 * it is the only process that reads the host's real credentials — so a second copy per
 * job would multiply exactly the surface this component exists to shrink, for no
 * isolation gain: what separates one job from another is the session token and the
 * per-session allowlist that `gateway.open()` mints, not which listener answered.
 *
 * Optional only so that a caller with no container sandboxes to run — the tests, and
 * anything driving `executeJob` directly — is not forced to stand one up. A container
 * sandbox that reaches `provision()` without one refuses to run rather than falling back
 * to mounting a credential.
 */
export type RunnerContext = {
  projects: Record<string, string>
  scratch: string
  gateway?: Gateway
  /**
   * How a sandbox is made. A seam, not a knob — the same shape `publishPatch` takes its
   * `PublishRemote` in, and for the same reason: everything above it is decisions, and
   * decisions that can only be exercised by starting a container are decisions nothing
   * exercises.
   *
   * The loop this seam exists for is the retry one. Whether a rejected patch gets a
   * second round, what the round is given as a budget, whether the session is resumed or
   * restarted, and what the ledger says afterwards are all questions answered *between*
   * two agent invocations — so a test that cannot script the invocations cannot reach any
   * of them, and the only alternative is running a real model twice per assertion.
   *
   * Absent means `createSandbox`, which is what every real caller uses.
   */
  sandboxes?: (input: CreateSandboxInput) => Sandbox
}

/**
 * The runner's loop, once per job (§5.2):
 *
 *   prepare   -> materialize workspace, check the image
 *   provision -> sandbox, ONCE per job rather than per round
 *   deliver   -> the agent; on a retry, resumed into the same session
 *   extract   -> a modifier's commits, as a patch, before anything else touches the tree
 *   grade     -> verify gate; a modifier it rejects may go round again (`retry.ts`)
 *   record    -> one report; the control plane writes it in one transaction
 *
 * The deliver/extract/grade three are the loop body. Everything above them happens once
 * per job and everything below them happens once per run, which is why the workspace and
 * the sandbox are outside it and the report is after it.
 */
export async function executeJob(
  cp: ControlPlane,
  config: RunnerContext,
  job: ClaimedJob,
): Promise<RunOutcome> {
  const startedAt = Date.now()
  const flusher = new EventFlusher(cp, job.runId)
  let sandbox: Sandbox | undefined
  let cleanup: (() => Promise<void>) | undefined
  /**
   * How many rounds this run actually took, declared out here so that `fail` can carry
   * it too: "the runtime crashed" and "the runtime crashed on the retry, after a graded
   * round that produced a patch" are different nights, and the second one has a patch on
   * disk to explain.
   *
   * Zero until a round starts, and omitted from the report at zero — a run that failed
   * before the agent ran said nothing about rounds, which is not the same as saying none
   * (principle 6).
   */
  let rounds = 0

  /**
   * `extra` carries what the run had already produced when it failed. A modifier whose
   * patch could not be extracted still changed files, and the record of *what* it
   * touched is the only thing left to look at once the workspace is deleted — dropping
   * it would make the failure unexplainable from the control plane.
   */
  const fail = async (
    detail: string,
    gates: GateResult[] = [],
    extra: Partial<Pick<RunReport, 'artifacts' | 'change'>> = {},
  ): Promise<RunOutcome> => {
    await flusher.flush()
    await cp
      .report({
        runId: job.runId,
        outcome: 'error',
        detail,
        durationMs: Date.now() - startedAt,
        ...(rounds > 0 ? { rounds } : {}),
        gates,
        coverage: { outcome: 'errored', reason: detail },
        artifacts: [],
        ...extra,
      })
      .catch((err) => console.error('[runner] failed to report failure', err))
    return 'error'
  }

  /**
   * The job cannot be run, and nothing went wrong — the two halves that make this a
   * different report from `fail`.
   *
   * `skipped` is what admission's refusals already record, and this is the same refusal
   * arriving late: the control plane admitted a modifier because the project's working
   * copy looked ready, and the commit the workspace actually pinned says otherwise.
   * Filing it as an error would put it in the ledger beside runs that broke, and would
   * latch the failure breaker against a worker that has not failed at anything — three
   * such nights and it stops being dispatched at all, for a project setting nobody has
   * looked at.
   */
  const refuse = async (detail: string): Promise<RunOutcome> => {
    await flusher.flush()
    await cp
      .report({
        runId: job.runId,
        outcome: 'skipped',
        detail,
        durationMs: Date.now() - startedAt,
        gates: [],
        coverage: { outcome: 'refused', reason: detail },
        artifacts: [],
      })
      .catch((err) => console.error('[runner] failed to report refusal', err))
    return 'skipped'
  }

  /**
   * One clock for the whole job, started where the job started.
   *
   * The sandbox's own timeout is applied per exec, so the agent alone may use all of
   * `timeoutMs`; anything the gate runs afterwards would then be a second helping of the
   * same allowance. Deriving a deadline here instead means every step after this point
   * shares one budget, and a job with a 30 minute timeout is over in 30 minutes rather
   * than in 30 plus however long its suite takes.
   */
  const deadline = startedAt + job.timeoutMs

  try {
    /**
     * A local checkout is an optimisation, not a requirement. If this machine has the
     * repo, clone from disk — fast, offline, no credentials. Otherwise clone from the
     * remote, so a freshly joined runner can work on a project it has never seen.
     */
    const localPath = config.projects[job.projectSlug]
    if (localPath && !existsSync(join(localPath, '.git'))) {
      // Explicit because git's own message names no project, and pointing at a directory
      // that contains repositories rather than at one is an easy mistake.
      return await fail(
        `${localPath} is not a git repository — "${job.projectSlug}" in this runner's ` +
          'projects map should point at the repo itself, not a directory containing repos.',
      )
    }
    if (!localPath && !job.remoteUrl) {
      return await fail(
        `no way to obtain "${job.projectSlug}": this runner has no local path for it, and ` +
          'the project has no remote url. Add one, or run `ogun project add` inside a\n' +
          'local checkout on this machine.',
      )
    }

    let baseSha: string | undefined
    if (localPath) {
      try {
        baseSha = await resolveHeadSha(localPath, job.projectDefaultBranch)
      } catch {
        return await fail(
          `${localPath} has no branch "${job.projectDefaultBranch}" — set project.defaultBranch ` +
            'in .ogun/config.yaml to whichever branch this project actually uses.',
        )
      }
    }

    const workspace = await materializeWorkspace({
      ...(localPath ? { sourceRepo: localPath } : {}),
      ...(job.remoteUrl ? { remoteUrl: job.remoteUrl } : {}),
      scratch: config.scratch,
      runId: job.runId,
      ref: baseSha ?? job.projectDefaultBranch,
    })
    cleanup = workspace.cleanup

    // `containedTarget` creates the parent, and refuses if the clone redirected it.
    await containedTarget(workspace.path, OUTPUT_PATH)
    // Harness input and output, not changes the worker made.
    await excludeFromGit(workspace.path, ['/.ogun-out/', '/.ogun-in/'])

    /**
     * The project's own config as of the commit this workspace was pinned to, read once,
     * before the agent starts.
     *
     * Three separate gates come out of this one blob — the sandbox downgrade below, the
     * test command after it, and the publisher's `maxOpenPullRequests` later — and the
     * shared read is not an economy. It is that all three have to agree about *which copy
     * of the file counts*: the blob at `workspace.sha`, never the tree on disk. The tree
     * is one a modifier can write, and each of these settings is a gate on the agent
     * doing the writing. See `pinnedProjectConfig`.
     *
     * Read for every permission profile, not only for `modifier` as it once was. The
     * settings here belong to the project, not to the profile, and a `policies` that is
     * `undefined` for a reviewer only because nobody asked is a value waiting to be
     * misread as "this project's config could not be read".
     */
    const pinned = await pinnedProjectConfig(workspace.path, workspace.sha)
    /**
     * Read here rather than where each policy is used, and in particular the publisher's
     * `maxOpenPullRequests` is read here rather than at publish time. Partly because the
     * publisher runs after the report, by which point this function is on its way into the
     * `finally` that deletes the workspace and the pinned `config.yaml` is unreachable —
     * but that is the accident. The reason is that a gate read after the agent has run is
     * a gate the agent could have edited.
     *
     * `undefined` when the blob is missing or its `policies:` block does not parse — an
     * *absent* block is the defaults, not a failure (see `readPolicies`). Every consumer
     * treats `undefined` as "this project's policy could not be established" and takes
     * the strict side of whatever it was deciding: the publisher withholds the pull
     * request, and the gate immediately below refuses the run.
     *
     * `PinnedPolicies` and not `Policies`: `readPolicies` returns only the half that
     * belongs in a repository. `failureBreakerThreshold` and `maxConcurrentModifiers` are
     * scheduling decisions the control plane has already made and stores on the project
     * row, and the runner answering either of them from a file it fetched would be a
     * second answer to a settled question. The type is what keeps that from happening
     * quietly the next time someone needs a number here.
     */
    const policies: PinnedPolicies | undefined = pinned === undefined ? undefined : readPolicies(pinned)

    /**
     * Whether this job may run in the sandbox its worker asked for — the containment
     * question, asked before the verifiability one below.
     *
     * Both gates read the same file and both can refuse the same run, so the order
     * decides which sentence a person is left with. "This worker may not edit files
     * directly on your host" explains why nothing ran; "declares no tests.command" would
     * send them to inspect a key that is very likely fine.
     *
     * This is also the value `createSandbox` is given further down. It used to be given
     * the literal `false` — see `sandboxDowngrade` for what that cost.
     */
    const downgrade = sandboxDowngrade({
      sandbox: job.sandbox === 'worktree' ? 'worktree' : 'container',
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
      policies,
      baseSha: workspace.sha,
    })
    if (downgrade.refusal) return await refuse(downgrade.refusal)
    /**
     * Immediately, on the runner's own stdout, as well as on the timeline further down.
     *
     * Two surfaces because they answer for two different people at two different moments.
     * The timeline is for whoever reads the run afterwards; this line is for whoever is
     * watching a runner they just started, and it is the one that arrives *before* the
     * agent does anything — which is the only point at which stopping it is cheap.
     */
    if (downgrade.notice) {
      console.warn(`[runner] run=${job.runId} ${job.workerName} — ${downgrade.notice}`)
    }

    /**
     * A modifier has to be able to prove its work, and this is where that becomes
     * knowable: read the project's test command before the agent starts, and refuse the
     * job if the pinned commit does not declare one.
     *
     * Admission asks the same question of the control plane's working copy and refuses
     * there (§4.3), which is where a person finds out. This is the drift case — the file
     * on the control plane's disk is not necessarily the file at `workspace.sha`, and a
     * `tests.command` deleted, moved to a branch, or added but not committed puts the two
     * answers apart. Asked here, the cost is a clone; asked after the run, it is a
     * modifier's whole round spent producing a patch nothing can check.
     */
    const testCommand = pinned === undefined ? undefined : readTestCommand(pinned)
    if (job.permissions === 'modifier' && !testCommand) {
      return await refuse(
        `${PROJECT_CONFIG_PATH} at ${workspace.sha.slice(0, 12)} declares no tests.command, ` +
          'so nothing could show this modifier\'s patch works. A modifier that cannot be ' +
          'verified does not run unattended — add `tests:\n  command: …` to ' +
          `${PROJECT_CONFIG_PATH} and commit it to ${job.projectDefaultBranch}.`,
      )
    }

    // Deliberately not caught: a node that cannot read its input must fail loudly
    // rather than run against an empty one. The outer catch turns it into a failed run.
    const upstream = await cp.inputs(job.jobId)
    if (upstream) {
      await writeSecretFile(
        await containedTarget(workspace.path, INPUT_PATH),
        `${JSON.stringify(upstream, null, 2)}\n`,
      )
    }

    /**
     * Caught, unlike `inputs`. A review with no history may re-report something already
     * known, which is noise; a review that refused to start reports nothing at all, and
     * the ledger would record "errored" for a surface that is in fact still unexamined.
     * Noise is the better failure, so long as it is not silent — hence the note.
     */
    const history = await cp.history(job.jobId).catch(() => null)
    if (history) {
      await writeHistory(workspace.path, history)
    }
    const historyNote = history
      ? `history: ${history.index.length} known finding(s) at ${HISTORY_INDEX_PATH}`
      : 'history: none reachable — this review cannot tell what has already been reported'

    // Make the worker's skill discoverable where *this* runtime looks — the two do not
    // agree on a location, so it depends on which one is about to run (§5.1).
    const spec = resolveRuntime(job.runtime)
    const searchPaths = defaultSearchPaths()
    const skill = await ensureSkillAvailable(
      workspace.path,
      job.skillRef,
      spec.provider,
      searchPaths,
    )
    if (!skill) {
      const available = await listAvailableSkills(workspace.path, searchPaths)
      return await fail(
        `the workspace has no skill named "${job.skillRef}"` +
          (available.length ? ` — it has: ${available.join(', ')}` : ' and no skills at all') +
          '. A skill only reaches a run once it is on the default branch.',
      )
    }

    const model = resolveModel(job.runtime, job.model)
    await cp.started(job.runId, {
      repoSha: workspace.sha,
      runtime: job.runtime,
      ...(model ? { model } : {}),
    })

    sandbox = (config.sandboxes ?? createSandbox)({
      kind: job.sandbox === 'worktree' ? 'worktree' : 'container',
      name: `ogun-${job.runId.slice(0, 12)}`,
      hostWorkspace: workspace.path,
      guestWorkspace: job.sandbox === 'worktree' ? workspace.path : GUEST_WORKSPACE,
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
      runtime: spec.provider,
      timeoutMs: job.timeoutMs,
      image: process.env.OGUN_IMAGE_OVERRIDE ?? imageFor(job),
      // The project's answer, from the blob at the pinned base — not a constant, and not
      // anything the agent about to run in here could have written. `sandboxDowngrade`
      // has already refused the run if this is `false` and the sandbox needed it `true`,
      // so the throw inside `createSandbox` is the backstop rather than the message.
      allowSandboxDowngrade: downgrade.allow,
      // Absent is not "unrestricted" — it resolves to the default allowlist for the
      // runtime, inside the sandbox (§4.6).
      ...(job.egress === undefined ? {} : { egress: job.egress }),
      /**
       * The connected applications this worker declared, and whose connection to use
       * (§4.13). Absent for every worker that did not write `connections:`, which is the
       * default and the point — a reviewer aimed at untrusted repository content must not
       * inherit a credentialed path to the project's issue tracker.
       *
       * `projectSlug` travels with it rather than being derived from the workspace path: a
       * connection is stored per project (ADR-0012), and the slug is the key. Deriving it
       * from a directory name is how a runner with two checkouts hands one project's
       * credential to the other's job.
       */
      ...(job.connections === undefined
        ? {}
        : { connections: job.connections, projectSlug: job.projectSlug }),
      /**
       * One gateway, owned by the runner process, handed to every job (ADR-0010). The
       * sandbox mints its own session from it and revokes it in `dispose()`, so what a
       * container gets is a token and an allowlist of its own rather than a share of
       * something global.
       */
      ...(config.gateway ? { gateway: config.gateway } : {}),
    })
    await sandbox.provision()

    const guestRoot = job.sandbox === 'worktree' ? workspace.path : GUEST_WORKSPACE
    const ctx = {
      prompt: composePrompt(job, guestRoot, skill.path, Boolean(upstream), history?.index.length ?? 0),
      ...(model ? { model } : {}),
      workspace: guestRoot,
      outputFile: `${guestRoot}/.ogun-out/last-message.txt`,
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
    }

    /**
     * §5.2's `for round` shape, unwrapped (§9, phase 3).
     *
     * Only a modifier gets more than one. A reviewer's gate decides whether its findings
     * persist, and re-delivering a rejected findings document is a different feature with
     * a different failure mode — §5.2 has said "retry is a modifier concept" since it was
     * written. What bounds a modifier's rounds is `retryDecision`, not this number: the
     * cap is the backstop for a project whose suite is too cheap for the budget to bite.
     */
    const maxRounds = job.permissions === 'modifier' ? MAX_MODIFIER_ROUNDS : 1
    const parser = newParserState()
    let lastEvent: RunEvent | undefined
    /**
     * Why the runtime said it failed, as opposed to whatever it happened to leave on
     * stderr. Both runtimes report a structured reason and then exit non-zero, and the
     * stderr tail is frequently the more misleading of the two: codex prints
     * "Reading additional input from stdin…" on every invocation, so a run killed by a
     * 400 from the model API surfaced that line instead — pointing at §4.7's stdin
     * gotcha, which is fixed, rather than at the model name, which was wrong.
     */
    let reportedFailure: string | undefined

    /**
     * The runner's own voice on the timeline. There are now enough of these — extraction,
     * the suite, each lens with something to say, and the retry decision either way —
     * that spelling out the event envelope at every call site was the larger half of what
     * this function had become.
     */
    const note = (text: string, fields: Record<string, unknown> = {}): void => {
      flusher.push([
        {
          type: 'runner.note',
          ts: new Date().toISOString(),
          seq: nextSeq(parser),
          payload: { note: text, ...fields },
        },
      ])
    }

    /**
     * Recorded on every run, not only when something was copied. Which skill a run
     * actually got is the single most useful thing for explaining its behaviour later —
     * `project` means the repo's own, `builtin` means Ogun's, and the difference changes
     * what the agent read. Emitted here, before the agent starts, so the timeline shows
     * it in the order it happened.
     */
    flusher.push([
      {
        type: 'runner.note',
        ts: new Date().toISOString(),
        seq: nextSeq(parser),
        payload: {
          note: `skill ${skill.name} (${skill.origin}) at ${skill.path}`,
          skill: skill.name,
          origin: skill.origin,
          path: skill.path,
          injected: skill.injected,
        },
      },
      /**
       * Recorded whether or not history arrived. A review that ran without it is not
       * wrong, but it is a review that could not check what it already knows — and
       * "reported again because it could not tell" must be distinguishable later from
       * "reported again on purpose".
       */
      {
        type: 'runner.note',
        ts: new Date().toISOString(),
        seq: nextSeq(parser),
        payload: {
          note: historyNote,
          knownFindings: history?.index.length ?? 0,
          historyAvailable: Boolean(history),
        },
      },
      /**
       * What this run gave up, when it gave anything up — see `sandboxDowngrade`.
       *
       * On the timeline rather than only in the runner's log because the log belongs to
       * whoever was watching at the time, and the question "was this agent contained"
       * gets asked weeks later by somebody reading the run. `uncontained: true` rides
       * along as a field so it can be found without matching on prose.
       *
       * Emitted here, before the agent's first turn, so the record of what it could reach
       * precedes everything it did rather than trailing it.
       */
      ...(downgrade.notice
        ? [
            {
              type: 'runner.note' as const,
              ts: new Date().toISOString(),
              seq: nextSeq(parser),
              payload: { note: downgrade.notice, uncontained: true, sandbox: 'worktree' },
            },
          ]
        : []),
      /**
       * A `worktree` sandbox has no network namespace, so a worker that declared
       * `egress:` does not get it — the same silent-drop family as `requires:`, and the
       * one place it can still be said. The refusal above does not cover it: a *reviewer*
       * on a worktree needs no policy and reaches this line with its allowlist quietly
       * gone.
       */
      /**
       * The same silent-drop family as `egress:` above, one step louder.
       *
       * A `worktree` worker declaring `connections:` is refused by `workerSchema` and by
       * `createSandbox`, so this note is for the case a *container* worker's grant did not
       * produce a credential — which `connectionReader` warns about on the runner's log and
       * which the run timeline is the only place a reader will find weeks later. Recorded
       * as a positive fact when it *was* granted, so "this agent could call Linear" is
       * answerable from the run rather than from whatever the config says today.
       */
      ...(job.connections && job.sandbox !== 'worktree'
        ? [
            {
              type: 'runner.note' as const,
              ts: new Date().toISOString(),
              seq: nextSeq(parser),
              payload: {
                note:
                  `this worker was granted the connections [${job.connections.join(', ')}] — ` +
                  'the sandbox may call them through the gateway, which splices this ' +
                  "project's credential in on the host. The container holds a placeholder.",
                connections: job.connections,
              },
            },
          ]
        : []),
      ...(job.sandbox === 'worktree' && job.egress !== undefined
        ? [
            {
              type: 'runner.note' as const,
              ts: new Date().toISOString(),
              seq: nextSeq(parser),
              payload: {
                note:
                  "this worker declares `egress:`, and the worktree sandbox cannot apply it — " +
                  "there is no network namespace to confine. The agent reaches whatever this " +
                  'machine reaches. Use `sandbox: container` for the allowlist to mean anything.',
                egressApplied: false,
              },
            },
          ]
        : []),
    ])

    let output: unknown
    let change: PatchExtraction | undefined
    let verdict: VerifyOutcome | undefined
    let usage: RunReport['usage']
    /** Set at the end of a round when there is to be another, and consumed by it. */
    let pending: { prompt: string; budgetMs: number } | undefined

    for (let round = 1; round <= maxRounds; round++) {
      rounds = round
      // Per round, not per run. A retry that exits non-zero without reporting a reason of
      // its own would otherwise be explained by the previous round's, which is a wrong
      // answer that reads like a right one.
      reportedFailure = undefined
      const roundCtx = pending ? { ...ctx, prompt: pending.prompt } : ctx
      /**
       * Resumed, not restarted (§5.2). The provider session carries the twenty minutes
       * this agent already spent reading the repository, and a retry that re-reads it
       * cold pays for that twice out of a budget it is already short of.
       *
       * The fallback is a fresh `start` with the original prompt *and* the feedback
       * concatenated, for a runtime that never reported a session id. It is worse — the
       * agent has to rediscover its own work from `git log` — and it is much better than
       * refusing the round, because the workspace still holds everything it did.
       */
      const argv =
        pending && parser.sessionId
          ? spec.resume(roundCtx, parser.sessionId)
          : spec.start(pending ? { ...ctx, prompt: `${ctx.prompt}\n\n${pending.prompt}` } : ctx)
      /**
       * A retry round is given an explicit timeout, and that is the whole of what keeps
       * the gate's share of the budget. `sandbox.exec` otherwise applies the sandbox's
       * own timeout, which is the *entire* `job.timeoutMs` — so a second round would be a
       * second full helping of a budget the first round already spent part of, and the
       * gate after it would find nothing left.
       */
      const handle = sandbox.exec(argv, pending ? { timeoutMs: pending.budgetMs } : undefined)
      for await (const line of handle.lines) {
        const events = spec.parseLine(line, parser)
        if (events.length === 0) continue
        lastEvent = events.at(-1)
        for (const e of events) {
          if (e.type === 'run.failed') reportedFailure = failureMessage(e.payload) ?? reportedFailure
        }
        flusher.push(events)
      }
      const { code, stderr } = await handle.done
      await flusher.flush()
      if (code !== 0) {
        const why = reportedFailure
          ? `${job.runtime} exited ${code}: ${reportedFailure}`
          : `${job.runtime} exited ${code}: ${stderr.slice(-1500)}`
        /**
         * The first round crashing is a failed run — nothing has been graded and there is
         * nothing to report but the crash. A *retry* crashing must not be, and the
         * difference is the point: the previous round's patch is already on disk and its
         * verdict is already in hand, and failing here would throw both away to report a
         * resume that did not start. So the loop ends and the run is reported as the last
         * round that finished, which is the state the patch file on disk actually
         * describes.
         */
        if (round === 1) return await fail(why)
        note(`the retry round did not complete: ${why}. Reporting round ${round - 1}.`, {
          round,
          retryFailed: true,
        })
        rounds = round - 1
        break
      }
      if (parser.sessionId) await cp.started(job.runId, { sessionId: parser.sessionId })
      /**
       * Accumulated across rounds rather than read off the last one.
       *
       * Each round ends with its own `result` event carrying that round's usage, so a
       * report built from `lastEvent` alone would charge a two-round run at the price of
       * its retry — and the retry is the cheap one, because the expensive reading
       * happened in round one. Under-reporting cost is the wrong direction to be wrong in
       * on a system whose entire premise is a subscription somebody is spending
       * (principle 1).
       */
      usage = addUsage(usage, usageFrom(lastEvent))

      // The agent may have created files; stage them or the grounding check will call a
      // real new file a hallucination (§5.3).
      await stageAll(workspace.path).catch(() => undefined)

      let raw: string | null
      try {
        raw = await sandbox.readFile(OUTPUT_PATH)
      } catch (err) {
        // A symlinked or oversized output is an attempt to make the host read something
        // it should not. That ends the run; it is not a gate failure to be graded.
        return await fail(err instanceof Error ? err.message : String(err))
      }
      output = raw === null ? undefined : safeJsonParse(raw)

      /**
       * The crossing (ADR-0005). A modifier's work exists only as commits in a clone this
       * function deletes in its `finally`, and the container had no remote to put it
       * anywhere else — so if it is not extracted here it is gone, and the run reads as an
       * agent that did nothing.
       *
       * **Before the gate, which is the reverse of where this sat.** The gate now runs the
       * project's suite in the same workspace, and a suite writes: `node_modules/.cache`,
       * `coverage/`, `.pytest_cache`, a compiled `dist/` — verified by running one against
       * a modifier's read-write mount, which left `node_modules/.cache/suite-artifact` in
       * the tree. Extraction begins with `git add -A`, so anything the suite dropped and
       * the repo does not ignore would be committed under "work the agent left
       * uncommitted" and published in the pull request. The patch has to be the agent's
       * work, so it is taken before anything else touches the tree.
       *
       * Nothing is lost by the swap: extraction commits what the agent left but does not
       * change a file in the worktree, so the suite still runs against exactly the tree the
       * agent produced. A patch written for a run the gate then rejects is not waste
       * either — the run records the patch and refuses to call it ready, and the person
       * reading the failure wants to see the diff that failed.
       *
       * **Once per round, to the same file, on purpose.** The workspace is never reset
       * between rounds (§5.2), so `base..HEAD` grows: round two's mbox contains round
       * one's commits and then some. It supersedes rather than competes, which is why
       * there is one `changes.patch` per run rather than one per round, and why a retry
       * that crashes before extracting leaves the previous round's artefact intact and
       * correct.
       *
       * The patch is written under `scratch/patches`, outside the workspace, because the
       * workspace is deleted in this function's `finally`. Nothing prunes that directory
       * yet — the same gap transcripts already have, and the natural place to close it is
       * the publisher, which is the step that knows a patch has been consumed.
       */
      if (job.permissions === 'modifier') {
        change = await extractPatch({
          workspace: workspace.path,
          baseSha: workspace.sha,
          destDir: join(config.scratch, 'patches', job.runId),
        })
        note(describeExtraction(change), {
          round,
          filesChanged: change.filesChanged,
          commits: change.commits,
          ...(change.patch ? { patchRef: change.patch.ref, bytes: change.patch.bytes } : {}),
        })
        if (change.unextractable) {
          /**
           * Loud, and with the file count kept: a modifier whose work cannot be published
           * is a broken factory, not a quiet night. Running the suite first would spend
           * the rest of the budget grading work that cannot leave this machine either way.
           *
           * No retry, on the same grounds `admission.ts` puts a project's missing test
           * command ahead of the failure breaker. An agent that rewrote history or
           * committed a build directory has produced a fact about this run, not a
           * question — and the second half of that fact is that the workspace it would
           * retry *in* is the one it just broke.
           */
          return await fail(change.unextractable, [], { change: changeRecord(change) })
        }
      }

      verdict = await runVerifyGate({
        config: job.verify ? verifySchema.parse(job.verify) : undefined,
        permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
        output,
        knownPaths: await trackedPaths(workspace.path),
        lineCountOf: (path) => countLines(workspace.path, path),
        sandbox,
        ...(testCommand ? { testCommand } : {}),
        ...(change?.facts ? { patch: change.facts } : {}),
        deadline,
        round,
        /**
         * What an agent lens needs to be an agent (§4.10). Handed in rather than
         * resolved inside the gate, because the runtime and the sandbox are the two
         * things `runVerifyGate` is deliberately given rather than allowed to build —
         * and a test that drives the gate without them gets a lens that *refuses* rather
         * than one that quietly passes. See `reviewCheck`.
         *
         * The `reviewer` role, not `job.model`. A patch graded by the model that wrote
         * it is the cheap half of a second opinion and the wrong half: §4.7 puts the
         * strong model on judgment for exactly this reason, and the whole reason a
         * modifier can afford it is that this runs once at the end rather than for the
         * length of the round.
         */
        agentLens: {
          spec,
          ...(resolveModel(job.runtime, 'reviewer')
            ? { model: resolveModel(job.runtime, 'reviewer') as string }
            : {}),
          guestRoot,
          baseSha: workspace.sha,
        },
        /**
         * An agent lens's own turns, on the run's timeline, tagged with the lens that
         * produced them.
         *
         * Sequenced from *this* run's parser rather than the lens's own, so the review
         * interleaves with the round it judged in the order it happened; the lens keeps a
         * separate parser state internally so that its `sessionId` never overwrites the
         * one a retry resumes into (see `runReviewLens`). Without the tag, a reader of
         * the timeline would find a second agent talking about the diff in the first
         * person and no way to tell it from the one that wrote it.
         */
        onLensEvent: (events) => {
          flusher.push(
            events.map((e) => ({
              ...e,
              seq: nextSeq(parser),
              payload: { ...e.payload, lens: 'review' },
            })),
          )
        },
      })
      if (verdict.tests) {
        note(describeTests(verdict), {
          round,
          testsRun: verdict.tests.ran,
          testsPassed: verdict.tests.passed,
        })
      }
      /**
       * Every other lens that had something to say, on the timeline, whether it passed or
       * failed. Gate results are not persisted as rows — a failure reaches the ledger
       * folded into `runs.detail`, and a *pass* with a detail reaches it nowhere at all.
       * That is fine for `schema` and `grounded`, which have nothing to say when they
       * pass, and not fine for the modifier lenses: "this patch edits the file that
       * decides how it is judged" is a passing verdict whose whole value is that a person
       * reads it before they read the diff.
       */
      for (const gate of verdict.gates) {
        if (gate.name === TESTS_LENS || !gate.detail) continue
        note(`${gate.name}: ${gate.detail}`, { round, gate: gate.name, passed: gate.passed })
      }

      if (job.permissions !== 'modifier') break
      if (!verdict.gates.some((g) => !g.passed)) break

      const decision = retryDecision({
        round,
        maxRounds,
        permissions: 'modifier',
        gates: verdict.gates,
        tests: verdict.tests,
        ...(verdict.review ? { review: verdict.review } : {}),
        remainingMs: deadline - Date.now(),
      })
      // Said whichever way it went. "This patch was refused and nobody tried again" is
      // the sentence a person needs, and it is the one an unrecorded decision loses.
      note(decision.reason, { round, retrying: decision.retry })
      if (!decision.retry) break

      /**
       * The gate just ran the project's suite in this workspace, and a suite writes into
       * the tree it is run against. Anything it left would be committed by the next
       * round's extraction as the agent's own work, so it goes before the agent is let
       * back in — and a suite that modified *tracked* content ends the loop instead,
       * because the alternative is running the agent's own `.gitattributes` filters on
       * the host to put them back (see `sweepGateArtifacts`).
       */
      const swept = await sweepGateArtifacts(workspace.path)
      if (swept.dirty.length > 0) {
        note(
          `no second attempt after all: running \`${testCommand}\` modified tracked files ` +
            `(${swept.dirty.slice(0, 5).join(', ')}), so a retry could not tell this ` +
            "project's suite output from the agent's work",
          { round, dirty: swept.dirty.length },
        )
        break
      }
      if (swept.removed.length > 0) {
        note(`removed ${swept.removed.length} file(s) the suite left in the tree`, {
          round,
          removed: swept.removed.slice(0, 20),
        })
      }

      pending = {
        prompt: retryPrompt({
          round: round + 1,
          maxRounds,
          gates: verdict.gates,
          agentBudgetMs: decision.agentBudgetMs,
          reserveMs: decision.reserveMs,
          guestRoot,
          outputPath: OUTPUT_PATH,
        }),
        budgetMs: decision.agentBudgetMs,
      }
    }

    /**
     * Unreachable while `maxRounds >= 1` and every early exit above returns rather than
     * breaks — kept because the alternative to an impossible branch here is a reachable
     * one where the report is assembled from a verdict nobody produced.
     */
    if (!verdict) return await fail('the run finished without the verify gate ever running')

    const transcriptRef = await writeTranscript(config, job, workspace.path)

    /**
     * Re-adjudication's host-side half (§4.11), computed here and not by the agent.
     *
     * `evidence` is the cited code as the runner reads it off this tree; it becomes a
     * dismissal's anchor the day somebody dismisses the finding. `dismissalChecks` says
     * whether each dismissal already standing is still about code that exists here, which
     * is what stops a dismissal being permanent by accident.
     *
     * Both run after the gate rather than before, so a run whose output failed the schema
     * check does not spend file reads on findings the control plane is about to refuse —
     * and `gatherEvidence` re-parses the document itself rather than trusting the gate,
     * because a worker may legitimately skip the schema lens (§4.10).
     *
     * Neither is fatal. Losing evidence costs a dismissal made tomorrow its anchor; losing
     * the checks leaves tonight's dismissals standing on nobody having looked, which the
     * control plane records on every suppression it writes. A review that refuses to
     * finish reports nothing at all, and that is the worse outcome (§4.11).
     */
    const evidence = await gatherEvidence(workspace.path, output).catch(() => [])
    const dismissalChecks = await checkDismissals(workspace.path, history?.bases ?? []).catch(
      () => [],
    )

    /**
     * On the timeline, because suppression's whole effect is an absence and the run that
     * produced it should be able to account for itself without a database query. A night
     * that checked no dismissals because none reached it reads differently from one that
     * checked eleven and found them all intact.
     */
    if ((history?.bases?.length ?? 0) > 0 || dismissalChecks.length > 0) {
      const moved = dismissalChecks.filter((c) => c.basis === 'moved').length
      note(
        `dismissals: checked ${dismissalChecks.length} of ${history?.bases?.length ?? 0} ` +
          `anchored dismissal(s); ${moved} no longer describe code in this tree`,
        { checked: dismissalChecks.length, lapsedBases: moved },
      )
    }

    /**
     * The node's own answer to whether the work it was handed should go ahead (§4.13).
     *
     * Read straight back out of the document the agent wrote, with the schema rather than
     * a cast: this is the one field in the report whose value stops the rest of a cycle,
     * and reading it off an unvalidated `any` would make a malformed block mean "admit"
     * by way of `undefined`. A document with no `scope` — every reviewer and every
     * modifier — leaves this undefined and the run is graded exactly as it was before.
     */
    const scope = findingsDocumentSchema.safeParse(output).data?.scope

    const report: RunReport = {
      runId: job.runId,
      /**
       * `dispatched` means exactly "there is a patch waiting for the publisher" (§5.2).
       * A modifier that changed nothing is `approved` — it ran, the gate was satisfied,
       * and it decided nothing needed doing. Filing that as `dispatched` would put an
       * empty change in front of whoever built the PR step next.
       *
       * A decline outranks a patch, and the ordering is not an accident. The two together
       * should be impossible — a scope evaluator runs on a read-only mount and produces no
       * commits — but if it ever happens, it is a node that said "this should not be
       * attempted" and then attempted it, and reading that as `dispatched` would open a
       * draft pull request out of work its own author disowned. The `changes` row is still
       * written; what it does not become is a publication.
       */
      outcome: scope?.verdict === 'decline' ? 'declined' : change?.patch ? 'dispatched' : 'approved',
      /**
       * On the run row, so the reason is beside the outcome wherever a run is listed
       * rather than only in the coverage ledger. `finalizeRun` prefers this over its own
       * gate summary, and there is no gate summary to lose here: a declined run's gates
       * all passed.
       */
      ...(scope?.verdict === 'decline' ? { detail: scope.reason } : {}),
      durationMs: Date.now() - startedAt,
      rounds,
      ...(usage ? { usage } : {}),
      /**
       * The *final* round's verdict, and only that one. Folding a rejected earlier round
       * into this array would derive the whole run down to `changes-requested` in
       * `finalizeRun`, which reads any failed gate as the gate's answer — so a run that
       * was retried and then passed would report as a run that failed. What the earlier
       * rounds were is `rounds` above and the timeline below, where the rejection and the
       * decision to retry are recorded in the order they happened.
       */
      gates: verdict.gates,
      ...(output !== undefined ? { findings: output as never } : {}),
      evidence,
      dismissalChecks,
      ...(change ? { change: changeRecord(change, verdict.tests) } : {}),
      /**
       * The reason travels with the ledger row, which is what makes "what did Ogun decline
       * last night, and why" one look at the coverage page rather than a run detail
       * somebody has to know to open. An *admit* is `clean`: the evaluator looked and found
       * no reason to stop, which is the same shape of result as a reviewer finding nothing.
       */
      coverage:
        scope?.verdict === 'decline'
          ? { outcome: 'declined', reason: scope.reason }
          : { outcome: change?.patch ? 'changed' : 'clean' },
      artifacts: [
        ...(transcriptRef ? [{ kind: 'transcript', ref: transcriptRef }] : []),
        // Both records, and they answer different questions: `artifacts` is "what files
        // did this run leave on disk", which the run page lists; `changes` is "what did
        // this run do to the code", which the publisher reads (§4.4).
        ...(change?.patch
          ? [{ kind: 'patch', ref: change.patch.ref, bytes: change.patch.bytes }]
          : []),
      ],
    }
    const result = (await cp.report(report)) as { outcome?: RunOutcome }
    const recorded = result.outcome ?? 'approved'

    /**
     * Report first, then publish. Never the other way round, and this is the ordering the
     * whole step hangs on.
     *
     * Publish-then-report fails in the one direction nothing can recover from: the push
     * and the pull request are on GitHub, and if the report call then fails — the control
     * plane is restarting, the token expired, the box lost its network — there is a live
     * pull request with no `changes` row, no run outcome, and nothing in the database that
     * knows either exists. The next thing to look at that project sees a modifier that
     * never finished, and a person finds the branch by accident.
     *
     * This order fails to a `changes` row with a null `branch`, which is a state the
     * schema already has a name for and the run detail page already shows: work that
     * exists and is not published. It is visible, it is inspectable — the patch is still
     * on disk — and it is the state a retry would start from anyway.
     *
     * It also puts the gate in the right place. `result.outcome` is what the control plane
     * *recorded*, not what this runner proposed, and the two differ exactly when a gate
     * failed: `finalizeRun` derives a `dispatched` with a failed gate down to
     * `changes-requested`. Publishing before reporting would mean deciding on the runner's
     * own claim, which is the claim the gate exists to overrule.
     */
    if (change?.patch) {
      await publishIfReady({
        cp,
        flusher,
        parser,
        job,
        outcome: recorded,
        ...(localPath ? { localPath } : {}),
        scratch: config.scratch,
        patchRef: change.patch.ref,
        baseSha: change.baseSha,
        ...(policies ? { policies } : {}),
        tests: { run: verdict.tests?.ran, passed: verdict.tests?.passed },
      })
    }

    return recorded
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err))
  } finally {
    await flusher.flush().catch(() => undefined)
    await sandbox?.dispose().catch(() => undefined)
    if (process.env.OGUN_KEEP_WORKSPACES !== '1') await cleanup?.().catch(() => undefined)
  }
}

/**
 * The job already carries its prompt — often as short as "Use the
 * staging-error-reviews skill." (§5.1). All this adds is where to put the answer,
 * because the CLI owns the format and the agent must not free-hand it (§4.10).
 */
function composePrompt(
  job: ClaimedJob,
  guestRoot: string,
  skillPath: string,
  hasUpstream: boolean,
  knownFindings: number,
): string {
  return [
    job.prompt,
    '',
    ...(hasUpstream
      ? [
          `What the workers before you produced is at ${guestRoot}/${INPUT_PATH}, including`,
          'the ones that found nothing and the ones that failed. Read it first — it is your',
          'input, not the repository.',
          '',
        ]
      : []),
    ...(knownFindings > 0
      ? [
          `This project's inbox already holds ${knownFindings} finding(s). The index is at`,
          `${guestRoot}/${HISTORY_INDEX_PATH} — read it before you choose a surface, so you do`,
          'not spend the run re-reporting something already known.',
          '',
          `Full write-ups are one file per finding under ${guestRoot}/${HISTORY_DIR}/, nested by`,
          'fingerprint, so `<area>/<surface>/` is every finding on that surface. Open only the',
          'ones you need. Reading all of them will anchor you to the last reviewer\'s framing,',
          'which is the opposite of the job.',
          '',
        ]
      : []),
    // The skill is named by path as well as by name. Claude Code can resolve it from
    // .claude/skills natively, but codex has no skill concept, so without this the
    // prompt is a reference to something the runtime cannot look up.
    `That skill is at ${guestRoot}/${skillPath}/SKILL.md — read it first, along with any`,
    'files it points to under references/. It defines the mission, the evidence standard,',
    'and the severity scale for this run.',
    '',
    /**
     * A modifier is told how its work leaves, because the shape of this sandbox is not the
     * shape it expects. There is no remote and no credential here (ADR-0005), and an agent
     * that spends its round trying to push learns that the hard way with nothing to show
     * for it.
     *
     * The uncommitted case is stated rather than left implicit: the runner collects it
     * either way, so silence would be safe — but an agent that knows its message becomes
     * the pull request writes a better one than an agent that thinks committing is
     * bookkeeping.
     */
    ...(job.permissions === 'modifier'
      ? [
          'Commit your work in this workspace with `git commit`. The message is what a',
          'person reviewing the pull request reads first, so write it for them.',
          '',
          'This workspace has no git remote and no credential, by design: you cannot push',
          'and there is nothing to push to. The runner extracts your commits as a patch',
          'after you exit and the host opens the pull request. Anything you leave',
          'uncommitted is collected too, but under a commit that says nobody wrote a',
          'message for it — which is a worse pull request, not a lost one.',
          '',
          `If there is something a reader needs that is not code, run \`ogun findings write\``,
          `to ${guestRoot}/${OUTPUT_PATH} with an empty findings array and your note.`,
        ]
      : [
          `Write your findings to ${guestRoot}/${OUTPUT_PATH} by running \`ogun findings write\`.`,
          'Do not hand-write that file and do not invent a format — the CLI owns the schema.',
          'If you looked and found nothing, still write the file with an empty findings array:',
          'a clean result and a run that never happened are different facts.',
        ]),
  ].join('\n')
}

/**
 * The wire shape of an extraction: the durable facts, without the host-only detail.
 *
 * The test outcome rides on the change rather than being derived from the gate list
 * downstream, because the gate reports one bit and the record needs two — and because
 * the control plane would otherwise have to recognise a lens by name to fill in a column
 * (§4.4). Omitted entirely when the gate produced no verdict, so `null` in the column
 * keeps meaning "nobody said" rather than "no".
 */
const changeRecord = (
  change: PatchExtraction,
  tests?: VerifyOutcome['tests'],
): RunReport['change'] => ({
  baseSha: change.baseSha,
  filesChanged: change.filesChanged,
  ...(change.patch ? { patchRef: change.patch.ref } : {}),
  ...(tests ? { testsRun: tests.ran, testsPassed: tests.passed } : {}),
})

/**
 * The publisher, and everything it takes to keep a failure here from becoming a failure
 * of the run.
 *
 * Wrapped so that nothing this does can change what the run reported. The report is
 * already written and terminal; a `gh` that is not installed, a remote that rejected the
 * push, or a bug in this module must end as a note on the timeline and a `changes` row
 * with a null `branch` — not as a thrown error unwinding into the outer `catch`, which
 * would send a second report that `finalizeRun` correctly refuses and log a crash for a
 * run that succeeded.
 *
 * Every path says something. A modifier that produced a patch and no pull request is the
 * single most confusing thing this system can do, and silence is what makes it confusing
 * rather than merely disappointing.
 */
async function publishIfReady(input: {
  cp: ControlPlane
  flusher: EventFlusher
  parser: ReturnType<typeof newParserState>
  job: ClaimedJob
  outcome: RunOutcome
  /** Absent when this runner has no checkout of the project — see below. */
  localPath?: string
  scratch: string
  patchRef: string
  baseSha: string
  policies?: PinnedPolicies
  tests: { run?: boolean; passed?: boolean }
}): Promise<void> {
  const note = (text: string, fields: Record<string, unknown> = {}): void => {
    input.flusher.push([
      {
        type: 'runner.note',
        ts: new Date().toISOString(),
        seq: nextSeq(input.parser),
        payload: { note: text, ...fields },
      },
    ])
  }

  /**
   * No local checkout, so nothing to make a worktree from.
   *
   * A runner that cloned this project from its remote could clone it again and push from
   * that — but it is a second materialization path, exercised by nobody, and the thing it
   * would be doing for the first time is pushing to somebody's default remote. The patch
   * survives on disk and the `changes` row records the work, so what is lost is
   * automation rather than the work itself. `ogun project add` on this machine fixes it.
   */
  if (!input.localPath) {
    note(
      `not published: this runner has no local checkout of "${input.job.projectSlug}", and a ` +
        'branch is pushed from a worktree of one. The patch is kept at ' +
        `${input.patchRef}.`,
    )
    return
  }

  try {
    const published = await publishPatch({
      repo: input.localPath,
      scratch: input.scratch,
      runId: input.job.runId,
      workerName: input.job.workerName,
      defaultBranch: input.job.projectDefaultBranch,
      baseSha: input.baseSha,
      patchRef: input.patchRef,
      outcome: input.outcome,
      tests: input.tests,
      ...(input.policies ? { policies: input.policies } : {}),
      // The only place a credential enters this pipeline. `publishPatch` takes it as a
      // parameter so every gate above it can be tested without one (ADR-0009).
      remote: githubCli(),
    })

    if (!published.pr) {
      note(`not published: ${published.refused ?? 'no reason recorded'}`)
      return
    }

    note(`published: ${published.pr.url} on ${published.pr.branch}`, {
      branch: published.pr.branch,
      prUrl: published.pr.url,
    })

    /**
     * Told to the control plane last, because it is the only part that can be caught up
     * afterwards. The pull request exists whatever happens here; a `changes` row that
     * still says null is wrong but recoverable from GitHub, where the branch name carries
     * the run id.
     */
    await input.cp.published(input.job.runId, published.pr.branch, published.pr.url)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    note(`publishing failed: ${detail}. The patch is kept at ${input.patchRef}.`)
    console.error(`[runner] run=${input.job.runId} publish failed`, err)
  }
}

/** Where a project says how it is built and how it is tested (§4.6, §9). */
const PROJECT_CONFIG_PATH = '.ogun/config.yaml'

/**
 * The project's test command as of the commit the workspace was pinned to, read out of
 * git rather than off disk.
 *
 * `git show <sha>:<path>` and not `readFile`, because the file on disk is inside a tree
 * the modifier had write access to. An agent that edits `tests.command` to `true` — one
 * line, no cleverness — would be setting its own gate, and the harness would faithfully
 * run it and report a pass. The blob at the pinned base is the version a person reviewed
 * and merged, and it is the only copy the agent could not reach.
 *
 * The consequence is deliberate: a modifier whose patch legitimately changes the test
 * command is still gated by the old one. The gate belongs to the project, not to the
 * patch asking to be let in.
 */
export async function projectTestCommand(
  workspace: string,
  baseSha: string,
): Promise<string | undefined> {
  const pinned = await pinnedProjectConfig(workspace, baseSha)
  return pinned === undefined ? undefined : readTestCommand(pinned)
}

/**
 * Whether a job may have the sandbox its worker asked for, and — when it may not — which
 * of the two reasons it was.
 *
 * ### What this replaces
 *
 * `createSandbox` was called with the literal `allowSandboxDowngrade: false`. That failed
 * *closed*, so nothing was ever contained less than it should have been; what it did was
 * make `policies.allowSandboxDowngrade` a setting that does nothing. A project that set
 * it `true` got exactly the refusal of a project that had never heard of it, and from
 * outside the three explanations — misspelled the key, misunderstood what it does, found
 * a bug — are indistinguishable, so the only way to tell them apart was to read this
 * file. A knob wired to nothing is not a safe default; it is a day of somebody's time.
 *
 * ### Why `policies` is a parameter rather than something read here
 *
 * Because of *where* it has to come from: the blob at the pinned base (see
 * `pinnedProjectConfig`), never the workspace. The workspace is mounted read-write for
 * the profile this gate exists to contain, and `.ogun/config.yaml` is a file in it — an
 * agent that appends `allowSandboxDowngrade: true` in its own checkout would be voting
 * itself out of the container it is running in. `tests.command` is read from the same
 * blob for the same reason, and one caller passing both is what keeps them agreeing.
 *
 * ### Why `undefined` is not folded into `false`
 *
 * Both take the strict side — an unreadable policy must never open the sandbox — but they
 * are different facts and principle 6's rule applies to refusals as much as to coverage.
 * "Your project says no" points at a line somebody can change; "your project's policy
 * could not be established" points at a file that does not parse. Told the first when it
 * is the second, a person edits a `true` that was already `true` and learns nothing. This
 * is the same null-vs-false distinction the publisher's gate makes about
 * `maxOpenPullRequests`, arrived at from the other direction.
 *
 * Only `modifier` on `worktree` is gated. A reviewer on a worktree is §4.6's documented
 * fast path — file-state isolation for an agent that cannot write anyway — and needs no
 * policy; a modifier there is an agent editing files directly on the host, as the runner
 * user, on the runner's network, with no capability isolation at all.
 *
 * ### Why a permitted downgrade still says something
 *
 * `notice` is set when the policy is honoured — when the answer is yes. That is not
 * belt-and-braces, it is the case with nothing else guarding it. A refusal explains
 * itself; a permission is silent, and this one is silent about a lot. Turning
 * `allowSandboxDowngrade` on does not relax one property, it opts out of the containment
 * model: no read-only mount, and mounts are where the permission profile is actually
 * enforced (`--disallowedTools` never restricted `Bash`, and codex has no equivalent); no
 * network namespace, so the worker's `egress:` allowlist is dropped without a word; no
 * gateway, so the agent reads the runner's own credential files directly; and the process
 * is the runner's user with the runner's `process.env`.
 *
 * A person can set that flag having read four words of a key name. The sentence has to
 * arrive somewhere they will be, so it goes on the run timeline — once per run that
 * actually downgraded, next to the run it applied to, where a fortnight later it is still
 * the answer to "what was this agent able to touch".
 *
 * Deliberately *not* fatal, not a prompt, and not repeated per exec. A warning that fires
 * on a configuration somebody chose on purpose, and fires often, is one they filter — and
 * then it is worth less than nothing, because it was the loud thing that was supposed to
 * be enough.
 */
export function sandboxDowngrade(input: {
  sandbox: 'container' | 'worktree'
  permissions: 'observer' | 'reviewer' | 'modifier'
  /** From the blob at `baseSha`. `undefined` means it could not be read. */
  policies: PinnedPolicies | undefined
  /** Named in the refusal, because "which copy of the config" is the whole question. */
  baseSha: string
}): { allow: boolean; refusal?: string; notice?: string } {
  const allow = input.policies?.allowSandboxDowngrade ?? false
  const downgrading = input.sandbox === 'worktree' && input.permissions === 'modifier'
  if (allow) {
    return downgrading
      ? {
          allow,
          notice:
            "uncontained: this modifier runs on the host as the runner's user, with the " +
            "runner's environment and network, because policies.allowSandboxDowngrade is " +
            `true at ${input.baseSha.slice(0, 12)}. The workspace is not mounted read-only, ` +
            'so the permission profile is not enforced by anything; the egress allowlist ' +
            'does not apply, since there is no network namespace; and the agent reads this ' +
            "machine's credential files rather than going through the gateway.",
        }
      : { allow }
  }
  if (!downgrading) return { allow }

  const at = input.baseSha.slice(0, 12)
  return {
    allow: false,
    refusal:
      input.policies === undefined
        ? `this worker is a modifier on the worktree sandbox, which would edit files ` +
          `directly on this host, and ${PROJECT_CONFIG_PATH} at ${at} could not be read — ` +
          'so whether the project allows that could not be established. The policies block ' +
          'is missing or malformed at that commit; fix it and commit it. A run is refused ' +
          'rather than uncontained.'
        : `this worker is a modifier on the worktree sandbox, which would edit files ` +
          `directly on this host, and ${PROJECT_CONFIG_PATH} at ${at} sets ` +
          'policies.allowSandboxDowngrade: false. Give the worker `sandbox: container`, or ' +
          'set that policy true and commit it if you mean to allow it.',
  }
}

/**
 * The raw text of that blob, which every gate that belongs to the project reads: the
 * sandbox downgrade and the test command before the agent runs, and the publisher's
 * policies after it has. One read rather than three, and more importantly one definition
 * of *which* copy of the file counts — call sites each doing their own is how they end up
 * disagreeing about it.
 */
export async function pinnedProjectConfig(
  workspace: string,
  baseSha: string,
): Promise<string | undefined> {
  // Missing file, unreadable object, a repository without that path at that commit —
  // all of them mean the same thing to the caller, which refuses rather than guessing.
  const shown = await gitIn(workspace, ['show', `${baseSha}:${PROJECT_CONFIG_PATH}`]).catch(
    () => null,
  )
  return shown === null ? undefined : shown.stdout
}

/**
 * Said on the timeline whether the suite passed, failed or never started — the same rule
 * the extraction note follows. A run whose gate could not be reached at all is the one a
 * person most needs an account of, and "took 4s" is how somebody notices a command that
 * is not running the suite it claims to.
 */
function describeTests(verdict: VerifyOutcome): string {
  const detail = verdict.gates.find((g) => g.name === 'tests')?.detail
  if (!verdict.tests?.ran) {
    return `the project's suite did not run: ${detail ?? 'no reason recorded'}`
  }
  return `the project's suite: ${detail ?? (verdict.tests.passed ? 'passed' : 'failed')}`
}

/**
 * Said on the timeline whatever happened, including "nothing". A modifier that changed
 * no files and a modifier whose patch was thrown away are both runs that produce no
 * branch, and the timeline is where a person finds out which one they are looking at.
 */
function describeExtraction(change: PatchExtraction): string {
  if (change.unextractable) return `no patch extracted: ${change.unextractable}`
  if (!change.patch) return 'the agent changed nothing — no patch to extract'
  return (
    `patch extracted: ${change.filesChanged} file(s) over ${change.commits} commit(s), ` +
    `${change.patch.bytes} bytes, against ${change.baseSha.slice(0, 12)}`
  )
}

/**
 * Each project has its own image; absent one, `ogun/base` — enough for a reviewer and not
 * enough for a modifier (§5.1).
 *
 * The tag is not spelled out here any more. It used to be, and `ogun image build` spelled
 * it out differently — from the checkout's directory name rather than the project slug —
 * so a repository whose directory is not named after the project built one image and ran
 * another. `projectImage` is now the only place the format string exists; exported so a
 * test can hold the builder and the runner to the same answer.
 */
export const imageFor = (job: Pick<ClaimedJob, 'permissions' | 'projectSlug'>): string =>
  job.permissions === 'modifier' ? projectImage(job.projectSlug) : baseImage()

async function trackedPaths(workspace: string): Promise<Set<string>> {
  // Through `gitIn`, like every git call made after the container has exited: `ls-files`
  // refreshes the index, and refreshing the index is enough to run a `core.fsmonitor`
  // command the agent left in the workspace's own config.
  const { stdout } = await gitIn(workspace, ['ls-files'])
  return new Set(stdout.split('\n').filter(Boolean))
}

/**
 * Only files a finding actually cites get read, so this costs one open per citation
 * rather than a walk of the tree. Path is already known-tracked by the caller, but it
 * still goes through the containment check — it originated in a sandbox.
 */
async function countLines(workspace: string, relPath: string): Promise<number | null> {
  try {
    const text = await readContained(workspace, relPath)
    if (text === null) return null
    // A trailing newline does not make a final empty line.
    return text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length
  } catch {
    // Unreadable is not the same as wrong; the caller treats null as "cannot judge".
    return null
  }
}

/** Transcripts are large and rarely read: to disk with a pointer, never into postgres. */
async function writeTranscript(
  config: RunnerContext,
  job: ClaimedJob,
  workspace: string,
): Promise<string | undefined> {
  const dir = join(config.scratch, 'transcripts', job.runId)
  await mkdir(dir, { recursive: true })
  const ref = join(dir, 'output.json')
  // Through readContained, not a bare readFile. This one bypassed the containment check
  // entirely, and it is the worst place to do so: whatever it reads is written to a host
  // artifact and served over the API.
  const raw = await readContained(workspace, OUTPUT_PATH).catch(() => null)
  if (raw === null) return undefined
  // `mode` on create is enough here, unlike the workspace writes: a run id is a fresh
  // uuid per claim — a re-claim after a stale sweep mints another — so this directory is
  // new every time and there is never a looser mode already on the path to inherit.
  await writeFile(ref, raw, { mode: 0o600 })
  return ref
}

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparseable: raw.slice(0, 2000) }
  }
}

/**
 * The sentence a person needs out of a `run.failed` payload.
 *
 * Neither runtime reports a flat message. Claude nests `{error: {message}}`; codex hands
 * back the provider's response body as a *string* of JSON, sometimes wrapped in its own
 * `{error: …}` first. So this walks: parse a string that looks like JSON, follow `error`
 * inward, and take the deepest `message` — falling back to whatever scalar it ended on
 * rather than returning nothing, since an ugly reason still beats the stderr tail.
 */
export function failureMessage(payload: unknown, depth = 0): string | undefined {
  if (depth > 6 || payload === null || payload === undefined) return undefined

  if (typeof payload === 'string') {
    const text = payload.trim()
    if (!text) return undefined
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return failureMessage(JSON.parse(text), depth + 1) ?? text
      } catch {
        return text
      }
    }
    return text
  }

  if (typeof payload !== 'object') return String(payload)

  const obj = payload as Record<string, unknown>
  // `message` last: an outer envelope often carries a generic one ("codex reported a
  // failure") while the useful text sits further in under `error`.
  for (const key of ['error', 'detail', 'message']) {
    if (key in obj) {
      const found = failureMessage(obj[key], depth + 1)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Two rounds' usage, added.
 *
 * Absent stays absent, and that is the whole care this needs: a runtime that reports no
 * usage must not have its silence turned into a zero the moment a second round runs, and
 * a round that reported nothing must not zero out one that did. So each field is summed
 * only over the rounds that carried it, and stays undefined if none of them did.
 */
function addUsage(a: RunReport['usage'], b: RunReport['usage']): RunReport['usage'] {
  if (!a) return b
  if (!b) return a
  const add = (x?: number, y?: number): number | undefined =>
    x === undefined ? y : y === undefined ? x : x + y
  const inputTokens = add(a.inputTokens, b.inputTokens)
  const outputTokens = add(a.outputTokens, b.outputTokens)
  const costCents = add(a.costCents, b.costCents)
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costCents !== undefined ? { costCents } : {}),
  }
}

function usageFrom(event: RunEvent | undefined): RunReport['usage'] {
  const u = event?.payload?.usage as
    | { inputTokens?: number; outputTokens?: number; costUsdEstimate?: number }
    | undefined
  if (!u) return undefined
  return {
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.costUsdEstimate !== undefined
      ? { costCents: Math.round(u.costUsdEstimate * 100) }
      : {}),
  }
}

/**
 * Lay the inbox out in the workspace: one index to read whole, one file per finding to
 * open on demand.
 *
 * Fingerprints are validated before they become paths. `parseFingerprint` already
 * requires exactly four lowercase kebab-case segments, which cannot contain a dot or a
 * separator and therefore cannot traverse — but this writes attacker-adjacent data (a
 * previous agent authored those strings) into a directory tree, so it is checked here
 * rather than assumed from a schema enforced somewhere else. A record with an
 * unparseable fingerprint keeps its place in the index and simply has no body file; it
 * is still a fact worth knowing about the surface.
 */
export async function writeHistory(workspace: string, history: FindingsHistory): Promise<void> {
  await writeSecretFile(
    await containedTarget(workspace, HISTORY_INDEX_PATH),
    `${JSON.stringify({ findings: history.index }, null, 2)}\n`,
  )

  for (const [fingerprint, body] of Object.entries(history.details)) {
    if (!parseFingerprint(fingerprint).ok) continue
    const file = await containedTarget(workspace, `${HISTORY_DIR}/${fingerprint}.md`)
    const entry = history.index.find((i) => i.fingerprint === fingerprint)
    const header = entry
      ? `# ${entry.title}\n\n- fingerprint: \`${fingerprint}\`\n- status: ${entry.status}\n- severity: ${entry.severity}\n- seen: ${entry.seenCount} time(s), last ${entry.lastSeenAt}\n${entry.path ? `- path: ${entry.path}\n` : ''}\n`
      : `# ${fingerprint}\n\n`
    await writeSecretFile(file, `${header}${body}\n`)
  }
}
