import { existsSync } from 'node:fs'
import type { GateResult, Lens, VerifyConfig } from '@ogun/core'
import { findingsDocumentSchema, parseFingerprint } from '@ogun/core'
import type { Sandbox } from './sandbox/index.ts'

/**
 * The verify gate (§4.10). Deterministic tool checks run first and short-circuit, so a
 * schema-invalid output never spends a grading call.
 *
 * In v1 the gate controls persistence, not retry: a failed gate means findings are not
 * persisted and the run records why. Same shape; phase 3 adds re-delivery on top.
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
  tests?: { ran: boolean; passed: boolean }
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
const TESTS_LENS = 'tests'

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
 */
function resolveLenses(input: VerifyInput): Lens[] {
  const config = input.config
  const mandatory: Lens[] =
    input.permissions === 'modifier' ? [{ name: TESTS_LENS, method: 'tool' }] : []
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
  const fail = (
    detail: string,
    ran: boolean,
  ): { gate: GateResult; tests: { ran: boolean; passed: boolean } } => ({
    gate: { name: TESTS_LENS, method: 'tool', passed: false, detail },
    tests: { ran, passed: false },
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
    tests: { ran: true, passed: true },
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
