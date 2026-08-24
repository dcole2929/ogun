import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { cycleConfigSchema } from './cycle.ts'
import { egressSchema } from './egress.ts'

export const RUNTIMES = ['claude', 'codex'] as const
export type Runtime = (typeof RUNTIMES)[number]

/** What the agent may do *inside* the sandbox. Publishing is not on this list — it is
 *  a host-side pipeline step, not an agent capability (§4.6). */
export const PERMISSION_PROFILES = ['observer', 'reviewer', 'modifier'] as const
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number]

export const SANDBOX_KINDS = ['container', 'worktree'] as const
export type SandboxKind = (typeof SANDBOX_KINDS)[number]

/**
 * How long a worker may run before it is given up on, when it does not say.
 *
 * Named rather than inlined because admission reads it too: a credential preflight has to
 * know how long the job it is about to admit could still be running, and a second literal
 * `30 * 60_000` somewhere else would drift from this one the first time either moved.
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60_000

/** Model names are roles, not tiers — a router maps them to specs (§4.7). */
export const MODEL_ROLES = ['worker', 'reviewer'] as const

export const lensSchema = z.object({
  name: z.string().min(1),
  method: z.enum(['tool', 'agent']),
  /** tool lenses only */
  command: z.string().optional(),
  /** agent lenses only */
  prompt: z.string().optional(),
  model: z.string().optional(),
})
export type Lens = z.infer<typeof lensSchema>

export const verifySchema = z.object({
  expectations: z.array(lensSchema).default([]),
  /** Drop specific defaults by name rather than replacing the whole set. */
  skipDefaultLenses: z.array(z.string()).default([]),
  /** `none` for non-code work where the standing rubric is meaningless. */
  lensProfile: z.enum(['default', 'none']).default('default'),
})
export type VerifyConfig = z.infer<typeof verifySchema>

export const workerSchema = z.object({
  skill: z.string().min(1),
  runtime: z.enum(RUNTIMES).default('claude'),
  model: z.string().default('worker'),
  permissions: z.enum(PERMISSION_PROFILES).default('reviewer'),
  sandbox: z.enum(SANDBOX_KINDS).default('container'),
  /** Overrides the skill's own default_prompt. Usually absent. */
  prompt: z.string().optional(),
  schedule: z.string().optional(),
  /** IANA name. Defaults to the control plane's own timezone, since "3am" in a config
   *  file means three in the morning where you are. */
  timezone: z.string().optional(),
  onMissed: z.enum(['skip', 'runOnce']).default('skip'),
  enabled: z.boolean().default(true),
  /** Capability labels a runner must advertise. Derived when omitted. */
  requires: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_WORKER_TIMEOUT_MS),
  /**
   * Which hosts this worker's sandbox may reach (§4.6). Absent means the default
   * allowlist for its runtime — see `egressSchema`, which is also why absent is not
   * spelled `.default(...)` here: "the worker said nothing" and "the worker asked for
   * exactly the defaults" are the same policy, but only the first can be told apart from
   * `egress: []` when this config is round-tripped back into yaml by the UI.
   */
  egress: egressSchema.optional(),
  verify: verifySchema.optional(),
})
export type WorkerConfig = z.infer<typeof workerSchema>

/**
 * How this repository runs its own suite (§9's tests-must-pass gate).
 *
 * Project-level, not per-worker: one repo has one way to run its tests, and a command
 * that could differ per worker is a knob whose only use is letting one modifier hold
 * itself to a weaker standard than another.
 *
 * The command is run by a shell inside the sandbox, so `pnpm -s test && pnpm lint` is a
 * legitimate value. There is no default: guessing at `npm test` for a project that never
 * said so produces a gate that passes because the script is missing, which is worse than
 * no gate at all because it looks like one.
 */
export const testsSchema = z.object({
  command: z.string().min(1).optional(),
})
export type TestsConfig = z.infer<typeof testsSchema>

export const policiesSchema = z.object({
  directPush: z.boolean().default(false),
  /** A modifier on `worktree` is an agent editing files directly on the host. */
  allowSandboxDowngrade: z.boolean().default(false),
  maxConcurrentModifiers: z.number().int().nonnegative().default(1),
  /** Consecutive failures before the breaker opens for a worker (§4.3). */
  failureBreakerThreshold: z.number().int().positive().default(3),
  /**
   * The PR cap §4.6 has named as a publisher gate since before there was a publisher.
   *
   * It bounds *unreviewed* work, not throughput. A nightly modifier opens pull requests
   * on a schedule and a person merges them when they get to it, so the two rates are
   * unrelated and the queue only ever grows in one direction. The failure it prevents is
   * not a runaway loop — `maxConcurrentModifiers` already stops that — it is waking up to
   * eleven draft branches nobody has read, at which point the honest thing to do with all
   * of them is close them, and a night's work is thrown away because it arrived in a pile.
   *
   * Three, because the number wants to be small enough that exceeding it is a fact you
   * notice rather than a limit you eventually raise. Counted against what is open on the
   * remote right now (ADR-0004), so merging or closing one immediately makes room.
   *
   * Zero is a valid and useful value: it stops publishing without stopping modifiers, so
   * a run still produces a patch, a `changes` row, and a diff to read — which is what you
   * want while you are still deciding whether to trust this worker at all.
   */
  maxOpenPullRequests: z.number().int().nonnegative().default(3),
})
export type Policies = z.infer<typeof policiesSchema>

export const projectConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    defaultBranch: z.string().default('main'),
    remoteUrl: z.string().optional(),
  }),
  extends: z.array(z.string()).default([]),
  workers: z.record(z.string(), workerSchema).default({}),
  /** Multi-worker graphs. A single worker needs none — it is already a one-node cycle. */
  cycles: z.record(z.string(), cycleConfigSchema).default({}),
  tests: testsSchema.prefault({}),
  policies: policiesSchema.prefault({}),
})
export type ProjectConfig = z.infer<typeof projectConfigSchema>

/**
 * The test command out of a `config.yaml`, from text, without demanding the rest of the
 * file be valid.
 *
 * Two callers read this from places the full schema cannot survive. Admission reads the
 * control plane's working copy, which a person may be halfway through editing; the
 * runner reads the blob at the commit the workspace was pinned to, which may have been
 * written by a different version of Ogun than the one reading it. A `workers:` block
 * this build cannot parse must not be able to answer "does this project declare a way to
 * test itself" — and `projectConfigSchema.parse` would answer it by throwing.
 *
 * Every failure returns `undefined`, and every caller treats `undefined` as "cannot be
 * verified" and refuses. So the tolerance only ever widens what is accepted as a
 * command; it never turns a broken file into a passing gate.
 */
export function readTestCommand(yamlText: string): string | undefined {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch {
    return undefined
  }
  const parsed = z.object({ tests: testsSchema.optional() }).safeParse(raw)
  return parsed.success ? parsed.data.tests?.command : undefined
}

/**
 * The policies out of a `config.yaml`, from text, on the same terms as `readTestCommand`
 * and for the same reason.
 *
 * The publisher reads this from the blob at the commit the workspace was pinned to, not
 * from the file on disk: the modifier had write access to that tree, and a line raising
 * `maxOpenPullRequests` to 999 is one edit away. A gate a patch can set is not a gate. The
 * blob at the pinned base is the copy a person reviewed and merged, and it is the only one
 * the agent could not reach.
 *
 * Absent `policies:` is not a failure — it means the defaults, which is what most repos
 * want and what `ogun init` writes. Every other failure returns `undefined`, and the one
 * caller treats `undefined` as "this project's policy could not be established" and
 * refuses to publish. So the tolerance can only ever withhold a pull request; it can
 * never produce one that a readable config would have refused.
 */
export function readPolicies(yamlText: string): Policies | undefined {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch {
    return undefined
  }
  const parsed = z.object({ policies: policiesSchema.prefault({}) }).safeParse(raw)
  return parsed.success ? parsed.data.policies : undefined
}
