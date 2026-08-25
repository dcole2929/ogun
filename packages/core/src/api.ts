import { z } from 'zod'
import { CONNECTED_APPS } from './connections.ts'
import type { CredentialOutlook } from './credentials.ts'
import { egressSchema } from './config/egress.ts'
import { runEventSchema } from './events.ts'
import { dismissalCheckSchema, findingEvidenceSchema } from './evidence.ts'
import { findingsDocumentSchema } from './findings.ts'
import { RUN_OUTCOMES } from './outcomes.ts'
import { COVERAGE_OUTCOMES } from './outcomes.ts'

/**
 * The runner/server wire contract (§3). The runner never opens a database connection —
 * everything crosses this boundary, so moving the control plane to a VPS is a URL
 * change rather than a rewrite. Validated on both ends.
 */

export const runnerHeartbeatSchema = z.object({
  runnerName: z.string().min(1),
  labels: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
})

/**
 * When one credential on a runner host stops working, on the wire.
 *
 * The shape is `CredentialExpiry` from `./credentials.ts`, declared again here because
 * that module deliberately imports nothing — the gateway loads it and must not pay for a
 * zod runtime. The two are kept in step by `credentialOutlookSchema` being typed as
 * producing a `CredentialOutlook`, so a variant added there and forgotten here fails to
 * compile rather than silently arriving as garbage.
 *
 * Note what is *not* on the wire: an access token, an API key, a refresh token, an
 * account id. A runner reports when its credential dies, never what it is (ADR-0010).
 */
const credentialExpirySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({ kind: z.literal('never') }),
  z.object({ kind: z.literal('unrecorded') }),
  z.object({ kind: z.literal('at'), expiresAt: z.number() }),
])

export const credentialOutlookSchema: z.ZodType<CredentialOutlook> = z.object({
  anthropic: credentialExpirySchema,
  openai: credentialExpirySchema,
})

export const claimRequestSchema = z.object({
  /** The name this machine registered under. Its real id lives on the control plane. */
  runnerName: z.string().min(1),
  /** Capability labels this runner advertises; a job's `requires` must be a subset. */
  labels: z.array(z.string()),
  /** How many slots the runner has free right now. */
  capacity: z.number().int().positive().default(1),
  /**
   * What this machine's model-provider credentials look like right now, as the gateway on
   * this same machine sees them.
   *
   * A capability fact about a host, exactly like `labels` — so it rides the path `labels`
   * already rides rather than a channel of its own. That is the whole freshness design:
   * the claim *is* the heartbeat, it happens every `pollIntervalMs` (three seconds by
   * default), and a report that arrives with it can never be more than one poll old. A
   * dedicated endpoint would have needed its own timer, its own retry, and its own failure
   * mode — runner claiming, reporter silent — which is a state that has to be detected and
   * decided about, for a fact that was already travelling this way.
   *
   * **Optional, and its absence is not "no credentials".** A runner built before this
   * field existed sends nothing, and the control plane must read that as "this machine has
   * not told us", never as "this machine cannot authenticate" — the absence-of-evidence
   * trap the preflight was careful about from the start. `credentialVerdict` admits on
   * silence; see its doc comment for why that direction and not the other.
   */
  credentials: credentialOutlookSchema.optional(),
})

/** Everything the runner needs to execute without a second round trip. */
export const claimedJobSchema = z.object({
  jobId: z.string(),
  runId: z.string(),
  cycleRunId: z.string(),
  projectSlug: z.string(),
  projectDefaultBranch: z.string(),
  /** Where to clone from when this runner has no local checkout. */
  remoteUrl: z.string().optional(),
  workerId: z.string(),
  workerName: z.string(),
  workerVersion: z.string(),
  nodeKey: z.string(),
  prompt: z.string(),
  runtime: z.string(),
  model: z.string(),
  permissions: z.string(),
  sandbox: z.string(),
  /**
   * Which hosts this job's sandbox may reach (§4.6). Absent means the default allowlist
   * for its runtime, which is what every job claimed by a runner older than this field
   * gets — the wire stays backward compatible in both directions.
   *
   * Validated with the real schema rather than a loose `z.string()` like its neighbours,
   * because those degrade safely and this does not: an unparseable `permissions` string
   * lands as a profile nothing matches, whereas an unparseable egress value would have to
   * be interpreted, and every interpretation of a malformed allowlist is a guess about
   * what a container may reach.
   */
  egress: egressSchema.optional(),
  /**
   * Which connected applications this job's sandbox may call (§4.13). Absent means none,
   * which is what every worker gets unless it wrote the field — and what every job claimed
   * by a runner older than this field gets, in the one direction that is safe to be wrong
   * about.
   *
   * Validated with the closed set rather than `z.array(z.string())`, for the reason
   * `egress` gives one field up: a name this build does not recognise has no safe
   * interpretation. `linear-staging` would either be dropped (a worker that silently loses
   * its connection) or honoured as an unknown app (a host table lookup that returns
   * nothing, one refactor away from returning something). A closed set refuses the claim
   * and says which names exist.
   */
  connections: z.array(z.enum(CONNECTED_APPS)).min(1).optional(),
  timeoutMs: z.number().int().positive(),
  skillRef: z.string(),
  verify: z.unknown().optional(),
  attempt: z.number().int().nonnegative(),
})
export type ClaimedJob = z.infer<typeof claimedJobSchema>

export const claimResponseSchema = z.object({
  jobs: z.array(claimedJobSchema),
})

export const eventBatchSchema = z.object({
  runId: z.string(),
  events: z.array(runEventSchema).min(1),
})

/** Sent once the runner knows what it actually resolved — sha, session, model. */
export const runStartedSchema = z.object({
  runId: z.string(),
  repoSha: z.string().optional(),
  sessionId: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  skillVersion: z.string().optional(),
})

export const gateResultSchema = z.object({
  name: z.string(),
  method: z.enum(['tool', 'agent']),
  passed: z.boolean(),
  detail: z.string().optional(),
})
export type GateResult = z.infer<typeof gateResultSchema>

/**
 * What a modifier run did to the tree (§4.4).
 *
 * Reported for every modifier run that got as far as looking, including the ones that
 * changed nothing — `filesChanged: 0` with no `patchRef` is the record of "it ran and
 * decided nothing needed doing", which is a different fact from no record at all
 * (principle 6).
 *
 * `patchRef` is a host path, not the patch: blobs live on disk with a pointer in
 * postgres. `branch` and `prUrl` are deliberately absent — the runner cannot know either,
 * because both are produced host-side after the container has exited (ADR-0005), and a
 * runner that proposed a branch name would be guessing at the publisher's collision
 * handling.
 */
export const runChangeSchema = z.object({
  baseSha: z.string(),
  filesChanged: z.number().int().nonnegative(),
  patchRef: z.string().optional(),
  /**
   * Whether the project's suite actually executed against this tree, and whether it was
   * green. Two fields rather than one tri-state boolean because they answer different
   * questions and only one of them is about the code: `testsRun: false` says nothing was
   * proved, `testsPassed: false` says something was disproved.
   *
   * Absent — not false — when there is no test outcome to report at all: a run recorded
   * before this gate existed, or one whose patch could not be extracted. `null` in the
   * column means "nobody said", and a publisher reading it as "the tests did not pass"
   * would be right by accident rather than by evidence (principle 6).
   */
  testsRun: z.boolean().optional(),
  testsPassed: z.boolean().optional(),
})
export type RunChange = z.infer<typeof runChangeSchema>

/**
 * The single write that ends a run. Outcome, findings, and coverage land in one
 * transaction — partial findings from a crashed run are worse than none (§5.1).
 */
export const runReportSchema = z.object({
  runId: z.string(),
  outcome: z.enum(RUN_OUTCOMES),
  detail: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      costCents: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * How many times the agent was delivered to before this run ended (§5.2's rounds).
   *
   * One for everything that is not a modifier, because retry is a modifier concept. For a
   * modifier it is the whole of the retry loop's ledger: `gates` carries only the last
   * round's verdict — it has to, or a run that was retried and then passed would derive
   * down to `changes-requested` — so without this a run that succeeded first time and a
   * run that succeeded on its second attempt are the same row (principle 6). The rejected
   * round's own reason, and the reason there was or was not another one, are on the
   * timeline where they happened.
   *
   * Optional rather than defaulted to 1, so `null` in the column keeps meaning "a runner
   * that predates the retry loop said nothing" rather than claiming a count nobody
   * reported.
   */
  rounds: z.number().int().positive().optional(),
  gates: z.array(gateResultSchema).default([]),
  /** Absent when the gate failed or the run errored before producing output. */
  findings: findingsDocumentSchema.optional(),
  /**
   * What the runner read off the disk about the findings above, and about the dismissals
   * already standing against this project (§4.11).
   *
   * Two arrays rather than fields inside `findings`, because `findings` is the agent's
   * document and these are not the agent's to write. The runner computes both from the
   * workspace after the container has exited; nothing inside the sandbox contributes to
   * either, and the control plane refuses to take a basis or a basis check from anywhere
   * else. A dismissal an agent could re-anchor is a dismissal an agent could use to
   * silence a finding about its own work.
   *
   * Optional rather than defaulted, because a runner that predates re-adjudication sends
   * neither and that is a fact worth keeping shaped like one. Absent and empty mean the
   * same thing to `finalizeRun` and it is not a pass: a dismissal with no check against it
   * stands on nobody having looked, and every suppression it produces says so.
   */
  evidence: z.array(findingEvidenceSchema).optional(),
  dismissalChecks: z.array(dismissalCheckSchema).optional(),
  /** Only a modifier reports one. Absent for a reviewer, which produces no diff. */
  change: runChangeSchema.optional(),
  coverage: z.object({
    outcome: z.enum(COVERAGE_OUTCOMES),
    reason: z.string().optional(),
  }),
  artifacts: z
    .array(z.object({ kind: z.string(), ref: z.string(), bytes: z.number().optional() }))
    .default([]),
})
export type RunReport = z.infer<typeof runReportSchema>

/**
 * The second write about a modifier run, and the only one the runner makes after its
 * report: the branch that now exists on the remote and the draft pull request opened for
 * it (ADR-0005).
 *
 * Separate from `runReportSchema` rather than folded into it, because the two facts are
 * established at different times and one of them can fail on its own. The report is what
 * the run did; publishing is what the host managed to do with it afterwards, and a report
 * that carried an empty `branch` would be indistinguishable from a report sent before the
 * publisher existed. Filling the columns in a second call means a run whose publish was
 * refused, or whose push failed, keeps a `changes` row with a null `branch` — which reads
 * as "this work exists and is not published", and is exactly the state a retry starts from.
 */
export const runPublishedSchema = z.object({
  runId: z.string(),
  /** Fully qualified is not wanted here; this is the short name, e.g. `ogun/fixer/3f2a`. */
  branch: z.string().min(1),
  prUrl: z.string().min(1),
})
export type RunPublished = z.infer<typeof runPublishedSchema>

export const triggerRunSchema = z.object({
  projectSlug: z.string().min(1),
  worker: z.string().min(1),
  prompt: z.string().optional(),
})
