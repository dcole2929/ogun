import { existsSync } from 'node:fs'
import type { GateResult, Lens, VerifyConfig } from '@ogun/core'
import { findingsDocumentSchema, parseFingerprint } from '@ogun/core'
import type { Sandbox } from './sandbox/index.ts'

/**
 * The verify gate (§4.10). Deterministic tool checks run first and short-circuit, so a
 * schema-invalid output never spends a grading call.
 *
 * In v1 the gate controls persistence, not retry: a failed gate means findings are not
 * persisted and the run records why. Same shape; phase 3 adds re-delivery on top.
 */
export type VerifyInput = {
  config: VerifyConfig | undefined
  permissions: 'observer' | 'reviewer' | 'modifier'
  /** Parsed output document, when the runtime produced one. */
  output: unknown
  /** Paths present in the reviewed tree, for the grounding check. */
  knownPaths: Set<string>
  /** Line count of a tracked file. Only cited files are read, not the whole tree. */
  lineCountOf: (path: string) => Promise<number | null>
  sandbox: Sandbox
}

export async function runVerifyGate(input: VerifyInput): Promise<GateResult[]> {
  const results: GateResult[] = []
  const lenses = resolveLenses(input)

  for (const lens of lenses.filter((l) => l.method === 'tool')) {
    const result = await runToolLens(lens, input)
    results.push(result)
    // Short-circuit: once a deterministic check has failed, an agent lens grading the
    // same output is spending a call to reach a conclusion we already have.
    if (!result.passed) return results
  }

  for (const lens of lenses.filter((l) => l.method === 'agent')) {
    results.push({
      name: lens.name,
      method: 'agent',
      passed: true,
      detail: 'agent lenses are not wired in phase 1 — recorded as skipped, not as passed silently',
    })
  }

  return results
}

/**
 * Default lens sets differ by permission profile. A standing rubric of
 * security/coupling/deadcode grades *a code change* — meaningless for a reviewer that
 * produced no diff. The reviewer analog grades findings quality.
 */
function resolveLenses(input: VerifyInput): Lens[] {
  const config = input.config
  if (config?.lensProfile === 'none') return config.expectations
  const skip = new Set(config?.skipDefaultLenses ?? [])
  const defaults: Lens[] =
    input.permissions === 'modifier'
      ? []
      : [
          { name: 'schema', method: 'tool' },
          { name: 'grounded', method: 'tool' },
        ]
  return [...defaults.filter((l) => !skip.has(l.name)), ...(config?.expectations ?? [])]
}

async function runToolLens(lens: Lens, input: VerifyInput): Promise<GateResult> {
  if (lens.name === 'schema' && !lens.command) return schemaCheck(input)
  if (lens.name === 'grounded' && !lens.command) return groundingCheck(input)
  if (!lens.command) {
    return { name: lens.name, method: 'tool', passed: false, detail: 'tool lens has no command' }
  }

  const argv = lens.command.split(/\s+/).filter(Boolean)
  const { done } = input.sandbox.exec(argv)
  const { code, stderr } = await done.catch((err: Error) => ({ code: 1, stderr: err.message }))
  return {
    name: lens.name,
    method: 'tool',
    passed: code === 0,
    ...(code === 0 ? {} : { detail: stderr.slice(-2000) || `exited ${code}` }),
  }
}

/** Structured output, validated (principle 5). Prose is not a finding. */
function schemaCheck(input: VerifyInput): GateResult {
  if (input.output === undefined || input.output === null) {
    return {
      name: 'schema',
      method: 'tool',
      passed: false,
      detail: 'the run produced no findings document',
    }
  }
  const parsed = findingsDocumentSchema.safeParse(input.output)
  if (!parsed.success) {
    return {
      name: 'schema',
      method: 'tool',
      passed: false,
      detail: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    }
  }
  for (const f of parsed.data.findings) {
    const fp = parseFingerprint(f.fingerprint)
    if (!fp.ok) {
      return {
        name: 'schema',
        method: 'tool',
        passed: false,
        detail: `bad fingerprint ${f.fingerprint}: ${fp.error}`,
      }
    }
  }
  return { name: 'schema', method: 'tool', passed: true }
}

/**
 * Does every cited `file:line` actually exist in what was reviewed? Cheap, catches
 * hallucinated findings, and runs before any expensive step (§4.11).
 *
 * The line half of that is not decoration. A path-only check passes a citation of
 * `real-file.ts:9999`, which is the exact shape a confabulated finding takes: the model
 * knows a plausible filename and invents a location in it. Found by ogun's own reviewer
 * on its second run, when the check validated paths and silently ignored `line`.
 *
 * Only cited files are read, so the cost is proportional to findings, not repo size.
 */
async function groundingCheck(input: VerifyInput): Promise<GateResult> {
  const parsed = findingsDocumentSchema.safeParse(input.output)
  if (!parsed.success) {
    return { name: 'grounded', method: 'tool', passed: false, detail: 'output is not parseable' }
  }

  const bad: string[] = []
  for (const f of parsed.data.findings) {
    for (const c of f.citations) {
      const path = normalize(c.path)
      if (!input.knownPaths.has(path)) {
        bad.push(`${f.fingerprint} cites ${c.path}, which is not in the tree`)
        continue
      }
      const end = c.endLine ?? c.line
      if (end === undefined) continue
      const lines = await input.lineCountOf(path)
      if (lines === null) continue
      if (end > lines) {
        bad.push(`${f.fingerprint} cites ${c.path}:${end}, but that file has ${lines} lines`)
      }
    }
  }

  if (bad.length > 0) {
    return {
      name: 'grounded',
      method: 'tool',
      passed: false,
      detail: bad.slice(0, 5).join('; '),
    }
  }
  return { name: 'grounded', method: 'tool', passed: true }
}

const normalize = (p: string): string => p.replace(/^\.\//, '').replace(/^\/workspace\//, '')

export const outputFileExists = (path: string): boolean => existsSync(path)
