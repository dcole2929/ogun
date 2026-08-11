import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { bold, dim, fail, green } from '../output.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

/**
 * `ogun image build` — build at project-add time, not at 2am (§4.6). A nightly run that
 * has to build an image first is a nightly run that fails on a bad network.
 */
export async function imageBuild(args: string[]): Promise<void> {
  const project = args[0]
  const context = project ? resolve(project) : join(repoRoot, 'images', 'base')
  const dockerfile = project ? join(context, '.ogun', 'Dockerfile') : join(context, 'Dockerfile')
  const tag = project ? `ogun/project-${basenameOf(context)}:latest` : 'ogun/base:latest'

  if (!existsSync(dockerfile)) {
    fail(
      project
        ? `${dockerfile} not found. A project image is ${bold('FROM ogun/base')} plus its toolchain.`
        : `${dockerfile} not found`,
    )
  }

  console.log(dim(`building ${tag} from ${dockerfile}`))
  const code = await runDocker(['build', '-t', tag, '-f', dockerfile, context])
  if (code !== 0) fail(`docker build exited ${code}`)
  console.log(green(`built ${tag}`))
}

const basenameOf = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? 'project'

const runDocker = (args: string[]): Promise<number> =>
  new Promise((res) => {
    const child = spawn('docker', args, { stdio: 'inherit' })
    child.on('close', (code) => res(code ?? 1))
    child.on('error', () => res(1))
  })
