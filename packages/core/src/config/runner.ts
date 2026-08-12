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
  /**
   * This machine's enrollment token, written by `ogun runner join`. Stored here, in a
   * 0600 file next to the rest of this machine's runner config, so starting the runner
   * needs no environment variable — a token you have to remember to export is a token
   * you forget to export.
   *
   * OGUN_TOKEN still overrides, for a systemd unit that prefers a secret file.
   */
  // nullish rather than optional: a hand-edited file with an explicit null is a
  // plausible thing to find, and is the same statement as omitting the key.
  token: z.string().nullish().transform((v) => v ?? undefined),
})
export type RunnerConfig = z.infer<typeof runnerConfigSchema>
