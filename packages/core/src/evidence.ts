import { z } from 'zod'
import { fingerprintSchema } from './fingerprint.ts'

/**
 * The evidence a dismissal is anchored to.
 *
 * Re-adjudication (§4.11) turns "I already dismissed this" into silence, and silence is
 * the most dangerous thing this system produces. A dismissal that outlives the code it
 * was about is worse than the noise it removes: dismiss "this retry loop is fine",
 * someone rewrites the retry loop into something genuinely broken, and the one worker
 * positioned to notice says nothing, forever, with nothing recording that it declined to.
 *
 * So a dismissal carries a *basis*: the text of the code the finding cited, as it stood
 * when the dismissal was made. While that text is still in the file, the dismissal is
 * about code that still exists and it holds. When it is gone, the dismissal has lost its
 * subject and lapses.
 *
 * Everything here is deliberately textual rather than a hash, and the normalization is
 * the whole design:
 *
 *   - **No line numbers.** §4.11 excludes them from a fingerprint because rebases shift
 *     them; the same argument applies here with more force. The basis is *searched for*
 *     in the file rather than read at a stored offset, so inserting forty lines above it
 *     changes nothing.
 *   - **Whole-file hashing was the obvious alternative and is wrong.** A digest of
 *     `finalize.ts` changes when anything in `finalize.ts` changes, so every dismissal on
 *     a file anyone is working in lapses nightly — which is the noise this feature exists
 *     to remove, arriving on a slower schedule.
 *   - **Indentation and blank lines are erased.** A formatter run across the repository
 *     must not lapse every dismissal in it; a reindented block is the same code and
 *     nobody re-decided anything.
 *   - **A rename inside the region does lapse it.** That is the point. The judgement was
 *     about that code, and that code is no longer there.
 *
 * The text is read from the workspace by the *runner*, host-side, after the container has
 * exited — never authored by an agent and never handed to one. A basis an agent could
 * write is a basis an agent could use to silence a finding about itself.
 */

/** Lines of context either side of the cited line, so the basis is a region not a line. */
export const EVIDENCE_CONTEXT_LINES = 2

/** Ceiling on a region, so a finding citing a 900-line range does not store the file. */
export const EVIDENCE_MAX_LINES = 14
export const EVIDENCE_MAX_CHARS = 1600

/**
 * Below this, a basis is not usable as one.
 *
 * A one-line excerpt is frequently `}` or `})` or a bare `return`, and those occur
 * everywhere. Searching for such a basis finds it in almost any version of almost any
 * file, so it would report `intact` forever and pin a dismissal open past every rewrite —
 * the exact silent failure the basis exists to prevent. Too short is therefore treated as
 * *no basis recorded*, which is a state the ledger names rather than a check that passes.
 */
export const EVIDENCE_MIN_CHARS = 24

/**
 * One line per line, whitespace-collapsed, blank lines dropped.
 *
 * Applied identically to the stored basis and to the file it is searched in, which is
 * what makes `includes` a meaningful test: a normalized excerpt of contiguous lines is a
 * contiguous substring of the normalized file, because both sides drop the same blanks.
 */
export function normalizeEvidence(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * The normalized text around a citation, or null when there is nothing usable to store.
 *
 * Null is a real answer and not a failure: a citation with no line, a line past the end
 * of the file, a region that normalizes to almost nothing. The caller records "no basis"
 * rather than inventing a weak one, because a weak basis suppresses silently and an
 * absent one is at least visible in the ledger.
 */
export function excerptEvidence(
  fileText: string,
  line: number | undefined,
  endLine?: number,
): string | null {
  if (!line || line < 1) return null
  const lines = fileText.split('\n')
  if (line > lines.length) return null

  const last = Math.max(line, endLine ?? line)
  const from = Math.max(0, line - 1 - EVIDENCE_CONTEXT_LINES)
  const to = Math.min(lines.length, last + EVIDENCE_CONTEXT_LINES)
  const region = lines.slice(from, Math.min(to, from + EVIDENCE_MAX_LINES)).join('\n')

  const normalized = normalizeEvidence(region).slice(0, EVIDENCE_MAX_CHARS)
  return normalized.length >= EVIDENCE_MIN_CHARS ? normalized : null
}

/**
 * Is the code a dismissal was made about still in this file?
 *
 * Deliberately a substring test over the whole file rather than a comparison at the
 * recorded line: the code moving *within* its file is not a reason to re-litigate a
 * decision about it, and a check anchored to an offset would call every insertion above
 * it a rewrite.
 */
export function basisIsIntact(fileText: string, basis: string): boolean {
  const needle = normalizeEvidence(basis)
  if (needle.length < EVIDENCE_MIN_CHARS) return false
  return normalizeEvidence(fileText).includes(needle)
}

/**
 * What the runner observed about one finding it is reporting, computed host-side.
 *
 * Separate from `rawFinding` on purpose. A raw finding is what the *agent* wrote and is
 * treated as a claim; this is what the runner *read off the disk* and is treated as a
 * fact. Merging them into one shape would put the two on the same footing, and the whole
 * value of a basis is that no agent can author it.
 */
export const findingEvidenceSchema = z.object({
  fingerprint: fingerprintSchema,
  /** The finding's primary citation — the same one `findings.path` records. */
  path: z.string().min(1),
  /** Normalized text of the cited region, per `excerptEvidence`. */
  snippet: z.string().min(1),
})
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>

/**
 * Three states, not a boolean, because two of them mean "the dismissal was not checked"
 * and one means "it was checked and it holds" (principle 6). A ledger recording all
 * three as `true` could not answer which dismissals stand on a live check and which
 * stand on nobody having looked.
 *
 *   intact     — the code the dismissal was about is still in the file.
 *   moved      — it is not. The dismissal has lost its subject.
 *   unreadable — the file could not be read at all, so nothing was established.
 */
export const BASIS_STATES = ['intact', 'moved', 'unreadable'] as const
export type BasisState = (typeof BASIS_STATES)[number]

/** The runner's verdict on one standing dismissal, for the tree this run reviewed. */
export const dismissalCheckSchema = z.object({
  fingerprint: fingerprintSchema,
  basis: z.enum(BASIS_STATES),
})
export type DismissalCheck = z.infer<typeof dismissalCheckSchema>

/**
 * What the control plane hands the runner so it can perform the check above.
 *
 * Never written into the workspace. It is the project's own source and holds no secret,
 * so this is not a confidentiality boundary — it is a separation of duties. The basis is
 * the one input to re-adjudication an agent must not be able to argue with, and a copy
 * inside the sandbox is a copy some future skill will start reading.
 */
export const dismissalBasisSchema = z.object({
  fingerprint: fingerprintSchema,
  path: z.string().min(1),
  basis: z.string().min(1),
})
export type DismissalBasis = z.infer<typeof dismissalBasisSchema>
