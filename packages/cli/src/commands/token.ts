import { randomBytes } from 'node:crypto'
import { bold, cyan, dim, green } from '../output.ts'

/**
 * `ogun token new` — the admin secret for a control plane bound beyond localhost.
 *
 * A command rather than a documented `openssl rand -hex 32`, because the shape of the
 * token is ours: the prefix is what makes one recognisable in a shell history or a
 * systemd unit, and it is what tells you whether a leaked string is an admin token or a
 * runner's.
 */
export function tokenNew(args: string[]): void {
  const token = `ogun_${randomBytes(32).toString('hex')}`

  if (args.includes('--quiet') || args.includes('-q')) {
    // For `OGUN_TOKEN=$(ogun token new -q)`.
    process.stdout.write(`${token}\n`)
    return
  }

  console.log(`\n  ${cyan(token)}\n`)
  console.log(bold('Control plane'))
  console.log(`  OGUN_TOKEN=${token} OGUN_BIND=0.0.0.0 pnpm server`)
  console.log(bold('\nCLI on another machine'))
  console.log(`  export OGUN_TOKEN=${token}`)
  console.log(`  export OGUN_SERVER_URL=http://<this-machine>:7777`)
  console.log(
    dim(
      [
        '',
        'This is the admin secret: it can define workers, and defining a worker is',
        'defining what runs on the host. Runners do not need it and should not have it —',
        'enroll each machine instead, which gives it a token scoped to claiming work:',
        '',
        `  ${green('ogun runner add <name>')}   or the Runners page`,
      ].join('\n'),
    ),
  )
}
