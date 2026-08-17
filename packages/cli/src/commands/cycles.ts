import { ago, bold, cyan, dim, fail, green, red, table, until, yellow } from '../output.ts'
import { authHeaders } from '../auth.ts'
import { parse } from '../args.ts'
import { cycleDefinitionSchema, nodesWithDependents, type CycleDefinition } from '@ogun/core'

/**
 * `ogun cycles` — the unit that actually schedules, and until this command existed the
 * only thing anywhere that mentioned one was the "via nightly" cell in `ogun workers`.
 *
 * That cell says a cycle drives the worker and nothing else: not what else is in the
 * graph, not what runs after what, not whether the schedule is still there, not whether
 * the thing has fired once since it was merged. A fan-in can therefore be correct in
 * config.yaml, absent from the database, and indistinguishable from a healthy one from
 * every command a person has. The columns here are chosen against that: shape, when it
 * fires next, and when it last actually ran.
 */
type CycleRow = {
  id: string
  name: string
  definition: unknown
  /** The one-node cycle that shadows a worker of the same name — it *is* the worker. */
  standalone: boolean
  schedule: {
    cron: string
    tz: string
    onMissed: string
    enabled: boolean
    lastRunAt: string | null
  } | null
  nextRuns: string[]
  lastRun: {
    id: string
    state: string
    trigger: string
    startedAt: string
    endedAt: string | null
  } | null
}

type Listed = { project: string; cycle: CycleRow }

export async function cyclesList(args: string[], serverUrl: string): Promise<void> {
  const { first: project } = parse(args, {}, 'ogun cycles [project]')
  const rows = await load(serverUrl, project)

  const named = rows.filter((r) => !r.cycle.standalone)
  if (named.length === 0) {
    console.log(
      dim(
        project
          ? `no cycles in ${project} — a cycle is a \`cycles:\` block in .ogun/config.yaml`
          : 'no cycles — a cycle is a `cycles:` block in .ogun/config.yaml',
      ),
    )
    console.log(dim('every worker still runs on its own schedule; see `ogun workers`'))
    return
  }

  console.log(
    table([
      [
        bold(''),
        bold('CYCLE'),
        bold('PROJECT'),
        bold('GRAPH'),
        bold('SCHEDULE'),
        bold('NEXT'),
        bold('LAST RUN'),
      ],
      ...named.map(({ project: slug, cycle }) => {
        const definition = definitionOf(cycle)
        return [
          enabledMark(cycle),
          cyan(cycle.name),
          dim(slug),
          definition ? arrows(shapeOf(definition)) : yellow('unreadable definition'),
          scheduleCell(cycle),
          nextCell(cycle),
          lastCell(cycle),
        ]
      }),
    ]),
  )

  const hidden = rows.length - named.length
  console.log(dim('\n`ogun cycles show <name>` for the graph in full'))
  if (hidden > 0) {
    // Not a filter anyone asked for, so say it is happening: the database really does
    // hold `hidden` more cycles than are printed here, and a count that does not add up
    // is exactly the kind of thing this command exists to stop.
    console.log(dim(`${hidden} single-worker cycles not shown — those are workers`))
  }
}

/**
 * `ogun cycles show <name>` — the whole graph, node by node.
 *
 * Earns a second command because the one thing a row cannot carry is which nodes publish
 * to the inbox and which only stage for a downstream node (§4.12). That is read off the
 * edges rather than declared, so it is invisible in config.yaml too: the reason a
 * reviewer's findings do not appear in the inbox is a graph property, and this is the
 * only place it is written down.
 */
export async function cyclesShow(args: string[], serverUrl: string): Promise<void> {
  const usage = 'ogun cycles show <name> [--project <slug>]'
  const { first: name, flags } = parse(args, { '--project': 'string' }, usage)
  if (!name) fail(`usage: ${usage}`)

  const rows = await load(serverUrl, flags.project)
  const matches = rows.filter((r) => r.cycle.name === name)
  if (matches.length === 0) {
    const known = rows.filter((r) => !r.cycle.standalone).map((r) => r.cycle.name)
    fail(
      `no cycle "${name}"` +
        (known.length > 0 ? ` — this control plane has ${known.join(', ')}` : ''),
    )
  }
  if (matches.length > 1) {
    fail(
      `"${name}" is a cycle in ${matches.map((m) => m.project).join(' and ')} — ` +
        `pass --project <slug>`,
    )
  }

  const { project, cycle } = matches[0]!
  const definition = definitionOf(cycle)
  if (!definition) fail(`cycle "${name}" has a definition this CLI cannot read`)

  console.log(`${bold(cycle.name)}  ${dim(project)}`)
  console.log(arrows(shapeOf(definition, Infinity)))
  if (cycle.standalone) {
    console.log(dim("a worker's own one-node cycle — `ogun workers` is where it belongs"))
  }

  console.log(bold('\nSchedule'))
  if (!cycle.schedule) {
    console.log(dim('  no schedule — it runs when something triggers it'))
  } else {
    const s = cycle.schedule
    console.log(
      `  ${s.cron}   ${dim(`${s.tz} · a missed occurrence is ${s.onMissed === 'runOnce' ? 'run once, late' : 'skipped'}`)}`,
    )
    if (!s.enabled) console.log(`  ${yellow('disabled — nothing will fire')}`)
    else if (cycle.nextRuns.length === 0) {
      console.log(`  ${yellow(`never — "${s.cron}" is not a usable expression`)}`)
    } else {
      console.log(`  ${dim('next')}  ${cycle.nextRuns.map(clock).join(dim('  ·  '))}`)
    }
  }

  console.log(bold('\nLast run'))
  console.log(
    cycle.lastRun
      ? `  ${stateColor(cycle.lastRun.state)}  ${dim(
          `${ago(cycle.lastRun.startedAt)} · ${cycle.lastRun.trigger} · ${cycle.lastRun.id.slice(0, 8)}`,
        )}`
      : `  ${yellow('never')}${dim(cycle.schedule ? ' — scheduled, but it has not fired yet' : '')}`,
  )

  const staged = nodesWithDependents(definition)
  const after = new Map(
    definition.nodes.map((n) => [n.key, definition.edges.filter((e) => e.to === n.key)]),
  )
  // Both columns are absent unless something in this graph uses them: a node key that is
  // not just the worker's name, or a prompt overridden for this cycle only. A column of
  // dashes is a column that makes the two that matter harder to find.
  const renamed = definition.nodes.some((n) => n.key !== n.worker)
  const overridden = definition.nodes.some((n) => n.prompt)

  console.log(bold('\nNodes'))
  console.log(
    table([
      [
        bold('  NODE'),
        ...(renamed ? [bold('WORKER')] : []),
        bold('AFTER'),
        bold('WRITES'),
        ...(overridden ? [bold('PROMPT')] : []),
      ],
      // Execution order rather than the order they were written: a node's place in the
      // list is then the same fact as its place in the run.
      ...layersOf(definition)
        .flat()
        .map((key) => {
          const node = definition.nodes.find((n) => n.key === key)!
          const deps = after.get(key) ?? []
          return [
            `  ${cyan(key)}`,
            ...(renamed ? [dim(node.worker)] : []),
            deps.length === 0
              ? dim('nothing — starts at once')
              : deps.map((d) => d.from).join(', '),
            staged.has(key)
              ? dim('staging')
              : // The node that writes to the inbox is the one worth spotting: everything
                // upstream of it is staged and invisible until it runs (§4.12).
                green('the inbox'),
            ...(overridden ? [node.prompt ? 'overridden here' : dim("the worker's")] : []),
          ]
        }),
    ]),
  )

  const policies = new Set(definition.edges.map((e) => e.onDepFailure))
  if (policies.has('degrade')) {
    console.log(
      dim('\na failed dependency degrades rather than blocks — the rest still runs, and'),
    )
    console.log(dim('the batch is marked incomplete in `ogun coverage`'))
  }
  if (policies.has('block')) {
    console.log(dim('\na failed dependency blocks what comes after it'))
  }

  console.log(dim(`\n\`ogun trigger ${project} ${cycle.name}\` runs it now`))
}

/**
 * The graph as layers of simultaneity: everything with nothing left to wait for starts
 * together, and the next layer waits for it.
 *
 * "3 nodes, 2 edges" is true of a fan-in and of a three-step chain alike, and they are
 * not the same night. Order within a layer is the order config.yaml wrote — nothing
 * distinguishes nodes that start together, so the useful one is the one you typed.
 *
 * Exported for its own test: the loop below has to terminate on input nothing validates.
 */
export function layersOf(definition: CycleDefinition): string[][] {
  const keys = new Set(definition.nodes.map((n) => n.key))
  const waitingFor = new Map(
    definition.nodes.map((n) => [
      n.key,
      // An edge from a node that is not in the graph can never be satisfied. Ignoring it
      // is the only option that terminates, and the definition is jsonb nothing checked.
      definition.edges.filter((e) => e.to === n.key && keys.has(e.from)).map((e) => e.from),
    ]),
  )

  const layers: string[][] = []
  const done = new Set<string>()
  while (waitingFor.size > 0) {
    const ready = [...waitingFor].filter(([, deps]) => deps.every((d) => done.has(d)))
    // Nothing ready with nodes left over is a cycle in the "DAG". The foreman would
    // deadlock on it; a listing command must not, so the knot is printed as one layer
    // and the reader can see what it is made of.
    const layer = ready.length > 0 ? ready.map(([key]) => key) : [...waitingFor.keys()]
    layers.push(layer)
    for (const key of layer) {
      done.add(key)
      waitingFor.delete(key)
    }
  }
  return layers
}

/**
 * One line for a graph: `adversarial-review, security-review → triage`.
 *
 * Names before counts, and counts only when the names will not fit — the whole reason to
 * look is which workers are in there. `width` is a column budget, not a wrap point: a
 * table cell that wraps stops being a column.
 */
export function shapeOf(definition: CycleDefinition, width = 44): string {
  const layers = layersOf(definition)
  const full = layers.map((l) => l.join(', ')).join(' → ')
  if (full.length <= width) return full

  const counted = layers.map((l) => (l.length > 1 ? `${l.length} workers` : l[0]!)).join(' → ')
  return counted.length <= width ? counted : `${counted.slice(0, width - 1)}…`
}

/** Dims the joins so the names carry the line and the structure stays readable. */
const arrows = (shape: string): string => shape.replaceAll(' → ', dim(' → '))

/** Filled only when something will fire it: no schedule and a disabled one both read as ○. */
const enabledMark = (c: CycleRow): string => (c.schedule?.enabled ? green('●') : dim('○'))

const scheduleCell = (c: CycleRow): string => {
  if (!c.schedule) return dim('—')
  // The zone only when it is not this machine's: `0 3 * * *` read on a laptop in London
  // means 3am in whatever zone the control plane resolved at sync time, and those are
  // the same string. Printing it always would be noise on the common case.
  const local = c.schedule.tz === here()
  return c.schedule.cron + (local ? '' : dim(` ${c.schedule.tz}`))
}

const nextCell = (c: CycleRow): string => {
  if (!c.schedule) return dim('on trigger')
  if (!c.schedule.enabled) return yellow('disabled')
  const next = c.nextRuns[0]
  return next ? until(next) : yellow('never — bad expression')
}

const lastCell = (c: CycleRow): string => {
  // "never" is a finding when something is meant to be firing nightly, and merely a fact
  // when nothing drives the cycle at all. Only the first is worth a colour.
  if (!c.lastRun) return c.schedule?.enabled ? yellow('never') : dim('never')
  return `${stateColor(c.lastRun.state)} ${dim(ago(c.lastRun.startedAt))}`
}

/**
 * A cycle run's states are its own vocabulary — `outcomeColor` speaks the run outcomes,
 * where "complete" is not a word and would come out as the same yellow as a failure.
 */
const stateColor = (state: string): string =>
  state === 'complete'
    ? green(state)
    : state === 'failed'
      ? red(state)
      : state === 'running'
        ? cyan(state)
        : yellow(state)

/** Day and time, in local zone: "next Sat 03:00" is the readable form of an occurrence. */
const clock = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    // 24-hour whatever the locale prefers: cron is written in it, and a schedule read
    // back as "03:00 AM" is one more translation between what you typed and what fires.
    hour12: false,
  })

const here = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A definition is jsonb; a row this CLI cannot parse is reported, not thrown over. */
const definitionOf = (c: CycleRow): CycleDefinition | null => {
  const parsed = cycleDefinitionSchema.safeParse(c.definition)
  return parsed.success ? parsed.data : null
}

/**
 * Cycles are per project on the wire, so no argument means every project — the same
 * shape `ogun workers` has, assembled here because the graph is a property of one repo.
 */
async function load(serverUrl: string, project?: string): Promise<Listed[]> {
  const slugs = project ? [project] : await projectSlugs(serverUrl)
  const all = await Promise.all(
    slugs.map(async (slug) => (await cyclesOf(serverUrl, slug)).map((cycle) => ({ project: slug, cycle }))),
  )
  return all.flat()
}

async function projectSlugs(serverUrl: string): Promise<string[]> {
  const res = await fetch(`${serverUrl}/api/projects`, { headers: await authHeaders() }).catch(
    () => null,
  )
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  const { projects } = (await res.json()) as { projects: Array<{ slug: string }> }
  return projects.map((p) => p.slug)
}

async function cyclesOf(serverUrl: string, slug: string): Promise<CycleRow[]> {
  const url = `${serverUrl}/api/projects/${encodeURIComponent(slug)}/cycles`
  const res = await fetch(url, { headers: await authHeaders() }).catch(() => null)
  // A name that is not a project is far more often a cycle name typed in the wrong slot
  // than a mistyped slug, so say which command wanted it.
  if (res?.status === 404) fail(`no project "${slug}" — did you mean \`ogun cycles show ${slug}\`?`)
  if (!res?.ok) fail(`could not reach the control plane at ${serverUrl}`)
  return ((await res.json()) as { cycles: CycleRow[] }).cycles
}
