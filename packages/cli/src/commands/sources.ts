import { loadLocalConfig } from '@ogun/core'
import { parse } from '../args.ts'
import { authHeaders } from '../auth.ts'
import { ago, bold, cyan, dim, fail, green, red, table, yellow } from '../output.ts'
import { resolveProject } from '../project-slug.ts'

/**
 * `ogun sources` — whether the outside world is still reaching the factory (§4.13).
 *
 * The terminal half of the answer to a table nobody could read. `source_polls` records
 * every look a source takes — including the ones that failed — and until now the only
 * reader was `main.ts`, which prints a line to a control-plane stdout. A key that expires
 * at 3am therefore left perfect evidence in a place that does not exist by morning.
 *
 * ### Why this is a listing and not a log
 *
 * A source at the default cadence writes ~288 rows a day. Printing them is a `tail -f`
 * with extra steps: it answers "what happened at 03:12" and cannot answer "is this
 * working". So the default output is one row per source with a *state* on it, and the
 * history is what you get when you name a source — which is the point at which you have
 * stopped asking "is anything wrong" and started asking "since when".
 *
 * ### The three flags are three different questions
 *
 * `--project` is the ordinary override on the shared ladder. `--source` narrows to one and
 * brings its history. `--ticket` is not a narrowing of either: it asks the question a
 * source generates more often than every other question combined — *ENG-123 is sitting
 * there with the label on and nothing happened* — which most often has the answer "it did
 * happen, on Tuesday". Ogun writes nothing back to Linear (ADR-0004), so a ticket that has
 * been completely dealt with looks, in Linear, exactly like one nothing ever saw.
 *
 * It reaches the control plane, unlike `connect list` beside it, and it has to: the ledger
 * is in postgres, not in this machine's config.json. That is worth knowing when the answer
 * is "could not reach the control plane" — the poll loop lives in the same process, so a
 * control plane that cannot be reached is also a control plane that is not polling.
 */

const USAGE = 'ogun sources [--project <slug>] [--source <name>] [--ticket <key>]'

type Health = {
  state: string
  kind: string | null
  detail: string | null
  remedy: string | null
  lastPolledAt: string | null
  lastOkAt: string | null
  lastAdmittedAt: string | null
  lastEmittedAt: string | null
  firstPollAt: string | null
  pollsRecorded: number
}

type Poll = {
  startedAt: string
  outcome: string
  kind: string | null
  seen: number
  admitted: number
  emitted: number
  trimmed: number
  truncated: boolean
  detail: string | null
}

type SourceRow = {
  name: string
  kind: string
  cycle: string
  enabled: boolean
  pollMinutes: number
  team: string
  filter: {
    status: string[]
    labels: string[]
    excludeLabels: string[]
    notBlocked: boolean
  } | null
  health: Health
  polls: Poll[]
}

type Emission = {
  externalKey: string
  sourceName: string
  outcome: string
  detail: string | null
  cycleRunId: string | null
  createdAt: string
}

export async function sourcesList(args: string[], serverUrl: string): Promise<void> {
  const { flags, positionals } = parse(
    args,
    { '--project': 'string', '--source': 'string', '--ticket': 'string' },
    USAGE,
  )

  /**
   * Refused rather than ignored, and it matters more here than it looks.
   *
   * `ogun coverage <project>` and `ogun workers <project>` next door take a bare word as
   * the project, so `ogun sources tickets` is a plausible thing to type — and every
   * plausible reading of it is different: a project called `tickets`, or a source called
   * `tickets`. Node's parser hands a stray positional back happily, so accepting it
   * silently means printing a confident answer about something the operator did not ask
   * about. That is exactly the failure `args.ts` was written to end.
   */
  if (positionals.length > 0) {
    fail(
      `ogun sources takes no positional arguments, and "${positionals[0]}" is one.\n` +
        `  usage: ${USAGE}\n` +
        '  The project comes from the directory you are standing in. To name a source,\n' +
        '  --source <name>; to ask about one ticket, --ticket <key>.',
    )
  }

  const project = await resolveProject(flags.project, await loadLocalConfig())
  const url = new URL(`/api/projects/${encodeURIComponent(project.slug)}/sources`, serverUrl)
  if (flags.ticket) url.searchParams.set('ticket', flags.ticket)

  const res = await fetch(url, { headers: await authHeaders() }).catch(() => null)
  if (!res) {
    fail(
      `could not reach the control plane at ${serverUrl}.\n` +
        '  The poll loop runs inside that process, so this is also the answer to "why has\n' +
        '  nothing been polled": if it is not up, nothing is looking at Linear either.',
    )
  }
  if (res.status === 404) {
    // The slug and where it came from, because "no such project" is a different mistake
    // depending on whether a person typed it or a directory name supplied it.
    fail(`the control plane has no project "${project.slug}" (from ${project.from}).`)
  }
  if (!res.ok) fail(`could not read sources for ${project.slug}: ${await res.text()}`)

  const body = (await res.json()) as {
    sources: SourceRow[]
    emissions: Emission[]
    ticket: string | null
  }

  if (flags.ticket) return reportTicket(flags.ticket, body.emissions, body.sources)
  if (flags.source) {
    const one = body.sources.find((s) => s.name === flags.source)
    if (!one) {
      fail(
        `"${project.slug}" has no source called "${flags.source}".\n` +
          (body.sources.length > 0
            ? `  It has: ${body.sources.map((s) => s.name).join(', ')}.`
            : '  It has none — sources are declared under `sources:` in .ogun/config.yaml.'),
      )
    }
    return reportOne(one!)
  }

  if (body.sources.length === 0) {
    console.log(dim(`"${project.slug}" has no sources.`))
    console.log(
      dim('  They are declared under `sources:` in .ogun/config.yaml and published by'),
    )
    console.log(dim('  `ogun project sync`.'))
    return
  }

  console.log(
    table([
      [
        bold('SOURCE'),
        bold('CYCLE'),
        bold('STATE'),
        bold('LAST LOOK'),
        bold('EVERY'),
        bold('LAST EMITTED'),
      ],
      ...body.sources.map((s) => [
        cyan(s.name),
        s.cycle,
        stateColor(s.health.state),
        s.health.lastPolledAt ? ago(s.health.lastPolledAt) : dim('never'),
        dim(`${s.pollMinutes}m`),
        s.health.lastEmittedAt ? ago(s.health.lastEmittedAt) : dim('never'),
      ]),
    ]),
  )

  /**
   * The sentence, under the table, for anything that is not plainly healthy.
   *
   * Not a `WHY` column: the detail is a paragraph — a refusal names the exact command that
   * fixes it, and a poll that matched nothing lists the statuses it actually saw — and a
   * column truncates precisely the half that tells you what to do. `ogun coverage` prints
   * the workers' notes below its table for the same reason.
   */
  for (const s of body.sources) {
    /**
     * A healthy source with something recorded still gets its paragraph, and that is not
     * an oversight in the filter.
     *
     * `detailFor` only writes one when the poll has something to say a person cannot
     * derive: it admitted nothing and here are the statuses that were actually on the
     * tickets, or `maxPages` cut the read short, or a ticket was edited since it was
     * emitted. Every one of those is a source that is *working* and possibly not doing
     * what its author meant — which is the failure this whole slice is most likely to
     * produce, and it would otherwise stay invisible until a week of silence tipped the
     * state over. A healthy poll that admitted something has no detail and prints nothing.
     */
    if (s.health.state === 'healthy' && !s.health.detail) continue
    console.log('')
    console.log(`${cyan(s.name)} ${dim('·')} ${stateColor(s.health.state)}${kindSuffix(s.health)}`)
    for (const line of explain(s)) console.log(`  ${line}`)
  }

  const emitted = body.emissions.filter((e) => e.outcome === 'emitted')
  if (emitted.length > 0) {
    console.log('')
    console.log(bold('recently emitted'))
    for (const e of emitted.slice(0, 5)) {
      console.log(`  ${cyan(e.externalKey)} ${dim(`${ago(e.createdAt)} · via ${e.sourceName}`)}`)
    }
    console.log(dim('  `ogun sources --ticket <key>` answers "has this one already run?"'))
  }
}

/** One source, and the history that says when its state began. */
function reportOne(s: SourceRow): void {
  console.log(`${bold(s.name)} ${dim('·')} ${stateColor(s.health.state)}${kindSuffix(s.health)}`)
  console.log(
    dim(
      `  ${s.kind}, team ${s.team || '?'}, into cycle "${s.cycle}", every ${s.pollMinutes}m` +
        (s.enabled ? '' : ' — DISABLED'),
    ),
  )
  if (s.filter) {
    /**
     * Printed next to the state, because it is one half of the only diagnosis that reads
     * as success. A poll that admits nothing records the statuses that were on the tickets
     * it read; `status: [To Do]` against a column called `Todo` is only visibly wrong when
     * the two lists are next to each other.
     */
    const parts = [`status ${s.filter.status.join(', ')}`]
    if (s.filter.labels.length > 0) parts.push(`labels ${s.filter.labels.join(' + ')}`)
    if (s.filter.excludeLabels.length > 0) {
      parts.push(`not ${s.filter.excludeLabels.join(', ')}`)
    }
    if (s.filter.notBlocked) parts.push('not blocked')
    console.log(dim(`  admits: ${parts.join(' · ')}`))
  } else {
    console.log(
      yellow('  its stored config is not a shape this build can read, so its filter cannot'),
    )
    console.log(yellow('  be shown — and the poller skips it without writing a row.'))
  }
  console.log('')
  for (const line of explain(s)) console.log(`  ${line}`)

  if (s.polls.length === 0) {
    console.log('')
    console.log(dim('  no polls recorded'))
    return
  }
  console.log('')
  console.log(
    table([
      [
        bold('WHEN'),
        bold('OUTCOME'),
        bold('SEEN'),
        bold('ADMITTED'),
        bold('EMITTED'),
        bold('WHY'),
      ],
      ...s.polls.map((p) => [
        dim(ago(p.startedAt)),
        outcomeColor(p.outcome, p.kind),
        String(p.seen),
        String(p.admitted),
        String(p.emitted) + (p.trimmed > 0 ? dim(` (+${p.trimmed} held)`) : ''),
        // One line each here — the full sentence is printed above for the *current* state,
        // which is the only one anybody can still act on.
        dim(oneLine(p.detail ?? '', 52)),
      ]),
    ]),
  )
}

/**
 * Has this ticket already produced work?
 *
 * The whole reason this flag exists: `source_emissions` is the only record that it has,
 * because Ogun writes nothing back to Linear, so the card looks untouched forever. Three
 * answers, and they are kept apart:
 *
 *  - emitted, with when and into which cycle run — the system worked, and there is nothing
 *    to fix.
 *  - claimed and then failed to start — the ledger's `failed` outcome. At most once, on
 *    purpose (a retry loop at 3am is not a fact anybody can act on), so this ticket will
 *    **not** be picked up again by itself.
 *  - no row at all, which is not "it was rejected": the filter's refusals are deliberately
 *    not recorded per ticket, because a ticket refused today may be admitted next week and
 *    a row saying "seen" would make it invisible forever. So the honest answer names the
 *    other two places to look rather than inventing a verdict.
 */
function reportTicket(ticket: string, emissions: Emission[], sources: SourceRow[]): void {
  const rows = emissions.filter((e) => e.externalKey.toLowerCase() === ticket.toLowerCase())
  if (rows.length === 0) {
    console.log(`${cyan(ticket)} has never been emitted for on this project.`)
    console.log('')
    console.log(dim('  That is not the same as "it was rejected". A ticket the filter refuses is'))
    console.log(dim('  deliberately not recorded — it may be admitted next week, and a row saying'))
    console.log(dim('  "seen" would make it invisible forever. So the two other explanations are:'))
    console.log('')
    console.log(dim('    the polls are not working'))
    console.log(dim('      `ogun sources` — every source here, and the state it is in'))
    console.log(dim('    the filter does not admit it'))
    console.log(dim('      `ogun sources --source <name>` — what it admits, beside the statuses'))
    console.log(dim('      its polls actually saw'))
    const names = sources.map((s) => s.name)
    if (names.length > 0) {
      console.log('')
      console.log(dim(`  sources here: ${names.join(', ')}`))
    }
    return
  }

  for (const e of rows) {
    if (e.outcome === 'emitted') {
      console.log(
        `${cyan(e.externalKey)} ${green('was emitted')} ${ago(e.createdAt)} via ${e.sourceName}.`,
      )
      console.log(
        dim(
          `  cycle run ${e.cycleRunId ?? '(none recorded)'} — nothing re-emits it, and the ` +
            'card in Linear',
        ),
      )
      console.log(dim('  is untouched because Ogun never writes back (ADR-0004).'))
    } else {
      console.log(
        `${cyan(e.externalKey)} ${red('was claimed and its cycle run could not be started')} ` +
          `${ago(e.createdAt)} via ${e.sourceName}.`,
      )
      if (e.detail) console.log(`  ${e.detail}`)
      console.log(
        dim('  The claim was kept deliberately: at most once. It will not be retried on its'),
      )
      console.log(dim('  own — fix what it names, then delete the emission row to let it back in.'))
    }
  }
}

/** The state's own sentence, then its remedy. Both, or neither says enough. */
function explain(s: SourceRow): string[] {
  const out: string[] = []
  if (s.health.detail) out.push(...wrapped(s.health.detail, 84))
  if (s.health.remedy) {
    if (out.length > 0) out.push('')
    out.push(...wrapped(s.health.remedy, 84).map((l) => yellow(l)))
  }
  if (s.health.state === 'failing' && s.health.lastOkAt) {
    out.push(dim(`last successful poll ${ago(s.health.lastOkAt)}`))
  }
  if (out.length === 0) out.push(dim('nothing recorded'))
  return out
}

/**
 * The kind, appended to the state and never folded into it.
 *
 * `failing` on its own is the collapse this whole change exists to undo: `auth` needs a
 * person, `ratelimited` needs nobody, `transport` needs watching, and `local` needs the
 * store on this machine fixed. Four remedies behind one word is three remedies lost.
 */
const kindSuffix = (h: Health): string =>
  h.state === 'failing' ? ` ${dim('·')} ${h.kind ?? dim('kind not recorded')}` : ''

const stateColor = (state: string): string => {
  switch (state) {
    case 'healthy':
      return green(state)
    case 'failing':
    case 'refused':
    case 'overdue':
      return red(state)
    case 'silent':
      return yellow(state)
    default:
      // `disabled` and `never-polled`: neither is a fault and neither is success.
      return dim(state)
  }
}

/** A poll row's outcome, with its kind, since `failed` alone does not say what to do. */
const outcomeColor = (outcome: string, kind: string | null): string =>
  outcome === 'ok'
    ? green(outcome)
    : outcome === 'refused'
      ? yellow(outcome)
      : red(kind ? `${outcome}/${kind}` : outcome)

const oneLine = (s: string, width: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

/** Wrap a paragraph so a remedy is readable in a terminal rather than one long line. */
function wrapped(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && line.length + 1 + word.length > width) {
      out.push(line)
      line = ''
    }
    line += line === '' ? word : ` ${word}`
  }
  if (line !== '') out.push(line)
  return out
}
