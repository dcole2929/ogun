#!/usr/bin/env node
import { cyan, fail, red } from './output.ts'
import { helpFor, isHelpFlag, usage } from './help.ts'
import { doctor } from './commands/doctor.ts'
import { projectAdd, projectList, projectSync } from './commands/project.ts'
import { projectSecret } from './commands/secrets.ts'
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
      // `secret` reaches no server: the store is this machine's config.json, and there is
      // no route that takes a secret in a request body (ADR-0012).
      else if (sub === 'secret' || sub === 'secrets') await projectSecret(rest)
      else if (sub === 'list' || sub === undefined) await projectList(serverUrl)
      else unknownSub('project', sub)
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
