import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { cycleConfigSchema } from './cycle.ts'

export const RUNTIMES = ['claude', 'codex'] as const
export type Runtime = (typeof RUNTIMES)[number]

/** What the agent may do *inside* the sandbox. Publishing is not on this list — it is
 *  a host-side pipeline step, not an agent capability (§4.6). */
export const PERMISSION_PROFILES = ['observer', 'reviewer', 'modifier'] as const
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number]

export const SANDBOX_KINDS = ['container', 'worktree'] as const
export type SandboxKind = (typeof SANDBOX_KINDS)[number]

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
  timeoutMs: z.number().int().positive().default(30 * 60_000),
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
