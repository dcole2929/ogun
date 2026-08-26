import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * Every skill Ogun ships to other repositories has to be **self-contained**, and this is
 * the one place that is checkable.
 *
 * `ensureSkillAvailable` copies a skill's own directory into the workspace and nothing
 * else. So a `SKILL.md` that says "follow the procedure at `../make-a-change/references/`"
 * resolves here — where the workspace is this whole repository — and dangles in every
 * project that names the built-in, which is the one case `skills/` exists for. The failure
 * is silent in the worst way: the agent reads "follow the procedure at …", finds nothing,
 * and proceeds without the half of the instructions that keeps a run from being lost.
 *
 * That is ADR-0015's recorded lesson, and until now it was a lesson rather than a check —
 * which lasted exactly as long as there was one modifier skill. Every reference a shipped
 * skill points at is opened here, from the directory that would actually travel.
 */
const BUILTIN_SKILLS = join(dirname(fileURLToPath(import.meta.url)), '../../../skills')

test('every built-in skill can be read from its own directory alone', async () => {
  const entries = await readdir(BUILTIN_SKILLS, { withFileTypes: true })
  const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  assert.ok(skills.length > 0, 'skills/ must contain the skills this build ships')

  for (const name of skills) {
    const dir = join(BUILTIN_SKILLS, name)
    assert.ok(existsSync(join(dir, 'SKILL.md')), `${name} has no SKILL.md`)
    /**
     * `agents/ogun.yaml` is what makes a skill schedulable at all (§4.8) — and
     * `allow_implicit_invocation: false` is the line that matters: a factory skill an
     * agent could reach for mid-task would run with no patch extraction, no gate and no
     * draft pull request behind it.
     */
    const agents = join(dir, 'agents', 'ogun.yaml')
    assert.ok(existsSync(agents), `${name} has no agents/ogun.yaml`)
    assert.match(
      await readFile(agents, 'utf8'),
      /allow_implicit_invocation:\s*false/,
      `${name} must not be auto-triggerable`,
    )

    const skillText = await readFile(join(dir, 'SKILL.md'), 'utf8')
    assert.doesNotMatch(
      skillText,
      /\.\.\//,
      `${name}'s SKILL.md points outside its own directory, which dangles in every ` +
        'project that names it (ADR-0015)',
    )

    // Every `references/<file>` any of this skill's own files names must be in this
    // skill's own directory, since that directory is the whole of what travels.
    const files = [skillText]
    const refDir = join(dir, 'references')
    if (existsSync(refDir)) {
      for (const ref of await readdir(refDir)) files.push(await readFile(join(refDir, ref), 'utf8'))
    }
    for (const body of files) {
      for (const match of body.matchAll(/`(references\/[\w./-]+)`/g)) {
        const ref = match[1]!
        assert.ok(existsSync(join(dir, ref)), `${name} names ${ref}, which it does not carry`)
      }
    }
  }
})
