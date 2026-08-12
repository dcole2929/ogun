import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import {
  discoverSkills,
  loadProjectConfig,
  localConfigPath,
  updateLocalConfig,
} from '@ogun/core'
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
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
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
  const res = await fetch(`${serverUrl}/api/projects`, { headers: await authHeaders() }).catch(() => null)
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
 * `~/.ogun/local.json` — machine-local. A filesystem path is a fact about *this* machine,
 * so it never travels the wire and never lands in the database (§4.5).
 *
 * Both halves read it: the control plane to find a repo when the UI edits a worker, and
 * the runner to clone from disk instead of the network.
 */
async function registerLocalPath(slug: string, root: string): Promise<void> {
  await updateLocalConfig((c) => ({ ...c, projects: { ...c.projects, [slug]: root } }))
}

/**
 * `ogun project add [dir]` — tell this machine where a repo is checked out, without the
 * full sync. Run it in each repo a runner on this machine should be able to work on.
 *
 * Optional: a runner with no path clones from the project's remote instead. Registering
 * one makes it faster, lets it work offline, and lets a co-located control plane edit
 * that project's config.yaml.
 */
export async function projectAdd(args: string[], serverUrl: string): Promise<void> {
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())

  if (!existsSync(join(root, '.git'))) {
    fail(`${root} is not a git repository — point this at the repo itself`)
  }

  // The slug comes from the project's own config where there is one, so this machine's
  // map agrees with what the control plane calls it. Two names for one project would
  // mean the path silently never matches.
  const configured = await loadProjectConfig(root)
    .then((l) => l.config.project.name)
    .catch(() => null)
  const slug = argValue(args, '--name') ?? configured ?? basename(root)

  if (!configured) {
    console.log(
      dim(
        `${root} has no .ogun/config.yaml, so this is registered as "${slug}" from its
` +
          'directory name. If the project is known by another name, pass --name.',
      ),
    )
  }

  await registerLocalPath(slug, root)
  console.log(green(`${slug} → ${root}`))
  console.log(dim(`  in ${localConfigPath()}`))

  const known = await fetch(`${serverUrl}/api/projects`, { headers: await authHeaders() })
    .then((r) => r.json() as Promise<{ projects: Array<{ slug: string }> }>)
    .then((d) => d.projects.some((p) => p.slug === slug))
    .catch(() => null)
  if (known === false) {
    console.log(
      dim(`\n  The control plane has no project called "${slug}" yet — \`ogun project sync\`.`),
    )
  }
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

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
