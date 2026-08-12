import { appendFile, cp, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

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

/** Places inside the workspace a skill might already be. Repo skills win. */
const WORKSPACE_SOURCES = [AGENTS_SKILLS, CLAUDE_SKILLS, CODEX_SKILLS]

/**
 * Roots outside the workspace to fall back to, in decreasing precedence. This is the
 * half of §5.1's inject step that was missing: a skill that is not in the repo has to
 * come from somewhere, or a worker pointing at a universal skill fails at run time even
 * though `ogun project sync` happily indexed it.
 */
export type SkillSearchPath = { root: string; origin: 'machine' | 'builtin' }

export type ResolvedSkill = {
  name: string
  /** Workspace-relative directory the agent should read. */
  path: string
  /** True when we had to place it somewhere the runtime would find it. */
  injected: boolean
  /** Where it came from, which is worth recording — a run's behaviour depends on it. */
  origin: 'project' | 'machine' | 'builtin'
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
  searchPaths: SkillSearchPath[] = [],
): Promise<ResolvedSkill | null> {
  const target = join(nativeSkillDir(runtime), skillName)

  // Already where this runtime looks: nothing to do. Common for a repo that keeps its
  // skills in .claude/skills for interactive sessions too.
  if (await exists(join(workspace, target, 'SKILL.md'))) {
    return { name: skillName, path: target, injected: false, origin: 'project' }
  }

  // The repo first, always. What "security review" means is a property of the codebase,
  // so a repo defining a skill by that name must beat a universal one.
  let source: string | undefined
  let origin: ResolvedSkill['origin'] = 'project'
  for (const base of WORKSPACE_SOURCES) {
    if (await exists(join(workspace, base, skillName, 'SKILL.md'))) {
      source = join(workspace, base, skillName)
      break
    }
  }

  if (!source) {
    for (const path of searchPaths) {
      if (await exists(join(path.root, skillName, 'SKILL.md'))) {
        source = join(path.root, skillName)
        origin = path.origin
        break
      }
    }
  }
  if (!source) return null

  // Copy rather than symlink: the workspace is bind-mounted into a container, and a
  // symlink resolving through the host's path layout would dangle inside it — which is
  // also why a builtin cannot simply be mounted from wherever Ogun is installed.
  await mkdir(join(workspace, nativeSkillDir(runtime)), { recursive: true })
  await cp(source, join(workspace, target), { recursive: true })

  // Harness-created files must never reach a patch. `stageAll` runs `git add -A` before
  // grading (§5.3), so without this a modifier's diff would carry a copy of its own
  // skill — and the grounding check would accept citations into it.
  await excludeFromGit(workspace, [`/${target}/`])

  return { name: skillName, path: target, injected: true, origin }
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

/** Every skill reachable for this run, for an error that names the alternatives. */
export async function listAvailableSkills(
  workspace: string,
  searchPaths: SkillSearchPath[] = [],
): Promise<string[]> {
  const found = new Set<string>()
  const roots = [
    ...WORKSPACE_SOURCES.map((b) => join(workspace, b)),
    ...searchPaths.map((p) => p.root),
  ]
  for (const dir of roots) {
    if (!(await exists(dir))) continue
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (await exists(join(dir, entry.name, 'SKILL.md')))) {
        found.add(entry.name)
      }
    }
  }
  return [...found].sort()
}

/**
 * Where a runner looks when a skill is not in the repo. Ogun's built-in library travels
 * with the install, so every machine running the same version resolves the same skill —
 * unlike `~/.ogun/skills`, which is yours alone and will differ between your laptop and
 * the always-on box.
 */
export function defaultSearchPaths(): SkillSearchPath[] {
  return [
    { root: expandHome('~/.ogun/skills'), origin: 'machine' },
    // `skills/`, not `.agents/skills/`. The latter is Ogun reviewing itself, which is
    // the same relationship any project has to its own skills — it would make no sense
    // to ship those to other repositories.
    { root: fileURLToPath(new URL('../../../skills', import.meta.url)), origin: 'builtin' },
  ]
}
