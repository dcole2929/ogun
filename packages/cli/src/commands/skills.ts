import { bold, cyan, dim, fail, green, table, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'

type SkillRow = {
  skill: {
    name: string
    displayName: string | null
    shortDescription: string | null
    defaultPrompt: string | null
    sourcePath: string
    origin: string
    referencePaths: string[]
    allowImplicitInvocation: boolean
    versionHash: string
    bodyLength: number
  }
  project: { slug: string } | null
  workers: Array<{ name: string; runtime: string; enabled: boolean; origin: string }>
}

/**
 * `ogun skills` — a skill is the durable artifact; a worker is a thin binding of one to
 * a runtime (principle 2). Showing which workers bind each skill is the useful half:
 * a skill nothing points at is dead weight, and that is invisible if you list them
 * separately.
 */
export async function skillsList(args: string[], serverUrl: string): Promise<void> {
  const project = argValue(args, '--project')
  const url = new URL('/api/skills', serverUrl)
  if (project) url.searchParams.set('project', project)

  const res = await fetch(url, { headers: await authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { skills } = (await res.json()) as { skills: SkillRow[] }

  if (skills.length === 0) {
    console.log(dim('no skills — run `ogun project sync` in a repo with .agents/skills/'))
    return
  }

  console.log(
    table([
      [bold('SKILL'), bold('WHERE'), bold('USED BY'), bold('DESCRIPTION')],
      ...skills.map((s) => [
        cyan(s.skill.name),
        dim(s.skill.origin),
        s.workers.length === 0
          ? yellow('nothing')
          : s.workers.map((w) => (w.enabled ? w.name : dim(w.name))).join(', '),
        (s.skill.shortDescription ?? '').slice(0, 54),
      ]),
    ]),
  )
  console.log(dim('\n`ogun skills show <name>` to read one'))
}

/** `ogun skills show <name>` — read the actual instructions a worker will run. */
export async function skillsShow(args: string[], serverUrl: string): Promise<void> {
  const name = args[0]
  if (!name) fail('usage: ogun skills show <name> [--project <slug>]')

  const project = argValue(args, '--project') ?? (await onlyProject(serverUrl))
  const res = await fetch(`${serverUrl}/api/skills/${project}/${name}`, { headers: await authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`no skill "${name}" in project "${project}"`)
  const body = (await res.json()) as {
    skill: SkillRow['skill'] & { body: string | null }
    workers: SkillRow['workers']
  }
  const s = body.skill

  console.log(bold(s.displayName ?? s.name))
  console.log(dim(`${s.sourcePath}  ·  ${s.origin}  ·  ${s.versionHash}`))
  if (s.shortDescription) console.log(`\n${s.shortDescription}`)

  console.log(bold('\nUsed by'))
  if (body.workers.length === 0) {
    console.log(yellow('  nothing — this skill never runs'))
  }
  for (const w of body.workers) {
    console.log(
      `  ${w.enabled ? green('●') : dim('○')} ${w.name} ${dim(`${w.runtime} · ${w.origin}`)}`,
    )
  }

  if (s.defaultPrompt) {
    console.log(bold('\nDefault prompt'))
    console.log(`  ${s.defaultPrompt}`)
  }
  console.log(
    dim(
      `\n  allow_implicit_invocation: ${s.allowImplicitInvocation}` +
        (s.allowImplicitInvocation
          ? '  ← an agent may reach for this mid-task'
          : '  ← runs only when ogun says so'),
    ),
  )

  if (s.referencePaths.length > 0) {
    console.log(bold('\nReferences'))
    for (const r of s.referencePaths) console.log(dim(`  ${r}`))
  }

  if (s.body) {
    console.log(bold('\nSKILL.md'))
    console.log(dim('─'.repeat(72)))
    console.log(s.body.trimEnd())
  }
}

const onlyProject = async (serverUrl: string): Promise<string> => {
  const res = await fetch(`${serverUrl}/api/projects`, { headers: await authHeaders() }).catch(() => null)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { projects } = (await res.json()) as { projects: Array<{ slug: string }> }
  if (projects.length === 1) return projects[0]!.slug
  fail(`--project is required (${projects.map((p) => p.slug).join(', ')})`)
}

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
