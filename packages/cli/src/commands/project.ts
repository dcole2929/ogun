import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  discoverSkills,
  expandCycle,
  inertPolicies,
  loadProjectConfig,
  localConfigPath,
  updateLocalConfig,
} from '@ogun/core'
import { bold, cyan, dim, fail, green, table, yellow } from '../output.ts'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'

const run = promisify(execFile)

/**
 * `ogun project sync` — read the repo's .ogun/config.yaml and its skills, then post the
 * resolved config to the control plane. The CLI is the thing with filesystem access to
 * a project; the server never touches one, which is what keeps absolute paths out of
 * the database (§4.5).
 */
export async function projectSync(args: string[], serverUrl: string): Promise<void> {
  const { first } = parse(args, {}, 'ogun project sync [dir]')
  const root = resolve(first ?? process.cwd())
  const loaded = await loadProjectConfig(root).catch((err) => {
    /**
     * A file that is missing and a file that will not parse are different problems with
     * different fixes, and `ENOENT: no such file or directory` is the one that reads as a
     * fault in Ogun rather than as something to go and do.
     *
     * It is also the one somebody is most likely to hit, because `ogun project add` sends
     * them here: add registers the path, sync is the next step, and a repository that has
     * never had a config has nothing for this to read.
     */
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      fail(
        `${root} has no .ogun/config.yaml, so there is nothing to sync.\n\n` +
          `  Write one — the smallest that works is two lines:\n\n` +
          `    project:\n      name: ${basename(root)}\n\n` +
          '  Commit it. The runner reads this file from git at the commit a job is pinned\n' +
          '  to, never from the working tree, so an uncommitted one is invisible to a run.',
      )
    }
    fail(`could not load ${root}/.ogun/config.yaml:\n  ${problemsIn(err)}`)
    throw err
  })
  const skills = await discoverSkills(root, [builtinSkillsRoot()])
  const remoteUrl = await gitRemote(root)

  // Sugar expands here rather than server-side, so the control plane only ever sees one
  // shape and the UI does not have to render two.
  const cycles = Object.fromEntries(
    Object.entries(loaded.config.cycles).map(([name, cycle]) => [name, expandCycle(cycle)]),
  )
  // A typo in `then:` is otherwise a cycle that runs its reviewers and then blocks
  // forever waiting on a node that has no worker behind it.
  for (const [name, definition] of Object.entries(cycles)) {
    for (const node of definition.nodes) {
      if (!loaded.config.workers[node.worker]) {
        fail(`cycle "${name}" refers to worker "${node.worker}", which is not defined`)
      }
    }
  }
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
    cycles,
    sources: loaded.config.sources,
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

  const result = (await res.json()) as {
    removed?: string[]
    removedSkills?: string[]
    overriddenSchedules?: string[]
    unmetRequirements?: Array<{ worker: string; missing: string[] }>
    registeredRunners?: number
    sources?: Array<{ name: string; cycle: string; kind?: string }>
  }

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
  for (const [name, definition] of Object.entries(cycles)) {
    // Printed as the dependency shape rather than a node list, because the thing worth
    // checking after a sync is what feeds what.
    const feeders = new Map<string, string[]>()
    for (const e of definition.edges) feeders.set(e.to, [...(feeders.get(e.to) ?? []), e.from])
    const shape = [...feeders].map(([to, from]) => `${from.join(' + ')} → ${to}`)
    const standalone = definition.nodes
      .map((n) => n.key)
      .filter((k) => !definition.edges.some((e) => e.from === k || e.to === k))
    console.log(
      dim(`cycle ${cyan(name)}: ${[...shape, ...standalone].join(', ') || 'no nodes'}`),
    )
  }
  /**
   * What each source will turn into, and the credential it will need.
   *
   * Said here because a source is the one definition whose *only* other feedback is a
   * `source_polls` row somebody has to go and look for. It is also the moment the key
   * becomes relevant: sync is when the source starts existing, and a source with no key
   * polls, refuses, and does it again in five minutes.
   */
  for (const source of result.sources ?? []) {
    console.log(dim(`source ${cyan(source.name)}: ${source.kind ?? '?'} → ${source.cycle}`))
  }
  /**
   * Said here because it is the only place it can be said.
   *
   * The old `team:` + `filter:` shape is translated into `conditions:` rather than
   * refused, since a stored source this build cannot parse is one `pollSources` skips —
   * a poller that silently stops, which is worse than any config error. The cost of that
   * kindness is that nothing ever tells you, so this does, at the one moment somebody is
   * looking at this file.
   */
  if (loaded.legacySources.length > 0) {
    console.log(
      yellow(
        `\n${loaded.legacySources.join(', ')}: still written as \`team:\` + \`filter:\``,
      ) +
        dim(
          '\n  Still polling — the old shape is translated. Rewrite as `conditions:` when' +
            '\n  convenient; `labels:` becomes `label.all_of` and `excludeLabels:`' +
            '\n  becomes `label.none_of`, and `team:` moves inside as a list.',
        ),
    )
  }
  // Said out loud for the same reason a removed worker is: a sync that deletes quietly
  // is a sync you cannot check. A skill leaving the index un-binds every worker that
  // named it, which is a bigger consequence than the one line it used to get.
  if (result.removedSkills?.length) {
    console.log(dim(`removed (no longer on disk): ${result.removedSkills.join(', ')}`))
  }
  if (result.removed?.length) {
    console.log(dim(`removed (gone from config.yaml): ${result.removed.join(', ')}`))
  }
  if (result.overriddenSchedules?.length) {
    // The config file still says `schedule:` on these workers, so the reason it no longer
    // fires belongs here rather than only in the docs.
    console.log(
      yellow(
        `\n  ${result.overriddenSchedules.join(', ')}: own schedule ignored — a cycle runs them.` +
          `\n  Put the schedule on the cycle instead; triggering the worker by name still works.`,
      ),
    )
  }

  /**
   * Labels this fleet cannot satisfy, and the setting that says nothing.
   *
   * Both are the same failure wearing two faces: a line in config.yaml that the rest of
   * the system does not act on. `requires: [gpu]` produces jobs that sit in `queued`
   * until a GPU machine joins — which is legitimate if one is coming and a silent hole
   * if one is not, and only the person who just typed it knows which. Printed here
   * because this is the moment they typed it.
   */
  if (result.registeredRunners === 0) {
    // Not a per-worker list: with no runner joined, *every* worker's requirements are
    // unmet and the list would say nothing the first line does not.
    console.log(
      yellow(
        '\n  no runner has joined this control plane, so nothing will claim these jobs.' +
          '\n  `ogun runner init` on the machine that should run them.',
      ),
    )
  } else if (result.unmetRequirements?.length) {
    console.log(
      yellow(
        '\n  no runner here advertises these, so their jobs would queue and never be claimed:',
      ),
    )
    for (const { worker, missing } of result.unmetRequirements) {
      console.log(yellow(`    ${worker}: ${missing.join(', ')}`))
    }
    console.log(
      dim(
        '  `ogun runner doctor` on the machine that has them; labels Ogun cannot detect\n' +
          '  are declared with `ogun runner init --labels <name>`.',
      ),
    )
  }

  /**
   * Settings this build stores and does not act on. A key that does nothing is
   * indistinguishable from a key that works, right up until the night it mattered.
   */
  for (const note of inertPolicies(loaded.config.policies)) {
    console.log(yellow(`\n  ${note}`))
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
    projects: Array<{
      slug: string
      defaultBranch: string
      remoteUrl: string | null
      drift: {
        state: 'current' | 'drifted' | 'unreachable' | 'unknown'
        what?: Array<'config' | 'skills'>
      }
    }>
  }
  if (projects.length === 0) {
    console.log(dim('no projects — run `ogun project sync` inside a repo with .ogun/config.yaml'))
    return
  }
  console.log(
    table([
      [bold('PROJECT'), bold('BRANCH'), bold('CONFIG'), bold('REMOTE')],
      ...projects.map((p) => [
        cyan(p.slug),
        p.defaultBranch,
        configState(p.drift.state),
        dim(p.remoteUrl ?? ''),
      ]),
    ]),
  )

  /**
   * Said once, under the table, rather than repeated per row: the remedy is the same
   * command whether one project has drifted or four have.
   */
  const drifted = projects.filter((p) => p.drift.state === 'drifted')
  if (drifted.length > 0) {
    console.log()
    for (const p of drifted) {
      // Naming which half moved, because they are edited by different acts: one is you
      // changing what runs, the other is you changing how a reviewer thinks.
      const what = p.drift.what ?? []
      const subject =
        what.length === 2
          ? 'config.yaml and the skills beside it have'
          : what[0] === 'skills'
            ? 'a skill has'
            : 'config.yaml has'
      console.log(
        yellow(
          `${p.slug}: ${subject} changed since last published, so the factory is still ` +
            'running the previous definition.',
        ),
      )
    }
    console.log(dim('run `ogun project sync` in the repo to publish it'))
  }
}

/**
 * `unreachable` is not a problem — it is a control plane with no copy of the repo, which
 * is the hosted case and the normal one there. Only drift is coloured, because only drift
 * is something to do.
 */
const configState = (state: string): string =>
  state === 'drifted'
    ? yellow('drifted')
    : state === 'current'
      ? green('synced')
      : dim(state === 'unreachable' ? 'not local' : 'unknown')

/**
 * `~/.ogun/config.json` — machine-local. A filesystem path is a fact about *this* machine,
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
  const { flags, first } = parse(
    args,
    { '--name': 'string' },
    'ogun project add [dir] [--name <slug>]',
  )
  const root = resolve(first ?? process.cwd())

  if (!existsSync(join(root, '.git'))) {
    fail(`${root} is not a git repository — point this at the repo itself`)
  }

  // The slug comes from the project's own config where there is one, so this machine's
  // map agrees with what the control plane calls it. Two names for one project would
  // mean the path silently never matches.
  const configured = await loadProjectConfig(root)
    .then((l) => l.config.project.name)
    .catch(() => null)
  const slug = flags.name ?? configured ?? basename(root)

  // Only when the name was *guessed*. Telling someone to pass --name when they just
  // passed --name reads as though it was ignored.
  if (!configured && !flags.name) {
    console.log(
      dim(
        `${root} has no .ogun/config.yaml, so "${slug}" is taken from the directory name.\n` +
          'If the project is known by another name, pass --name.',
      ),
    )
  }
  /**
   * A repository with no config gets one, because otherwise this command cannot do what
   * it is named for.
   *
   * `project add` was written as a performance hint for a project that already exists —
   * "tell this machine where a repo is checked out, without the full sync" — and that is
   * a real thing to want. But it is also the first command under `projects` in the help
   * and the one called `add`, so it is what somebody reaches for with a repository Ogun
   * has never seen. There it wrote a path into this machine's map and stopped: the
   * control plane had no project, `project list` showed nothing, and the only way on was
   * `.ogun/config.yaml`, a file nothing in the tool has ever created and which the person
   * had not been shown.
   *
   * So the entry point that was missing is this one, and it is the whole of what was
   * missing: two lines are a valid config — everything else in that file has a default or
   * is a thing to add later — and with them on disk `ogun project sync` is a step that
   * works rather than one that fails on a file nobody wrote.
   *
   * Never over an existing file. That one is the definition, reviewed in a pull request,
   * and a command called `add` overwriting it would be the worst kind of surprise.
   */
  const configPath = join(root, '.ogun', 'config.yaml')
  if (configured === null) {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      `# What Ogun does in this repository. Committed, because the runner reads it from\n` +
        `# git at the commit a job is pinned to and never from the working tree — a change\n` +
        `# that is not committed is invisible to every run.\n` +
        `#\n` +
        `# Nothing is configured yet. \`ogun skills\` lists what is available to add here.\n` +
        `project:\n  name: ${slug}\n`,
      'utf8',
    )
    console.log(green(`wrote ${configPath}`))
    console.log(
      dim(
        '  Commit it — the runner reads this file from git, so an uncommitted one is\n' +
          '  invisible to a run.',
      ),
    )
  }

  await registerLocalPath(slug, root)
  console.log(green(`${slug} → ${root}`))
  console.log(dim(`  in ${localConfigPath()}`))

  /**
   * `sync` is still a separate command, and this still points at it.
   *
   * The two do different jobs on different sides of the wire: a path is a fact about
   * *this machine* and never leaves it (§4.5), while syncing posts a resolved config to
   * the control plane. Registering a checkout is a thing to do without re-registering a
   * project, and syncing is a thing to do from a machine that never runs a runner — so
   * folding one into the other would take a command away rather than add one.
   *
   * What was broken was never the split. It was that this line recommended `sync` to a
   * repository `sync` could not read, and the same function had printed "has no
   * .ogun/config.yaml" twenty lines earlier. With the config written, the recommendation
   * is true: it is one step, and the step works.
   */
  if (configured === null) {
    console.log(dim(`\n  Next: \`ogun project sync\` registers "${slug}" with the control plane.`))
    return
  }
  /**
   * An existing config means the project may already be registered, which is worth a
   * request to find out: nagging somebody to sync a project they have synced is how a
   * command's last line becomes something people stop reading.
   */
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

/**
 * What is actually wrong with a config.yaml, one line per problem.
 *
 * A zod error's `message` is its issue list rendered as JSON, and this command printed
 * that raw. It is unreadable at exactly the moment it matters: a `cycles:` block whose
 * graph could never finish comes back as a page of brackets wrapped around the one
 * sentence worth reading. An issue's path is already the path into the file, so
 * `cycles.nightly: …` is all of it that helps.
 */
const problemsIn = (err: unknown): string => {
  const { issues } = err as { issues?: Array<{ path: PropertyKey[]; message: string }> }
  if (!Array.isArray(issues)) return (err as Error).message
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')
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
