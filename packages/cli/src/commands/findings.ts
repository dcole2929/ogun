import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  findingsDocumentSchema,
  parseFingerprint,
  rawFindingSchema,
  type FindingsDocument,
} from '@ogun/core'
import { bold, cyan, dim, fail, green, red, severityColor, table } from '../output.ts'

/**
 * The CLI owns every format the agent touches (§4.10). A skill never asks an agent to
 * produce well-formed JSON in prose — it shells out to these subcommands. An agent that
 * free-hands its output format produces a different shape every night and nothing
 * downstream can depend on it.
 */

const OUTPUT_PATH = process.env.OGUN_OUTPUT_PATH ?? '.ogun-out/findings.json'

/** `ogun findings write` — reads a findings document on stdin, validates, writes it. */
export async function findingsWrite(args: string[]): Promise<void> {
  const target = resolve(argValue(args, '--out') ?? OUTPUT_PATH)
  const raw = await readStdin()
  if (raw.trim() === '') {
    fail('nothing on stdin. Pipe a JSON document: {"findings": [...]}')
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    fail(`stdin is not valid JSON: ${(err as Error).message}`)
  }

  const doc = findingsDocumentSchema.safeParse(parsedJson)
  if (!doc.success) {
    console.error(red('the findings document is not valid:'))
    for (const issue of doc.error.issues.slice(0, 10)) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
    console.error(dim('\nExpected shape:'))
    console.error(dim(EXAMPLE))
    process.exit(1)
  }

  for (const f of doc.data.findings) {
    const fp = parseFingerprint(f.fingerprint)
    if (!fp.ok) fail(`bad fingerprint "${f.fingerprint}": ${fp.error}`)
  }

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(doc.data, null, 2)}\n`, { mode: 0o600 })
  const n = doc.data.findings.length
  console.log(
    green(
      n === 0
        ? // A clean result and a run that never happened are different facts (§4.11).
          `recorded a clean review (0 findings) to ${target}`
        : `recorded ${n} finding${n === 1 ? '' : 's'} to ${target}`,
    ),
  )
}

/** `ogun validate-findings <file>` — the schema tool check, runnable as a verify lens. */
export async function validateFindings(args: string[]): Promise<void> {
  const file = resolve(args[0] ?? OUTPUT_PATH)
  const doc = await loadDocument(file)
  for (const f of doc.findings) {
    const fp = parseFingerprint(f.fingerprint)
    if (!fp.ok) fail(`${f.fingerprint}: ${fp.error}`)
  }
  console.log(green(`${file}: valid, ${doc.findings.length} finding(s)`))
}

/**
 * `ogun check-citations <file>` — the grounding check. Does every cited path exist in
 * the tree that was reviewed? Cheap, catches hallucinated findings, and runs before any
 * expensive step (§4.11).
 */
export async function checkCitations(args: string[]): Promise<void> {
  const file = resolve(args[0] ?? OUTPUT_PATH)
  const doc = await loadDocument(file)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const { stdout } = await run('git', ['ls-files'], { maxBuffer: 32 * 1024 * 1024 })
  const tracked = new Set(stdout.split('\n').filter(Boolean))

  const bad: string[] = []
  for (const f of doc.findings) {
    for (const c of f.citations) {
      const path = c.path.replace(/^\.\//, '').replace(/^\/workspace\//, '')
      if (!tracked.has(path)) bad.push(`${f.fingerprint} cites ${c.path}`)
    }
  }
  if (bad.length > 0) {
    console.error(red('citations that do not exist in the reviewed tree:'))
    for (const b of bad) console.error(`  ${b}`)
    process.exit(1)
  }
  console.log(green(`${file}: all citations grounded`))
}

/** `ogun findings schema` — what a skill prints when it needs to remind itself. */
export function findingsSchema(): void {
  console.log(bold('A findings document:'))
  console.log(EXAMPLE)
  console.log(bold('\nfingerprint'))
  console.log(
    [
      '  <area>/<surface>/<invariant>/<technique>, each a lowercase kebab-case slug.',
      '  It names the *meaning* of the issue, so the same problem found again next week',
      '  is recognised as the same finding. Deliberately excludes line numbers: a rebase',
      '  must not mint a new identity for an unchanged finding.',
    ].join('\n'),
  )
}

/** `ogun findings list` — read the inbox from the control plane. */
export async function findingsList(args: string[], serverUrl: string): Promise<void> {
  const project = argValue(args, '--project')
  const status = argValue(args, '--status') ?? 'open,triaged'
  const url = new URL('/api/findings', serverUrl)
  if (project) url.searchParams.set('project', project)
  url.searchParams.set('status', status)

  const res = await fetch(url).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { findings } = (await res.json()) as {
    findings: Array<{
      finding: { fingerprint: string; severity: string; title: string; status: string; seenCount: number; path?: string }
      project: { slug: string }
    }>
  }
  if (findings.length === 0) {
    console.log(dim('no findings'))
    return
  }
  console.log(
    table([
      [bold('SEVERITY'), bold('FINGERPRINT'), bold('SEEN'), bold('TITLE')],
      ...findings.map((f) => [
        severityColor(f.finding.severity),
        cyan(f.finding.fingerprint),
        String(f.finding.seenCount),
        f.finding.title.slice(0, 60),
      ]),
    ]),
  )
}

async function loadDocument(file: string): Promise<FindingsDocument> {
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) fail(`no such file: ${file}`)
  let json: unknown
  try {
    json = JSON.parse(raw!)
  } catch (err) {
    fail(`${file} is not valid JSON: ${(err as Error).message}`)
  }
  const doc = findingsDocumentSchema.safeParse(json)
  if (!doc.success) {
    console.error(red(`${file} does not match the findings schema:`))
    for (const issue of doc.error.issues.slice(0, 10)) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
    process.exit(1)
  }
  return doc.data
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

void rawFindingSchema

const EXAMPLE = `{
  "findings": [
    {
      "fingerprint": "security/public-orders/account-isolation/cross-account-id-swap",
      "title": "Order lookup trusts a client-supplied account id",
      "body": "getOrder() reads accountId from the request body and never checks it against the session, so any authenticated user can read any order by guessing an id.",
      "severity": "high",
      "confidence": 0.85,
      "citations": [{ "path": "src/routes/orders.ts", "line": 44 }]
    }
  ]
}`
