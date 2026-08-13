#!/usr/bin/env node
import { bold, cyan, dim, fail } from './output.ts'
import { doctor } from './commands/doctor.ts'
import { projectAdd, projectList, projectSync } from './commands/project.ts'
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
import { runnerInit, runnerInvite, runnerJoin } from './commands/runner.ts'
import { tokenRotate, tokenShow } from './commands/token.ts'
import { runnerStart, serverStart } from './commands/serve.ts'

const serverUrl = process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'
const [command, sub, ...rest] = process.argv.slice(2)

/**
 * The CLI is a peer to the UI, not an afterthought (§7) — and it is also the interface
 * the *agents* use. `findings write`, `validate-findings`, and `check-citations` run
 * inside the sandbox, which is what keeps output format out of the prompt (§4.10).
 */
const usage = `${bold('ogun')} — a local-first software factory

${bold('running it')}
  ogun server                      start the control plane and web UI
  ogun runner init [--name]        make this machine a runner for it
  ogun runner start                start a runner on this machine
  ogun runner doctor               what this machine can actually run
  ogun image build [project-dir]   build ogun/base, or a project image

${bold('adding a machine')}
  ogun runner invite               on the CONTROL PLANE — mints a join token
  ogun runner join <url> --token   on the NEW MACHINE — paste what invite printed
  ogun token show                  admin secret, to unlock the UI from another device

${bold('projects')}
  ogun project add [dir] [--name]  tell this machine where a repo is checked out
  ogun project sync [dir]          read .ogun/config.yaml and register it
  ogun project list

${bold('what can run')}
  ogun skill new <name>            scaffold .agents/skills/<name>/
  ogun skill link                  link existing skills into .claude/ and .codex/
  ogun skills                      every skill, and which workers bind it
  ogun skills show <name>          read one, including its SKILL.md
  ogun workers                     every worker

${bold('running')}
  ogun trigger <project> <worker>  queue a run now
  ogun runs                        recent runs
  ogun coverage <project>          what ran, what didn't, and why

${bold('findings')}
  ogun findings list [--project x] [--status open]
  ogun findings schema             print the document shape

${bold('used by skills, inside the sandbox')}
  ogun findings write [--out f]    validate a findings document on stdin and write it
  ogun validate-findings [file]    schema check          (verify lens)
  ogun check-citations [file]      grounding check       (verify lens)

${dim(`control plane: ${serverUrl}`)}`

try {
  switch (command) {
    case 'runner':
      if (sub === 'doctor') await doctor(serverUrl)
      else if (sub === 'start') runnerStart(rest)
      else if (sub === 'init') await runnerInit(rest)
      else if (sub === 'invite') await runnerInvite(rest, serverUrl)
      else if (sub === 'join') await runnerJoin(rest)
      else fail('usage: ogun runner start | doctor | init | invite | join <url> --token <t>')
      break

    case 'project':
      if (sub === 'add') await projectAdd(rest, serverUrl)
      else if (sub === 'sync') await projectSync(rest, serverUrl)
      else if (sub === 'list' || sub === undefined) await projectList(serverUrl)
      else fail('usage: ogun project add [dir] | sync [dir] | list')
      break

    case 'server':
      if (sub === undefined || sub === 'start') serverStart(rest)
      else fail('usage: ogun server')
      break

    case 'token':
      if (sub === 'show' || sub === undefined) await tokenShow(rest)
      else if (sub === 'rotate') await tokenRotate()
      else fail('usage: ogun token show [--quiet] | ogun token rotate')
      break

    case 'skill':
      if (sub === 'new') await skillNew(rest)
      else if (sub === 'link') await skillLink(rest)
      else if (sub === 'show') await skillsShow(rest, serverUrl)
      else fail('usage: ogun skill new <name> | link | show <name>')
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
      else fail('usage: ogun findings list | write | schema')
      break

    case 'validate-findings':
      await validateFindings([sub, ...rest].filter(Boolean) as string[])
      break

    case 'check-citations':
      await checkCitations([sub, ...rest].filter(Boolean) as string[])
      break

    case 'image':
      if (sub === 'build') await imageBuild(rest)
      else fail('usage: ogun image build [project-dir]')
      break

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(usage)
      break

    default:
      console.error(`unknown command: ${cyan(command)}\n`)
      console.log(usage)
      process.exit(1)
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
