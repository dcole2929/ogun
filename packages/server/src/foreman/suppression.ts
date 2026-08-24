import { SEVERITIES } from '@ogun/core'
import type { BasisState, DismissalCheck, RawFinding } from '@ogun/core'

/**
 * Re-adjudication's other half: deciding what a run is *not* allowed to say (§4.11).
 *
 * `applyAdjudications` handles findings nobody re-reported. This handles the opposite
 * case and the one the product actually dies of — a finding somebody already dismissed,
 * reported again tonight, and again the night after that. Without it the inbox fills with
 * things whose answer is already known, people stop reading it, and every other thing
 * this system does is worth nothing.
 *
 * **The decision is deterministic and it is made here, not by an agent.** §10 open
 * question 3 proposed showing a reviewer its prior findings verbatim and having it
 * classify them, and that half is built and kept (`/api/jobs/:id/history`, §4.11). What
 * it must not be allowed to do is *decide the silence*. The two mistakes are not
 * symmetric: an agent that wrongly says "this is different" costs a duplicate row a
 * person can dismiss in one click, and an agent that wrongly says "this is the one you
 * dismissed" removes a real finding from the only place anybody would have seen it, with
 * no second reviewer downstream and nothing in the ledger to notice. Principle 4 says
 * deterministic code before AI and names dedupe as ordinary code; this is dedupe against
 * a person's decision, which is a stronger claim than dedupe against last night.
 *
 * The agent still contributes, and contributes exactly where determinism cannot reach: it
 * may *nominate* a differently-phrased finding as the same issue, through an ordinary
 * `duplicate-of` verdict. That widens a dismissal, but only through a row with a pointer,
 * a reason and a run attached — visible, auditable and reversible — never by an inference
 * made inside a model and then forgotten.
 *
 * Matching is exact fingerprint, or one hop through such a pointer. **Never by prefix.**
 * The hierarchy exists so a cooldown can cover a surface, and a cooldown is temporary and
 * loud. A dismissal is permanent and silent, and `security/orders/account-isolation/` has
 * two techniques under it precisely because they are two different bugs — collapsing them
 * would silence the second one on the strength of a decision made about the first, which
 * is the failure mode that makes every automated reviewer eventually untrustworthy.
 */

export type DismissalRow = {
  fingerprint: string
  status: string
  duplicateOf: string | null
  severity: string
  dismissedAt: Date | null
  dismissedBasis: string | null
  dismissedSeverity: string | null
}

/**
 * Why a reported finding did not reach the inbox, in enough detail to audit.
 *
 * `basis` carries two states the runner never reports, and they are the point of the
 * field: `unrecorded` means the dismissal never had an anchor to check, `unchecked` means
 * it had one and this run did not look. Both suppress, and both are different facts from
 * a check that passed (principle 6).
 */
export type SuppressionOutcome = {
  fingerprint: string
  /** The dismissal whose authority silenced it — this finding, or the one it merges into. */
  dismissal: string
  basis: BasisState | 'unrecorded' | 'unchecked'
  reason: string
}

/** A dismissal that stopped applying, and the finding whose arrival established it. */
export type LapseOutcome = {
  fingerprint: string
  dismissal: string
  reason: string
}

/**
 * What a run is allowed to say about one reported finding — and, for the two decisions
 * that touch an existing row, *which rows move*.
 *
 * The row targets are named, not derived. Every decision here involves up to two rows —
 * the dismissal that holds the authority and the alias that merges into it — and for a
 * direct sighting they are the same row, which is what makes the mistake so easy: code
 * written against the direct case reads `finding.fingerprint`, passes its tests, and
 * silently writes to the alias the day a `duplicate-of` verdict lands. That is not
 * hypothetical; it is what `suppress` did, so an aliased suppression bumped the
 * duplicate's `seen_count` and left the dismissed row reading `seen_count: 1` no matter
 * how often reviewers re-found it. ADR-0011 rejected time-boxed dismissals *because* that
 * counter keeps the pressure visible, so the aliased case had quietly lost the only
 * compensating control the decision rests on.
 *
 * So the shape carries `dismissal` and `alias` — never a boolean plus a fingerprint the
 * caller has to recombine — and `suppress` no longer carries the reported finding at all,
 * because after the fix nothing about the suppressed write-up is ever written anywhere:
 * the alias is a row to bump, not content to copy. `alias === null` *is* "this sighting
 * was the dismissed finding itself", so the two facts cannot disagree. It cannot stop a
 * caller writing to `alias` — nothing can — but it can stop the two rows from arriving
 * under names that both read as "the finding", which is the whole of what went wrong.
 */
export type Decision =
  | { kind: 'publish'; finding: RawFinding }
  | {
      kind: 'suppress'
      outcome: SuppressionOutcome
      /** The `wontfix` row whose authority silenced the sighting. Always the primary. */
      dismissal: string
      /** The duplicate the sighting arrived under, or null when it *was* the dismissal. */
      alias: string | null
    }
  /**
   * A lapse split in two, so an alias's write-up cannot reach the reopened row.
   *
   * The dismissed row is reopened in front of a reader, and the direct case rewrites its
   * title, body and severity from tonight's report — which is right, because it is that
   * row's own sighting. The aliased case must not: it is a *different* finding's write-up,
   * and copying it over would replace the text the person read with text about the
   * rephrasing. Carrying the sighting only on the variant allowed to use it means the
   * aliased branch has nothing to copy from rather than a rule not to.
   */
  | { kind: 'lapse'; outcome: LapseOutcome; dismissal: string; alias: null; sighting: RawFinding }
  | { kind: 'lapse'; outcome: LapseOutcome; dismissal: string; alias: string }

/** Highest first in `SEVERITIES`, so a bigger number is a worse problem. */
const rank = (severity: string): number => {
  const at = (SEVERITIES as readonly string[]).indexOf(severity)
  return at === -1 ? -1 : SEVERITIES.length - at
}

const on = (at: Date | null): string => (at ? ` on ${at.toISOString().slice(0, 10)}` : '')

export function decideSuppression(input: {
  reported: RawFinding[]
  known: DismissalRow[]
  checks: DismissalCheck[]
}): Decision[] {
  const rows = new Map(input.known.map((r) => [r.fingerprint, r]))
  const checked = new Map(input.checks.map((c) => [c.fingerprint, c.basis]))

  return input.reported.map((finding): Decision => {
    const row = rows.get(finding.fingerprint)
    if (!row) return { kind: 'publish', finding }

    /**
     * One hop, never two. `applyAdjudications` already refuses a merge onto a duplicate,
     * so a chain cannot be built through the supported path — but resolving transitively
     * here would make a chain that arrived some other way (a hand-edited row, a future
     * writer) silently extend a dismissal across findings nobody ever compared.
     */
    const dismissal =
      row.status === 'wontfix'
        ? row
        : row.status === 'duplicate' && row.duplicateOf
          ? rows.get(row.duplicateOf)
          : undefined
    if (!dismissal || dismissal.status !== 'wontfix') return { kind: 'publish', finding }

    /**
     * The one place the two rows are told apart, and therefore the only place that can
     * get it wrong. Everything downstream reads `dismissal` and `alias` rather than
     * working it out again from a fingerprint that means different things in the two
     * cases.
     */
    const alias = dismissal.fingerprint === finding.fingerprint ? null : finding.fingerprint
    const via = alias ? `, reported here as ${alias}` : ''
    const lapse = (why: string): Decision => {
      const reopens = dismissal.fingerprint
      const outcome: LapseOutcome = {
        fingerprint: finding.fingerprint,
        dismissal: reopens,
        reason: `dismissal lapsed: ${why}`,
      }
      return alias === null
        ? { kind: 'lapse', outcome, dismissal: reopens, alias: null, sighting: finding }
        : { kind: 'lapse', outcome, dismissal: reopens, alias }
    }
    const suppress = (basis: SuppressionOutcome['basis'], why: string): Decision => ({
      kind: 'suppress',
      dismissal: dismissal.fingerprint,
      alias,
      outcome: {
        fingerprint: finding.fingerprint,
        dismissal: dismissal.fingerprint,
        basis,
        reason: `suppressed by ${dismissal.fingerprint}, dismissed as wontfix${on(
          dismissal.dismissedAt,
        )}${via}: ${why}`,
      },
    })

    /**
     * Escalation lapses the dismissal before the basis is even consulted.
     *
     * A dismissal is a decision about a consequence, not about a location — "this retry
     * loop is fine" is an answer to a `low`. A reviewer now calling the same thing
     * `critical` is making a claim the person never ruled on, and the honest thing is to
     * put it in front of them.
     *
     * This is the one input to the decision an agent influences, and it is wired so that
     * the agent can only ever make the system *louder*: a model that inflates severity
     * costs a row somebody dismisses again, and a model that deflates it changes nothing,
     * because a lower severity is not a new claim. Comparing against the severity frozen
     * at dismissal rather than the row's current one matters for the same reason — the
     * row's severity is rewritten by whichever reviewer last described it, and grading a
     * person's decision against a later reviewer's calibration is not grading it against
     * what they decided.
     */
    const dismissedAt = dismissal.dismissedSeverity ?? dismissal.severity
    if (rank(finding.severity) > rank(dismissedAt)) {
      return lapse(
        `reported as ${finding.severity}, and the dismissal was of a ${dismissedAt}${via}`,
      )
    }

    if (!dismissal.dismissedBasis) {
      return suppress(
        'unrecorded',
        'no basis was recorded for it, so nothing could establish that the code it was ' +
          'about has changed',
      )
    }

    const basis = checked.get(dismissal.fingerprint)
    if (basis === 'moved') {
      return lapse(
        `the code it was dismissed about is no longer in the tree${via} — the judgement ` +
          'was about code that has since been rewritten or removed',
      )
    }
    if (basis === 'intact') {
      return suppress('intact', 'the code it was dismissed about is unchanged')
    }
    if (basis === 'unreadable') {
      return suppress(
        'unreadable',
        'the file it was anchored to could not be read on this run, so the basis was not ' +
          'checked',
      )
    }
    return suppress(
      'unchecked',
      'this run reported no check of its basis, so the dismissal stands on nobody having ' +
        'looked rather than on the code being unchanged',
    )
  })
}
