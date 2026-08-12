import { loadLocalConfig, localConfigPath, updateLocalConfig } from '@ogun/core'
import { randomBytes } from 'node:crypto'
import { bold, cyan, dim, fail, green } from '../output.ts'

/**
 * `ogun token show` — print this machine's admin secret.
 *
 * There is deliberately no "create" step in the normal flow. `ogun server` generates one
 * the first time it binds beyond localhost and stores it, and the CLI on that machine
 * reads the same file — so the token exists without anyone having to carry it between
 * two commands. You only need to see it to unlock the web UI from another device, or to
 * run the CLI from one.
 */
export async function tokenShow(args: string[]): Promise<void> {
  const config = await loadLocalConfig()
  const token = config.server.token

  if (!token) {
    console.log(dim('No admin token on this machine.'))
    console.log(
      dim(
        'One is generated the first time `ogun server` binds beyond localhost. A control\n' +
          'plane on localhost needs none — nothing off this machine can reach it.',
      ),
    )
    return
  }

  if (args.includes('--quiet') || args.includes('-q')) {
    process.stdout.write(`${token}\n`)
    return
  }

  console.log(`\n  ${cyan(token)}\n`)
  console.log(dim(`  stored in ${localConfigPath()}`))
  console.log(bold('\nUse it to'))
  console.log('  · unlock the web UI from another device')
  console.log(`  · run the CLI from another machine: ${dim('export OGUN_TOKEN=…')}`)
  console.log(
    dim(
      '\nRunners do not need this and should not have it — they get their own token from' +
        `\n${green('  ogun runner invite')}`,
    ),
  )
}

/** `ogun token rotate` — invalidates every existing session and CLI export. */
export async function tokenRotate(): Promise<void> {
  const existing = (await loadLocalConfig()).server.token
  if (!existing) fail('there is no admin token on this machine to rotate')

  const token = `ogun_${randomBytes(32).toString('hex')}`
  await updateLocalConfig((c) => ({ ...c, server: { ...c.server, token } }))

  console.log(`\n  ${cyan(token)}\n`)
  console.log(
    dim(
      'Restart `ogun server` for this to take effect. Every browser session and every\n' +
        'exported OGUN_TOKEN stops working; runner tokens are unaffected, since they are\n' +
        'separate credentials.',
    ),
  )
}
