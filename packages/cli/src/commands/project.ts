import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { discoverSkills, expandHome, loadProjectConfig } from '@ogun/core'
import { bold, cyan, dim, fail, green, table } from '../output.ts'
import { authHeaders } from '../auth.ts'

const run = promisify(execFile)

/**
 * `ogun project sync` — read the repo's .ogun/config.yaml and its skills, then post the
 * resolved config to the control plane. The CLI is the thing with filesystem access to
 * a project; the server never touches one, which is what keeps absolute paths out of
 * the database (§4.5).
 */
export async function projectSync(args: string[], serverUrl: string): Promise<void> {
  const root = resolve(args[0] ?? process.cwd())
  const loaded = await loadProjectConfig(root).catch((err) => {
    fail(`could not read ${root}/.ogun/config.yaml: ${(err as Error).message}`)
    throw err
  })
  const skills = await discoverSkills(root, [builtinSkillsRoot()])
  const remoteUrl = await gitRemote(root)
  await registerLocalPath(loaded.config.project.name, root)

  const payload = {
    slug: loaded.config.project.name,
    defaultBranch: loaded.config.project.defaultBranch,
    ...(loaded.config.project.remoteUrl ?? remoteUrl
      ? { remoteUrl: loaded.config.project.remoteUrl ?? remoteUrl }
      : {}),
    configHash: loaded.configHash,
    workers: loaded.config.workers,
    policies: loaded.config.policies,
    skills: skills.map((s) => ({
      name: s.name,
      sourcePath: s.sourcePath,
      versionHash: s.versionHash,
      origin: s.origin,
      body: s.body,
      referencePaths: s.referencePaths,
      allowImplicitInvocation: s.agentConfig.policy.allow_implicit_invocation,
      ...(s.agentConfig.interface.display_name
        ? { displayName: s.agentConfig.interface.display_name }
        : s.frontmatter.name
          ? { displayName: s.frontmatter.name }
          : {}),
      ...(s.agentConfig.interface.short_description ?? s.frontmatter.description
        ? {
            shortDescription:
              s.agentConfig.interface.short_description ?? s.frontmatter.description,
          }
        : {}),
      ...(s.agentConfig.interface.default_prompt
        ? { defaultPrompt: s.agentConfig.interface.default_prompt }
        : {}),
    })),
  }

  const res = await fetch(`${serverUrl}/api/projects/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  }).catch(() => null)
  if (!res?.ok) {
    fail(`sync failed: ${res ? await res.text() : `could not reach ${serverUrl}`}`)
  }

  const result = (await res.json()) as { removed?: string[] }

  console.log(green(`synced ${payload.slug}`))
  console.log(
    table([
      [bold('WORKER'), bold('SKILL'), bold('RUNTIME'), bold('SANDBOX'), bold('PERMISSIONS')],
      ...Object.entries(loaded.config.workers).map(([name, w]) => [
        cyan(name),
        w.skill,
        w.runtime,
        w.sandbox,
        w.permissions,
      ]),
    ]),
  )
  if (skills.length > 0) {
    console.log(dim(`\nskills: ${skills.map((s) => s.name).join(', ')}`))
  }
  if (result.removed?.length) {
    console.log(dim(`removed (gone from config.yaml): ${result.removed.join(', ')}`))
  }

  // A skill only reaches an automated run once it lands on the default branch, since
  // the workspace is a clone at a pinned SHA (§4.8). Worth saying out loud.
  const dirty = await isDirty(root)
  if (dirty) {
    console.log(
      dim('\nnote: uncommitted changes here will not be visible to a run — the workspace is'),
    )
    console.log(dim('a clone at the default branch HEAD, not your working copy.'))
  }
}

export async function projectList(serverUrl: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/projects`, { headers: authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { projects } = (await res.json()) as {
    projects: Array<{ slug: string; defaultBranch: string; remoteUrl: string | null }>
  }
  if (projects.length === 0) {
    console.log(dim('no projects — run `ogun project sync` inside a repo with .ogun/config.yaml'))
    return
  }
  console.log(
    table([
      [bold('PROJECT'), bold('BRANCH'), bold('REMOTE')],
      ...projects.map((p) => [cyan(p.slug), p.defaultBranch, dim(p.remoteUrl ?? '')]),
    ]),
  )
}

/**
 * ~/.ogun/projects.json — machine-local, same posture as runner.json. A control plane on
 * this machine reads it to find the repo when the UI edits a worker.
 *
 * Written here rather than sent over the API on purpose: a filesystem path is a fact
 * about *this* machine, so it must never travel the wire or land in the database (§4.5).
 * A remote control plane simply will not have this file, and degrades to rendering yaml
 * for you to paste.
 */
async function registerLocalPath(slug: string, root: string): Promise<void> {
  const path = expandHome(process.env.OGUN_PROJECT_MAP ?? '~/.ogun/projects.json')
  const existing = await readFile(path, 'utf8')
    .then((t) => JSON.parse(t) as { projects?: Record<string, string> })
    .catch(() => ({ projects: {} }))
  const projects = { ...(existing.projects ?? {}), [slug]: root }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Ogun's `skills/` directory is the built-in library — universal disciplines available in
 * every repo without copying them around. A project defining a skill of the same name
 * overrides it.
 *
 * Deliberately not `.agents/skills/`: that is Ogun's own skills for reviewing Ogun,
 * exactly as any other project has its own, and shipping those to other repositories
 * would be nonsense.
 */
export function builtinSkillsRoot(): string {
  return resolve(fileURLToPath(new URL('../../../..', import.meta.url)), 'skills')
}

const gitRemote = async (root: string): Promise<string | undefined> => {
  const { stdout } = await run('git', ['-C', root, 'remote', 'get-url', 'origin']).catch(() => ({
    stdout: '',
  }))
  return stdout.trim() || undefined
}

const isDirty = async (root: string): Promise<boolean> => {
  const { stdout } = await run('git', ['-C', root, 'status', '--porcelain']).catch(() => ({
    stdout: '',
  }))
  return stdout.trim().length > 0
}
