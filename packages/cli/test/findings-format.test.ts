import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { findingsDocumentSchema } from '@ogun/core'

/**
 * §4.10: "The CLI owns every format the agent touches." A skill points an agent at
 * `ogun findings schema` to confirm the shape, so a field the schema accepts and this
 * command does not describe is, from the agent's side, a field that does not exist.
 *
 * That is not hypothetical. `adjudications` shipped documented in the skill and absent
 * from this output, and triage — told to emit them, checking the authority, finding
 * nothing — emitted none for two nights while nine already-fixed findings sat in the
 * inbox. This test is the thing that would have caught it.
 */
test('every top-level field of the document is described by `ogun findings schema`', async () => {
  const { findingsSchema } = await import('../src/commands/findings.ts')

  const printed: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void printed.push(args.join(' '))
  try {
    findingsSchema()
  } finally {
    console.log = log
  }
  const out = printed.join('\n')

  // Derived from the schema rather than hand-listed, so a field added later fails here
  // instead of being silently undocumented — which is the whole failure mode.
  for (const field of Object.keys(findingsDocumentSchema.shape)) {
    assert.ok(out.includes(field), `\`ogun findings schema\` never mentions "${field}"`)
  }
})

/**
 * The example is what an agent copies. If it parses, the shape it teaches is real; if it
 * does not, the command is confidently handing out something the validator will reject.
 */
test('the example the command prints is itself a valid document', async () => {
  const { findingsSchema } = await import('../src/commands/findings.ts')
  const printed: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void printed.push(args.join(' '))
  try {
    findingsSchema()
  } finally {
    console.log = log
  }

  const text = printed.join('\n')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const parsed = findingsDocumentSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
  assert.ok(parsed.success, `the printed example does not validate: ${parsed.error?.message}`)
  assert.equal(parsed.data?.adjudications?.length, 1, 'the example should show a verdict')
})

/** Every verdict the schema accepts should be findable in the help, or it is unreachable. */
test('each verdict is named in the output', async () => {
  const { findingsSchema } = await import('../src/commands/findings.ts')
  const printed: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void printed.push(args.join(' '))
  try {
    findingsSchema()
  } finally {
    console.log = log
  }
  const out = printed.join('\n')
  for (const verdict of ['still-applies', 'fixed', 'no-longer-applicable', 'duplicate-of']) {
    assert.ok(out.includes(verdict), `verdict "${verdict}" is not documented`)
  }
})
