import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { bold, cyan, dim, fail, green } from '../output.ts'

/**
 * `ogun skill new <name>` — scaffold a skill in the repo.
 *
 * Skills are authored here, not in the UI: they are prose, they belong in git, and they
 * are the thing you actually iterate on. The scaffold's job is to make the shape obvious
 * and to leave the parts that need thought clearly unfinished, rather than filling them
 * with plausible defaults you would forget to replace.
 */
export async function skillNew(args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith('--'))
  if (!name) fail('usage: ogun skill new <name> [--dir <repo>]')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`"${name}" must be a lowercase kebab-case slug — it becomes a directory and a config key`)
  }

  const root = resolve(argValue(args, '--dir') ?? process.cwd())
  const dir = join(root, '.agents', 'skills', name)
  if (existsSync(dir)) fail(`${relative(root, dir)} already exists`)

  const title = name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())

  await mkdir(join(dir, 'agents'), { recursive: true })
  await mkdir(join(dir, 'references'), { recursive: true })

  await writeFile(join(dir, 'SKILL.md'), skillMd(name, title))
  await writeFile(join(dir, 'agents', 'ogun.yaml'), agentYaml(name, title))

  // The shared procedure is a pointer, not a copy. Seventeen reviewers stay consistent
  // because there is one procedure, not seventeen (§4.8).
  const shared = join(root, '.agents', 'skills', 'adversarial-review', 'references', 'running-a-review.md')
  const sharedNote = existsSync(shared)
    ? `See ../adversarial-review/references/running-a-review.md — the shared procedure every
review skill delegates to. Do not copy it here; reference it.\n`
    : `Put anything this skill shares with other skills here, and reference it from
SKILL.md rather than inlining it.\n`
  await writeFile(join(dir, 'references', 'README.md'), sharedNote)

  console.log(green(`created ${relative(root, dir)}`))
  console.log(dim('  SKILL.md            the mission — edit this first'))
  console.log(dim('  agents/ogun.yaml    display name, default prompt, invocation policy'))
  console.log(dim('  references/         shared procedure and background'))
  console.log(`\n${bold('Next')}`)
  console.log(`  1. write the mission in ${cyan(`${relative(root, dir)}/SKILL.md`)}`)
  console.log(`  2. ${cyan('ogun project sync')} to index it`)
  console.log(`  3. create a worker pointing at it, in the UI or in .ogun/config.yaml`)
}

const skillMd = (name: string, title: string): string => `---
name: ${name}
description: TODO — one sentence on what this looks for and when it runs. This is what an agent reads to decide whether the skill applies, so be concrete.
---

# ${title}

TODO — what question does this skill ask that a normal review does not? One paragraph.
If you cannot answer that, this is probably a variation of an existing skill rather
than a new one.

## Procedure

Follow \`references/running-a-review.md\` for orientation, novelty rules, grounding, and
publication. It owns the parts every review shares. This file owns only the mission
below.

## Mission

TODO — what to look at, and how deep to go. Be specific about scope: breadth is the
usual failure mode, and a skill that says "look for problems" produces a dozen shallow
observations instead of one demonstrated bug.

## Evidence standard

A finding must name a concrete change. Every finding cites a real \`path\` and \`line\` in
the tree being reviewed — a citation that does not exist fails the grounding check and
the whole run's findings are discarded.

TODO — what counts as proof *for this discipline*? A security finding needs an attack
path; a performance finding needs a measurement.

## Out of scope

- Style, formatting, naming. A linter does this better and for free.
- Anything an ADR already settled. Read \`docs/adr/\` first.
- TODO — what else would be noise from this particular skill?

## Severity

Calibrate against consequence, not effort.

| | |
|---|---|
| \`critical\` | TODO |
| \`high\` | TODO |
| \`medium\` | TODO |
| \`low\` | TODO |
| \`info\` | Worth knowing, not worth doing anything about today |

If you are hesitating between two levels, pick the lower one. A reviewer that grades
everything \`high\` has said nothing.

## Finishing

Write findings with the CLI — never by hand:

\`\`\`sh
ogun findings write <<'JSON'
{ "findings": [ ... ] }
JSON
\`\`\`

If you looked and found nothing, still write the file with an empty array. A clean
review and a review that never happened are different facts.
`

const agentYaml = (name: string, title: string): string => `interface:
  display_name: "${title}"
  short_description: "TODO — one line, shown in the skills list and the worker form"
  default_prompt: "Use the ${name} skill."
policy:
  # A factory skill must never be auto-triggered by an agent mid-task. It runs when
  # Ogun says so, and only then.
  allow_implicit_invocation: false
`

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
