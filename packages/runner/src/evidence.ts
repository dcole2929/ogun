import {
  basisIsIntact,
  excerptEvidence,
  findingsDocumentSchema,
  type DismissalBasis,
  type DismissalCheck,
  type FindingEvidence,
} from '@ogun/core'
import { readContained } from './sandbox/paths.ts'

/**
 * The host's half of re-adjudication (§4.11).
 *
 * Both functions here read the workspace after the container has exited, on the host, in
 * the runner process. That placement is the whole point of the module: a dismissal's
 * anchor and the check against it are the two facts an agent must never be able to write.
 * An agent that could author a basis could anchor a dismissal to code it knows will never
 * change, and stay permanently silent about its own surface; an agent that could author
 * the check could report `intact` and do the same in one step.
 *
 * The control plane cannot do this itself and that is not an oversight. §4.5 forbids an
 * absolute repository path in the database, and a hosted control plane has no checkout at
 * all — the runner is the only party that holds the tree, which is the same reason the
 * grounding check lives out here.
 *
 * Nothing read here is written back into the workspace. A file cache is kept per call
 * because several findings usually cite one file, and a review with sixteen findings
 * would otherwise open the same module sixteen times.
 */

/**
 * Three outcomes, because two of them are not the same fact about the code.
 *
 * A file that is *not there* is a definite statement: the code a dismissal was anchored
 * to has gone. A file that could not be *read* — a symlinked citation the containment
 * check refused, a permission error, something oversized — establishes nothing at all.
 * Collapsing them would either lapse a person's decision on an I/O error or hold one over
 * a file somebody deleted, and those are the two failures this whole mechanism exists to
 * keep apart.
 */
type FileRead =
  | { state: 'text'; text: string }
  | { state: 'absent' }
  | { state: 'unreadable' }

const reader = (workspace: string): ((path: string) => Promise<FileRead>) => {
  const seen = new Map<string, Promise<FileRead>>()
  return (path) => {
    const cached = seen.get(path)
    if (cached) return cached
    // Through `readContained`, never `readFile`: these paths came out of a sandbox, and a
    // symlinked citation is an attempt to make the host read something it should not.
    const read: Promise<FileRead> = readContained(workspace, path)
      .then((text): FileRead => (text === null ? { state: 'absent' } : { state: 'text', text }))
      .catch((): FileRead => ({ state: 'unreadable' }))
    seen.set(path, read)
    return read
  }
}

/**
 * The cited code for each finding this run reported, as it stands in the reviewed tree.
 *
 * Only the *primary* citation, which is the one `findings.path` already records — the
 * basis has to name one place or "has the code changed" has no answer. A finding whose
 * citation carries no line, or points past the end of its file, or whose region is too
 * slight to identify anything, simply produces no entry: `evidence.ts` would rather
 * record no basis than a weak one, because a weak basis suppresses silently and a missing
 * one is at least named in the ledger.
 */
export async function gatherEvidence(
  workspace: string,
  document: unknown,
): Promise<FindingEvidence[]> {
  const parsed = findingsDocumentSchema.safeParse(document)
  if (!parsed.success) return []

  const read = reader(workspace)
  const out: FindingEvidence[] = []
  for (const finding of parsed.data.findings) {
    const citation = finding.citations[0]
    if (!citation) continue
    const file = await read(citation.path)
    if (file.state !== 'text') continue
    const snippet = excerptEvidence(file.text, citation.line, citation.endLine)
    if (!snippet) continue
    out.push({ fingerprint: finding.fingerprint, path: citation.path, snippet })
  }
  return out
}

/**
 * Whether each standing dismissal is still about code that exists here.
 *
 * Every dismissal is checked, not only the ones tonight's reviewer happened to re-report.
 * That costs one file read each and it keeps the answer a property of the *tree* rather
 * than of what an agent chose to mention — otherwise a reviewer could keep a lapsed
 * dismissal alive simply by never bringing it up.
 *
 * A file that is gone reports `moved`, not `unreadable`: the whole module having been
 * deleted is the strongest possible evidence that the code somebody dismissed is no
 * longer there. `unreadable` is kept for the case where nothing was established at all,
 * because lapsing a person's decision on a failed read would put a finding they dismissed
 * back in front of them on the strength of an I/O error.
 */
export async function checkDismissals(
  workspace: string,
  bases: DismissalBasis[],
): Promise<DismissalCheck[]> {
  const read = reader(workspace)
  const out: DismissalCheck[] = []
  for (const entry of bases) {
    const file = await read(entry.path)
    const basis =
      file.state === 'absent'
        ? 'moved'
        : file.state === 'unreadable'
          ? 'unreadable'
          : basisIsIntact(file.text, entry.basis)
            ? 'intact'
            : 'moved'
    out.push({ fingerprint: entry.fingerprint, basis })
  }
  return out
}
