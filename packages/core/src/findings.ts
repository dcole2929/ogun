import { z } from 'zod'
import { fingerprintSchema } from './fingerprint.ts'

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * Status lifecycle (§4.11 / §4.12). `gated` and `overflow` exist because triage never
 * deletes, it marks: one bad model call silently dropping a real finding is the
 * serious failure mode, and non-destructive marking is the mitigation.
 */
export const FINDING_STATUSES = [
  'open',
  'triaged',
  'fixed',
  'wontfix',
  'duplicate',
  'gated',
  'overflow',
  /**
   * The surface the finding described is gone — the function was deleted, the module
   * restructured, the whole path removed. Distinct from `fixed`, which asserts somebody
   * corrected the behaviour and implies the invariant is now upheld. Conflating them
   * would lose exactly the distinction principle 6 is about: "we fixed it" and "the
   * question stopped existing" are different facts about the code.
   *
   * A text column rather than a pg enum is what makes adding this cheap, which is the
   * reason the table is built that way.
   */
  'obsolete',
] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const citationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
})
export type Citation = z.infer<typeof citationSchema>

/**
 * What a reviewer must emit. The CLI owns this format (§4.10) — the skill never asks
 * an agent to free-hand JSON, it shells out to `ogun validate-findings`.
 */
export const rawFindingSchema = z.object({
  fingerprint: fingerprintSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1).optional(),
  citations: z.array(citationSchema).min(1),
  /** Present only on a permitted revisit — see the revisit budget in §4.11. */
  revisitOf: z.string().optional(),
  revisitReason: z.string().optional(),
})
export type RawFinding = z.infer<typeof rawFindingSchema>

/**
 * A verdict on a finding that already exists in the inbox.
 *
 * §4.11 proposed `still-applies | resolved-by-this-diff | no-longer-applicable`, and
 * §10.3 records that as a proposal to revisit here. Two changes on contact:
 *
 * `resolved-by-this-diff` is gone, because there is no diff. A reviewer works over a
 * pinned SHA of the default branch and the unit of review is a *surface*, not a change
 * (§5.1) — so "did this diff resolve it" is a question the adjudicator cannot answer.
 * `fixed` replaces it and has to cite the code that does the fixing, which makes the
 * claim checkable by the grounding gate rather than taken on trust.
 *
 * `duplicate-of` is added, because the failure this exists to stop is not only "the
 * developer already saw it". It is also "four reviewers described one bug four ways
 * across four nights". Within a night triage merges by seeing every output at once
 * (§4.12); across nights nothing could, and the inbox proved it — one invite bug under
 * four fingerprints, one runner-claim bug under two.
 *
 * `wontfix` is deliberately not a verdict. That is a person deciding they accept a risk,
 * and nothing here should be able to reach it.
 */
export const ADJUDICATIONS = ['still-applies', 'fixed', 'no-longer-applicable', 'duplicate-of'] as const
export type AdjudicationVerdict = (typeof ADJUDICATIONS)[number]

const adjudicationBase = {
  /** The finding being judged. It must already exist in this project's inbox. */
  fingerprint: fingerprintSchema,
  /**
   * Why, in the adjudicator's own words. Required on every verdict including
   * `still-applies`: "I checked and it still holds" is a result worth recording, and an
   * unexplained status change in the inbox is indistinguishable from a model slip.
   */
  reason: z.string().min(1),
}

export const adjudicationSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('still-applies'), ...adjudicationBase }),
  z.object({
    verdict: z.literal('fixed'),
    ...adjudicationBase,
    /**
     * Where the fix is. Required, and checked by the same grounding gate that checks a
     * finding's citations — closing something is exactly as consequential as opening it,
     * and it is the direction with no second reviewer to catch a mistake.
     */
    citations: z.array(citationSchema).min(1),
  }),
  z.object({ verdict: z.literal('no-longer-applicable'), ...adjudicationBase }),
  z.object({
    verdict: z.literal('duplicate-of'),
    ...adjudicationBase,
    /** The finding this one collapses into. Must exist, and must not itself be a duplicate. */
    duplicateOf: fingerprintSchema,
  }),
])
export type Adjudication = z.infer<typeof adjudicationSchema>

export const findingsDocumentSchema = z.object({
  /**
   * A reviewer that looked and found nothing still reports. An empty array here and a
   * missing file are different facts: "clean" versus "never looked".
   */
  findings: z.array(rawFindingSchema),
  /**
   * Verdicts on what the inbox already held. Absent for a reviewer that stages — only a
   * node that publishes may change the inbox, which is the same rule findings follow and
   * is read off the graph rather than declared (§4.12).
   */
  adjudications: z.array(adjudicationSchema).optional(),
  /**
   * Anything about this pass that is not a finding: which reviewers did not run and what
   * therefore went unexamined, why a pass was inconclusive, what the node noticed but
   * could not substantiate.
   *
   * Kept on the run rather than attached to a finding, because its subject is the pass —
   * a degraded night is exactly the case where there is no finding to hang it on. Triage
   * is required to write one when the batch is degraded, and for a long time the schema
   * accepted it and nothing persisted it.
   */
  notes: z.string().optional(),
})
export type FindingsDocument = z.infer<typeof findingsDocumentSchema>
