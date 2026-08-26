/**
 * How much of a command's output a gate is allowed to put in the ledger, and the one
 * function that trims it.
 *
 * Extracted when the `project-image` lens arrived, because it needed exactly this and a
 * second copy of it would have been a second answer to "how much of a build log ends up
 * in postgres". The numbers are the interesting part: enough to name the failing test or
 * the line the build died on, not enough to store a build log — and `runs.detail` is a
 * column somebody reads on a phone at 8am, not an artefact store.
 *
 * The tail rather than the head, always. A suite prints its summary last and a docker
 * build prints the error last; a head would reliably capture the part nobody needs.
 */
export const TAIL_LINES = 40
export const MAX_DETAIL_BYTES = 4000

/**
 * The tail of what a command said, appended to a gate's detail, or a phrase saying it
 * said nothing.
 *
 * Both streams, and stdout first. A failing suite writes its report to stdout and
 * frequently leaves stderr empty, so a gate that quoted stderr alone would record
 * "tests: failed" with nothing under it — and the ten lines naming which test broke are
 * the whole value of this gate to a person at 8am. Buildkit is the mirror image: it puts
 * its whole transcript on stderr, so quoting stdout alone would say nothing about why an
 * image did not build.
 *
 * "and printed nothing" rather than an empty string, because a command that failed
 * silently is itself a fact worth reading — most often a shell that could not find the
 * binary at all.
 */
export const outputOf = (tail: string[], stderr: string): string => {
  const text = [tail.join('\n'), stderr.trim()].filter(Boolean).join('\n')
  return text ? `:\n${text}`.slice(-MAX_DETAIL_BYTES) : ' — and printed nothing'
}

/** Keep only the last `TAIL_LINES` of a stream, in place. */
export const pushTail = (tail: string[], line: string): void => {
  tail.push(line)
  if (tail.length > TAIL_LINES) tail.shift()
}
