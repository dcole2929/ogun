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

/**
 * A node's answer to whether the work it was handed should go ahead (§4.13, ADR-0013).
 *
 * The scope evaluator is the first worker whose *product* is a decision rather than a
 * description. A reviewer says what it found, a modifier says what it changed; a scope
 * evaluator says yes or no about a ticket, and the rest of the cycle runs or does not run
 * on the strength of it. That answer has to be a field rather than a sentence in `notes`,
 * because something downstream has to act on it, and `releaseDependents` is not a person.
 *
 * **On the report document rather than in a file of its own.** The runner already reads
 * one document off the sandbox, the schema lens already validates it, and the CLI already
 * owns its shape (§4.10). A second output path would be a second thing to mount, a second
 * thing to parse, and a second way for a run to be half-reported — a verdict written and
 * the findings lost, or the reverse.
 *
 * **Not tied to one skill.** Any node that is the entry of a cycle may decline the cycle;
 * a planner that cannot find a plan is answering the same question one stage later. So it
 * lives beside `findings` and `adjudications` rather than in a scope-evaluator-shaped
 * corner of the tree, and a document carrying no verdict is graded exactly as it was
 * before this field existed.
 */
export const SCOPE_VERDICTS = ['admit', 'decline'] as const
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number]

export const scopeSchema = z.object({
  verdict: z.enum(SCOPE_VERDICTS),
  /**
   * Why, in the evaluator's own words, and required on both verdicts.
   *
   * On a decline this is the whole product of the run, and very likely the only thing the
   * ticket will ever produce: `source_emissions` is unique on `(project, ticket)` and a
   * ticket edited afterwards is reported and **not** re-emitted (ADR-0013), so nothing
   * automatic ever looks at that card again. A decline with no reason is not a terse
   * result; it is a ticket that disappears.
   *
   * Required on an admit too, and that is the less obvious half. It records what the
   * evaluator thought it was admitting, which is the first thing anybody wants when a
   * pipeline three nodes later produces something nobody recognises.
   *
   * Prose, not a category. A closed set of decline reasons was considered and rejected: it
   * would aggregate nicely and it would cost the only thing this text is for. The reason
   * has one reader — the person who filed the ticket — and a label tells them nothing they
   * can act on, where "it says the export is slow and never says how slow is acceptable"
   * tells them exactly what to write next. `severity` is an enum because it *orders an
   * inbox*; there is no inbox of declines to sort, so an enum here would buy a group-by
   * nobody asked for and cost the specificity. And the moment there is a list, an agent
   * picks the nearest label instead of saying the true thing.
   */
  reason: z.string().trim().min(1),
})
export type Scope = z.infer<typeof scopeSchema>

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
  /**
   * The verdict on whether this work should go ahead, when the node was asked for one.
   *
   * Optional because almost no node is asked. A reviewer and a modifier never carry it and
   * are graded as they always were. A worker that *is* required to answer says so by
   * declaring the `verdict` lens (§4.10), which is what turns a missing answer into a
   * failed gate rather than into a silent `approved` that releases the rest of the
   * pipeline over a ticket nobody judged.
   */
  scope: scopeSchema.optional(),
})
export type FindingsDocument = z.infer<typeof findingsDocumentSchema>
