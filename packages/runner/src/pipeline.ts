import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  verifySchema,
  type ClaimedJob,
  type GateResult,
  type RunEvent,
  type RunOutcome,
  type RunReport,
} from '@ogun/core'
import { ControlPlane, EventFlusher } from './client.ts'
import {
  createSandbox,
  GUEST_WORKSPACE,
  readContained,
  type Sandbox,
} from './sandbox/index.ts'
import { nextSeq, newParserState, resolveModel, resolveRuntime } from './runtimes/index.ts'
import { materializeWorkspace, resolveHeadSha, stageAll } from './workspace.ts'
import { runVerifyGate } from './verify.ts'
import {
  defaultSearchPaths,
  ensureSkillAvailable,
  excludeFromGit,
  listAvailableSkills,
} from './skills.ts'

const run = promisify(execFile)

/** Where a reviewer is told to write its findings, workspace-relative. */
export const OUTPUT_PATH = '.ogun-out/findings.json'

/**
 * The runner's loop, once per job (§5.2):
 *
 *   prepare   -> materialize workspace, check the image
 *   provision -> sandbox, ONCE per job rather than per round
 *   deliver   -> round 0 only in v1; the `for round` shape stays so phase 3 is an
 *                unwrapping rather than a rewrite
 *   grade     -> verify gate
 *   record    -> one report; the control plane writes it in one transaction
 */
export async function executeJob(
  cp: ControlPlane,
  config: { projects: Record<string, string>; scratch: string },
  job: ClaimedJob,
): Promise<RunOutcome> {
  const startedAt = Date.now()
  const flusher = new EventFlusher(cp, job.runId)
  let sandbox: Sandbox | undefined
  let cleanup: (() => Promise<void>) | undefined

  const fail = async (detail: string, gates: GateResult[] = []): Promise<RunOutcome> => {
    await flusher.flush()
    await cp
      .report({
        runId: job.runId,
        outcome: 'error',
        detail,
        durationMs: Date.now() - startedAt,
        gates,
        coverage: { outcome: 'errored', reason: detail },
        artifacts: [],
      })
      .catch((err) => console.error('[runner] failed to report failure', err))
    return 'error'
  }

  try {
    /**
     * A local checkout is an optimisation, not a requirement. If this machine has the
     * repo, clone from disk — fast, offline, no credentials. Otherwise clone from the
     * remote, so a freshly joined runner can work on a project it has never seen.
     */
    const localPath = config.projects[job.projectSlug]
    if (localPath && !existsSync(join(localPath, '.git'))) {
      // Explicit because git's own message names no project, and pointing at a directory
      // that contains repositories rather than at one is an easy mistake.
      return await fail(
        `${localPath} is not a git repository — "${job.projectSlug}" in this runner's ` +
          'projects map should point at the repo itself, not a directory containing repos.',
      )
    }
    if (!localPath && !job.remoteUrl) {
      return await fail(
        `no way to obtain "${job.projectSlug}": this runner has no local path for it, and ` +
          'the project has no remote url. Add one, or run `ogun project add` inside a\n' +
          'local checkout on this machine.',
      )
    }

    let baseSha: string | undefined
    if (localPath) {
      try {
        baseSha = await resolveHeadSha(localPath, job.projectDefaultBranch)
      } catch {
        return await fail(
          `${localPath} has no branch "${job.projectDefaultBranch}" — set project.defaultBranch ` +
            'in .ogun/config.yaml to whichever branch this project actually uses.',
        )
      }
    }

    const workspace = await materializeWorkspace({
      ...(localPath ? { sourceRepo: localPath } : {}),
      ...(job.remoteUrl ? { remoteUrl: job.remoteUrl } : {}),
      scratch: config.scratch,
      runId: job.runId,
      ref: baseSha ?? job.projectDefaultBranch,
    })
    cleanup = workspace.cleanup

    await mkdir(join(workspace.path, '.ogun-out'), { recursive: true })
    // The findings document is harness output, not a change the worker made.
    await excludeFromGit(workspace.path, ['/.ogun-out/'])

    // Make the worker's skill discoverable where *this* runtime looks — the two do not
    // agree on a location, so it depends on which one is about to run (§5.1).
    const spec = resolveRuntime(job.runtime)
    const searchPaths = defaultSearchPaths()
    const skill = await ensureSkillAvailable(
      workspace.path,
      job.skillRef,
      spec.provider,
      searchPaths,
    )
    if (!skill) {
      const available = await listAvailableSkills(workspace.path, searchPaths)
      return await fail(
        `the workspace has no skill named "${job.skillRef}"` +
          (available.length ? ` — it has: ${available.join(', ')}` : ' and no skills at all') +
          '. A skill only reaches a run once it is on the default branch.',
      )
    }

    const model = resolveModel(job.runtime, job.model)
    await cp.started(job.runId, {
      repoSha: workspace.sha,
      runtime: job.runtime,
      ...(model ? { model } : {}),
    })

    sandbox = createSandbox({
      kind: job.sandbox === 'worktree' ? 'worktree' : 'container',
      name: `ogun-${job.runId.slice(0, 12)}`,
      hostWorkspace: workspace.path,
      guestWorkspace: job.sandbox === 'worktree' ? workspace.path : GUEST_WORKSPACE,
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
      runtime: spec.provider,
      timeoutMs: job.timeoutMs,
      image: process.env.OGUN_IMAGE_OVERRIDE ?? imageFor(job),
      allowSandboxDowngrade: false,
    })
    await sandbox.provision()

    const guestRoot = job.sandbox === 'worktree' ? workspace.path : GUEST_WORKSPACE
    const ctx = {
      prompt: composePrompt(job, guestRoot, skill.path),
      ...(model ? { model } : {}),
      workspace: guestRoot,
      outputFile: `${guestRoot}/.ogun-out/last-message.txt`,
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
    }

    // v1 runs exactly one round. Keeping the loop makes phase 3's retry an unwrapping.
    const maxRounds = 1
    const parser = newParserState()
    let lastEvent: RunEvent | undefined

    /**
     * Recorded on every run, not only when something was copied. Which skill a run
     * actually got is the single most useful thing for explaining its behaviour later —
     * `project` means the repo's own, `builtin` means Ogun's, and the difference changes
     * what the agent read. Emitted here, before the agent starts, so the timeline shows
     * it in the order it happened.
     */
    flusher.push([
      {
        type: 'runner.note',
        ts: new Date().toISOString(),
        seq: nextSeq(parser),
        payload: {
          note: `skill ${skill.name} (${skill.origin}) at ${skill.path}`,
          skill: skill.name,
          origin: skill.origin,
          path: skill.path,
          injected: skill.injected,
        },
      },
    ])

    for (let round = 0; round < maxRounds; round++) {
      const handle = sandbox.exec(spec.start(ctx))
      for await (const line of handle.lines) {
        const events = spec.parseLine(line, parser)
        if (events.length === 0) continue
        lastEvent = events.at(-1)
        flusher.push(events)
      }
      const { code, stderr } = await handle.done
      await flusher.flush()
      if (code !== 0) {
        return await fail(`${job.runtime} exited ${code}: ${stderr.slice(-1500)}`)
      }
      if (parser.sessionId) await cp.started(job.runId, { sessionId: parser.sessionId })
    }

    // The agent may have created files; stage them or the grounding check will call a
    // real new file a hallucination (§5.3).
    await stageAll(workspace.path).catch(() => undefined)

    let raw: string | null
    try {
      raw = await sandbox.readFile(OUTPUT_PATH)
    } catch (err) {
      // A symlinked or oversized output is an attempt to make the host read something it
      // should not. That ends the run; it is not a gate failure to be graded.
      return await fail(err instanceof Error ? err.message : String(err))
    }
    const output = raw === null ? undefined : safeJsonParse(raw)
    const gates = await runVerifyGate({
      config: job.verify ? verifySchema.parse(job.verify) : undefined,
      permissions: job.permissions as 'observer' | 'reviewer' | 'modifier',
      output,
      knownPaths: await trackedPaths(workspace.path),
      lineCountOf: (path) => countLines(workspace.path, path),
      sandbox,
    })

    const transcriptRef = await writeTranscript(config, job, workspace.path)
    const usage = usageFrom(lastEvent)

    const report: RunReport = {
      runId: job.runId,
      outcome: 'approved',
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
      gates,
      ...(output !== undefined ? { findings: output as never } : {}),
      coverage: { outcome: 'clean' },
      artifacts: transcriptRef ? [{ kind: 'transcript', ref: transcriptRef }] : [],
    }
    const result = (await cp.report(report)) as { outcome?: RunOutcome }
    return result.outcome ?? 'approved'
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err))
  } finally {
    await flusher.flush().catch(() => undefined)
    await sandbox?.dispose().catch(() => undefined)
    if (process.env.OGUN_KEEP_WORKSPACES !== '1') await cleanup?.().catch(() => undefined)
  }
}

/**
 * The job already carries its prompt — often as short as "Use the
 * staging-error-reviews skill." (§5.1). All this adds is where to put the answer,
 * because the CLI owns the format and the agent must not free-hand it (§4.10).
 */
function composePrompt(job: ClaimedJob, guestRoot: string, skillPath: string): string {
  return [
    job.prompt,
    '',
    // The skill is named by path as well as by name. Claude Code can resolve it from
    // .claude/skills natively, but codex has no skill concept, so without this the
    // prompt is a reference to something the runtime cannot look up.
    `That skill is at ${guestRoot}/${skillPath}/SKILL.md — read it first, along with any`,
    'files it points to under references/. It defines the mission, the evidence standard,',
    'and the severity scale for this run.',
    '',
    `Write your findings to ${guestRoot}/${OUTPUT_PATH} by running \`ogun findings write\`.`,
    'Do not hand-write that file and do not invent a format — the CLI owns the schema.',
    'If you looked and found nothing, still write the file with an empty findings array:',
    'a clean result and a run that never happened are different facts.',
  ].join('\n')
}

/** Each project has its own image; absent one, `ogun/base` — enough for a reviewer and
 *  not enough for a modifier (§5.1). */
const imageFor = (job: ClaimedJob): string =>
  job.permissions === 'modifier'
    ? `ogun/project-${job.projectSlug}:latest`
    : (process.env.OGUN_BASE_IMAGE ?? 'ogun/base:latest')

async function trackedPaths(workspace: string): Promise<Set<string>> {
  const { stdout } = await run('git', ['-C', workspace, 'ls-files'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return new Set(stdout.split('\n').filter(Boolean))
}

/**
 * Only files a finding actually cites get read, so this costs one open per citation
 * rather than a walk of the tree. Path is already known-tracked by the caller, but it
 * still goes through the containment check — it originated in a sandbox.
 */
async function countLines(workspace: string, relPath: string): Promise<number | null> {
  try {
    const text = await readContained(workspace, relPath)
    if (text === null) return null
    // A trailing newline does not make a final empty line.
    return text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length
  } catch {
    // Unreadable is not the same as wrong; the caller treats null as "cannot judge".
    return null
  }
}

/** Transcripts are large and rarely read: to disk with a pointer, never into postgres. */
async function writeTranscript(
  config: { projects: Record<string, string>; scratch: string },
  job: ClaimedJob,
  workspace: string,
): Promise<string | undefined> {
  const dir = join(config.scratch, 'transcripts', job.runId)
  await mkdir(dir, { recursive: true })
  const ref = join(dir, 'output.json')
  // Through readContained, not a bare readFile. This one bypassed the containment check
  // entirely, and it is the worst place to do so: whatever it reads is written to a host
  // artifact and served over the API.
  const raw = await readContained(workspace, OUTPUT_PATH).catch(() => null)
  if (raw === null) return undefined
  await writeFile(ref, raw, { mode: 0o600 })
  return ref
}

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparseable: raw.slice(0, 2000) }
  }
}

function usageFrom(event: RunEvent | undefined): RunReport['usage'] {
  const u = event?.payload?.usage as
    | { inputTokens?: number; outputTokens?: number; costUsdEstimate?: number }
    | undefined
  if (!u) return undefined
  return {
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.costUsdEstimate !== undefined
      ? { costCents: Math.round(u.costUsdEstimate * 100) }
      : {}),
  }
}
