import { z } from 'zod'

/**
 * ~/.ogun/runner.json — machine-local, never synced, never in the database.
 * /home/doug/dev/x on WSL2 vs /Users/doug/dev/x on macOS: the repo registry is
 * per-runner precisely so no absolute path is ever stored centrally (§4.5).
 */
export const runnerConfigSchema = z.object({
  runnerId: z.string().min(1),
  labels: z.array(z.string()).default([]),
  projects: z.record(z.string(), z.string()).default({}),
  scratch: z.string().default('~/.ogun/work'),
  maxConcurrentJobs: z.number().int().positive().default(2),
  serverUrl: z.string().default('http://localhost:7777'),
  pollIntervalMs: z.number().int().positive().default(3000),
})
export type RunnerConfig = z.infer<typeof runnerConfigSchema>
