import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { linkForRuntimes } from '../src/commands/skill-new.ts'

const run = promisify(execFile)

/**
 * No directory is read by both runtimes — measured, with the agents' own search tools
 * disabled so only native discovery could answer:
 *
 *   .claude/skills   claude yes, codex no
 *   .codex/skills    claude no,  codex yes
 *   .agents/skills   claude no,  codex yes
 *
 * `.agents/skills` reads as neutral and is not. Authoring there alone means Claude Code
 * cannot see the skill when you open the repo yourself, which is what these links fix.
 */
const repo = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-link-'))
  await run('git', ['-C', dir, 'init', '-q'])
  await mkdir(join(dir, '.agents/skills/review'), { recursive: true })
  await writeFile(join(dir, '.agents/skills/review/SKILL.md'), '# review')
  return dir
}

test('one authored skill is linked into both runtime directories', async () => {
  const dir = await repo()
  const linked = await linkForRuntimes(dir, 'review')
  assert.deepEqual(linked, ['.claude/skills/review', '.codex/skills/review'])

  for (const d of ['.claude/skills/review', '.codex/skills/review']) {
    assert.ok((await lstat(join(dir, d))).isSymbolicLink(), `${d} should be a link`)
    assert.equal(await readFile(join(dir, d, 'SKILL.md'), 'utf8'), '# review')
  }
})

test('the link is relative, so it survives being moved', async () => {
  // An absolute link would dangle inside a container bind-mount, where the workspace is
  // at /workspace rather than wherever it lives on the host.
  const dir = await repo()
  await linkForRuntimes(dir, 'review')
  const target = await readlink(join(dir, '.claude/skills/review'))
  assert.equal(target, '../../.agents/skills/review')
  assert.ok(!target.startsWith('/'), 'must not be absolute')
})

test('it survives git and a workspace clone', async () => {
  const dir = await repo()
  await linkForRuntimes(dir, 'review')
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'])

  // Stored as mode 120000 — a symlink, not a text file containing a path.
  const { stdout } = await run('git', ['-C', dir, 'ls-files', '-s', '.claude/skills/review'])
  assert.match(stdout, /^120000 /)

  const clone = await mkdtemp(join(tmpdir(), 'ogun-clone-'))
  await run('git', ['clone', '-q', '--local', '--no-hardlinks', dir, clone])
  assert.equal(await readFile(join(clone, '.claude/skills/review/SKILL.md'), 'utf8'), '# review')
})

test('an existing directory is left alone', async () => {
  // A repo that already keeps a real skill in .claude/skills must not have it replaced
  // by a link to a different one.
  const dir = await repo()
  await mkdir(join(dir, '.claude/skills/review'), { recursive: true })
  await writeFile(join(dir, '.claude/skills/review/SKILL.md'), '# the real one')

  const linked = await linkForRuntimes(dir, 'review')
  assert.deepEqual(linked, ['.codex/skills/review'])
  assert.equal(
    await readFile(join(dir, '.claude/skills/review/SKILL.md'), 'utf8'),
    '# the real one',
  )
})

test('linking twice is a no-op', async () => {
  const dir = await repo()
  await linkForRuntimes(dir, 'review')
  assert.deepEqual(await linkForRuntimes(dir, 'review'), [])
})

/**
 * Ogun's own shipped library lives in `skills/`, and is useful against Ogun itself. It is
 * in-tree here, so a relative link is safe; in *another* project a builtin is copied into
 * the workspace by the runner instead, because a link out to wherever Ogun is installed
 * would dangle in a container and break on another machine.
 */
test('a shipped skill is linked from its own directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ogun-shipped-'))
  await mkdir(join(dir, 'skills/adversarial-review'), { recursive: true })
  await writeFile(join(dir, 'skills/adversarial-review/SKILL.md'), '# shipped')

  const linked = await linkForRuntimes(dir, 'adversarial-review', 'skills')
  assert.deepEqual(linked, [
    '.claude/skills/adversarial-review',
    '.codex/skills/adversarial-review',
  ])
  assert.equal(
    await readlink(join(dir, '.claude/skills/adversarial-review')),
    '../../skills/adversarial-review',
  )
  assert.equal(
    await readFile(join(dir, '.claude/skills/adversarial-review/SKILL.md'), 'utf8'),
    '# shipped',
  )
})
