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

export const findingsDocumentSchema = z.object({
  /**
   * A reviewer that looked and found nothing still reports. An empty array here and a
   * missing file are different facts: "clean" versus "never looked".
   */
  findings: z.array(rawFindingSchema),
  notes: z.string().optional(),
})
export type FindingsDocument = z.infer<typeof findingsDocumentSchema>
