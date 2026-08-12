import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { ensureSkillAvailable, listAvailableSkills, nativeSkillDir } from '../src/skills.ts'

const run = promisify(execFile)

/**
 * "Use the adversarial-review skill." is only a real instruction if the runtime can
 * resolve that name — and the two runtimes disagree about where to look. Measured with
 * search tools disabled, so only native discovery could answer:
 *
 *   .claude/skills  claude yes, codex no
 *   .codex/skills   claude no,  codex yes
 *   .agents/skills  claude no,  codex yes
 *
 * There is no shared location, so the destination depends on which runtime is running.
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

test('a skill goes to the running runtime\'s own directory, not a shared one', async () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const dir = await workspace({ '.agents/skills/review/SKILL.md': '# review' })
    const resolved = await ensureSkillAvailable(dir, 'review', runtime)

    assert.equal(resolved?.injected, true)
    assert.equal(resolved?.path, `${nativeSkillDir(runtime)}/review`)
    assert.equal(await readFile(join(dir, resolved!.path, 'SKILL.md'), 'utf8'), '# review')
  }
})

test('the other runtime\'s directory is not a source of truth by accident', async () => {
  // A skill sitting only in .claude/skills is still usable by a codex worker — it just
  // has to be copied across, because codex cannot see that directory.
  const dir = await workspace({ '.claude/skills/review/SKILL.md': '# review' })
  const resolved = await ensureSkillAvailable(dir, 'review', 'codex')
  assert.equal(resolved?.path, '.codex/skills/review')
  assert.equal(resolved?.injected, true)
})

test('references come along, since the shared procedure lives there', async () => {
  const dir = await workspace({
    '.agents/skills/review/SKILL.md': '# review',
    '.agents/skills/review/references/running-a-review.md': '# procedure',
  })
  await ensureSkillAvailable(dir, 'review', 'claude')
  assert.equal(
    await readFile(join(dir, '.claude/skills/review/references/running-a-review.md'), 'utf8'),
    '# procedure',
  )
})

test('a skill already where the runtime looks is left alone', async () => {
  const dir = await workspace({ '.claude/skills/review/SKILL.md': '# already here' })
  const resolved = await ensureSkillAvailable(dir, 'review', 'claude')
  assert.equal(resolved?.injected, false)
  assert.equal(resolved?.path, '.claude/skills/review')
})

test('a missing skill is null, so the run can fail loudly', async () => {
  const dir = await workspace({ '.agents/skills/other/SKILL.md': '# other' })
  assert.equal(await ensureSkillAvailable(dir, 'review', 'claude'), null)
  // And the caller can say what *is* available, which is the useful half of the error.
  assert.deepEqual(await listAvailableSkills(dir), ['other'])
})

test('a directory without SKILL.md is not a skill', async () => {
  const dir = await workspace({ '.agents/skills/notaskill/README.md': 'nope' })
  assert.equal(await ensureSkillAvailable(dir, 'notaskill', 'claude'), null)
  assert.deepEqual(await listAvailableSkills(dir), [])
})

test('an injected skill never reaches a patch', async () => {
  // stageAll runs `git add -A` before grading, so without the exclude a modifier's diff
  // would carry a copy of its own skill.
  const dir = await workspace({ '.agents/skills/review/SKILL.md': '# review' })
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

  await ensureSkillAvailable(dir, 'review', 'claude')
  await run('git', ['-C', dir, 'add', '-A'])

  const { stdout } = await run('git', ['-C', dir, 'status', '--porcelain'])
  assert.equal(stdout.trim(), '', 'the injected copy showed up as a change')
})

/**
 * "Some skills are universal but many are per repo." Both have to work, and the repo has
 * to win — what "security review" means is a property of the codebase, not of the tool.
 */
test('a skill the repo does not have comes from the builtin library', async () => {
  const dir = await workspace({ 'README.md': '# empty repo' })
  const library = await workspace({ 'security-review/SKILL.md': '# universal' })

  const resolved = await ensureSkillAvailable(dir, 'security-review', 'claude', [
    { root: library, origin: 'builtin' },
  ])
  assert.equal(resolved?.origin, 'builtin')
  assert.equal(await readFile(join(dir, resolved!.path, 'SKILL.md'), 'utf8'), '# universal')
})

test('a repo skill overrides a builtin of the same name', async () => {
  const dir = await workspace({ '.agents/skills/security-review/SKILL.md': '# this repo' })
  const library = await workspace({ 'security-review/SKILL.md': '# universal' })

  const resolved = await ensureSkillAvailable(dir, 'security-review', 'claude', [
    { root: library, origin: 'builtin' },
  ])
  assert.equal(resolved?.origin, 'project', 'the repo must win')
  assert.equal(await readFile(join(dir, resolved!.path, 'SKILL.md'), 'utf8'), '# this repo')
})

test('a machine-local skill beats a builtin but loses to the repo', async () => {
  const machine = await workspace({ 'review/SKILL.md': '# mine' })
  const library = await workspace({ 'review/SKILL.md': '# universal' })
  const paths = [
    { root: machine, origin: 'machine' as const },
    { root: library, origin: 'builtin' as const },
  ]

  const empty = await workspace({ 'README.md': 'x' })
  assert.equal((await ensureSkillAvailable(empty, 'review', 'claude', paths))?.origin, 'machine')

  const withRepo = await workspace({ '.agents/skills/review/SKILL.md': '# repo' })
  assert.equal((await ensureSkillAvailable(withRepo, 'review', 'claude', paths))?.origin, 'project')
})

test('the error names skills from every source, not just the repo', async () => {
  const dir = await workspace({ '.agents/skills/local-only/SKILL.md': '# a' })
  const library = await workspace({ 'universal/SKILL.md': '# b' })
  assert.deepEqual(await listAvailableSkills(dir, [{ root: library, origin: 'builtin' }]), [
    'local-only',
    'universal',
  ])
})
