# Ogun — Architecture

A local-first software factory: scheduled AI workers that review, maintain, and
eventually implement code across a set of repositories.

Status: design. Nothing is built yet. Decisions marked **[settled]** are ones we've
argued through; **[deferred]** are deliberate non-goals for now; **[open]** still need
an answer.

---

## 1. Principles

1. **Runs happen on-device.** Wherever the control plane lives, the AI executes on a
   machine with your Claude/Codex subscription credentials. This is a permanent
   constraint, not a v0 shortcut — it's the entire cost model.
2. **Skills are durable, jobs are ephemeral.** A skill is committed to git. A job is a
   disposable execution of a skill by a worker.
3. **The sandbox never pushes.** It produces a patch. The host publishes. Git
   credentials never enter an agent's reach.
4. **Deterministic code before AI.** Ticket filtering, scheduling, git plumbing,
   dedupe — ordinary code. LLMs only where judgment is required.
5. **Structured output, validated.** Findings are records with schemas, not prose.
6. **Never silently lose coverage.** If a worker didn't run, or ran and produced
   nothing, or produced something that got filtered — those are three different
   facts and must never share a name.
7. **Propose, don't push.** Branches and draft PRs. Merging stays human.

---

## 2. Vocabulary

| Term | Definition |
|---|---|
| **Project** | A connected repository. Top-level organizational unit. |
| **Skill** | A reusable capability — instructions, scripts, reference material. `SKILL.md` convention. Committed to git. |
| **Worker** | A configured executor: skill + runtime + model + permissions + sandbox. The thing you schedule. |
| **Job** | One requested unit of work, created from a worker. Queued, claimed, executed. |
| **Run** | One execution attempt of a job. Carries traces, events, cost. |
| **Cycle** | A DAG of jobs with dependencies (e.g. four reviewers fanning into a triage node). |
| **Trigger** | What creates work: cron, manual, integration event, or another job. |
| **Foreman** | Orchestration + admission. Decides what runs, when, and whether it's allowed to. |
| **Runner** | The process that claims jobs and executes them on-device. |
| **Sandbox** | The isolated workspace a job executes in — container or git worktree. |
| **Runtime** | How an AI agent is actually invoked — `claude` or `codex`, as presets over a generic CLI spec. |
| **Finding** | One normalized issue reported by a reviewer worker. Has stable identity across runs. |
| **Change** | Code produced by a modifier worker: branch, diff, test result, PR. |
| **Integration** | External system connection — GitHub, Linear. |

Note: **"agent" is not a domain noun.** It's the ambient term for the AI doing work.
The configured, schedulable thing is a **Worker**. Using "agent" as a type name
collides with the AI session actually running inside a job.

---

## 3. Topology

```
WSL2 host — always-on-ish, systemd
│
├── ogun-server ──────────────── postgres (container)
│     ├── foreman: cron eval, missed-run catchup, DAG release, admission
│     ├── api :7777 (hono)
│     └── web UI (vite/react build, served by hono)
│
├── ogun-runner ──── HTTP ────→ localhost:7777/api/jobs/claim
│     ├── sandbox: container (default) | worktree (opt-in)
│     │     mounts: ~/.claude:ro  ~/.codex:ro  cache volumes
│     │     NO ssh key, NO gh token, NO network to GitHub
│     └── runtime: claude | codex  (presets over a cli spec)
│
└── publisher (host-side)
      patch → scratch worktree → branch → gh pr create --draft
```

**Why HTTP on one host.** The runner speaks HTTP to the server even though they're
the same machine. Cost: nothing. Benefit: moving the control plane to a VPS later is
a URL change, and the boundary is exercised from day one. The runner never opens a
database connection. **[settled]**

---

## 4. Components

### 4.1 Control plane

Hono API + React UI + Postgres, one Node process serving both. Owns: project/worker/
skill/cycle definitions (indexed from git — git is the source of truth), the job
queue, run history, findings, the runner registry.

Does **not** own: skill content (git), credentials (env/secrets), workspaces (disk),
raw model output beyond structured records + log refs.

### 4.2 Triggers

- `cron` — evaluated in-process by croner, not system cron
- `manual` — a button in the UI, a CLI command
- `integration` — GitHub push, Linear poll (phase 3+)
- `chained` — a DAG edge inside a cycle

**Missed-run policy is load-bearing.** WSL2 stops when Windows sleeps, hibernates, or
reboots for updates. On startup, Foreman asks per schedule: was an occurrence due
between `last_run_at` and now? Then per-worker policy:

```yaml
onMissed: skip      # nightly review — yesterday's is stale, wait for tonight
onMissed: runOnce   # weekly report — catch up, but only once
```

**Re-scan schedules; don't register once.** The obvious implementation registers cron
callbacks at startup from whatever config existed then, which means editing a worker
hot-reloads but *adding* one requires a restart. Foreman re-scans on an interval or on
config change — adding a worker is something you'll do constantly in the early weeks.

**Not Temporal or Trigger.dev.** [settled] Temporal solves durable mid-workflow
resumption across a fleet. We don't have that problem: our recovery unit is "retry the
whole job," which is an `attempts` column and an `available_at` timestamp. Trigger.dev
wants to own the execution environment, which conflicts directly with on-device runs.
Both also put a large dependency between you and the thing you're trying to
understand. What we actually write is croner for evaluation, `SKIP LOCKED` for
claiming, and a few hundred lines for dependency release and retry. Keep an
`Orchestrator` interface so a swap stays possible; don't build toward it.

### 4.3 Foreman — orchestration and admission

Two responsibilities, one component:

**Orchestration.** Evaluate schedules, create jobs, release DAG nodes when their
dependencies succeed, apply retry policy, detect stalled runs, finalize cycles.

**Admission.** Before a job is dispatched, decide whether it's allowed to run. This is
what stops the 2am failure loop from eating your entire rate limit by morning.

Guards, each at the scope where its scarce resource actually lives:

| Guard | Scope | v1? |
|---|---|---|
| Concurrent jobs | global (machine) | **yes** — start at 2; WSL2 will OOM otherwise |
| Consecutive-failure breaker | worker × project | **yes** — ~30 lines, prevents the real disaster |
| Runs per day | worker × project | defer |
| Token budget per day | global, per runtime | defer |
| Open agent PRs | project | defer (phase 3) |

Two implementation notes:

- **Admission consumes the budget, not completion.** Record the run at admit time as a
  side effect. A job that crashes before finishing still counts — otherwise a crash
  loop bypasses the budget entirely.
- **Persist breaker state in Postgres**, not process memory. On WSL2 an in-memory
  breaker resets every Windows update, which is exactly when you'd want it to hold.

**Budgets count tokens and runs, not cents.** [settled] On a subscription there is no
dollar cost — the scarce thing is rate-limit headroom in a rolling window. Keep a
`cost_cents` column on traces for later (real if an API-key runtime is ever added),
but the guard that fires for us is volume.

Defer the daily ceilings until a week of real data exists — you can't pick a sensible
token budget before knowing what one review run costs.

### 4.4 Durable state

**Postgres**, in a container next to the server. [settled — reversible]

Rationale: Docker is already a hard dependency for sandboxing, so the container costs
nothing new; `FOR UPDATE SKIP LOCKED` is the correct claim primitive; JSONB suits
run-event payloads; and there's no migration when the control plane moves off the
box. Honest caveat: SQLite would serve a single-host factory of this size perfectly
well. This is a ~2-hour migration later, not a one-way door.

Drizzle for schema and queries.

**What the database is for.** [settled] Postgres owns exactly what GitHub and Linear
cannot represent: runs, events, cost, and findings identity. PR state and ticket state
stay in GitHub and Linear, read live, **never mirrored**. A review producing thirty
observations with severity, status, and cross-run identity does not fit in a PR label;
"this PR is awaiting review" does not need a row in our database.

That split is why the `changes` table is an *artifact record* of what a run produced —
branch, diff, test result, resulting PR URL — and not the source of truth for where
that PR is in its lifecycle.

### 4.5 Runners

A runner claims jobs over HTTP and executes them. It advertises capability labels;
jobs declare requirements. Today there is one runner on WSL2; the protocol is the
same when a home server appears.

**The repo registry is per-runner, never global.** `/home/doug/dev/x` on WSL2 vs
`/Users/doug/dev/x` on macOS. No absolute path is ever stored in the database.

```jsonc
// ~/.ogun/runner.json — machine-local, never synced
{
  "runnerId": "wsl-desktop",
  "labels": ["claude", "codex", "docker"],
  "projects": { "ogun": "/home/doug/dev/ogun" },
  "scratch": "/home/doug/.ogun/work",
  "maxConcurrentJobs": 2
}
```

### 4.6 Sandbox

Two implementations behind one interface, chosen **per worker** (not just per
permission profile):

| Sandbox | Use | Notes |
|---|---|---|
| `container` | **default** | Real capability isolation. Per-project image. |
| `worktree` | opt-in | Fast, no image build. Isolates file state only, not capability. |

A `modifier` worker downgrading to `worktree` means an agent editing files directly
on the host. Gate it behind `policies.allowSandboxDowngrade: false`.

**Images.** Each project has its own image: `.ogun/Dockerfile` doing `FROM ogun/base`.
Base carries `claude`, `codex`, `git`, node. The project layer adds its toolchain.

- Tag by content hash of Dockerfile + lockfile.
- Rebuild when either changes, or the image ages past N days.
- Build at `ogun project add`, **not** at 2am.
- Mount a persistent package-manager cache volume, or every nightly run re-downloads
  the world.

**Credentials.** `~/.claude` and `~/.codex` mounted read-only. Worst case for a
misbehaving agent is burning rate limit. **No git credential ever enters a sandbox.**

**The sandbox never pushes.** [settled]

```
container:  clone at pinned SHA → agent works → commit locally → exit
runner:     extract git format-patch / bundle from the workspace
host:       apply to scratch worktree → push branch → gh pr create --draft
```

This collapses the "Publisher" permission profile — publishing becomes a host-side
pipeline step with its own gates (tests green, diff under N lines, PR cap not
exceeded) rather than an agent capability.

Permission profiles still exist for what the agent may do *inside* the sandbox:
`observer` (read), `reviewer` (read + run tests/scanners, emit findings), `modifier`
(write + commit). Enforced by the sandbox where practical, not just described in
prompts.

#### Basis: `claude-sandbox`, with a changed posture

`~/dev/claude-sandbox` already solves the awkward parts and `ogun/base` should start
from its `base/Dockerfile` plus codex. Reuse directly:

- Cross-platform credential resolution — `~/.claude` → `/home/dev/.claude`,
  `CLAUDE_CONFIG_DIR` set, three-way fallback for `.claude.json` (explicit → inside
  the data dir on Linux/WSL → legacy sibling on macOS), plus macOS Keychain
  extraction into a chmod-600 tempfile.
- Copying `.gitconfig` rather than bind-mounting it, so git can rewrite it.
- The layered config precedence (defaults → user dir → project dir → flags), which is
  already the hierarchy specced in §4.8.
- Resource caps (`mem_limit`, `cpus`) and the base toolchain.

**It is a convenience sandbox, not a security boundary.** It protects the host from
Claude's mistakes while a human watches a `--dangerously-skip-permissions` session.
Unattended overnight runs need a different posture. Five settings change:

| | claude-sandbox | ogun `reviewer` | ogun `modifier` |
|---|---|---|---|
| Network | `network_mode: host` | allowlist: model API only | allowlist: model API + package registries |
| `/var/run/docker.sock` | mounted | **never** | **never** |
| `gh` CLI | installed, `~/.config/gh` mounted rw | not installed | not installed |
| Project dir | bind-mount rw, the real working copy | local clone at pinned SHA | local clone at pinned SHA |
| `dev` user | passwordless sudo | no sudo | no sudo |
| Services (pg, redis, …) | sibling containers via compose | none needed | in-container, from the project image |

The socket is the load-bearing one: anything holding `/var/run/docker.sock` can start
a privileged container mounting `/`, so the container boundary is nominal. Mounting
`~/.config/gh` likewise hands the container a GitHub token, contradicting
sandbox-never-pushes.

**Self-contained: no siblings, no socket, no dind.** [settled] Everything a job needs
runs inside its own container. The Docker socket is never mounted — it is
root-equivalent on the host, so mounting it makes the container boundary decorative.
Docker-in-docker is not the escape hatch either: it needs `--privileged`, which is no
better. Consequences, in order of when they bite:

- **Reviewers need no services at all.** They read code and reason about it. Phases
  1–2 never encounter this question.
- **Modifiers needing postgres/redis get them *inside* the image.** The project's
  `.ogun/Dockerfile` installs them; the entrypoint starts them before the agent runs.
  This is what per-project images are for, and it keeps the job a single unit with
  nothing to orchestrate.
- **A project whose suite genuinely requires orchestrating multiple containers is out
  of scope for autonomous runs** until there's a better answer. Record that as a
  limitation rather than reaching for the socket.

**No `gh` in the image, and no git remote.** The container never talks to GitHub. The
runner prepares the workspace as a local clone pinned to a SHA
(`git clone --local --no-hardlinks`, so a container cannot corrupt the source repo's
object store), mounts it read-write, and the agent commits locally. Every outbound git
operation — fetch, push, PR creation — happens on the host after the container exits.
That makes the never-pushes rule structural rather than policed: there is no
credential and no remote to push to.

**Egress cannot be `none`.** The agent runtime itself calls out — `api.anthropic.com`
for claude, OpenAI's endpoint for codex. So a reviewer container is a tight allowlist
containing exactly those hosts, not an airgap. Modifiers add package registries.
Everything else is denied by default.

### 4.7 Runtimes

`claude` and `codex` are **presets over one generic `cli` spec**, not two bespoke
adapters. Two hand-written adapters means writing the same subprocess and
stream-normalizing code twice, and it drifts.

```ts
type RuntimeSpec = {
  provider: 'cli' | 'claude' | 'codex'
  command?: string[]          // argv; prompt appended as final arg
  model?: string
  parse?: 'text' | 'json'
  sessionFlag?: string        // '--resume' (claude) | '--session'
  dirFlag?: string
  stream?: boolean
  usage?: {                   // how to extract token counts
    inputKeys?: string[]
    outputKeys?: string[]
    cacheInputKeys?: string[]
    textPattern?: string
  }
}
```

Model names are **roles**, not tiers: workers reference `worker` and `reviewer`, and a
router maps names to specs. The routing logic follows from where cost and risk sit —
the worker burns most of the tokens and most of the clock across delivery, while the
reviewer runs several times per job and one bad approve costs a bad PR. Spend the
strong model on judgment; run the worker cheap.

**Runtime returns `AsyncIterable<RunEvent>`, not `Promise<Response>`.** [settled] The
naive shape is one call that hides an entire agentic session — the CLI runs, makes
fifty tool calls, and returns. That gives the UI nothing to render until the job is
over. Instead, every agent action is normalized into one event type as it happens, so
the run-detail timeline, the CLI, and any future consumer all render an identical
session.

Claude Code gives this natively via `--output-format stream-json`.
**[open] Codex event format** — unknown until `codex` is installed. Normalizing two
dissimilar streams into one `RunEvent` is the real work of supporting both; spike it
before committing.

### 4.8 Skills

Adopt the existing `SKILL.md` convention rather than inventing a format. Resolution
order:

```
built-in (ogun://security-review)
   ↓
global   (~/.ogun/skills/)
   ↓
project  (repo/.ogun/skills/, repo/.claude/skills/)
```

Repo-local wins. Skills are read from disk on every trigger tick, so editing a skill
takes effect on the next run with no restart.

### 4.9 Workers

```yaml
# repo/.ogun/config.yaml
project:
  name: ogun
extends: [ogun://typescript]

workers:
  security:
    skill: ogun://security-review
    runtime: claude
    model: reviewer
    permissions: reviewer
    sandbox: container
    schedule: "0 3 * * *"
    onMissed: skip

  quick-idioms:
    skill: ./skills/idioms
    runtime: codex
    permissions: reviewer
    sandbox: worktree      # opt out of containers for speed

policies:
  directPush: false
  allowSandboxDowngrade: false
  maxConcurrentModifiers: 1
```

### 4.10 Verification

Every worker has a verify gate: deterministic tool checks first, then agent lenses.
Tool checks short-circuit, so a schema-invalid output never spends a grading call.

**In v1 the gate controls persistence, not retry.** [settled] With no retry loop, a
failed gate means findings are not persisted and the run records why. Same Grader,
same config shape; phase 3 adds re-delivery on top without changing either.

**Default lens sets differ by permission profile.** A standing rubric of security /
coupling / deadcode grades *a code change* — meaningless for a reviewer that produced
no diff. The reviewer analog grades *findings quality*:

| Profile | Tool checks | Agent lenses |
|---|---|---|
| `reviewer` | output matches schema; every cited `file:line` exists in the diff | actionable? grounded in cited evidence? not N restatements of one issue? |
| `modifier` | build, test, lint, diff size | security, coupling, deadcode |

Per-worker overrides: `skipDefaultLenses: [...]`, or `lensProfile: none` for
non-code work.

```yaml
# alongside a skill
verify:
  expectations:
    - { name: schema,   method: tool, command: "ogun validate-findings out.json" }
    - { name: grounded, method: tool, command: "ogun check-citations out.json" }
    - name: actionable
      method: agent
      model: reviewer
      prompt: "Each finding must name a concrete change. Reject vague observations."
```

Tool checks can be Ogun's own CLI — that keeps the expensive checks rare and the
cheap ones deterministic.

### 4.11 Findings

The part that determines whether this is usable in week two.

**Stable identity.** Finding ID is a deterministic hash of
`(worker, skill_version, file, normalized_content)` — and **deliberately excludes the
line number**, because rebases and unrelated edits shift lines and would mint a
spurious new ID for an unchanged finding.

**Status lifecycle.** `open | triaged | fixed | wontfix | duplicate | gated |
overflow`, plus
`first_seen_run`, `last_seen_run`, `seen_count`. Without this, night two regenerates
every finding from night one and "I already dismissed this" is unrepresentable.

**Re-adjudication.** [phase 2] Hashing catches exact repeats. It does not catch the
same issue phrased differently. The mechanism: show the reviewer its own prior
unresolved findings for the file (verbatim stored text) and have it classify each as
`still-applies | resolved-by-this-diff | no-longer-applicable`. This is the antidote
to the failure mode every automated reviewer eventually exhibits — repeatedly
re-flagging an issue the developer has already seen and chosen not to act on.

Design the schema for it now; build it in phase 2.

**Grounding check.** Before findings are persisted, a deterministic check: does every
cited `file:line` exist in the diff? Cheap, catches hallucinated findings, and runs
before any expensive step — the same short-circuit principle as §4.10's tool checks.

**Coverage ledger.** Per run, record which workers were selected, ran, failed, or were
skipped and why. Silent coverage loss is the trust-killer.

### 4.12 Triage

A fan-in node that runs after all reviewers in a cycle and is **the only thing that
writes to the findings table**. Reviewers write to a staging area.

Without it, four reviewers produce ~70 rows a night: the same god-object flagged by
two of them in different words, twenty variations of one lint complaint, four
independent calibrations of "high severity", and a dozen things dismissed last week.
No reviewer can fix that — each sees only its own output.

Triage does five things:

1. **Cross-reviewer dedupe** — two descriptions of one issue collapse into one
   finding with two sources. Hash dedupe cannot do this; it needs every output at
   once, which is exactly what a fan-in provides.
2. **Severity normalization** — one calibration instead of N independent ones.
3. **Ranking** — severity × confidence × effort, so the top of the inbox is worth
   reading.
4. **Suppression against history** — the natural home for re-adjudication. One
   implementation rather than N drifting copies inside each reviewer.
5. **Coverage ledger assembly** — marks the batch degraded when a reviewer failed.

Cheap to run well: structured JSON in, no repo reading. A strong model is affordable
here even when the reviewers run cheap.

**Triage never deletes, it marks.** `gated` (below confidence threshold) and
`overflow` (passed the gate, cut by top-N) are distinct statuses carrying reasons;
raw reviewer output is kept as a run artifact; the UI can show everything including
gated. One bad model call silently dropping a real finding is the serious failure
mode here, and non-destructive marking is the mitigation.

**Fan-in is the only real justification for cycles.** Fan-out alone is just N
independent jobs. But triage does *not* require a DAG engine: for a fixed reviewer
set it is a two-stage sequential pipeline — run N jobs, await all, run one more,
roughly 30 lines. A general DAG engine is only needed for user-defined graphs. Hence
triage in phase 2, cycles in phase 3.

### 4.13 Integrations

- **GitHub** — clone, branch, push, draft PR. Host-side only.
- **Linear** — poll every N minutes with a *deterministic* filter (status, label,
  not-blocked) before any AI sees a ticket. Sources emit jobs; they are not workers.

**[open]** How PR lifecycle state is represented once modifier workers exist —
GitHub is authoritative per §4.4, but the specific mechanism (labels, checks,
review state, or some combination) is undecided. Phase 3 concern.
- **[deferred]** GitHub-repo-as-findings-sink. Interesting as an exporter (findings as
  markdown files, triage in PRs, history for free) but wrong for operational data:
  git has no cheap atomic claim, latency is seconds, and run events are
  high-frequency appends. Keep findings storage free of Postgres-specific assumptions
  so this stays possible.

---

## 5. Execution

Two nested levels. The cycle lifecycle is Foreman's; the job pipeline is the runner's.
Keeping them separate is what lets phase 1 ship a one-node cycle and phase 3 add a
graph without touching either end.

### 5.1 Cycle lifecycle — Foreman's loop

```
  croner                          2 AM fires
     │
     ▼
  FOREMAN ─── read cycle definition from .ogun/ (fresh each fire)
     │        create CycleRun + Jobs for entry nodes
     │        each Job carries its own prompt
     │        admit (budget, breaker, concurrency)
     ▼
  DATABASE   jobs: queued
     │
     ▼
  RUNNER     claim (SKIP LOCKED, matched on capability labels)
     │       materialize workspace — local git clone @ pinned SHA
     │       ensure project image is current (content-hash check)
     │       inject only skills NOT already in the workspace
     ▼
  SANDBOX    workspace mounted rw; no socket, no remote, allowlist egress
     │       agent runs the job's prompt
     │       └──► RunEvents stream out continuously, batched
     ▼
  RUNNER     verify gate → extract patch (modifiers)
     ▼
  DATABASE   ONE transaction: run outcome + findings + coverage
     │
     ▼
  FOREMAN    node terminal → release dependents whose deps are satisfied
     │       none left → CycleRun complete
     ▼
  UI         SSE live during; findings inbox after
```

Seven things that flow is deliberate about:

1. **The trigger only says "fire."** Croner knows a cadence and nothing else. All
   resolution — which cycle, which workers, what depends on what — is Foreman's, read
   fresh from `.ogun/` at fire time so a config edit needs no restart.
2. **The job carries its own prompt.** Not a reference the runner has to expand — the
   literal text handed to the agent, often as short as *"Use the
   staging-error-reviews skill."* Layered like all config: the worker supplies a
   default, a cycle node or a source (a Linear ticket) may override it.
3. **Skills usually need nothing done.** A skill in the repo's `.claude/skills/` or
   `.ogun/skills/` arrives with the workspace and the runtime discovers it natively.
   Injection applies only to a global or built-in skill that isn't already present.
4. **The workspace is materialized, not fetched.** `git clone --local
   --no-hardlinks` from the copy already on disk, then checkout the pinned SHA. No
   network, and `--no-hardlinks` so the container cannot corrupt the real object
   store. Full history comes along, which the grounding check needs for
   `git diff <base>`. In a future cloud-runner world this same step becomes a network
   clone — that's the seam, and the only thing that changes.
5. **Admission happens at dispatch, not at execution.** Foreman holds the history in
   Postgres, so it can refuse before a job is ever queued. The runner re-checks at
   claim time because conditions change while a job sits in the queue; defence in
   depth, not the primary gate.
6. **Release is per-node, not per-stage.** A node unlocks as soon as *its* dependencies
   are terminal, not when the whole preceding stage finishes. Otherwise a slow reviewer
   stalls everything behind it.
7. **A failed dependency doesn't have to block a dependent.** Each edge declares
   `on_dep_failure: block | degrade`. Triage uses `degrade` — it runs with three of
   four reviewers and marks the batch incomplete in the coverage ledger. Silent
   coverage loss is worse than a partial result.

#### Why an isolated workspace at all

A project ships a Dockerfile describing how to run itself, so it's tempting to mount
the live working copy and skip the copy entirely. Three reasons not to, in order of
force:

- **A nightly reviewer must not review your dirty tree.** At 3am it would grade
  whatever half-finished edit is open, emit findings about it, and churn them every
  night as you work.
- **`repo_sha` has to mean something.** Re-adjudication asks "did this change since I
  last saw it," which requires knowing exactly what was reviewed.
- **Concurrency.** Two jobs on one project, or a job while you're editing, corrupt
  each other.

Equally, the code should **not** be baked into the image. Environment and content have
different lifecycles: a Dockerfile changes monthly, the code hourly. `COPY . .` makes
the image cache key the whole source tree, so every commit forces a rebuild before any
job can start. **The image provides the environment; the workspace provides the code.**

This does place a requirement on projects: **a project must ship an image that can run
its own test suite end to end**, or modifier workers have nothing to verify against.
Absent `.ogun/Dockerfile`, a project falls back to `ogun/base`, which is enough for
reviewers and not enough for modifiers.

#### Events and findings are different writes

- **Events** are high-volume and needed live. The runner batches them (flush every N
  events or M milliseconds, whichever first) and POSTs to the control plane, each
  carrying a per-run sequence number so ordering survives out-of-order delivery and
  the UI can detect gaps. Control plane to browser is SSE — unidirectional is all the
  timeline needs. On a runner crash, everything already flushed is durable and a
  stale-claim sweep marks the run.
- **Findings** are written once, in a single transaction with the run's terminal state
  and coverage row. Partial findings from a crashed run are worse than none, and
  nothing becomes visible unless the verify gate passed.
- **Raw agent transcripts** are large and rarely read: written to disk as a run
  artifact with a pointer in `artifacts`, never into Postgres.

**A single job is a one-node cycle.** [settled] Phase 1 creates a `CycleRun`
containing exactly one job. It costs one table and an FK, and it means "run this
worker now" and "run the nightly cycle" are the same code path from the start. The
coverage ledger forces this anyway: recording which workers ran in a batch requires a
batch identity to hang it on.

**A cycle is complete when every node is terminal** — succeeded, failed, or skipped.
Not when all succeeded.

### 5.2 Job pipeline — the runner's loop

Runs inside the runner, once per job.

```
prepare   worker config; materialize workspace; ensure image current;
          inject only the skills the workspace lacks
   ↓
admit     re-check with foreman (primary gate was at dispatch)
   ↓
provision sandbox — ONCE per job, not per round
   ↓
   ┌─ round 0: deliver(job.prompt) → grade ─┐    ← v1: exactly one round
   └─ round N: deliver(feedback, resume session) → grade ─┘
   ↓
record    outcome + findings + coverage in one transaction;
          transcript to disk, patch extracted
```

`prepare` is thin by design. The prompt already exists on the job, and the skill is
almost always already in the workspace — so there is no prompt composition step and
usually no skill materialization either.

**The workspace is provisioned once and every retry reuses it.** [settled] The retry
prompt has to say so — *"your previous attempt's changes are still present; run
`git status` and `git diff` and build on that work, do not start over"* — and the
provider session carries forward (`--resume`) so a retry continues the same
conversation rather than re-reading the repo cold. Provisioning per round instead
turns three cheap rounds into three full-price ones and invites thrashing.

**v1 has no retry loop.** [settled] Reviewers emit findings; the verify gate decides
whether they persist; done. Retry is a modifier concept (phase 3). Keep the `for
round` shape running exactly once so phase 3 is an unwrapping, not a rewrite.

**Outcome taxonomy** — never conflated:
`approved | changes-requested | skipped (admission refused) | dispatched | error`

### 5.3 Patch reconciliation

For any provider whose agent edited a workspace we then need to grade or publish:

1. Reset workspace to base ref (a retry would otherwise fail to apply)
2. Apply patch
3. **Stage it** — `git apply` leaves changes unstaged, and untracked new files do not
   appear in `git diff <base>`, so an unstaged new test file is invisible to the gate
4. Write any extra files

**Path safety for anything written back from a sandbox:** reject absolute and `..`
paths, resolve symlinks on both the workspace and the target's parent and require
containment, open with `O_NOFOLLOW`, mode 0600.

---

## 6. Data model

```
projects            id, slug, remote_url, default_branch
skills              id, project_id?, name, source_path, version_hash
workers             id, project_id, name, skill_id, runtime, model_role,
                    permissions, sandbox, enabled
schedules           id, cycle_id, cron, tz, on_missed, last_run_at, enabled
cycles              id, project_id, name, definition (jsonb)
                    -- nodes[] + edges[] {from, to, on_dep_failure}
                    -- a single worker is a one-node cycle

cycle_runs          id, cycle_id, trigger, started_at, ended_at, state
jobs                id, cycle_run_id, worker_id, project_id, prompt,
                    depends_on[], requires[], state, priority, available_at,
                    attempts, claimed_by, claimed_at
                    -- prompt is the literal text handed to the agent
runs                id, job_id, runner_id, started_at, ended_at, outcome,
                    repo_sha, worker_version, skill_version, runtime, model,
                    input_tokens, output_tokens, cost_cents, duration_ms
run_events          id, run_id, seq, ts, type, payload (jsonb)

staged_findings     id, run_id, worker_id, raw (jsonb)   -- pre-triage, queryable
findings            id, project_id, worker_id, fingerprint, path, snippet,
                    severity, title, body, status, first_seen_run,
                    last_seen_run, seen_count
changes             id, run_id, branch, base_sha, patch, files_changed,
                    tests_run, tests_passed, pr_url
                    -- artifact record only; PR lifecycle state lives in GitHub
coverage            id, cycle_run_id, worker_id, selected, ran, outcome, reason
artifacts           id, run_id, kind, ref
                    -- kind=transcript points at a file on disk, never inlined

runners             id, name, labels[], last_seen_at, max_concurrency
```

`worker_version` and `skill_version` on every run answer the question that otherwise
becomes unanswerable: *did this finding stop appearing because we fixed the code, or
because I edited the skill?*

`input_tokens` / `output_tokens` are tracked separately for worker and reviewer roles
— you cannot reconstruct that split after the fact, and it's what makes model
comparison possible later.

---

## 7. Layout

```
ogun/
  packages/
    core/         types, drizzle schema, fingerprinting, config resolution
    runner/       job pipeline, sandbox impls, runtime presets
    server/       hono api, foreman, integrations, serves web build
    cli/          peer to the UI, same application layer
  apps/
    web/          vite + react + react-router + tanstack query
  images/
    base/         Dockerfile for ogun/base

~/.ogun/          machine-local: runner.json, global skills, cache volumes
```

Stack: Node 22 (via fnm), Hono, Vite + React (no Next), Postgres + Drizzle, croner,
Zod for all config and structured-output validation, Docker.

A CLI is a peer to the UI, not an afterthought — `ogun runner doctor` (which runtimes
and tools are present on this machine), `ogun run <worker>`, `ogun runs`,
`ogun findings`.

---

## 8. Cross-platform

Only WSL2 matters today, but the constraints are real:

- **"Always on" isn't.** WSL2 stops with Windows sleep/hibernate/update reboots.
  Hence the missed-run policy.
- **systemd.** Set `systemd=true` in `/etc/wsl.conf`; run server and runner as units
  so they survive restarts.
- **Memory.** WSL2 caps at ~50% of Windows RAM. A container running an agent plus a
  test suite is not small. `maxConcurrentJobs: 2`; raise `memory=` in `.wslconfig`
  before raising concurrency.
- **Filesystem.** Everything on ext4. Never `/mnt/c` — roughly 10× slower.

---

## 9. Phasing

**Phase 1 — the loop works.** One project, one `adversarial-review` worker, container
sandbox, manual trigger from the UI. Foreman creates a **one-node CycleRun** — the
same path a nightly cycle will take, with a graph of one. **Verify gate** (tool checks
+ reviewer-profile agent lenses) gating findings persistence. Findings persisted with
fingerprints. Run detail page with a live event timeline. Both `claude` and `codex`
runtimes (pending the codex event-format spike). No cron, no retry, no fan-in, no
publishing.

**Phase 2 — the factory runs itself.** Foreman: cron, missed-run catchup, schedule
re-scan, the job queue, concurrency cap, failure breaker. Second and third workers.
**Triage fan-in** — the first multi-node cycle, and the first use of
`on_dep_failure: degrade`. Findings inbox as the home screen. Re-adjudication.

**Phase 3 — the write path.** Modifier workers, retry loop on the existing verify
gate, modifier-profile lenses, patch → branch → draft PR pipeline, tests-must-pass
gate, PR cap. Arbitrary user-defined graphs if they turn out to be wanted.

**Phase 4 — Linear.** Deterministic ticket filtering, scope evaluator, ticket →
plan → implement → review → draft PR.

**Explicit non-goals:** Kubernetes, multi-tenancy, RBAC, billing, graphical workflow
canvas, auto-merge, agent memory, model auto-selection, remote runner mesh.

---

## 10. Open questions

1. **Codex event format.** Blocked on installing `codex`. Determines whether
   `RunEvent` normalization is a day or a week, and therefore whether both runtimes
   land in phase 1.
2. **Image staleness policy.** Rebuild on Dockerfile/lockfile change is obvious; what
   the age-based trigger should be is not.
3. **Re-adjudication mechanism.** The approach (show prior unresolved findings
   verbatim, classify) is a proposal, not a decision. Revisit at implementation.
4. **Triage prompt and calibration.** What the severity scale actually is, and how
   triage is itself evaluated. It is the one node that can silently lose real
   findings, so it needs its own quality measure — currently undefined.
5. **Workspace materialization cost on large repos.** `--no-hardlinks` copies the
   object store per job. Fine for these repos; if one gets big the escape hatch is
   dropping the flag, at the cost of a container being able to corrupt the source.
   No policy yet for when to switch.
