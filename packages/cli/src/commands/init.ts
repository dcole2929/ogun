import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadLocalConfig } from '@ogun/core'
import { bold, cyan, dim, fail, green, yellow } from '../output.ts'
import { dbMigrate, dbUp, isReady } from './db.ts'
import { imageBuild } from './image.ts'
import { runnerInit } from './runner.ts'

const run = promisify(execFile)

/**
 * `ogun init` — everything a machine needs before it can run anything, in the order the
 * dependencies actually fall.
 *
 * This was four commands whose ordering was folklore. `ogun image build` in particular
 * looked like a prerequisite of `ogun server` and is not: the image is what a *job* runs
 * inside, so nothing needs it until a runner claims work. Putting it in a startup
 * sequence made it look like the server depended on Docker, which it does not.
 *
 * Idempotent, and says what it skipped. Re-running after adding Docker, or after a
 * migration lands, should be the obvious move rather than a risk.
 */
export async function init(args: string[]): Promise<void> {
  const skipImage = args.includes('--no-image')
  const steps: string[] = []
  const skipped: string[] = []

  console.log(bold('\nChecking what this machine has\n'))

  const has = async (bin: string): Promise<string | null> =>
    run(bin, ['--version'], { timeout: 15_000 }).then(
      ({ stdout }) => stdout.split('\n')[0]!.trim(),
      () => null,
    )

  const [docker, git] = await Promise.all([has('docker'), has('git')])
  console.log(`  ${docker ? green('ok  ') : yellow('none')}  docker   ${dim(docker ?? 'not installed')}`)
  console.log(`  ${git ? green('ok  ') : yellow('none')}  git      ${dim(git ?? 'not installed')}`)

  // Docker is required for the database and for the default sandbox. Without it there is
  // no useful next step, so this is a hard stop rather than a warning.
  if (!docker) {
    fail(
      'docker is required — it runs the database and the sandbox each job executes in.\n' +
        '  Install it, then run `ogun init` again.',
    )
  }
  if (!git) fail('git is required — workspaces are clones of your repositories')

  console.log(bold('\nDatabase\n'))
  if (await isReady()) {
    console.log(`  ${green('ok  ')}  already running`)
    skipped.push('database')
  } else {
    await dbUp()
    steps.push('started postgres')
  }
  await dbMigrate()
  steps.push('applied migrations')

  console.log(bold('\nSandbox image\n'))
  if (skipImage) {
    console.log(dim('  skipped (--no-image)'))
    skipped.push('image')
  } else {
    const built = await run('docker', ['image', 'inspect', 'ogun/base:latest']).then(
      () => true,
      () => false,
    )
    if (built) {
      console.log(`  ${green('ok  ')}  ogun/base already built`)
      skipped.push('image')
    } else {
      // Built now rather than at 2am. A nightly run that has to build an image first is
      // a nightly run that fails on a bad network (§4.6).
      await imageBuild([])
      steps.push('built ogun/base')
    }
  }

  console.log(bold('\nThis machine as a runner\n'))
  const local = await loadLocalConfig().catch(() => null)
  if (local?.runner) {
    console.log(`  ${green('ok  ')}  already registered as ${bold(local.runner.name)}`)
    skipped.push('runner')
  } else {
    console.log(dim('  registering — the control plane must be running for this'))
    console.log(dim(`  if it is not, run ${cyan('ogun runner init')} after starting it`))
  }

  console.log(bold('\nReady\n'))
  for (const s of steps) console.log(`  ${green('·')} ${s}`)
  for (const s of skipped) console.log(`  ${dim('·')} ${dim(`${s} — already done`)}`)

  console.log(`\n  ${cyan('ogun server')}        the control plane and web UI`)
  console.log(`  ${cyan('ogun runner init')}   once the server is up, if this machine should run jobs`)
  console.log(`  ${cyan('ogun runner start')}  start claiming work\n`)
}

/** Kept separate so `ogun runner init` still works on its own. */
export { runnerInit }
