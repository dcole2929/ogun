import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ExecHandle } from './types.ts'

export type SpawnOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}

/**
 * One subprocess runner for both sandbox kinds. stdin is always closed: codex hangs
 * forever otherwise, reporting "Reading additional input from stdin…" — which in
 * production would look exactly like a hung agent (§4.7).
 */
export function spawnJsonl(command: string, argv: string[], opts: SpawnOptions): ExecHandle {
  const child = spawn(command, argv, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  // Cap it: a runaway build can emit hundreds of megabytes and we only need the tail
  // for a failure message.
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-64_000)
  })

  /**
   * Remembered rather than inferred. A process killed here exits with a null code and no
   * stderr of its own, which reads exactly like a crash — and for the test gate the
   * difference decides whether the reason says "the suite failed" or "the suite ran out
   * of the job's time", which are different facts about a change (principle 6).
   */
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
  }, opts.timeoutMs)
  timer.unref()

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

  const done = new Promise<{ code: number | null; stderr: string; timedOut: boolean }>(
    (resolveDone, rejectDone) => {
      child.on('error', (err) => {
        clearTimeout(timer)
        rejectDone(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveDone({ code, stderr, timedOut })
      })
    },
  )

  return { lines: rl, done }
}
