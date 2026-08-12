import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { ensureSkillAvailable, listWorkspaceSkills } from '../src/skills.ts'

const run = promisify(execFile)

/**
 * "Use the adversarial-review skill." is only a real instruction if the runtime can
 * resolve that name. Claude Code searches `.claude/skills/`; ogun's canonical location
 * is `.agents/skills/`. Without this step the prompt pointed at nothing and worked only
 * because the agent went hunting with `find`.
 */
const workspace = async (layout: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-skills-'))
  await run('git', ['-C', dir, 'init', '-q'])
  for (const [path, body] of Object.entries(layout)) {
    await mkdir(join(dir, path, '..'), { recursive: true }).catch(() => {})
    await mkdir(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(dir, path), body)
  }
  return dir
}

test('a skill in .agents/skills is placed where the runtime looks', async () => {
  const dir = await workspace({ '.agents/skills/review/SKILL.md': '# review' })
  const resolved = await ensureSkillAvailable(dir, 'review')

  assert.equal(resolved?.injected, true)
  assert.equal(resolved?.path, '.claude/skills/review')
  assert.equal(await readFile(join(dir, '.claude/skills/review/SKILL.md'), 'utf8'), '# review')
})

test('references come along, since the shared procedure lives there', async () => {
  const dir = await workspace({
    '.agents/skills/review/SKILL.md': '# review',
    '.agents/skills/review/references/running-a-review.md': '# procedure',
  })
  await ensureSkillAvailable(dir, 'review')
  assert.equal(
    await readFile(join(dir, '.claude/skills/review/references/running-a-review.md'), 'utf8'),
    '# procedure',
  )
})

test('a skill already where the runtime looks is left alone', async () => {
  const dir = await workspace({ '.claude/skills/review/SKILL.md': '# already here' })
  const resolved = await ensureSkillAvailable(dir, 'review')
  assert.equal(resolved?.injected, false)
  assert.equal(resolved?.path, '.claude/skills/review')
})

test('a missing skill is null, so the run can fail loudly', async () => {
  const dir = await workspace({ '.agents/skills/other/SKILL.md': '# other' })
  assert.equal(await ensureSkillAvailable(dir, 'review'), null)
  // And the caller can say what *is* available, which is the useful half of the error.
  assert.deepEqual(await listWorkspaceSkills(dir), ['other'])
})

test('a directory without SKILL.md is not a skill', async () => {
  const dir = await workspace({ '.agents/skills/notaskill/README.md': 'nope' })
  assert.equal(await ensureSkillAvailable(dir, 'notaskill'), null)
  assert.deepEqual(await listWorkspaceSkills(dir), [])
})

test('an injected skill never reaches a patch', async () => {
  // stageAll runs `git add -A` before grading, so without the exclude a modifier's diff
  // would carry a copy of its own skill.
  const dir = await workspace({ '.agents/skills/review/SKILL.md': '# review' })
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

  await ensureSkillAvailable(dir, 'review')
  await run('git', ['-C', dir, 'add', '-A'])

  const { stdout } = await run('git', ['-C', dir, 'status', '--porcelain'])
  assert.equal(stdout.trim(), '', 'the injected copy showed up as a change')
})
