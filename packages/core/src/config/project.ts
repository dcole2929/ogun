import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { cycleConfigSchema } from './cycle.ts'
import { sourceSchema } from './source.ts'
import { egressSchema } from './egress.ts'
import { CONNECTED_APPS } from '../connections.ts'

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
  /**
   * Extra capability labels a runner must advertise before it may claim this worker's
   * jobs — for things Ogun cannot detect by looking for a binary: `gpu`, `vpn`,
   * `staging-db`. See `workerRequirements`, which is what actually reads this.
   *
   * *Added to* what the worker's own shape implies, never a replacement for it. The
   * previous wording here — "derived when omitted" — reads as though declaring the field
   * takes the derivation over, and that reading has a silent failure: a `container`
   * worker declaring `requires: [gpu]` would stop requiring `docker`, and its jobs would
   * be offered to a machine that cannot run them. Nothing about writing "this also needs
   * a GPU" says "and it no longer needs Docker".
   */
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
  /**
   * Which connected applications this worker's skill may call at runtime, from inside the
   * sandbox — `connections: [linear]` and nothing else today (§4.13, ADR-0010).
   *
   * **Absent is the default and absent means none**, which is the field's entire reason
   * for existing. Putting `api.linear.app` on the *gateway's* standing allowlist would have
   * been three lines and would have given every worker on the machine a credentialed path
   * to the project's issue tracker — including `adversarial-review`, which is pointed at
   * untrusted repository content on purpose and whose whole threat model is that the
   * content is trying to make it do something. A reviewer reading code has no business
   * calling Linear, and the way it has no business is that nobody wrote this line for it.
   *
   * Declaring it grants three things at once, which is why it is one field rather than a
   * host in `egress:` plus a credential somewhere:
   *
   *  1. the application's hosts join *this session's* allowlist, not the gateway's;
   *  2. the gateway will splice this project's real credential into requests to them;
   *  3. the container is told the connection exists, and given a placeholder.
   *
   * What it does **not** grant is any part of ticket selection. `admitsTicket` runs
   * host-side and returns a brand a sandbox cannot mint, so a skill with this field can
   * read a ticket it was already given and cannot choose which tickets Ogun works on. See
   * `src/connections.ts`.
   */
  connections: z.array(z.enum(CONNECTED_APPS)).min(1).optional(),
  verify: verifySchema.optional(),
})
  /**
   * Two ways of declaring a connection that cannot work, refused where they are written.
   *
   * Both are the same shape of mistake — asking for a credential to be spliced in at a
   * gateway the sandbox is not talking to — and both fail *silently* if allowed through.
   * The agent starts, reaches Linear with a placeholder or does not reach it at all, and
   * reports an authentication failure that names the workspace credential. An operator
   * then rotates a key that was never used.
   *
   * `egress: open` is the sharper of the two. It has no gateway at all (ADR-0010's named
   * escape hatch), so a `connections:` beside it is not merely ineffective: it reads as a
   * *narrowing* — "this worker may reach one extra application" — sitting next to
   * unrestricted internet plus a real mounted model credential. Refusing it stops the
   * config from carrying a claim in the opposite direction to what it does.
   *
   * `sandbox: worktree` is refused rather than warned, which is a deliberate difference
   * from how `egress:` is treated on a worktree (dropped, with a note on the timeline).
   * The reason is that there is nothing to protect: a worktree agent runs as the runner,
   * on the runner's network, with read access to the runner's home — which is where
   * `~/.ogun/config.json` and the project's Linear grant live. Injecting a credential into
   * a process that can already read the file it came from is theatre, and theatre is worse
   * than nothing because it reads like a protection. A note on the timeline would say
   * "this was not applied"; a refusal says "this was never a thing you could ask for".
   */
  .check((ctx) => {
    const worker = ctx.value
    if (!worker.connections || worker.connections.length === 0) return
    if (worker.egress === 'open' || worker.egress === 'none') {
      ctx.issues.push({
        code: 'custom',
        input: worker,
        path: ['connections'],
        message:
          `\`connections:\` needs the egress gateway, and \`egress: ${worker.egress}\` has ` +
          'none — `open` bypasses it entirely and `none` is an airgap. Declare the extra ' +
          'hosts your suite needs as a list instead, or drop `connections:`',
      })
    }
    if (worker.sandbox !== 'container') {
      ctx.issues.push({
        code: 'custom',
        input: worker,
        path: ['connections'],
        message:
          '`connections:` needs `sandbox: container`. A worktree agent runs as the runner, ' +
          'on the runner\'s network, and can already read the config.json the credential ' +
          'would be read from — so there is nothing for the gateway to keep out of it',
      })
    }
  })
export type WorkerConfig = z.infer<typeof workerSchema>

/**
 * The capability labels a runner must advertise before it may claim a job for this
 * worker (§4.5) — `jobs.requires`, and the left-hand side of the `requires <@ labels`
 * test the claim query makes.
 *
 * Two sources, unioned, and the union is the point. The derived half is what the
 * worker's shape implies and no config can waive: a `codex` runtime needs the `codex`
 * binary, a `container` sandbox needs `docker`. The declared half is `requires:` — the
 * capabilities Ogun has no way to detect, which is why they can only be asserted by
 * hand at both ends (`ogun runner init --labels gpu` on the machine, `requires: [gpu]`
 * on the worker).
 *
 * The declared half was being dropped entirely: the derivation lived in `cycles.ts` and
 * never looked at the worker's config, so `requires:` was parsed by the schema, stored
 * in `workers.config`, echoed back by the API and preserved through UI edits — and read
 * by nothing. A worker asking for a GPU was offered to every runner, and found out by
 * failing on whichever machine happened to be free.
 *
 * Lives here rather than beside its one caller because it now has two, and they hold a
 * worker in different shapes: the foreman holds a `workers` row (columns plus a jsonb
 * `config`), and the sync-time check holds a `WorkerConfig` straight out of the file.
 * Two derivations of the same set is how the queue and the warning about the queue end
 * up disagreeing about which labels a job needs.
 *
 * Order is derived-then-declared and duplicates are dropped, so the array is stable for
 * a given worker: it is stored on every job row and shown in the UI, and a set that
 * reshuffles makes diffs and screenshots lie about a change that did not happen.
 */
export function workerRequirements(
  worker: Pick<WorkerConfig, 'runtime' | 'sandbox'> & { requires?: string[] | undefined },
): string[] {
  const derived = [worker.runtime, ...(worker.sandbox === 'container' ? ['docker'] : [])]
  // Trimmed and emptied-out, because these reach a postgres array comparison against
  // labels that `listFlag` already trimmed on the way in. A `requires: ["gpu "]` that
  // matches nothing on any machine is indistinguishable from the feature being broken.
  const declared = (worker.requires ?? []).map((label) => label.trim()).filter(Boolean)
  return [...new Set([...derived, ...declared])]
}

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
  /**
   * Whether Ogun may write to the project's default branch. It may not, and `true` is a
   * value this build accepts and does not implement.
   *
   * The publisher builds every branch as `ogun/<worker>/<runid>` and pushes
   * `HEAD:refs/heads/<that>`, so "never the default branch" is true by construction for
   * any project whose default branch is not itself under `ogun/`. `publishPatch` checks
   * the policy anyway, for the one case construction does not cover — a default branch
   * literally named `ogun/<worker>/<runid>`, which is a legal ref. That check is a
   * backstop, it is tested, and it is written against this flag rather than against the
   * prefix so that a direct-push path, if one is ever built, finds the gate already in
   * the right shape.
   *
   * The consequence for a reader is the part worth stating here rather than only in
   * `publishPatch`: setting this `true` does not make Ogun push. It opens a draft pull
   * request exactly as before. `ogun project sync` says so out loud (`inertPolicies`)
   * rather than leaving you to infer it from a night of pull requests you did not want.
   *
   * Not refused outright the way `extends:` is, though the two are the same kind of
   * declared-and-unimplemented. `extends:` silently changed *nothing* about a run;
   * `directPush` is a safety flag whose only implemented value is the safe one, so a
   * config carrying `true` is producing the conservative behaviour rather than a wrong
   * one. Failing to parse it would stop a project's runs over a setting that is, today,
   * being honoured in the strict direction.
   */
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
 * Settings this build accepts, stores, and does not act on — said out loud at
 * `ogun project sync`, which is the moment somebody has just written one.
 *
 * The whole family of bugs this branch is about is a declared setting that never reaches
 * the thing it names, and the reason each survived is that nothing anywhere says "that
 * key does nothing". A `false` that is being honoured strictly and a `true` that is being
 * ignored look identical from outside, and both look identical to a working feature.
 *
 * A list rather than a boolean because it is expected to grow and shrink: an entry
 * leaves the moment its setting is implemented, and a value that is inert is a property
 * of the value rather than of the key — `directPush: false` is not inert, it is the rule.
 *
 * Deliberately empty for a default config. A warning that fires on an ordinary
 * configuration is one people learn to scroll past, and then the one that matters
 * scrolls past too.
 */
export function inertPolicies(policies: Policies): string[] {
  const notes: string[] = []
  if (policies.directPush) {
    notes.push(
      'policies.directPush: true has no implementation — Ogun always opens a draft pull ' +
        'request from an `ogun/<worker>/<run>` branch and never pushes to the default ' +
        'branch. The setting is a gate, and its only implemented value is the closed one.',
    )
  }
  return notes
}

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
  /**
   * Where work comes *from* the outside world (§4.13). A peer of `workers:` and `cycles:`
   * rather than a member of either, because a source emits jobs and is not a worker: it
   * runs on the host, holds the credential, and never executes anything itself.
   */
  sources: z.record(z.string(), sourceSchema).default({}),
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
