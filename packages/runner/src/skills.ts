import { appendFile, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The `inject` step from §5.1 — "inject only the skills the workspace lacks".
 *
 * A skill in the repo arrives with the workspace, but arriving is not the same as being
 * *discoverable*, and the two runtimes do not agree on where to look. Measured against
 * codex-cli 0.147.0 and Claude Code 2.1.228, with search tools disabled so only native
 * discovery could answer:
 *
 * | location          | claude | codex |
 * |-------------------|--------|-------|
 * | `.claude/skills/` | yes    | no    |
 * | `.codex/skills/`  | no     | yes   |
 * | `.agents/skills/` | no     | yes   |
 *
 * So there is no single location that both runtimes find. A skill is materialized into
 * the *running* runtime's own directory, which is also where a human using that tool
 * interactively would expect it.
 *
 * `.agents/skills/` stays canonical for authoring (§4.8): it is the one Ogun owns, it is
 * what `ogun skill new` scaffolds, and codex reading it too is a convenience rather than
 * something to depend on.
 */
export const AGENTS_SKILLS = '.agents/skills'
export const CLAUDE_SKILLS = '.claude/skills'
export const CODEX_SKILLS = '.codex/skills'

export type SkillRuntime = 'claude' | 'codex'

/** Where this runtime natively discovers skills. */
export const nativeSkillDir = (runtime: SkillRuntime): string =>
  runtime === 'claude' ? CLAUDE_SKILLS : CODEX_SKILLS

/** Every place a skill might already be, most canonical first. */
const SOURCES = [AGENTS_SKILLS, CLAUDE_SKILLS, CODEX_SKILLS]

export type ResolvedSkill = {
  name: string
  /** Workspace-relative directory the agent should read. */
  path: string
  /** True when we had to place it somewhere the runtime would find it. */
  injected: boolean
}

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

/**
 * Returns null when the skill simply is not in this repo. That is a real condition worth
 * reporting rather than papering over — a worker pointing at a skill the workspace does
 * not contain should fail loudly, not run a prompt that references nothing.
 */
export async function ensureSkillAvailable(
  workspace: string,
  skillName: string,
  runtime: SkillRuntime,
): Promise<ResolvedSkill | null> {
  const target = join(nativeSkillDir(runtime), skillName)

  // Already where this runtime looks: nothing to do. Common for a repo that keeps its
  // skills in .claude/skills for interactive sessions too.
  if (await exists(join(workspace, target, 'SKILL.md'))) {
    return { name: skillName, path: target, injected: false }
  }

  let source: string | undefined
  for (const base of SOURCES) {
    if (await exists(join(workspace, base, skillName, 'SKILL.md'))) {
      source = join(base, skillName)
      break
    }
  }
  if (!source) return null

  // Copy rather than symlink: the workspace is bind-mounted into a container, and a
  // symlink resolving through the host's path layout would dangle inside it.
  await mkdir(join(workspace, nativeSkillDir(runtime)), { recursive: true })
  await cp(join(workspace, source), join(workspace, target), { recursive: true })

  // Harness-created files must never reach a patch. `stageAll` runs `git add -A` before
  // grading (§5.3), so without this a modifier's diff would carry a copy of its own
  // skill — and the grounding check would accept citations into it.
  await excludeFromGit(workspace, [`/${target}/`])

  return { name: skillName, path: target, injected: true }
}

/**
 * `.git/info/exclude` rather than `.gitignore` — it is local to the clone and never
 * appears as a modification to the repository itself.
 */
export async function excludeFromGit(workspace: string, patterns: string[]): Promise<void> {
  const path = join(workspace, '.git', 'info', 'exclude')
  await mkdir(join(workspace, '.git', 'info'), { recursive: true })
  await appendFile(path, `\n# added by ogun\n${patterns.join('\n')}\n`)
}

/** Every skill the workspace carries, for a prompt that wants to name alternatives. */
export async function listWorkspaceSkills(workspace: string): Promise<string[]> {
  const found = new Set<string>()
  for (const base of SOURCES) {
    const dir = join(workspace, base)
    if (!(await exists(dir))) continue
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (await exists(join(dir, entry.name, 'SKILL.md')))) {
        found.add(entry.name)
      }
    }
  }
  return [...found].sort()
}
