import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type WorkerRow } from '../api.ts'
import { ScheduleField, type ScheduleValue } from '../ScheduleField.tsx'

const RUNTIMES = ['claude', 'codex']
const MODEL_ROLES = ['worker', 'reviewer']
const PERMISSIONS = ['observer', 'reviewer', 'modifier']
const SANDBOXES = ['container', 'worktree']

const HELP: Record<string, string> = {
  observer: 'reads the code and nothing else',
  reviewer: 'reads, runs tests and scanners, emits findings',
  modifier: 'writes and commits — phase 3, no publishing path yet',
  container: 'real capability isolation, per-project image',
  worktree: 'fast, no image build. Isolates file state only, not capability',
  worker: 'the cheap model — burns most of the tokens and most of the clock',
  reviewer_model: 'the strong model — runs several times per job, one bad approve is costly',
}

export type WorkerFormProps = {
  projectSlug: string
  existing?: WorkerRow['worker']
  /** Compare-and-swap token from the list read. Two tabs cannot clobber each other. */
  configHash?: string
  onDone: () => void
}

/**
 * The point of this form is that a worker is a small thing: a skill, plus how to run
 * it. Everything here has a working default except which skill to point at.
 */
export function WorkerForm({ projectSlug, existing, configHash, onDone }: WorkerFormProps) {
  const qc = useQueryClient()
  const { data: skillData } = useQuery({
    queryKey: ['skills', projectSlug],
    queryFn: () => api.skills(projectSlug),
  })
  const skills = skillData?.skills ?? []

  const [name, setName] = useState(existing?.name ?? '')
  const [skill, setSkill] = useState(existing?.skillRef ?? '')
  const [runtime, setRuntime] = useState(existing?.runtime ?? 'claude')
  const [model, setModel] = useState(existing?.modelRole ?? 'worker')
  const [permissions, setPermissions] = useState(existing?.permissions ?? 'reviewer')
  const [sandbox, setSandbox] = useState(existing?.sandbox ?? 'container')
  const [prompt, setPrompt] = useState(String(existing?.config?.prompt ?? ''))
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [schedule, setSchedule] = useState<ScheduleValue>({
    cron: String(existing?.config?.schedule ?? ''),
    onMissed: (existing?.config?.onMissed as 'skip' | 'runOnce') ?? 'skip',
  })

  const chosen = skills.find((s) => s.skill.name === skill)
  const defaultPrompt = chosen?.skill.defaultPrompt ?? `Use the ${skill || '<skill>'} skill.`

  // Naming the worker after the skill is the common case and a fine default, but it is
  // also what made "is adversarial-review a skill or a worker?" ambiguous — so it is a
  // prefill you can edit, not a rule.
  useEffect(() => {
    if (!existing && skill && !name) setName(skill)
  }, [skill, existing, name])

  const [written, setWritten] = useState<{ path: string; text: string } | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const input = {
        projectSlug,
        name,
        skill,
        runtime,
        model,
        permissions,
        sandbox,
        enabled,
        // An empty string is how you clear a prompt override; omitting it would keep
        // the old one on an edit. Same for the schedule.
        prompt: prompt.trim(),
        schedule: schedule.cron.trim(),
        onMissed: schedule.onMissed,
        ...(configHash ? { expectedHash: configHash } : {}),
      }
      return existing ? api.updateWorker(existing.id, input) : api.createWorker(input)
    },
    onSuccess: async (result) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['allWorkers'] }),
        qc.invalidateQueries({ queryKey: ['workers'] }),
        qc.invalidateQueries({ queryKey: ['skills'] }),
      ])
      // Don't close: the point of writing to config.yaml is that you can see the change
      // and go commit it. Closing the form hides the only evidence it happened.
      setWritten({ path: result.config.path, text: result.config.text })
    },
  })

  const modifierOnWorktree = permissions === 'modifier' && sandbox === 'worktree'
  const nameValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  const canSave = Boolean(skill) && nameValid && !modifierOnWorktree && !save.isPending

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <h2 style={{ marginTop: 0 }}>{existing ? `Edit ${existing.name}` : 'New worker'}</h2>

      <div className="form">
        <label>
          <span>Skill</span>
          <select value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">choose a skill…</option>
            {skills.map((s) => (
              <option key={s.skill.id} value={s.skill.name}>
                {s.skill.displayName ?? s.skill.name}
              </option>
            ))}
          </select>
          {chosen?.skill.shortDescription && (
            <small className="muted">{chosen.skill.shortDescription}</small>
          )}
          {skills.length === 0 && (
            <small className="muted">
              none indexed — <span className="mono">ogun project sync</span>
            </small>
          )}
        </label>

        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="nightly-security"
            disabled={Boolean(existing)}
          />
          <small className={name && !nameValid ? 'error' : 'muted'}>
            {name && !nameValid
              ? 'lowercase kebab-case only — it becomes a container name'
              : existing
                ? 'the name is fixed; delete and recreate to change it'
                : 'what you schedule and trigger'}
          </small>
        </label>

        <label>
          <span>Runtime</span>
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            {RUNTIMES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Model role</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODEL_ROLES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <small className="muted">
            {model === 'worker' ? HELP.worker : HELP.reviewer_model}
          </small>
        </label>

        <label>
          <span>Permissions</span>
          <select value={permissions} onChange={(e) => setPermissions(e.target.value)}>
            {PERMISSIONS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <small className="muted">{HELP[permissions]}</small>
        </label>

        <label>
          <span>Sandbox</span>
          <select value={sandbox} onChange={(e) => setSandbox(e.target.value)}>
            {SANDBOXES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <small className={modifierOnWorktree ? 'error' : 'muted'}>
            {modifierOnWorktree
              ? 'a modifier on a worktree edits files directly on your host — refused'
              : HELP[sandbox]}
          </small>
        </label>

        <label className="wide">
          <span>Prompt</span>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={defaultPrompt}
          />
          <small className="muted">
            The literal text handed to the agent. Leave blank and the skill's own
            <span className="mono"> default_prompt</span> is used — most workers want that.
            {chosen && (
              <>
                {' '}
                Here that is <span className="mono">{defaultPrompt}</span>
              </>
            )}
          </small>
        </label>

        <ScheduleField value={schedule} onChange={setSchedule} />

        <label className="inline">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
      </div>

      {save.error && <p className="error">{errorText(save.error)}</p>}

      {written ? (
        <div style={{ marginTop: 14 }}>
          <p style={{ margin: '0 0 6px', fontSize: 13 }}>
            Wrote <span className="mono">{written.path}</span>. It is not committed — review
            the diff and commit it like any other change.
          </p>
          <pre className="md-code" style={{ maxHeight: 260 }}>
            {excerpt(written.text, name)}
          </pre>
          <button onClick={onDone}>Done</button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? 'saving…' : existing ? 'Save' : 'Create worker'}
          </button>
          <button onClick={onDone}>Cancel</button>
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
            Writes to <span className="mono">.ogun/config.yaml</span>
          </span>
        </div>
      )}
    </div>
  )
}

/** The worker's own block out of the whole file — enough to see what landed. */
function excerpt(text: string, name: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trimEnd() === `  ${name}:`)
  if (start === -1) return text
  let end = start + 1
  while (end < lines.length && /^\s{4,}\S/.test(lines[end] ?? '')) end++
  return lines.slice(start, end).join('\n')
}

const errorText = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  // The client throws "<path>: <status> <json body>"; surface just the message.
  const match = /"error":"((?:[^"\\]|\\.)*)"/.exec(raw)
  return match?.[1]?.replace(/\\"/g, '"').replace(/\\n/g, ' ') ?? raw
}
