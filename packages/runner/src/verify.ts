import { existsSync } from 'node:fs'
import type { GateResult, Lens, VerifyConfig } from '@ogun/core'
import { findingsDocumentSchema, parseFingerprint } from '@ogun/core'
import { SWEEP_UP_SUBJECT, type PatchFacts } from './patch.ts'
import type { Sandbox } from './sandbox/index.ts'

/**
 * The verify gate (§4.10). Deterministic tool checks run first and short-circuit, so a
 * schema-invalid output never spends a grading call.
 *
 * For a reviewer the gate still controls persistence and nothing else: a failed gate
 * means findings are not persisted and the run records why. For a modifier it now also
 * decides whether there is another round — the gate is where a rejection reason is
 * produced, and `retry.ts` is where it is turned into a decision. Nothing about a lens
 * changes for that; `retryable()` there reads the results this returns.
 */
export type VerifyInput = {
  config: VerifyConfig | undefined
  permissions: 'observer' | 'reviewer' | 'modifier'
  /** Parsed output document, when the runtime produced one. */
  output: unknown
  /** Paths present in the reviewed tree, for the grounding check. */
  knownPaths: Set<string>
  /** Line count of a tracked file. Only cited files are read, not the whole tree. */
  lineCountOf: (path: string) => Promise<number | null>
  sandbox: Sandbox
  /**
   * The project's own test command, read from the commit the workspace was pinned to —
   * never from the tree the agent just had write access to. A modifier that could edit
   * `.ogun/config.yaml` to `command: "true"` would be an agent holding the pen on its own
   * report card, and it is one line of shell away in a workspace mounted read-write.
   */
  testCommand?: string
  /**
   * What the host read off the workspace's git history after extraction, for the lenses
   * that grade the *patch* rather than the tree (§4.10).
   *
   * Absent for a reviewer, which produces no diff, and for a modifier that changed
   * nothing. Absent has to pass — a modifier that decided nothing needed doing is an
   * ordinary `approved` run — but it passes *with a detail saying so*, because "the
   * messages were read and were clean" and "there were no messages" are not the same
   * fact and must not wear the same value (principle 6).
   */
  patch?: PatchFacts
  /**
   * When the job's timeout expires, as epoch milliseconds — `startedAt + timeoutMs`, not
   * a second budget of the gate's own. See `testsCheck` for why there is only one number.
   */
  deadline: number
}

export type VerifyOutcome = {
  gates: GateResult[]
  /**
   * What became of the project's suite, when there was one to run.
   *
   * Separate from the gate's `passed` because `changes.tests_run` and
   * `changes.tests_passed` are two different claims about a patch, and the gate collapses
   * them into one bit. "The suite ran and was red" is a fact about the code; "the suite
   * never ran" is a fact about the harness, and a publisher told only that the gate
   * failed cannot tell which it is holding (principle 6).
   */
  tests?: {
    ran: boolean
    passed: boolean
    /**
     * How long the suite took, when it ran at all. The retry loop's whole budget
     * arithmetic is built on this one measurement rather than on a chosen constant — see
     * `retryDecision`. Absent when the suite never started, which is also the case where
     * no retry is possible, so the two absences agree.
     */
    durationMs?: number
  }
}

export async function runVerifyGate(input: VerifyInput): Promise<VerifyOutcome> {
  const results: GateResult[] = []
  const lenses = resolveLenses(input)
  let tests: VerifyOutcome['tests']

  for (const lens of lenses.filter((l) => l.method === 'tool')) {
    if (lens.name === TESTS_LENS && !lens.command) {
      const outcome = await testsCheck(input)
      tests = outcome.tests
      results.push(outcome.gate)
      if (!outcome.gate.passed) return { gates: results, tests }
      continue
    }
    if (PATCH_LENSES.has(lens.name) && !lens.command) {
      const result = patchLens(lens.name, input)
      results.push(result)
      if (!result.passed) return { gates: results, ...(tests ? { tests } : {}) }
      continue
    }
    const result = await runToolLens(lens, input)
    results.push(result)
    // Short-circuit: once a deterministic check has failed, an agent lens grading the
    // same output is spending a call to reach a conclusion we already have.
    if (!result.passed) return { gates: results, ...(tests ? { tests } : {}) }
  }

  for (const lens of lenses.filter((l) => l.method === 'agent')) {
    results.push({
      name: lens.name,
      method: 'agent',
      passed: true,
      detail: 'agent lenses are not wired in phase 1 — recorded as skipped, not as passed silently',
    })
  }

  return { gates: results, ...(tests ? { tests } : {}) }
}

/** The one lens whose command comes from the project rather than from the worker. */
export const TESTS_LENS = 'tests'

/**
 * Does any commit message in this patch close somebody's issue on merge (ADR-0009)?
 *
 * Refuses, rather than warns, and that is the decision worth defending. GitHub scans
 * commit messages when a branch merges and nothing here can strip a line without
 * rewriting the artefact a person is reviewing — so a warning would record the harm
 * without preventing it, and the harm lands weeks later on somebody who never saw this
 * run: an issue nobody connected to the work closes itself, citing an agent's commit as
 * the reason. `skills/fix-a-finding` has said "never write a closing keyword" since it
 * was written, and §4.10 is where an instruction becomes a gate.
 *
 * It is also almost always *wrong on its own terms*: a modifier takes work out of the
 * findings inbox, where things are identified by fingerprint. It has no issue number to
 * be right about.
 */
const COMMIT_MESSAGE_LENS = 'commit-message'

/** Does this patch edit the file that decides how it is judged? See `selfGatingCheck`. */
const SELF_GATING_LENS = 'self-gating'

/** The lenses that read `input.patch` rather than the tree or the output document. */
const PATCH_LENSES = new Set([COMMIT_MESSAGE_LENS, SELF_GATING_LENS])

/**
 * Default lens sets differ by permission profile. A standing rubric of
 * security/coupling/deadcode grades *a code change* — meaningless for a reviewer that
 * produced no diff. The reviewer analog grades findings quality.
 *
 * A modifier's test gate is not among the defaults, and the distinction is the whole
 * point of it. `skipDefaultLenses` and `lensProfile: none` are a worker's own escape
 * hatches from checks that grade *its output* — dropping `grounded` from a worker that
 * writes prose is a reasonable thing for a person to decide. "Does this patch break the
 * repository" is not that kind of check: it belongs to the project, every modifier is
 * held to it, and a worker able to switch it off in its own stanza is a worker that can
 * publish unverified code by editing four words. A project that genuinely wants no test
 * gate declares no test command — and then admission refuses to dispatch modifiers at
 * all, which is the same answer said out loud (§4.3).
 *
 * The two patch lenses are mandatory on the same grounds and ordered **before** the test
 * gate on a different one. They cost microseconds against a suite that costs minutes, and
 * short-circuiting means a patch carrying `Closes #14` never spends the budget proving
 * code that is unpublishable whatever the suite says. The cost of that ordering is a
 * `changes` row with null test columns — which reads as "nobody said", is true, and is
 * the reason the publisher's three test refusals are three sentences rather than one.
 */
function resolveLenses(input: VerifyInput): Lens[] {
  const config = input.config
  const mandatory: Lens[] =
    input.permissions === 'modifier'
      ? [
          { name: COMMIT_MESSAGE_LENS, method: 'tool' },
          { name: SELF_GATING_LENS, method: 'tool' },
          { name: TESTS_LENS, method: 'tool' },
        ]
      : []
  if (config?.lensProfile === 'none') return [...mandatory, ...config.expectations]
  const skip = new Set(config?.skipDefaultLenses ?? [])
  const defaults: Lens[] =
    input.permissions === 'modifier'
      ? []
      : [
          { name: 'schema', method: 'tool' },
          { name: 'grounded', method: 'tool' },
        ]
  return [
    ...mandatory,
    ...defaults.filter((l) => !skip.has(l.name)),
    ...(config?.expectations ?? []),
  ]
}

/**
 * §9's tests-must-pass gate: the project's own suite, against the tree the agent left,
 * inside the sandbox that agent ran in.
 *
 * **The budget is the job's, and there is only one of it.** A timeout of its own would be
 * a second number able to disagree with the first — set it above `timeoutMs` and it never
 * fires, below it and a job's stated ceiling silently means something else. So the suite
 * gets what is left of `job.timeoutMs` at the moment the gate starts, and a job's timeout
 * keeps meaning "this job is over by then" rather than "the agent is over by then, and
 * then some". An agent that spent the entire budget leaves nothing, and that is reported
 * as what it is: a run that could not prove its work, not a run that passed.
 *
 * There is deliberately no floor under which the suite is not attempted. A floor would be
 * the second number again, chosen from nothing; a suite given four seconds fails with a
 * reason naming the four seconds, which is the same information without the invented
 * constant.
 *
 * Every path out of here that is not a green suite is a *failed gate*. That is the point
 * of the slice: `finalize` withdraws `dispatched` when any gate fails, so an unproved
 * patch is never handed to the publisher — and a timeout, a missing command and a red
 * suite each say which of those it was.
 */
async function testsCheck(
  input: VerifyInput,
): Promise<{ gate: GateResult; tests: VerifyOutcome['tests'] }> {
  /**
   * `durationMs` is passed only where the suite *finished*, which is a narrower thing
   * than `ran`. A suite killed at the deadline ran and produced no measurement of how
   * long it takes — only of how much was left — and handing that number to the retry
   * loop as "what the gate needs next time" would be quoting the budget back at itself.
   */
  const fail = (
    detail: string,
    ran: boolean,
    durationMs?: number,
  ): { gate: GateResult; tests: { ran: boolean; passed: boolean; durationMs?: number } } => ({
    gate: { name: TESTS_LENS, method: 'tool', passed: false, detail },
    tests: { ran, passed: false, ...(durationMs === undefined ? {} : { durationMs }) },
  })

  /**
   * Unreachable in a healthy factory: admission refuses a modifier whose project
   * declares no test command, and the runner refuses one whose pinned commit declares
   * none, before the agent starts. Kept, and kept failing, because the alternative to an
   * unreachable branch here is a reachable one where a missing command means no gate —
   * and this function is the last place that decision is made.
   */
  if (!input.testCommand) {
    return fail(
      'this project declares no tests.command in .ogun/config.yaml, so nothing here can ' +
        'show the patch works',
      false,
    )
  }

  const budgetMs = input.deadline - Date.now()
  if (budgetMs <= 0) {
    return fail(
      `the job's timeout was already spent when the gate began, so \`${input.testCommand}\` ` +
        'was never run — the patch is unproved rather than broken',
      false,
    )
  }

  const startedAt = Date.now()
  // Through a shell, because a project's test command is a shell command: `pnpm -s test
  // && pnpm lint` is an ordinary thing to write in that field, and splitting it on
  // whitespace turns `&&` into an argument.
  const handle = input.sandbox.exec(['sh', '-c', input.testCommand], {
    timeoutMs: budgetMs,
    raw: true,
  })

  /**
   * Stdout is kept, not discarded. A failing suite writes its report to stdout and
   * frequently leaves stderr empty, so a gate that quoted stderr alone would record
   * "tests: failed" with nothing under it — and the whole value of this gate to a person
   * at 8am is the ten lines naming which test broke. Draining it also keeps the child
   * from blocking on a full pipe.
   */
  const tail: string[] = []
  for await (const line of handle.lines) {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
  }
  const { code, stderr, timedOut } = await handle.done.catch((err: Error) => ({
    code: 1,
    stderr: err.message,
    timedOut: false,
  }))
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  if (timedOut) {
    return fail(
      `\`${input.testCommand}\` was still running after ${elapsed}s, which is all that ` +
        "remained of the job's timeout, and was killed. A suite that does not finish has " +
        'not passed' + output(tail, stderr),
      true,
    )
  }
  if (code !== 0) {
    return fail(
      `\`${input.testCommand}\` exited ${code ?? 'on a signal'} after ${elapsed}s` +
        output(tail, stderr),
      true,
      Date.now() - startedAt,
    )
  }
  return {
    gate: {
      name: TESTS_LENS,
      method: 'tool',
      passed: true,
      // Recorded on the way past even though it passed: "the suite ran and took 4
      // seconds" is how a person notices a command that is not running the suite at all.
      detail: `\`${input.testCommand}\` passed in ${elapsed}s`,
    },
    tests: { ran: true, passed: true, durationMs: Date.now() - startedAt },
  }
}

/**
 * The lenses that grade the artefact a modifier actually produced.
 *
 * §4.10's table has said `build, test, lint, diff size` for a modifier since it was
 * written, and three of those four are the project's own `tests.command` under different
 * names — a repository that lints in CI lints in `tests.command`, and one that does not
 * would not be linted by a lens either. `diff size` is real and is *already* recorded: the
 * extraction note carries files, commits and bytes onto the timeline every run, and the
 * only thing a lens would add is a threshold nobody can derive. So what is here instead
 * are the two questions the suite structurally cannot answer, both about the patch as a
 * *published artefact* rather than as code.
 *
 * Both are deterministic, and that is not an economy — it is that neither needs judgment.
 * "Does this message contain a closing keyword" is a regex GitHub itself publishes the
 * rules for. What genuinely needs an agent lens is listed in §4.10 and deliberately not
 * built: whether the diff is one change or four, whether a test was weakened to make the
 * suite green, whether the message explains the repair rather than restating the finding.
 * Those are the reviewer-lens calibration problem again, and there is one merged modifier
 * patch in existence to calibrate against.
 */
function patchLens(name: string, input: VerifyInput): GateResult {
  /**
   * Nothing to look at, so nothing is claimed. A modifier that changed nothing reaches
   * here, and reporting `passed: true` would mean the ledger could not tell a patch whose
   * messages were read and cleared from a run that had no messages at all (principle 6).
   */
  if (!input.patch) {
    return {
      name,
      method: 'tool',
      passed: true,
      detail: 'this run produced no patch, so there was nothing for this lens to read',
    }
  }
  return name === COMMIT_MESSAGE_LENS
    ? commitMessageCheck(input.patch)
    : selfGatingCheck(input.patch)
}

/**
 * GitHub's own closing-keyword grammar, as narrowly as it can be written.
 *
 * `close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`, any case, optionally
 * followed by a colon, then whitespace, then an issue reference — and the reference has
 * to come *immediately* after. That last part is the whole difference between this lens
 * and a broken one: `skills/fix-a-finding` tells a modifier to write "the bug reported in
 * #14", which is a sentence GitHub does not act on, and a check that flagged every `#14`
 * near the word "fixes" would refuse the exact phrasing the skill recommends.
 *
 * Four reference forms, because GitHub honours all four: `#14`, `GH-14`, `owner/repo#14`,
 * and a full issue URL. Missing one means the gate reads as enforced and is not.
 */
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:#\d+|GH-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+?\/issues\/\d+)/i

function commitMessageCheck(patch: PatchFacts): GateResult {
  for (const message of patch.messages) {
    for (const line of message.split('\n')) {
      const hit = CLOSING_KEYWORD.exec(line)
      if (!hit) continue
      return {
        name: COMMIT_MESSAGE_LENS,
        method: 'tool',
        passed: false,
        detail:
          `a commit message in this patch says "${hit[0].trim()}", which closes that issue ` +
          'on GitHub the moment the branch merges. Nothing downstream can strip it: the ' +
          'pull request body fences agent prose, but GitHub scans the commit messages ' +
          'themselves and rewriting one would destroy the artefact a person is reviewing ' +
          `(ADR-0009). The offending line is: ${line.trim().slice(0, 200)}`,
      }
    }
  }

  /**
   * A pass that is not silent, because the interesting case passes.
   *
   * A patch whose only commit is the runner's sweep-up is a pull request with no
   * explanation in it — the title becomes "Work the agent left uncommitted" and the body
   * quotes the harness's own words back as "what the agent said it did". That is worth
   * saying out loud and it is *not* worth refusing over: the sweep-up commit exists to
   * save work that would otherwise be deleted with the workspace seconds later, and a
   * gate that threw it away would make the net pointless. It is also already unmistakable
   * in `git log`, which is what it was designed for.
   */
  if (patch.sweptUp) {
    return {
      name: COMMIT_MESSAGE_LENS,
      method: 'tool',
      passed: true,
      detail:
        `no closing keyword, but this patch contains a "${SWEEP_UP_SUBJECT}" commit — the ` +
        'agent left work in the worktree and the runner committed it under a message ' +
        'nobody wrote. The pull request is that much harder to review.',
    }
  }
  return { name: COMMIT_MESSAGE_LENS, method: 'tool', passed: true }
}

/**
 * Does this patch edit the file that decides whether it is publishable?
 *
 * **Passes either way, and says so when it is true.** Refusing was considered and is
 * wrong: `.ogun/config.yaml` is a file in the repository like any other, a reviewer can
 * legitimately file a finding about it, and `references/making-a-change.md` §7 already
 * tells a modifier that changing it is allowed so long as the message says so plainly.
 * A gate that refused would make one file unfixable by the machinery built to fix files.
 *
 * What the check is *for* is that the edit cannot hide. The gates were read from the blob
 * at the pinned base before the agent started, so nothing an agent writes here changes
 * how it is judged — but "the agent edited its own exam paper, and it had no effect" is
 * the single most important sentence a person can be handed before they read the diff,
 * and it must not depend on them noticing one path in a file list.
 */
const GATE_PATHS = ['.ogun/config.yaml']

function selfGatingCheck(patch: PatchFacts): GateResult {
  const touched = patch.paths.filter((p) => GATE_PATHS.includes(p))
  if (touched.length === 0) return { name: SELF_GATING_LENS, method: 'tool', passed: true }
  return {
    name: SELF_GATING_LENS,
    method: 'tool',
    passed: true,
    detail:
      `this patch edits ${touched.join(', ')}, which is where this project declares the ` +
      'test command and the policies that gate publication. The gate read the blob at the ' +
      'pinned base, so the edit changed nothing about how this run was judged — but a ' +
      'person reviewing the pull request should know it is in there.',
  }
}

/** Enough to name the failing test, not enough to put a build log in postgres. */
const TAIL_LINES = 40
const MAX_DETAIL_BYTES = 4000

const output = (tail: string[], stderr: string): string => {
  const text = [tail.join('\n'), stderr.trim()].filter(Boolean).join('\n')
  return text ? `:\n${text}`.slice(-MAX_DETAIL_BYTES) : ' — and printed nothing'
}

async function runToolLens(lens: Lens, input: VerifyInput): Promise<GateResult> {
  if (lens.name === 'schema' && !lens.command) return schemaCheck(input)
  if (lens.name === 'grounded' && !lens.command) return groundingCheck(input)
  if (lens.name === VERDICT_LENS && !lens.command) return verdictCheck(input)
  if (!lens.command) {
    return { name: lens.name, method: 'tool', passed: false, detail: 'tool lens has no command' }
  }

  /**
   * `raw`, and through a shell. This split the command on whitespace and handed the
   * pieces to `sandbox.exec`, which prefixes the *agent runtime binary* — so the one
   * documented example in §4.10, `ogun validate-findings out.json`, would have run as
   * `claude ogun validate-findings out.json` inside the container. Nothing caught it
   * because no worker configures a command lens yet; the modifier test gate is the first
   * thing to go through this path.
   */
  const { lines, done } = input.sandbox.exec(['sh', '-c', lens.command], { raw: true })
  const tail: string[] = []
  for await (const line of lines) {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
  }
  const { code, stderr } = await done.catch((err: Error) => ({ code: 1, stderr: err.message }))
  return {
    name: lens.name,
    method: 'tool',
    passed: code === 0,
    ...(code === 0 ? {} : { detail: `exited ${code}${output(tail, stderr)}` }),
  }
}

/**
 * Did a node that was asked for a verdict actually give one (§4.13)?
 *
 * Declared rather than default — `verify: { expectations: [{ name: verdict, method: tool }] }`
 * — because only the worker's own stanza knows that its skill's product is a decision. A
 * reviewer holding no verdict is an ordinary reviewer, not a broken one.
 *
 * It exists because of what the *absence* of a verdict would otherwise mean. A scope
 * evaluator that wandered off, hit its timeout mid-thought, or simply forgot the last
 * command in its skill leaves a document with findings and no `scope` block, and without
 * this lens that run is `approved` — the node succeeds, its dependents are released, and
 * the plan and implement stages run on a ticket nobody judged. Fail-open at exactly the
 * gate whose whole job is to be the closed one.
 *
 * Failing here is deliberately *not* the same as declining. A missing verdict is not a
 * quiet "no": it is a run that was asked one question and did not answer it, so it derives
 * to `changes-requested`, blocks the dependents anyway, and counts toward the failure
 * breaker — which is what should happen to a worker that keeps not answering. Recording
 * silence as a decline would put a judgement in the ledger that nobody made, and the
 * ticket would be refused for good on the strength of it (ADR-0013's emission ledger never
 * re-emits).
 */
const VERDICT_LENS = 'verdict'

function verdictCheck(input: VerifyInput): GateResult {
  const parsed = findingsDocumentSchema.safeParse(input.output)
  if (!parsed.success) {
    return { name: VERDICT_LENS, method: 'tool', passed: false, detail: 'output is not parseable' }
  }
  const scope = parsed.data.scope
  if (!scope) {
    return {
      name: VERDICT_LENS,
      method: 'tool',
      passed: false,
      detail:
        'this worker is required to reach a verdict and its document carries none. Write ' +
        'the document again with a `scope` block: {"verdict": "admit"|"decline", ' +
        '"reason": "..."}.',
    }
  }
  return {
    name: VERDICT_LENS,
    method: 'tool',
    passed: true,
    // The verdict on the timeline, so the one sentence that decides whether the rest of a
    // pipeline runs is legible from the run page without opening the ledger.
    detail: `${scope.verdict}: ${scope.reason}`,
  }
}

/** Structured output, validated (principle 5). Prose is not a finding. */
function schemaCheck(input: VerifyInput): GateResult {
  if (input.output === undefined || input.output === null) {
    return {
      name: 'schema',
      method: 'tool',
      passed: false,
      detail: 'the run produced no findings document',
    }
  }
  const parsed = findingsDocumentSchema.safeParse(input.output)
  if (!parsed.success) {
    return {
      name: 'schema',
      method: 'tool',
      passed: false,
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    }
  }
  for (const f of parsed.data.findings) {
    const fp = parseFingerprint(f.fingerprint)
    if (!fp.ok) {
      return {
        name: 'schema',
        method: 'tool',
        passed: false,
        detail: `bad fingerprint ${f.fingerprint}: ${fp.error}`,
      }
    }
  }
  return { name: 'schema', method: 'tool', passed: true }
}

/**
 * Does every cited `file:line` actually exist in what was reviewed? Cheap, catches
 * hallucinated findings, and runs before any expensive step (§4.11).
 *
 * The line half of that is not decoration. A path-only check passes a citation of
 * `real-file.ts:9999`, which is the exact shape a confabulated finding takes: the model
 * knows a plausible filename and invents a location in it. Found by ogun's own reviewer
 * on its second run, when the check validated paths and silently ignored `line`.
 *
 * Only cited files are read, so the cost is proportional to findings, not repo size.
 */
async function groundingCheck(input: VerifyInput): Promise<GateResult> {
  const parsed = findingsDocumentSchema.safeParse(input.output)
  if (!parsed.success) {
    return { name: 'grounded', method: 'tool', passed: false, detail: 'output is not parseable' }
  }

  const bad: string[] = []
  /**
   * Adjudications are grounded too, and a `fixed` verdict is the one that most needs it:
   * closing a finding is as consequential as opening one, and it is the direction with
   * no second reviewer downstream to catch a mistake. A citation pointing at a fix that
   * is not there fails the whole run, exactly as a hallucinated finding does.
   */
  const cited = [
    ...parsed.data.findings.map((f) => ({ id: f.fingerprint, citations: f.citations })),
    ...(parsed.data.adjudications ?? []).flatMap((a) =>
      a.verdict === 'fixed' ? [{ id: `${a.fingerprint} (fixed)`, citations: a.citations }] : [],
    ),
  ]

  for (const f of cited) {
    for (const c of f.citations) {
      const path = normalize(c.path)
      if (!input.knownPaths.has(path)) {
        bad.push(`${f.id} cites ${c.path}, which is not in the tree`)
        continue
      }
      const end = c.endLine ?? c.line
      if (end === undefined) continue
      const lines = await input.lineCountOf(path)
      if (lines === null) continue
      if (end > lines) {
        bad.push(`${f.id} cites ${c.path}:${end}, but that file has ${lines} lines`)
      }
    }
  }

  if (bad.length > 0) {
    return {
      name: 'grounded',
      method: 'tool',
      passed: false,
      detail: bad.slice(0, 5).join('; '),
    }
  }
  return { name: 'grounded', method: 'tool', passed: true }
}

const normalize = (p: string): string => p.replace(/^\.\//, '').replace(/^\/workspace\//, '')

export const outputFileExists = (path: string): boolean => existsSync(path)
