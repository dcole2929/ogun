#!/usr/bin/env node
import { cyan, fail, red } from './output.ts'
import { helpFor, isHelpFlag, usage } from './help.ts'
import { doctor } from './commands/doctor.ts'
import { projectAdd, projectList, projectSync } from './commands/project.ts'
import { connect, connectList, disconnect } from './commands/connect.ts'
import { secretList, secretRm, secretSet } from './commands/secret.ts'
import { coverage, runsList, trigger } from './commands/runs.ts'
import { sourcesList } from './commands/sources.ts'
import {
  checkCitations,
  findingsList,
  findingsSchema,
  findingsWrite,
  validateFindings,
} from './commands/findings.ts'
import { imageBuild } from './commands/image.ts'
import { skillsList, skillsShow } from './commands/skills.ts'
import { skillLink, skillNew } from './commands/skill-new.ts'
import { workersList } from './commands/workers.ts'
import { cyclesList, cyclesShow } from './commands/cycles.ts'
import { runnerInit, runnerInvite, runnerJoin } from './commands/runner.ts'
import { tokenRotate, tokenShow } from './commands/token.ts'
import {
  daemonLogs,
  daemonStatus,
  daemonStop,
  runnerStart,
  serverStart,
} from './commands/serve.ts'
import { dbDown, dbMigrate, dbStatus, dbUp } from './commands/db.ts'
import { init } from './commands/init.ts'

const serverUrl = process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'
const argv = process.argv.slice(2)
const [command, sub, ...rest] = argv

/**
 * Help is answered before dispatch, not inside each command. `ogun findings write` reads
 * stdin and several others open a socket, so a `--help` handled after the switch would
 * block or fail on an unreachable control plane rather than print anything.
 */
if (command === undefined || argv.some(isHelpFlag)) {
  const path = argv.filter((a) => !isHelpFlag(a))
  const topic = path.length > 0 ? helpFor(path) : undefined
  if (topic) {
    console.log(topic)
  } else if (path.length > 0) {
    console.error(red(`no help for: ${path.join(' ')}`) + '\n')
    console.log(usage(serverUrl))
    process.exit(1)
  } else {
    console.log(usage(serverUrl))
  }
  process.exit(0)
}

/**
 * What a dropped spelling answers with.
 *
 * Three of these moved for one reason — the vendor's name left the command path, and the
 * project stopped being a positional — so they land in the same place. `ogun secret` is
 * **not** among them any more: it came back as a general per-project store beside
 * `connect` rather than inside it, because a secret is not guaranteed to be an
 * integration. See `commands/secret.ts`.
 */
const oldSpelling = (was: string): string =>
  `\`${was}\` is now \`ogun connect\`.\n` +
  '  The integration is an argument, not a command, and one command covers every way of\n' +
  '  giving a project access to it:\n' +
  '    ogun connect linear --client-id <id> --client-secret <secret>\n' +
  '                                             an application, in Ogun\'s own name\n' +
  '    ogun connect linear --consent …          somebody approves it in a browser\n' +
  '    ogun connect linear --api-key            a personal API key\n' +
  '    ogun connect list                        what is connected, and how healthy\n' +
  '    ogun disconnect linear                   remove every credential for it\n' +
  '  The project comes from the directory you are in, or from --project <slug>.\n' +
  '  For a per-project value that is not an integration: `ogun secret set <name> <key>`.'

/**
 * `ogun connections` became `ogun connect list`, and is refused rather than aliased.
 *
 * A listing was a top-level noun sitting beside three verbs, and `ogun secret list` coming
 * back would have made that two conventions for "show me what is stored". An alias is a
 * second shape that has to keep working forever; muscle memory only needs a signpost.
 */
const droppedListing = (was: string): string =>
  `\`ogun ${was}\` is now \`ogun connect list\`, which mirrors \`ogun secret list\`.\n` +
  '  The verbs stay at the top level: `ogun connect`, `ogun disconnect`.'

/**
 * There is one usage text per command and it lives in help.ts, so an unknown subcommand
 * prints that command's page rather than a second, drifting summary of it.
 */
const unknownSub = (command: string, sub: string | undefined): never => {
  console.error(
    `${red(sub ? `unknown: ogun ${command} ${sub}` : `ogun ${command} needs a subcommand`)}\n`,
  )
  console.error(helpFor([command]) ?? usage(serverUrl))
  process.exit(1)
}

/**
 * The CLI is a peer to the UI, not an afterthought (§7) — and it is also the interface
 * the *agents* use. `findings write`, `validate-findings`, and `check-citations` run
 * inside the sandbox, which is what keeps output format out of the prompt (§4.10).
 */
try {
  switch (command) {
    case 'runner':
      if (sub === 'doctor') await doctor(serverUrl)
      else if (sub === 'start') await runnerStart(rest)
      else if (sub === 'stop') await daemonStop('runner', rest)
      else if (sub === 'status') await daemonStatus('runner')
      else if (sub === 'logs') await daemonLogs('runner', rest)
      else if (sub === 'init') await runnerInit(rest)
      else if (sub === 'invite') await runnerInvite(rest, serverUrl)
      else if (sub === 'join') await runnerJoin(rest)
      else unknownSub('runner', sub)
      break

    case 'project':
      if (sub === 'add') await projectAdd(rest, serverUrl)
      else if (sub === 'sync') await projectSync(rest, serverUrl)
      else if (sub === 'secret' || sub === 'secrets') {
        fail(
          `\`ogun project ${sub}\` is now \`ogun secret\`, and the project comes from the\n` +
            '  directory you are standing in — as `project add` and `project sync` always\n' +
            '  have — or from --project <slug>.\n' +
            '    ogun secret set <name> <key>\n' +
            '    ogun secret list\n' +
            '    ogun secret rm <name>\n' +
            '  For an integration credential, `ogun connect <integration>` knows about ' +
            'grants.',
        )
      } else if (sub === 'linear') fail(oldSpelling(`ogun project ${sub}`))
      else if (sub === 'list' || sub === undefined) await projectList(serverUrl)
      else unknownSub('project', sub)
      break

    /**
     * The one vocabulary for giving a project *access* to an integration.
     *
     * The integration is a **value** rather than a word in the command path, which is what
     * makes `ogun connect github` a new argument instead of a new command tree. `connect`,
     * `connect list` and `disconnect` reach no server in their default shapes — the store
     * is this machine's config.json, written directly (ADR-0012) — so they work before
     * `ogun init`, with the database down, and over SSH. `--consent` is the exception,
     * because its CSRF nonce and its callback both live in the control-plane process.
     *
     * Two top-level verbs, because they are two different *acts*; the listing is a
     * subcommand, `ogun connect list`, mirroring `ogun secret list`. `disconnect` stays a
     * verb rather than becoming `connect rm`: it revokes a token at Linear, which is not
     * the same as removing a row from a listing, and it is the one somebody reaches for
     * during an incident. The machine's own credentials remain `ogun token`.
     */
    case 'connect':
      // `list` is not an integration name and cannot become one: `SECRET_NAMES` is a
      // closed set, so adding one called `list` would be a compile-visible decision here
      // rather than a subcommand that silently stopped working.
      if (sub === 'list') await connectList(rest)
      else await connect([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'connections':
    case 'connection':
      fail(droppedListing(command))
      break

    case 'disconnect':
      await disconnect([sub, ...rest].filter(Boolean) as string[])
      break

    /**
     * `ogun secret` — one value under one name, for a project, on this machine.
     *
     * Beside `connect` rather than inside it. `connect` is *access* and knows what a grant
     * is; this is *storage* and takes a free-form name, because a secret is not guaranteed
     * to be an integration. They overlap on one slot — a `linear` key — and write it
     * through the same function under the same lock, so the overlap cannot become a
     * disagreement. `commands/secret.ts` carries the argument.
     */
    case 'secret':
    case 'secrets':
      if (sub === 'set') await secretSet(rest)
      else if (sub === 'rm' || sub === 'remove') await secretRm(rest)
      // `ogun secret --project x` is a list with a filter, not a subcommand called
      // "--project" — the same rule `ogun skills` follows.
      else if (sub === undefined || sub === 'list' || sub.startsWith('-')) {
        await secretList([sub, ...rest].filter((a): a is string => a !== undefined && a !== 'list'))
      } else unknownSub('secret', sub)
      break

    /**
     * `ogun linear` is gone, and this is a signpost rather than an alias.
     *
     * The vendor's name in the command path made a GitHub integration a whole new command
     * tree. Nothing outside this repository calls it; what survives a release is muscle
     * memory, and for that a bare "unknown command" is a dead end.
     */
    case 'linear':
      fail(oldSpelling(`ogun ${command}`))
      break

    case 'init':
      await init([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'db':
      if (sub === 'up') await dbUp()
      else if (sub === 'down') await dbDown(rest)
      else if (sub === 'migrate') await dbMigrate()
      else if (sub === 'status' || sub === undefined) await dbStatus()
      else unknownSub('db', sub)
      break

    case 'server':
      // `server` and `server start` are the same command, so a leading flag is an
      // argument to it and not a mistyped subcommand: `ogun server --port 8080` must
      // reach the server rather than being reported as an unknown subcommand. That is
      // also what makes the bare `ogun server -d` work without `start`.
      if (sub === undefined || sub === 'start') await serverStart(rest)
      else if (sub === 'stop') await daemonStop('server', rest)
      else if (sub === 'status') await daemonStatus('server')
      else if (sub === 'logs') await daemonLogs('server', rest)
      else if (sub.startsWith('-')) await serverStart([sub, ...rest])
      else unknownSub('server', sub)
      break

    case 'token':
      if (sub === 'show' || sub === undefined) await tokenShow(rest)
      else if (sub === 'rotate') await tokenRotate()
      else unknownSub('token', sub)
      break

    case 'skill':
      if (sub === 'new') await skillNew(rest)
      else if (sub === 'link') await skillLink(rest)
      else if (sub === 'show') await skillsShow(rest, serverUrl)
      else unknownSub('skill', sub)
      break

    case 'skills':
      if (sub === 'show') await skillsShow(rest, serverUrl)
      // `ogun skills --project x` is a list with a filter, not a skill named "--project".
      else if (sub === undefined || sub === 'list' || sub.startsWith('--')) {
        await skillsList([sub, ...rest].filter(Boolean) as string[], serverUrl)
      } else await skillsShow([sub, ...rest], serverUrl)
      break

    case 'workers':
      await workersList([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'cycles':
      // `ogun cycles <project>` filters, the same positional `workers` takes — so a bare
      // name that is a cycle rather than a project is a 404 the command explains, not a
      // second meaning for the same argument.
      if (sub === 'show') await cyclesShow(rest, serverUrl)
      else await cyclesList([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'trigger':
      await trigger([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'runs':
      await runsList(serverUrl)
      break

    case 'coverage':
      await coverage([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    /**
     * `ogun sources` — a listing noun at the top level, beside `workers`, `cycles` and
     * `coverage`, and not `ogun source list`. A `source` namespace holding one listing
     * would be the dead-weight noun `ogun project secret` and `ogun linear connect` were
     * both taken apart for.
     *
     * The project comes from the ladder rather than from a positional, which is the
     * settled convention (`project add`, `project sync`, `connect`, `secret`) and is why
     * `ogun coverage <project>` beside it reads differently — that one predates it. A
     * bare word here is not a project: `--source` and `--ticket` are the two narrowings
     * this command has, and both name what they are.
     */
    case 'sources':
    case 'source':
      await sourcesList([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'findings':
      if (sub === 'write') await findingsWrite(rest)
      else if (sub === 'schema') findingsSchema()
      else if (sub === 'list' || sub === undefined) await findingsList(rest, serverUrl)
      else unknownSub('findings', sub)
      break

    case 'validate-findings':
      await validateFindings([sub, ...rest].filter(Boolean) as string[])
      break

    case 'check-citations':
      await checkCitations([sub, ...rest].filter(Boolean) as string[])
      break

    case 'image':
      if (sub === 'build') await imageBuild(rest)
      else unknownSub('image', sub)
      break

    default:
      console.error(`unknown command: ${cyan(command)}\n`)
      console.log(usage(serverUrl))
      process.exit(1)
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
