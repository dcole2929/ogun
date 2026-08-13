import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadLocalConfig } from '@ogun/core'
import { bold, cyan, dim, fail, green, yellow } from '../output.ts'
import { parse } from '../args.ts'
import { dbMigrate, dbUp, isReady } from './db.ts'
import { imageBuild } from './image.ts'
import { runnerInit } from './runner.ts'

const run = promisify(execFile)

const DEFAULT_SERVER_URL = process.env.OGUN_SERVER_URL ?? 'http://localhost:7777'

/** Short timeout: this is "is it already up", not "wait for it". */
const controlPlaneIsUp = (serverUrl: string): Promise<boolean> =>
  fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  )

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
export async function init(args: string[], serverUrl = DEFAULT_SERVER_URL): Promise<void> {
  const { flags } = parse(args, { '--no-image': 'boolean' }, 'ogun init [--no-image]')
  const skipImage = Boolean(flags['no-image'])
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

  /**
   * Registering as a runner is the one step that needs the control plane, because name
   * uniqueness is enforced there and nowhere else — two machines answering to one name
   * would silently share a claim identity and a run history.
   *
   * Everything above this point is prerequisites and needs nothing running, so `init`
   * before `server` is the right order. This step just cannot complete in that order on
   * a first run, which is fine: it registers if the control plane happens to be up, and
   * otherwise says plainly what to run after starting it. It used to print
   * "registering — the control plane must be running for this" and then not register,
   * which reads as a step that succeeded.
   */
  console.log(bold('\nThis machine as a runner\n'))
  const local = await loadLocalConfig().catch(() => null)
  if (local?.runner) {
    console.log(`  ${green('ok  ')}  already registered as ${bold(local.runner.name)}`)
    skipped.push('runner')
  } else if (await controlPlaneIsUp(serverUrl)) {
    await runnerInit([])
    steps.push('registered this machine as a runner')
  } else {
    console.log(`  ${yellow('none')}  not registered yet`)
    console.log(dim(`  the control plane is not running at ${serverUrl}, and registering`))
    console.log(dim(`  needs it — start ${cyan('ogun server')}, then ${cyan('ogun runner init')}`))
  }

  console.log(bold('\nReady\n'))
  for (const s of steps) console.log(`  ${green('·')} ${s}`)
  for (const s of skipped) console.log(`  ${dim('·')} ${dim(`${s} — already done`)}`)

  const registered = Boolean((await loadLocalConfig().catch(() => null))?.runner)
  console.log(`\n  ${cyan('ogun server')}        the control plane and web UI`)
  if (!registered) {
    console.log(`  ${cyan('ogun runner init')}   once it is up, if this machine should run jobs`)
  }
  console.log(`  ${cyan('ogun runner start')}  start claiming work\n`)
}
