import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  findingsDocumentSchema,
  parseFingerprint,
  writeSecretFile,
  type FindingsDocument,
} from '@ogun/core'
import { bold, cyan, dim, fail, green, red, severityColor, table } from '../output.ts'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'

/**
 * The CLI owns every format the agent touches (§4.10). A skill never asks an agent to
 * produce well-formed JSON in prose — it shells out to these subcommands. An agent that
 * free-hands its output format produces a different shape every night and nothing
 * downstream can depend on it.
 */

const HISTORY_INDEX = '.ogun-in/history.json'
const OUTPUT_PATH = process.env.OGUN_OUTPUT_PATH ?? '.ogun-out/findings.json'

/**
 * The inbox that goes with a given output document: `.ogun-in/` is the sibling of the
 * `.ogun-out/` being written into, which is how the runner mounts the pair.
 *
 * Derived from the *resolved target* rather than from `OUTPUT_PATH`, and the difference
 * is not theoretical. `OUTPUT_PATH` is the default before `--out` has been consulted, and
 * in a sandbox it is the absolute `/workspace/.ogun-out/findings.json` the image sets —
 * so the remarks below read `/workspace/.ogun-in/` no matter where the caller asked the
 * document to go. Somebody writing a document elsewhere got remarks about a different
 * repository's inbox, or none.
 */
const historyIndexFor = (target: string): string => join(dirname(target), '..', HISTORY_INDEX)

/** `ogun findings write` — reads a findings document on stdin, validates, writes it. */
export async function findingsWrite(args: string[]): Promise<void> {
  const { flags } = parse(args, { '--out': 'string' }, 'ogun findings write [--out <file>]')
  const target = resolve(flags.out ?? OUTPUT_PATH)
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

  for (const a of doc.data.adjudications ?? []) {
    const fp = parseFingerprint(a.fingerprint)
    if (!fp.ok) fail(`bad fingerprint "${a.fingerprint}" in adjudications: ${fp.error}`)
    if (a.verdict === 'duplicate-of' && !parseFingerprint(a.duplicateOf).ok) {
      fail(`bad duplicateOf "${a.duplicateOf}" on ${a.fingerprint}`)
    }
  }

  await mkdir(dirname(target), { recursive: true })
  await writeSecretFile(target, `${JSON.stringify(doc.data, null, 2)}\n`)

  const n = doc.data.findings.length
  const verdicts = doc.data.adjudications?.length ?? 0
  const parts = [
    n === 0
      ? // A clean result and a run that never happened are different facts (§4.11).
        'a clean review (0 findings)'
      : `${n} finding${n === 1 ? '' : 's'}`,
    ...(verdicts > 0 ? [`${verdicts} verdict${verdicts === 1 ? '' : 's'}`] : []),
  ]
  console.log(green(`recorded ${parts.join(' and ')} to ${target}`))

  await remarkOnUnjudgedHistory(target, verdicts)
  await remarkOnDismissedRepeats(target, doc.data)
}

/**
 * Say when a document leaves the inbox untouched.
 *
 * Not a refusal — plenty of runs have nothing defensible to say about old findings, and a
 * gate here would push an agent into inventing verdicts, which is far worse than leaving
 * a finding open. But silence at this moment is what let two nights pass with nine
 * already-fixed findings sitting in the inbox: the write succeeded, said "recorded 1
 * finding", and nothing indicated half the job had gone undone.
 *
 * Printed at the one moment the agent can still act on it, and phrased as the count
 * rather than an instruction — the skill says what to do; this says what is true.
 */
async function remarkOnUnjudgedHistory(target: string, verdicts: number): Promise<void> {
  if (verdicts > 0) return
  const index = await readFile(historyIndexFor(target), 'utf8').catch(() => null)
  if (!index) return
  const known = (JSON.parse(index) as { findings?: unknown[] }).findings?.length ?? 0
  if (known === 0) return
  console.log(
    dim(
      `note: ${HISTORY_INDEX} lists ${known} finding${known === 1 ? '' : 's'} already in the ` +
        'inbox and this document judges none of them.',
    ),
  )
}

/**
 * Say when a document re-files something a person already dismissed.
 *
 * Not a refusal, for the same reason as above — and because refusing would be pointless:
 * the control plane suppresses the sighting whether or not this printed anything, so the
 * row is going nowhere either way (§4.11, ADR-0011). What the agent loses by not knowing
 * is the chance to spend the finding usefully. Two moves are open to it and neither is
 * re-filing: if the same problem genuinely returned *worse* than it was dismissed, the
 * severity it reports is what lapses the dismissal, and if this is one bug the reviewers
 * keep rephrasing, a `duplicate-of` verdict is the only thing in the system that can
 * teach a new fingerprint it belongs to an old decision.
 *
 * Printed at the one moment the agent can still act on it, and phrased as what is true
 * rather than as an instruction — the skill says what to do.
 */
async function remarkOnDismissedRepeats(
  target: string,
  doc: { findings: Array<{ fingerprint: string }> },
): Promise<void> {
  if (doc.findings.length === 0) return
  const index = await readFile(historyIndexFor(target), 'utf8').catch(() => null)
  if (!index) return
  const parsed = JSON.parse(index) as { findings?: Array<{ fingerprint?: string; status?: string }> }
  const dismissed = new Set(
    (parsed.findings ?? []).filter((f) => f.status === 'wontfix').map((f) => f.fingerprint),
  )
  const repeats = doc.findings.filter((f) => dismissed.has(f.fingerprint)).map((f) => f.fingerprint)
  if (repeats.length === 0) return
  console.log(
    dim(
      `note: ${repeats.length} of these ${repeats.length === 1 ? 'is' : 'are'} already dismissed ` +
        `(${repeats.join(', ')}) and will be suppressed rather than published.`,
    ),
  )
}

/** `ogun validate-findings <file>` — the schema tool check, runnable as a verify lens. */
export async function validateFindings(args: string[]): Promise<void> {
  const { first } = parse(args, {}, 'ogun validate-findings [file]')
  const file = resolve(first ?? OUTPUT_PATH)
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
  const { first } = parse(args, {}, 'ogun check-citations [file]')
  const file = resolve(first ?? OUTPUT_PATH)
  const doc = await loadDocument(file)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const { stdout } = await run('git', ['ls-files'], { maxBuffer: 32 * 1024 * 1024 })
  const tracked = new Set(stdout.split('\n').filter(Boolean))
  const lineCounts = new Map<string, number>()

  const bad: string[] = []
  for (const f of doc.findings) {
    for (const c of f.citations) {
      const path = c.path.replace(/^\.\//, '').replace(/^\/workspace\//, '')
      if (!tracked.has(path)) {
        bad.push(`${f.fingerprint} cites ${c.path}, which is not in the tree`)
        continue
      }
      // The line half matters as much as the path: a confabulated finding names a real
      // file at an invented location, and a path-only check waves that through.
      const end = c.endLine ?? c.line
      if (end === undefined) continue
      let lines = lineCounts.get(path)
      if (lines === undefined) {
        const text = await readFile(path, 'utf8').catch(() => null)
        if (text === null) continue
        lines = text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length
        lineCounts.set(path, lines)
      }
      if (end > lines) {
        bad.push(`${f.fingerprint} cites ${c.path}:${end}, but that file has ${lines} lines`)
      }
    }
  }
  if (bad.length > 0) {
    console.error(red('citations that do not hold up:'))
    for (const b of bad) console.error(`  ${b}`)
    process.exit(1)
  }
  console.log(green(`${file}: all citations grounded`))
}

/** `ogun findings schema` — what a skill prints when it needs to remind itself. */
/**
 * The whole document, not the half of it a reviewer uses.
 *
 * This command is what §4.10 means by "the CLI owns every format the agent touches", and
 * the skills point an agent here to confirm the shape. So a field that exists in the
 * schema and not in this output is a field that does not exist: `adjudications` shipped
 * without being described here, and triage — which had been told to emit them, checked
 * the authority, and found nothing — correctly emitted none. Two nights of an inbox with
 * nine already-fixed findings in it, because the format was documented in one place and
 * owned in another.
 */
export function findingsSchema(): void {
  console.log(bold('A findings document:'))
  console.log(EXAMPLE)

  console.log(bold('\nfindings') + dim('  — what you found this run'))
  console.log(
    [
      '  Every finding cites a real path and line in the tree you are looking at. A',
      '  citation that is not there fails the grounding check and discards the whole',
      "  run's output, so check them rather than reconstructing them from memory.",
    ].join('\n'),
  )

  console.log(bold('\nfingerprint'))
  console.log(
    [
      '  <area>/<surface>/<invariant>/<technique>, each a lowercase kebab-case slug.',
      '  It names the *meaning* of the issue, so the same problem found again next week',
      '  is recognised as the same finding. Deliberately excludes line numbers: a rebase',
      '  must not mint a new identity for an unchanged finding.',
    ].join('\n'),
  )

  console.log(bold('\nadjudications') + dim('  — verdicts on findings that already exist'))
  console.log(
    [
      '  Optional, and only a node that publishes may use them — a reviewer feeding',
      '  triage stages its verdicts like everything else. The inbox you are judging is',
      '  at .ogun-in/history.json, with the full write-ups under .ogun-in/history/.',
      '',
      `  ${bold('still-applies')}         you read the code and the problem is still there`,
      `  ${bold('fixed')}                 the code now upholds the invariant — needs citations`,
      `  ${bold('no-longer-applicable')}  the surface is gone: file deleted, path restructured`,
      `  ${bold('duplicate-of')}          same invariant as another finding — needs duplicateOf`,
      '',
      '  Every verdict carries a `reason` in your own words, including still-applies:',
      '  "I checked and it still holds" is a result, and without it "still broken" and',
      '  "nobody has looked since March" are the same row.',
      '',
      '  A `fixed` citation is checked exactly as a finding\'s is. Closing something is as',
      '  consequential as opening it, and it is the direction with no reviewer after you.',
      '',
      `  ${dim('wontfix is not a verdict. A person decided to accept that risk.')}`,
      '',
      '  duplicate-of is also how a dismissal reaches a rephrasing. A sighting of a',
      '  dismissed finding is suppressed by exact fingerprint, so one bug described four',
      '  ways stays noisy until you say the four are one. That verdict is the only thing',
      '  in the system that can say it.',
    ].join('\n'),
  )

  console.log(bold('\nnotes') + dim('  — what a reader needs that is not a finding'))
  console.log(
    [
      '  A degraded night belongs here, naming the workers that did not run. An inbox',
      '  with three findings from four reviewers looks identical to one from three',
      '  reviewers, and they mean different things.',
    ].join('\n'),
  )
}

/** `ogun findings list` — read the inbox from the control plane. */
export async function findingsList(args: string[], serverUrl: string): Promise<void> {
  const { flags } = parse(
    args,
    { '--project': 'string', '--status': 'string' },
    'ogun findings list [--project <slug>] [--status <a,b>]',
  )
  const project = flags.project
  const status = flags.status ?? 'open,triaged'
  const url = new URL('/api/findings', serverUrl)
  if (project) url.searchParams.set('project', project)
  url.searchParams.set('status', status)

  const res = await fetch(url, { headers: await authHeaders() }).catch(() => null)
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
  ],
  "adjudications": [
    {
      "fingerprint": "security/invites/single-use/toctou",
      "verdict": "fixed",
      "reason": "redemption is now one conditional UPDATE, so exactly one racer wins",
      "citations": [{ "path": "src/routes/runners.ts", "line": 168 }]
    }
  ],
  "notes": "security-review crashed, so nothing looked at the auth surface tonight."
}`
