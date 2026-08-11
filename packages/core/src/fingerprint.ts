import { z } from 'zod'

/**
 * Stable finding identity is a semantic fingerprint, not a content hash (§4.11).
 *
 *   <area>/<surface>/<invariant>/<technique>
 *   security/public-orders/account-isolation/cross-account-id-swap
 *
 * A hash dedupes exact repeats and nothing else. A hierarchical path dedupes meaning
 * and supports prefix matching, so a cooldown can cover a whole surface.
 *
 * Note what it excludes: no line number. Rebases and unrelated edits shift lines and
 * would mint a spurious new identity for an unchanged finding.
 */
export const FINGERPRINT_SEGMENTS = ['area', 'surface', 'invariant', 'technique'] as const

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const fingerprintSchema = z
  .string()
  .min(1)
  .refine((v) => parseFingerprint(v).ok, {
    message:
      'fingerprint must be <area>/<surface>/<invariant>/<technique>, each a lowercase kebab-case slug',
  })

export type ParsedFingerprint = {
  area: string
  surface: string
  invariant: string
  technique: string
}

export type ParseResult =
  | { ok: true; value: ParsedFingerprint }
  | { ok: false; error: string }

export function parseFingerprint(raw: string): ParseResult {
  const parts = raw.split('/')
  if (parts.length !== FINGERPRINT_SEGMENTS.length) {
    return {
      ok: false,
      error: `expected ${FINGERPRINT_SEGMENTS.length} segments (${FINGERPRINT_SEGMENTS.join('/')}), got ${parts.length}`,
    }
  }
  for (const [i, part] of parts.entries()) {
    if (!SEGMENT.test(part)) {
      return { ok: false, error: `segment ${i + 1} (${FINGERPRINT_SEGMENTS[i]}) is not a kebab-case slug: ${JSON.stringify(part)}` }
    }
  }
  const [area, surface, invariant, technique] = parts as [string, string, string, string]
  return { ok: true, value: { area, surface, invariant, technique } }
}

/** Every prefix of a fingerprint, longest first — what cooldown matching walks. */
export function fingerprintPrefixes(raw: string): string[] {
  const parts = raw.split('/')
  const out: string[] = []
  for (let n = parts.length; n > 0; n--) out.push(parts.slice(0, n).join('/'))
  return out
}

/** True when `pattern` covers `fingerprint` — exact, or a path prefix on a segment boundary. */
export function fingerprintMatches(pattern: string, fingerprint: string): boolean {
  return fingerprint === pattern || fingerprint.startsWith(`${pattern}/`)
}
