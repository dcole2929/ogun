import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runVerifyGate } from '../src/verify.ts'
import type { ExecOptions, Sandbox } from '../src/sandbox/index.ts'

/**
 * §9's tests-must-pass gate: a modifier proves its work, or its patch is not published.
 *
 * Everything here is about what the gate *refuses*. A gate that passes when it should is
 * pleasant; a gate that passes when it should not is the whole hazard, because the run
 * then reports `dispatched` and a pull request goes out from a red tree. So each case
 * below is a way the suite could fail to prove anything — no command, no time, a suite
 * that never finished — and each one has to end as a failed gate rather than as silence.
 */

type Call = { argv: string[]; opts?: ExecOptions }

const sandboxThat = (result: {
  code: number | null
  stdout?: string[]
  stderr?: string
  timedOut?: boolean
}): { sandbox: Sandbox; calls: Call[] } => {
  const calls: Call[] = []
  const sandbox = {
    kind: 'container',
    provision: async () => {},
    exec: (argv: string[], opts?: ExecOptions) => {
      calls.push({ argv, ...(opts ? { opts } : {}) })
      return {
        lines: (async function* () {
          for (const line of result.stdout ?? []) yield line
        })(),
        done: Promise.resolve({
          code: result.code,
          stderr: result.stderr ?? '',
          timedOut: result.timedOut ?? false,
        }),
      }
    },
    readFile: async () => null,
    dispose: async () => {},
  } as unknown as Sandbox
  return { sandbox, calls }
}

const modifierGate = (
  sandbox: Sandbox,
  over: { testCommand?: string; deadline?: number; config?: Parameters<typeof runVerifyGate>[0]['config'] } = {},
) =>
  runVerifyGate({
    config: over.config,
    permissions: 'modifier',
    // A modifier writes code, not a findings document. Nothing in this gate reads it.
    output: undefined,
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox,
    ...('testCommand' in over ? { testCommand: over.testCommand } : { testCommand: 'pnpm -s test' }),
    deadline: over.deadline ?? Date.now() + 10 * 60_000,
  })

test('a modifier is graded on the project\'s suite, run as a command in its own right', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  const verdict = await modifierGate(sandbox)

  const gate = verdict.gates.find((g) => g.name === 'tests')
  assert.equal(gate?.passed, true, 'a green suite passes the gate')
  assert.equal(verdict.tests?.ran, true)
  assert.equal(verdict.tests?.passed, true)
  /**
   * `raw`, because the sandbox otherwise prefixes the agent runtime binary — every exec
   * before this one was the agent — and `claude sh -c 'pnpm -s test'` runs claude.
   */
  assert.deepEqual(calls[0]?.argv, ['sh', '-c', 'pnpm -s test'])
  assert.equal(calls[0]?.opts?.raw, true)
})

test('a red suite fails the gate and carries what it printed', async () => {
  const { sandbox } = sandboxThat({
    code: 1,
    stdout: ['not ok 3 - publisher applies the patch', '1 failing'],
  })
  const verdict = await modifierGate(sandbox)

  const gate = verdict.gates.find((g) => g.name === 'tests')
  assert.equal(gate?.passed, false)
  assert.equal(verdict.tests?.ran, true)
  assert.equal(verdict.tests?.passed, false)
  /**
   * A red suite *finished*, and the retry loop's entire budget arithmetic is that
   * measurement — the reserve it holds back for the gate's next run is what the suite
   * just cost, not a constant somebody chose. A gate that reported only `ran: false`
   * here would leave `retryDecision` with nothing to reserve against and no retry would
   * ever happen; one that reported a duration for a suite killed at the deadline would
   * be quoting the budget back at itself.
   */
  assert.equal(typeof verdict.tests?.durationMs, 'number')
  // Stdout, not stderr. A failing suite reports on stdout and frequently leaves stderr
  // empty, so a gate quoting stderr alone says "tests: failed" and nothing else — which
  // is the sentence nobody can act on at 8am.
  assert.match(gate?.detail ?? '', /not ok 3 - publisher applies the patch/)
})

/**
 * The timeout rule, stated as a test: the suite runs inside what is left of the job's
 * budget, not inside a second allowance of its own. A separate number could be set above
 * `timeoutMs` and never fire, or below it and quietly redefine what the job's timeout
 * means.
 */
test('the suite is given what remains of the job\'s timeout, never a fresh one', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  await modifierGate(sandbox, { deadline: Date.now() + 5_000 })

  const budget = calls[0]?.opts?.timeoutMs ?? 0
  assert.ok(budget > 0 && budget <= 5_000, `the suite was given ${budget}ms of a 5s remainder`)
})

test('a suite that outlives the budget fails the gate rather than looking green', async () => {
  const { sandbox } = sandboxThat({ code: null, timedOut: true })
  const verdict = await modifierGate(sandbox)

  const gate = verdict.gates.find((g) => g.name === 'tests')
  assert.equal(gate?.passed, false, 'a killed suite has not passed')
  assert.match(gate?.detail ?? '', /still running/)
  // It did run. "Ran and did not finish" is not "never ran", and the change record keeps
  // them apart because only one of them is a statement about the code.
  assert.deepEqual(verdict.tests, { ran: true, passed: false })
})

test('a job whose budget is already spent fails the gate without starting a suite', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  const verdict = await modifierGate(sandbox, { deadline: Date.now() - 1 })

  assert.equal(calls.length, 0, 'nothing is started against a deadline that has passed')
  assert.equal(verdict.gates.find((g) => g.name === 'tests')?.passed, false)
  assert.deepEqual(verdict.tests, { ran: false, passed: false })
})

/**
 * The runner refuses such a job before the agent starts and admission refuses it before
 * dispatch, so this is the third line of the same answer. It is here because it is the
 * last one: if the other two are ever bypassed, a missing command must still not read as
 * a gate nobody needed.
 */
test('no test command is not a pass', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  const verdict = await modifierGate(sandbox, { testCommand: undefined })

  assert.equal(calls.length, 0)
  const gate = verdict.gates.find((g) => g.name === 'tests')
  assert.equal(gate?.passed, false)
  assert.match(gate?.detail ?? '', /declares no tests.command/)
  assert.deepEqual(verdict.tests, { ran: false, passed: false })
})

/**
 * `skipDefaultLenses` and `lensProfile: none` let a worker drop checks that grade its own
 * output. "Does this patch break the repository" is not that kind of check — it belongs
 * to the project, and a worker able to switch it off in its own stanza could publish
 * unverified code by editing four words of yaml.
 */
test('a worker cannot configure its own test gate away', async () => {
  for (const config of [
    { expectations: [], skipDefaultLenses: ['tests'], lensProfile: 'default' as const },
    { expectations: [], skipDefaultLenses: [], lensProfile: 'none' as const },
  ]) {
    const { sandbox, calls } = sandboxThat({ code: 1 })
    const verdict = await modifierGate(sandbox, { config })

    assert.equal(calls.length, 1, `the suite still ran with ${JSON.stringify(config)}`)
    assert.equal(verdict.gates.find((g) => g.name === 'tests')?.passed, false)
  }
})

test('a reviewer is not asked to run a suite — it produced no diff to test', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  const verdict = await runVerifyGate({
    config: undefined,
    permissions: 'reviewer',
    output: { findings: [] },
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox,
    testCommand: 'pnpm -s test',
    deadline: Date.now() + 60_000,
  })

  assert.equal(calls.length, 0)
  assert.equal(verdict.gates.find((g) => g.name === 'tests'), undefined)
  assert.equal(verdict.tests, undefined, 'a run with no suite must not claim one')
})

/**
 * §4.10's own example is `command: "ogun validate-findings out.json"`. It was being split
 * on whitespace and handed to an exec that prefixes the agent runtime, so in a container
 * it would have run `claude ogun validate-findings out.json`. No worker configures a
 * command lens yet, which is the only reason nothing noticed.
 */
test('a configured tool lens runs its command, not the runtime with its command as argv', async () => {
  const { sandbox, calls } = sandboxThat({ code: 0 })
  await runVerifyGate({
    config: {
      expectations: [
        { name: 'no-todos', method: 'tool', command: 'grep -r TODO src | wc -l' },
      ],
      skipDefaultLenses: ['schema', 'grounded'],
      lensProfile: 'default',
    },
    permissions: 'reviewer',
    output: { findings: [] },
    knownPaths: new Set(),
    lineCountOf: async () => null,
    sandbox,
    deadline: Date.now() + 60_000,
  })

  // Whole, through a shell: a pipe is an ordinary thing to write in that field, and
  // splitting on whitespace turns `|` into an argument.
  assert.deepEqual(calls[0]?.argv, ['sh', '-c', 'grep -r TODO src | wc -l'])
  assert.equal(calls[0]?.opts?.raw, true)
})
