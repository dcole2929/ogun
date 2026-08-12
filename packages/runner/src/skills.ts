import { appendFile, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The `inject` step from §5.1 — "inject only the skills the workspace lacks".
 *
 * A skill in the repo arrives with the workspace, but arriving is not the same as being
 * *discoverable*. Claude Code resolves skills from `.claude/skills/`; Ogun's canonical
 * location is `.agents/skills/` (§4.8). So a prompt of "Use the adversarial-review
 * skill." had nothing to resolve against, and only worked because the agent went looking
 * with `find` and happened to succeed. Codex has no skill discovery at all.
 *
 * This makes the binding real: the worker's skill is placed where the runtime looks, and
 * the caller names its concrete path in the prompt so a runtime with no skill concept
 * can still follow it.
 */
export const AGENTS_SKILLS = '.agents/skills'
export const CLAUDE_SKILLS = '.claude/skills'

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
): Promise<ResolvedSkill | null> {
  const canonical = join(AGENTS_SKILLS, skillName)
  const claudePath = join(CLAUDE_SKILLS, skillName)

  const inClaude = await exists(join(workspace, claudePath, 'SKILL.md'))
  const inAgents = await exists(join(workspace, canonical, 'SKILL.md'))

  // Already where the runtime looks: nothing to do. This is the common case for a repo
  // that keeps its skills in .claude/skills for interactive sessions too.
  if (inClaude) return { name: skillName, path: claudePath, injected: false }
  if (!inAgents) return null

  // Copy rather than symlink: the workspace is bind-mounted into a container, and a
  // symlink resolving through the host's path layout would dangle inside it.
  await mkdir(join(workspace, CLAUDE_SKILLS), { recursive: true })
  await cp(join(workspace, canonical), join(workspace, claudePath), { recursive: true })

  // Harness-created files must never reach a patch. `stageAll` runs `git add -A` before
  // grading (§5.3), so without this a modifier's diff would carry a copy of its own
  // skill — and the grounding check would accept citations into it.
  await excludeFromGit(workspace, [`/${claudePath}/`])

  return { name: skillName, path: claudePath, injected: true }
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
  for (const base of [AGENTS_SKILLS, CLAUDE_SKILLS]) {
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
