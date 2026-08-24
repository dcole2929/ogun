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

/**
 * What a project permits, as one `policies:` block in one file — and read by two
 * different processes, out of two different copies of that file.
 *
 * That split is not tidiness. It is the reason half of these can be trusted at all, and
 * the two subsets declared below exist so that mixing them up is a type error rather
 * than a review comment somebody has to think of.
 *
 * ### Control-plane policies — `maxConcurrentModifiers`, `failureBreakerThreshold`
 *
 * Scheduling and admission. `ogun project sync` posts them; they live on the `projects`
 * row; the foreman reads them from there and nowhere else. Two properties make that the
 * right home. The agent cannot influence them — by the time a sandbox exists, the
 * decisions they govern (may this job be dispatched, has this worker earned a breaker)
 * have already been taken. And the runner has no business re-deriving them: it would be
 * answering a *scheduling* question from a file it fetched out of a repository, which is
 * how one question ends up with two answers that drift.
 *
 * ### Pinned-blob policies — `directPush`, `allowSandboxDowngrade`, `maxOpenPullRequests`
 *
 * Gates on what an agent's own work is allowed to become. The runner reads these from
 * `git show <baseSha>:.ogun/config.yaml` (`readPolicies`) — never from the workspace, and
 * never from the database. A modifier has write access to its checkout, so a gate read
 * from that checkout is a gate the agent sets for itself; one line appended to its own
 * `config.yaml` and `maxOpenPullRequests` is 999. The blob at the pinned base is the copy
 * a person reviewed and merged, and it is the only one the agent could not reach. See
 * ADR-0009 and §4.6.
 *
 * These deliberately have **no** stored copy. Not because storing one would be extra
 * work, but because a stored copy is a second answer to the same question sitting
 * somewhere a future caller can find it — and that caller will not know which copy
 * counted. `controlPlanePoliciesSchema` and `pinnedPoliciesSchema` each carry only their
 * own half, so "read `maxOpenPullRequests` off the project row" and "ask the pinned blob
 * for the breaker threshold" do not compile.
 */
export const policiesSchema = z.object({
  directPush: z.boolean().default(false),
  /** A modifier on `worktree` is an agent editing files directly on the host. */
  allowSandboxDowngrade: z.boolean().default(false),
  /**
   * How many of this project's modifier jobs may be in flight at once (§4.3).
   *
   * The runaway-loop bound. A modifier is the profile that writes, commits and leaves a
   * patch behind, and several of them churning on one repository at 3am is the shape of
   * night that spends a rate limit and leaves a pile nobody asked for —
   * `maxOpenPullRequests` bounds what reaches the remote, this bounds what is produced
   * in the first place.
   *
   * Per project, not per machine. `maxConcurrentJobs` is the machine's cap and exists
   * because WSL2 will OOM; this one is a statement about how much unattended change one
   * repository wants at a time, and two projects sharing a counter would mean a busy repo
   * silently throttling a quiet one for a reason neither config mentions.
   *
   * Zero is meaningful and is not "unlimited": it switches modifiers off for the project
   * while leaving every other profile running. Refused at admission with a sentence
   * rather than left queued, because a job that is never dispatched and never explained
   * is the coverage hole principle 6 exists to prevent.
   */
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

/**
 * The half the control plane stores and decides with. See `policiesSchema` for why there
 * are halves at all.
 *
 * A `pick`, not a second literal list of fields: the defaults, the bounds and the prose
 * stay written once, and adding a key to `policiesSchema` without deciding which side of
 * the boundary it falls on is then a visible omission rather than a copied line that
 * quietly disagrees.
 *
 * Zod strips what it is not told about, so parsing a whole `policies` block through this
 * is also the projection — a payload that still carries `maxOpenPullRequests` cannot
 * smuggle it into the database.
 */
export const controlPlanePoliciesSchema = policiesSchema.pick({
  maxConcurrentModifiers: true,
  failureBreakerThreshold: true,
})
export type ControlPlanePolicies = z.infer<typeof controlPlanePoliciesSchema>

/**
 * What the defaults are, as a value, for a project the control plane has never had
 * policies for.
 *
 * A function rather than a frozen constant because callers hold it, and a shared mutable
 * object that four call sites can write to is a bug waiting for its first `.threshold =`.
 */
export const defaultControlPlanePolicies = (): ControlPlanePolicies =>
  controlPlanePoliciesSchema.parse({})

/**
 * The half the runner reads out of the blob at the pinned base, and the only half it can
 * read: `readPolicies` returns this type, so a gate that has no business coming out of a
 * repository cannot accidentally be answered from one.
 */
export const pinnedPoliciesSchema = policiesSchema.pick({
  directPush: true,
  allowSandboxDowngrade: true,
  maxOpenPullRequests: true,
})
export type PinnedPolicies = z.infer<typeof pinnedPoliciesSchema>

export const projectConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    defaultBranch: z.string().default('main'),
    remoteUrl: z.string().optional(),
  }),
  /**
   * Withdrawn, and withdrawn loudly.
   *
   * `extends: [ogun://typescript]` was in this schema and in §4.9's example config, and
   * was read by nothing: no loader resolved a base config, no worker inherited a field,
   * and a project that set it got precisely the config it had written out itself. There
   * were no consumers to remove, because there had never been one.
   *
   * Deleting the field would have left the same silence with one fewer place to find it —
   * zod strips keys it is not told about, so an existing `extends:` line would go on
   * being ignored, now with nothing in the schema to explain what had happened to it. So
   * the key stays declared, and is declared as unacceptable: a config carrying it fails
   * to parse, names itself in the message, and is fixed in the thirty seconds it takes to
   * delete a line.
   *
   * That is a breaking change for any config that sets it, and is meant to be. Config
   * inheritance was never delivered; someone believing they had it is the failure worth
   * interrupting. If it is built later it may take this name back — what it may not do is
   * take the name back quietly, since a key that once meant nothing and now means
   * something is the worst of the three states.
   */
  extends: z
    .never({
      error:
        '`extends:` is not supported. It was declared but never implemented — no config ' +
        'was ever inherited from it — so it is now refused rather than ignored. Remove ' +
        'the line from .ogun/config.yaml.',
    })
    .optional(),
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
 *
 * Returns the *pinned* half only (`pinnedPoliciesSchema`), which is a boundary and not a
 * convenience. The runner is a process holding a repository it was handed; it must not be
 * able to answer a control-plane question — "what is this project's breaker threshold" —
 * from a file, because the control plane already has an answer and two answers is one
 * too many. A caller reaching for `readPolicies(...).failureBreakerThreshold` gets a type
 * error rather than a plausible number.
 *
 * The narrowing also means a malformed *control-plane* key no longer withholds a pull
 * request here. That is right: it is caught at `ogun project sync`, where the whole
 * `projectConfigSchema` is parsed and a bad value stops the sync with a message, rather
 * than at 3am by refusing to publish work that was in every other respect fine.
 */
export function readPolicies(yamlText: string): PinnedPolicies | undefined {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch {
    return undefined
  }
  const parsed = z.object({ policies: pinnedPoliciesSchema.prefault({}) }).safeParse(raw)
  return parsed.success ? parsed.data.policies : undefined
}
