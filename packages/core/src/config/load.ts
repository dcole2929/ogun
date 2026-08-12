import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { projectConfigSchema, type ProjectConfig } from './project.ts'
import { skillAgentConfigSchema, type SkillAgentConfig } from './skill.ts'
import { runnerConfigSchema, type RunnerConfig } from './runner.ts'

export const expandHome = (p: string): string =>
  p.startsWith('~/') ? join(homedir(), p.slice(2)) : p

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export const hashContent = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)

export type LoadedProject = {
  root: string
  configPath: string
  config: ProjectConfig
  /** Hash of the raw config text — what worker.versionHash is derived from. */
  configHash: string
}

/** Reads .ogun/config.yaml fresh. Config is never cached: an edit takes effect on the
 *  next trigger tick with no restart (§4.2). */
export async function loadProjectConfig(root: string): Promise<LoadedProject> {
  const configPath = join(root, '.ogun', 'config.yaml')
  const text = await readFile(configPath, 'utf8')
  const config = projectConfigSchema.parse(parseYaml(text))
  return { root, configPath, config, configHash: hashContent(text) }
}

export type DiscoveredSkill = {
  name: string
  /** Absolute on this machine. Only the repo-relative form is ever persisted. */
  dir: string
  /** Relative to the project root when the skill lives in the repo. */
  sourcePath: string
  origin: 'global' | 'project'
  versionHash: string
  agentConfig: SkillAgentConfig
  frontmatter: { name?: string; description?: string }
  /** The SKILL.md text. Shipped to the control plane so a UI can show it. */
  body: string
  /** Files under references/, repo-relative. Where a shared procedure lives (§4.8). */
  referencePaths: string[]
}

/**
 * Discovery order, increasing precedence (§4.8):
 *
 *   global    ~/.ogun/skills/
 *   project   <repo>/.agents/skills/  and  <repo>/.claude/skills/
 *
 * `.agents/skills/` is canonical for skills Ogun runs; `.claude/skills/` is what an
 * interactive session picks up. A later directory wins on name collision.
 */
export async function discoverSkills(projectRoot: string): Promise<DiscoveredSkill[]> {
  const sources: Array<{ dir: string; origin: 'global' | 'project'; base: string }> = [
    { dir: expandHome('~/.ogun/skills'), origin: 'global', base: expandHome('~/.ogun/skills') },
    { dir: join(projectRoot, '.agents', 'skills'), origin: 'project', base: projectRoot },
    { dir: join(projectRoot, '.claude', 'skills'), origin: 'project', base: projectRoot },
  ]

  const byName = new Map<string, DiscoveredSkill>()
  for (const source of sources) {
    if (!(await exists(source.dir))) continue
    for (const entry of await readdir(source.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(source.dir, entry.name)
      const skillMd = join(dir, 'SKILL.md')
      if (!(await exists(skillMd))) continue

      const md = await readFile(skillMd, 'utf8')
      const agentConfig = await readAgentConfig(dir)
      const sourcePath = source.origin === 'project' ? dir.slice(source.base.length + 1) : dir
      const references = await listReferences(dir, sourcePath)
      byName.set(entry.name, {
        name: entry.name,
        dir,
        sourcePath,
        origin: source.origin,
        versionHash: hashContent(md, JSON.stringify(agentConfig), references.join(',')),
        agentConfig,
        frontmatter: parseFrontmatter(md),
        body: md,
        referencePaths: references,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Only one level deep — a skill's references are a flat set of documents, and walking
 *  arbitrarily deep would sweep up whatever else someone parked in the directory. */
async function listReferences(skillDir: string, sourcePath: string): Promise<string[]> {
  const dir = join(skillDir, 'references')
  if (!(await exists(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => `${sourcePath}/references/${e.name}`)
    .sort()
}

async function readAgentConfig(skillDir: string): Promise<SkillAgentConfig> {
  const agentsDir = join(skillDir, 'agents')
  if (await exists(agentsDir)) {
    const files = (await readdir(agentsDir)).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
    )
    // ogun.yaml wins if present, otherwise first alphabetically — matches how other
    // tools keep one file per consuming agent in the same directory.
    const pick = files.find((f) => f.startsWith('ogun.')) ?? files.sort()[0]
    if (pick) {
      const text = await readFile(join(agentsDir, pick), 'utf8')
      return skillAgentConfigSchema.parse(parseYaml(text) ?? {})
    }
  }
  return skillAgentConfigSchema.parse({})
}

/** Minimal frontmatter reader — a full YAML parse of arbitrary SKILL.md frontmatter
 *  would fail on the ones that put unquoted colons in a description. */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of md.slice(4, end).split('\n')) {
    const m = /^(name|description):\s*(.*)$/.exec(line)
    if (!m) continue
    const value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (m[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}

export async function loadRunnerConfig(path?: string): Promise<RunnerConfig> {
  const file = expandHome(path ?? process.env.OGUN_RUNNER_CONFIG ?? '~/.ogun/runner.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  const config = runnerConfigSchema.parse(raw)
  return {
    ...config,
    scratch: expandHome(config.scratch),
    projects: Object.fromEntries(
      Object.entries(config.projects).map(([k, v]) => [k, resolve(expandHome(v))]),
    ),
  }
}
