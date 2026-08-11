import { z } from 'zod'

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
  onMissed: z.enum(['skip', 'runOnce']).default('skip'),
  enabled: z.boolean().default(true),
  /** Capability labels a runner must advertise. Derived when omitted. */
  requires: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  verify: verifySchema.optional(),
})
export type WorkerConfig = z.infer<typeof workerSchema>

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
  policies: policiesSchema.prefault({}),
})
export type ProjectConfig = z.infer<typeof projectConfigSchema>
