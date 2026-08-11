#!/usr/bin/env node
import { bold, cyan, dim, fail } from './output.ts'
import { doctor } from './commands/doctor.ts'
import { projectList, projectSync } from './commands/project.ts'
import { coverage, runsList, trigger } from './commands/runs.ts'
import {
  checkCitations,
  findingsList,
  findingsSchema,
  findingsWrite,
  validateFindings,
} from './commands/findings.ts'
import { imageBuild } from './commands/image.ts'
import { runnerInit } from './commands/runner.ts'

const serverUrl = process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'
const [command, sub, ...rest] = process.argv.slice(2)

/**
 * The CLI is a peer to the UI, not an afterthought (§7) — and it is also the interface
 * the *agents* use. `findings write`, `validate-findings`, and `check-citations` run
 * inside the sandbox, which is what keeps output format out of the prompt (§4.10).
 */
const usage = `${bold('ogun')} — a local-first software factory

${bold('setup')}
  ogun runner init                 write ~/.ogun/runner.json for this machine
  ogun runner doctor               what this machine can actually run
  ogun image build [project-dir]   build ogun/base, or a project image

${bold('projects')}
  ogun project sync [dir]          read .ogun/config.yaml and register it
  ogun project list

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
      else if (sub === 'init') await runnerInit(rest)
      else fail('usage: ogun runner init | ogun runner doctor')
      break

    case 'project':
      if (sub === 'sync') await projectSync(rest, serverUrl)
      else if (sub === 'list' || sub === undefined) await projectList(serverUrl)
      else fail('usage: ogun project sync [dir] | ogun project list')
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
