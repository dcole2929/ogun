#!/usr/bin/env node
import { cyan, fail, red } from './output.ts'
import { helpFor, isHelpFlag, usage } from './help.ts'
import { doctor } from './commands/doctor.ts'
import { projectAdd, projectList, projectSync } from './commands/project.ts'
import { connect, connections, disconnect } from './commands/connect.ts'
import { coverage, runsList, trigger } from './commands/runs.ts'
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
import { runnerStart, serverStart } from './commands/serve.ts'
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
 * What a dropped spelling answers with. One sentence, because all four of them — `ogun
 * secret`, `ogun linear`, and both under `ogun project` — were dropped for the same reason
 * and land in the same place.
 */
const oldSpelling = (was: string): string =>
  `\`${was}\` is now \`ogun connect\`.\n` +
  '  The integration is an argument, not a command, and one command covers every way of\n' +
  '  giving a project access to it:\n' +
  '    ogun connect linear                      Ogun takes a token in its own name\n' +
  '    ogun connect linear --consent            somebody approves it in a browser\n' +
  '    ogun connect linear --api-key            a personal API key\n' +
  '    ogun connections                         what is connected, and how healthy\n' +
  '    ogun disconnect linear                   remove every credential for it\n' +
  '  The project comes from the directory you are in, or from --project <slug>.'

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
      else if (sub === 'start') runnerStart(rest)
      else if (sub === 'init') await runnerInit(rest)
      else if (sub === 'invite') await runnerInvite(rest, serverUrl)
      else if (sub === 'join') await runnerJoin(rest)
      else unknownSub('runner', sub)
      break

    case 'project':
      if (sub === 'add') await projectAdd(rest, serverUrl)
      else if (sub === 'sync') await projectSync(rest, serverUrl)
      else if (sub === 'secret' || sub === 'secrets' || sub === 'linear') {
        fail(oldSpelling(`ogun project ${sub}`))
      }
      else if (sub === 'list' || sub === undefined) await projectList(serverUrl)
      else unknownSub('project', sub)
      break

    /**
     * The one vocabulary for giving a project access to an integration.
     *
     * The integration is a **value** rather than a word in the command path, which is what
     * makes `ogun connect github` a new argument instead of a new command tree. `connect`,
     * `connections` and `disconnect` reach no server in their default shapes — the store is
     * this machine's config.json, written directly (ADR-0012) — so they work before `ogun
     * init`, with the database down, and over SSH. `--consent` is the exception, because
     * its CSRF nonce and its callback both live in the control-plane process.
     *
     * Three top-level verbs rather than one noun with subcommands, because they are three
     * different acts on the same thing and `ogun connection connect` is a word too many.
     * The machine's own credentials remain `ogun token`, which is what keeps this
     * unambiguous.
     */
    case 'connect':
      await connect([sub, ...rest].filter(Boolean) as string[], serverUrl)
      break

    case 'connections':
    case 'connection':
      await connections([sub, ...rest].filter(Boolean) as string[])
      break

    case 'disconnect':
      await disconnect([sub, ...rest].filter(Boolean) as string[])
      break

    /**
     * `ogun secret` and `ogun linear` are gone, and these are signposts rather than
     * aliases.
     *
     * Both were a second spelling of "let Ogun into this workspace" — one filed under
     * storage, one with the vendor's name in the command path — and having two is the thing
     * `connect` exists to end, so keeping either as an alias would be keeping the problem
     * with better documentation. Nothing outside this repository calls them. What survives a
     * release is muscle memory, and for that a bare "unknown command" is a dead end.
     */
    case 'secret':
    case 'secrets':
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
      // reach the server rather than being reported as an unknown subcommand.
      if (sub === undefined || sub === 'start') serverStart(rest)
      else if (sub.startsWith('-')) serverStart([sub, ...rest])
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
