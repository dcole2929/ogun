# Ogun — Architecture

A local-first software factory: scheduled AI workers that review, maintain, and
eventually implement code across a set of repositories.

Status: phase 1 is built and the loop runs end to end. Decisions marked **[settled]**
are ones we've argued through; **[deferred]** are deliberate non-goals for now;
**[open]** still need an answer. Where the implementation diverged from what was
designed, the divergence is recorded here rather than quietly dropped.

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
└── publisher (in the runner process, host-side)
      patch → scratch worktree → git am → push → gh pr create --draft
      credential behind one interface; `gh` today (ADR-0009)
```

**Why HTTP on one host.** The runner speaks HTTP to the server even though they're
the same machine. Cost: nothing. Benefit: moving the control plane to a VPS later is
a URL change, and the boundary is exercised from day one. The runner never opens a
database connection. **[settled — ADR-0001]**

---

## 4. Components

### 4.1 Control plane

Hono API + React UI + Postgres, one Node process serving both. Owns: project/worker/
skill/cycle definitions, the job queue, run history, findings, the runner registry.

**Git is the source of truth for worker definitions, and the control plane edits the
file.** [settled — ADR-0002] A worker lives in exactly one place: `.ogun/config.yaml`,
in the repo. Creating one in the UI writes that file and re-indexes from it. There is
no second place a worker can exist, and no "which copy wins" question.

Two designs were tried before this one. Keeping UI workers in the database alongside
file workers meant an `origin` column, a shadowing rule, and a promotion step — three
concepts to hold, and worker definitions that did not travel with the repo. Routing the
write through the runner would have worked too, but the runner's job is to clone *out*
of your repos, never write into them, and widening that was a worse trade than widening
the server's.

What this costs: the control plane needs a local path for a project to edit it. That is
recoverable rather than fundamental — the rule §4.5 actually protects is *no absolute
path in the database*, since `/home/doug/dev/x` and `/Users/doug/dev/x` are the same
project. So the path map is machine-local (`~/.ogun/config.json`, written by
`ogun project add` and `ogun project sync`) and never crosses the API. A control
plane with no local copy reports that it cannot edit and returns the YAML block to paste
by hand — which is the hosted case, and the seam where `ConfigStore` grows a second
implementation that writes through the GitHub API.

Nothing about the sandbox changes. This is the host-side control plane writing one file;
no agent gains a capability, and §4.6's never-pushes rule is untouched.

Four properties make editing someone's hand-written file acceptable:

- **Comments, key order, and quoting survive.** Writes go through the YAML Document API,
  not parse-and-restringify. A UI that silently reformats your file is a UI you stop
  trusting with your file.
- **Defaults are omitted.** Only fields differing from the schema default are written, so
  the diff stays readable instead of accumulating every key at its default value.
- **The result is validated before it lands**, and the write is atomic via rename. The UI
  cannot leave a `config.yaml` on disk that the next sync refuses to load, or a truncated
  one after a crash.
- **Edits are compare-and-swap** on a content hash, so two tabs — or a tab racing your
  editor — fail loudly instead of one silently winning.

**The file is written, never committed.** The uncommitted diff *is* the review step, and
auto-committing to someone's working branch is not the control plane's call.

**Skills are indexed, never authored here.** Sync ships each `SKILL.md` body, its
reference paths, and `allow_implicit_invocation` to the control plane so the UI can show
what a worker will actually do without reaching into a project's filesystem. That row is
an index of git, overwritten wholesale on every sync; editing a skill happens in the
repo.

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

**Postgres**, in a container next to the server. [settled — reversible; ADR-0003]

Rationale: Docker is already a hard dependency for sandboxing, so the container costs
nothing new; `FOR UPDATE SKIP LOCKED` is the correct claim primitive; JSONB suits
run-event payloads; and there's no migration when the control plane moves off the
box. Honest caveat: SQLite would serve a single-host factory of this size perfectly
well. This is a ~2-hour migration later, not a one-way door.

Drizzle for schema and queries.

**What the database is for.** [settled — ADR-0004] Postgres owns exactly what GitHub
and Linear cannot represent: runs, events, cost, and findings identity. PR state and
ticket state stay in GitHub and Linear, read live, **never mirrored**. A review producing
thirty observations with severity, status, and cross-run identity does not fit in a PR
label; "this PR is awaiting review" does not need a row in our database.

That split is why the `changes` table is an *artifact record* of what a run produced —
branch, diff, test result, resulting PR URL — and not the source of truth for where
that PR is in its lifecycle.

### 4.5 Runners

A runner claims jobs over HTTP and executes them. It advertises capability labels;
jobs declare requirements. Today there is one runner on WSL2; the protocol is the
same when a home server appears.

**The repo registry is per-runner, never global.** `/home/doug/dev/x` on WSL2 vs
`/Users/doug/dev/x` on macOS. No absolute path is ever stored in the database.

**A local checkout is an optimisation, not a requirement.** [settled] A runner with no
path for a project clones from its remote, so a machine that joined a minute ago can work
on anything. Registering one — `ogun project add` inside the repo — makes it faster, works
offline, and lets a co-located control plane edit that project's `config.yaml`.

**One machine-local file, not one per component.** [settled] `~/.ogun/config.json` holds
everything this box knows. There were briefly two — one for the server's path map, one
for the runner's — both answering "where is project X on this disk" and able to disagree.
A machine has one filesystem, so it has one map.

**JSON here, YAML in the repo.** [settled] The two config files are different things, and
the format follows who writes each one. `~/.ogun/config.json` is written by commands
(`runner init`, `project add`) and never hand-edited, so there are no comments or key
order to preserve and JSON's lack of ambiguity is worth more than its unfriendliness.
`.ogun/config.yaml` is authored by a person, reviewed in a pull request, and edited in
place by the UI — which needs comments and ordering to survive a round-trip (§4.9), and
which is why prompts are readable block scalars rather than strings full of `\n`.

The cost is remembering which file is which shape, and it is a real cost. The alternative
— one format everywhere — means either giving the repo file up to JSON, which loses the
comments in the file people actually read, or giving the machine file to YAML, which buys
nothing for a file no one opens.

```jsonc
// ~/.ogun/config.json — machine-local, never synced, mode 0600
{
  // Optional. Absent, a runner clones from the project's remote instead.
  "projects": { "ogun": "/home/doug/dev/ogun" },

  // Present once this machine runs a control plane bound beyond localhost.
  // Generated on first start; never typed in.
  "server": { "token": "ogun_…" },

  // Present once this machine is a runner.
  "runner": {
    "id": "wsl-desktop",
    "labels": ["claude", "codex", "docker"],
    "serverUrl": "http://localhost:7777",
    "token": "ogr_…",
    "maxConcurrentJobs": 2,
    "scratch": "~/.ogun/work"
  }
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

**The sandbox never pushes.** [settled — ADR-0005]

```
container:  clone at pinned SHA → agent works → commit locally → exit
runner:     extract git format-patch / bundle from the workspace
host:       apply to scratch worktree → push branch → gh pr create --draft
```

This collapses the "Publisher" permission profile — publishing becomes a host-side
pipeline step with its own gates (tests green, diff under N lines, PR cap not
exceeded) rather than an agent capability.

**Built, and it runs in the runner process.** [settled — ADR-0009] The step is
`packages/runner/src/publish.ts`, the mirror of `patch.ts`, triggered automatically once a
job finalizes — and *after* the report, so a publish that fails halfway leaves a `changes`
row with a null `branch` rather than a live pull request the database has never heard of.
Its gates are the run's recorded outcome being `dispatched`, `changes.tests_passed` being
true rather than merely not-false, and `policies.maxOpenPullRequests` counted live against
open pull requests under the `ogun/` branch prefix. The credential reaches it through one
two-method interface with one implementation (`git` + `gh`); a repo-scoped GitHub App
installation token is the second, and its condition is a runner that is not your own
machine. The diff-size limit named above is applied at *extraction* as `MAX_PATCH_BYTES`
rather than at publish, since a patch over it never becomes an artefact at all.

Permission profiles still exist for what the agent may do *inside* the sandbox:
`observer` (read), `reviewer` (read + run tests/scanners, emit findings), `modifier`
(write + commit).

**Enforced at the mount.** [settled] The tree under review is mounted read-only for
`observer` and `reviewer`, and read-write only for `modifier`. `.ogun-out/` is layered
over it read-write, because it lives inside the tree and a blanket read-only mount stops
a reviewer reporting at all — which is not a stricter reviewer, it is a broken one.

The mount, rather than the runtime, because it is the one place both runtimes go through.
This was previously "enforced by the sandbox where practical", which was never true of the
code: the whole of it was `--disallowedTools Edit,Write,NotebookEdit,MultiEdit` on claude,
in a session that also passes `--dangerously-skip-permissions`, so `Bash` wrote whatever
it liked. Codex had no restriction at all, and the container passed `OGUN_PERMISSIONS`
into an environment nothing read. A guarantee expressed as a runtime flag is applied by
whichever runtime happens to support it, which is exactly how that happened.

Verified against a real review rather than asserted: a reviewer on a read-only tree
completed in 181s, reported a finding, and produced no filesystem errors. The claude flag
list stays — no longer load-bearing, but free, and it tells the agent the intent up front
rather than letting a write die on a read-only filesystem mid-task.

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

**Self-contained: no siblings, no socket, no dind.** [settled — ADR-0006] Everything a
job needs runs inside its own container. The Docker socket is never mounted — it is
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

**Egress cannot be `none` for an agent run.** The runtime itself calls out —
`api.anthropic.com` for claude, OpenAI's endpoint for codex — so a reviewer container
cannot be an airgap.

**Egress is a host allowlist.** [built] A worker declares the hosts its sandbox may
reach; anything else is refused. Four spellings, of which `open` and `none` are what
already shipped and keep working unchanged:

| `egress:` | Means |
|---|---|
| *absent* | The default allowlist for the worker's runtime. **The default.** |
| a list of hosts | Those hosts *in addition to* the defaults. `*.example.com` allowed. |
| `open` | Unrestricted internet. An explicit opt-out; the runner logs it every run. |
| `none` | No network at all. Structural, and correct for a tool-only pass. |

The default set is the model API for whichever runtime will run — `*.anthropic.com` or
`*.openai.com` plus `*.chatgpt.com` and `*.oaiusercontent.com` — plus
`registry.npmjs.org`, because §9's tests-must-pass gate runs the project's suite in this
same sandbox and a blocked registry turns `pnpm install` into a red suite rather than an
egress error. A declared list *adds* to that: replacing it would let a worker lock its own
runtime out of the model API, which is not a stricter worker but one that cannot start.

Vendor domains are wildcarded rather than enumerated. Guessing today's endpoint names —
the API host, the OAuth refresh host, the feature-flag host a CLI stalls on — and being
wrong produces a hang that reads as anything but a firewall rule, and it buys nothing:
the attacker in the prompt-injection story does not control a host under `anthropic.com`.

**How it is enforced: `--network none`, plus one unix socket.** The container has no
network interface but `lo`. Its only route out is a unix socket the runner bind-mounts in,
on the far side of which is a forward proxy in the runner process that allows `CONNECT`
to allowlisted hosts and refuses everything else with a 403 naming the host. Inside the
container a ~40-line forwarder bridges `127.0.0.1:8118` to that socket, because
`HTTPS_PROXY` cannot name a socket file; `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are set in
**both** letter cases, since curl, Go and reqwest deliberately ignore uppercase
`HTTP_PROXY` (the CGI `Proxy:` header hole) while other clients read only uppercase.

The ordering is the point and it is the opposite of how a proxy is usually deployed. On a
normal bridge network `HTTPS_PROXY` is *advice*, and a prompt-injected agent declines it
with `curl --noproxy '*'`. Here there is no interface to decline with.

What was rejected, and why:

- **`iptables` on resolved IPs.** Needs `NET_ADMIN`, which `--cap-drop ALL` plus
  `no-new-privileges` exists to deny — and rules written at container start are stale
  immediately against a rotating CDN, so they are simultaneously too narrow (the job
  fails) and far too wide (the whole CDN is allowed).
- **DNS filtering.** Only stops a client that asks DNS. `curl https://1.2.3.4/ -H 'Host:'`
  never asks. It filters the honest.
- **A dedicated docker network with masquerade disabled.** The runner-up, and it fails on
  reachability rather than filtering: the host end must bind an address the container can
  see, and under Docker Desktop on WSL2 the bridge gateway lives in the engine's VM, not
  in the distro the runner runs in. Making it portable means an unauthenticated forward
  proxy bound to `0.0.0.0`.
- **A sibling proxy container.** Ruled out by ADR-0006 — which is the reason ADR-0005
  gave for the allowlist having no cheap implementation. A unix socket sidesteps it
  entirely: the proxy is the runner, which was already running.

Deliberately not built here: no TLS interception, no credential injection, no policy
engine. `CONNECT` is allowlisted by hostname and the bytes are piped through untouched.
The credential-injecting gateway being built alongside this subsumes this enforcement
point — same socket, same env, same `--network none` container — and when it lands, the
credential mounts stop existing.

**Images must be rebuilt for this.** The forwarder is baked into `ogun/base`, so an image
built before it cannot bridge to the socket — and the silent failure is backwards: the
container still gets `--network none` and a mounted socket nothing knows to use, so a
*tightened* egress policy presents as a total airgap and the agent reports it as an auth
failure. The base image therefore declares `OGUN_EGRESS_FORWARDER=1` and the runner
refuses to enforce an allowlist without it, naming the rebuild. Project images inherit the
marker through `FROM ogun/base` and pick it up on their next `ogun image build .`.

**What this does not close.** Exfiltration *through* the model API itself, by an agent
writing a secret into a completion request, is unaffected by any allowlist. That is a
different and harder problem and it is open.

**Credentials.** `~/.claude` and `~/.codex` credential files are mounted read-only into a
staging path and copied to a writable home. This spec used to say the worst case for a
misbehaving agent was burning rate limit. That was false, and the correction is the whole
reason the allowlist above got built: what lands in that home is a live OAuth token, and
under `egress: open` anything running in the container could read it and POST it
anywhere. Not a hypothetical agent that turns malicious — an `adversarial-review` worker
is aimed at untrusted repository content by design, so a crafted README, a test fixture or
a dependency's source is the delivery mechanism. **No git credential ever enters a
sandbox**, which remains true and was always the stronger half of the claim.

### 4.7 Runtimes

`claude` and `codex` are **presets over one generic `cli` spec**, not two bespoke
adapters. Two hand-written adapters means writing the same subprocess and
stream-normalizing code twice, and it drifts.

```ts
type RuntimeSpec = {
  provider: 'cli' | 'claude' | 'codex'
  model?: string
  // argv builders, not a flag list — resume is structurally different per runtime
  start:  (ctx: JobCtx) => string[]
  resume: (ctx: JobCtx, sessionId: string) => string[]
  parseEvent: (line: string) => RunEvent | null   // JSONL → normalized
  resultFile?: 'last-message'                     // authoritative final output
  stdin: 'close'                                  // see gotcha below
}
```

**`resume` is an argv builder, not a `sessionFlag` string.** [corrected] The obvious
design — a flag name appended to the base command — does not survive contact with
codex. Claude resumes with a flag (`claude --resume <id> …`); codex resumes with a
*subcommand* (`codex exec resume <id> <prompt>`). Templating one flag name cannot
express that, so each preset supplies its own argv construction.

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

#### Verified event formats

[settled] Both were spiked against real runs (codex-cli 0.147.0, Claude Code 2.1.226).
Both emit clean JSONL; the shapes differ but map onto one `RunEvent` without loss.

Claude Code (`-p --output-format stream-json --verbose`) is **API-message shaped** —
one line per message, content blocks inside. Codex (`exec --json`) is **item-lifecycle
shaped** — a thread containing turns containing items, each with started/completed.

| `RunEvent` | Claude Code | Codex |
|---|---|---|
| `run.started` | `system` / `init` | `thread.started` + `turn.started` |
| session id | `system.init.session_id` | `thread.started.thread_id` |
| `agent.message` | `assistant` with a `text` block | `item.completed` type `agent_message` |
| `tool.started` | `assistant` with a `tool_use` block | `item.started` type `command_execution` |
| `tool.completed` | `user` with a `tool_result` block | `item.completed` (carries `exit_code`, `aggregated_output`) |
| `run.completed` | `result` / `success` | `turn.completed` |
| usage | `result.usage` + `modelUsage` | `turn.completed.usage` |
| cost estimate | `result.total_cost_usd` | *not reported* |
| rate limit | `rate_limit_event` | *not reported* |

Correlating a tool call to its result differs: Claude splits them across two messages
joined by `tool_use.id` → `tool_result.tool_use_id`; codex pairs them by `item.id`.
Both are stable keys, so the normalizer just uses a different one per preset.

**Granularity is per-message, not per-token.** Neither runtime emits deltas in
headless mode — each line is a complete message or a completed item. The timeline
shows each tool call and each assistant message as it happens, which is what a
run-detail view needs, but it is not a typewriter stream.

Three findings that change how we drive these:

1. **Codex hangs forever if stdin is left open.** It reports *"Reading additional
   input from stdin…"* and waits. The harness must close stdin (`< /dev/null`) on
   every invocation — hence `stdin: 'close'` in the spec. This cost a 300-second
   timeout to discover and would have looked like a hung agent in production.
2. **Codex's `--output-schema` constrains *every* assistant message, not just the
   last.** Observed directly: with a findings schema attached, codex emitted a
   schema-valid `{"findings":[]}` as items 0 and 1 *before running any tools*, then
   investigated, then emitted the real answer as item 4. A harness that parses the
   first schema-valid message gets a confidently empty result. **Use
   `-o/--output-last-message <file>` as the authoritative output** — that file
   correctly held only the final answer.
3. **`total_cost_usd` from Claude is a list-price estimate, not a charge.** It is
   populated on a subscription run (a trivial two-turn job reported $0.089). Useful
   as a relative signal for comparing workers; not a bill. Codex reports no cost at
   all, which is another reason §4.3's budgets count tokens and runs.

Claude's `rate_limit_event` is worth wiring into Foreman directly — it is a real
signal of remaining subscription headroom rather than our token-count proxy. Codex
has no equivalent, so the proxy stays as the fallback.

**Verdict: both runtimes in phase 1.** Normalization is a day of work against two
well-structured formats, not the open-ended risk it looked like before the spike.

### 4.8 Skills

Adopt the existing `SKILL.md` convention rather than inventing a format, and build on
[mattpocock/skills](https://github.com/mattpocock/skills) rather than starting from
zero. That collection already covers the disciplines a factory needs — `tdd`,
`diagnosing-bugs`, `code-review`, `research`, `prototype`,
`improve-codebase-architecture`, `grill-with-docs`, `to-spec`, `to-tickets`,
`implement` — and splits them along a distinction we want anyway:

- **User-invoked** skills orchestrate a workflow you ask for.
- **Model-invoked** skills embed a discipline an agent reaches for on its own.

Install editable (`npx skills@latest add mattpocock/skills`) rather than as a managed
plugin, so project-specific skills can be layered on and edited in place.

**Discovery.** Skills resolve from, in increasing precedence:

```
mattpocock/skills baseline (installed, editable)
   ↓
global    ~/.ogun/skills/
   ↓
project   <repo>/.agents/skills/  and  <repo>/.claude/skills/
```

`.agents/skills/` is the canonical location for skills Ogun runs; `.claude/skills/` is
what an interactive Claude Code session picks up. Projects that want both keep them in
sync. Skills are read from disk on every trigger tick, so an edit takes effect on the
next run with no restart — but note that a skill only reaches an automated run once it
lands on the default branch, since the workspace is a clone at a pinned SHA.

**A skill is not a worker, and naming them the same thing hides that.** The skill is
the durable artifact — instructions, committed to git, reusable. A worker is a thin
binding of one skill to a runtime, a model role, a permission profile, and a sandbox.
Two workers can bind the same skill and differ only in which model runs it. Naming the
first worker after its skill is a convenient default and it is what the UI prefills, but
it made "is `adversarial-review` a skill or a worker?" an unanswerable question for
longer than it should have been.

**A skill carries its own worker config.** Beside `SKILL.md`, an `agents/*.yaml`
supplies what Ogun needs to schedule it:

```yaml
interface:
  display_name: "Adversarial Review"
  short_description: "Probe the default branch with adversarial campaigns"
  default_prompt: "Use the running-software-factory-adversarial-reviews skill."
policy:
  allow_implicit_invocation: false
```

`default_prompt` is the job's prompt (§5.1). **`allow_implicit_invocation: false` is
the important line** — a factory skill must never be auto-triggered by an agent
mid-task. It runs when Ogun says so, and only then.

**Thin skills over a shared procedure.** The pattern worth copying: each review skill
carries only its mission, evidence standard, taxonomy, and severity ladder, then
delegates to one shared `running-a-review.md` that owns orientation, novelty rules,
finding classification, publication, and cleanup. Seventeen reviewers stay consistent
because there is one procedure, not seventeen.

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

  go-modules:
    skill: ./skills/deps
    permissions: modifier
    # Added to the defaults (the model API + registry.npmjs.org), not instead of them.
    # Omit the key entirely to get just the defaults; `open` for unrestricted; `none`
    # for a genuine airgap (§4.6).
    egress:
      - proxy.golang.org
      - "*.crates.io"

policies:
  directPush: false
  allowSandboxDowngrade: false
  maxConcurrentModifiers: 1
  maxOpenPullRequests: 3   # the publisher's cap, counted live on the remote
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

**Only the tool checks are wired.** [open] `schema` and `grounded` run and can fail a
run; agent lenses are resolved and recorded as skipped with that stated as the reason,
rather than silently reported as passed. Grading findings quality with a model is a
prompt-calibration problem, not a plumbing one, and guessing at the rubric before there
is a week of real reviewer output to calibrate against would bake in the wrong one.

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

**The CLI owns every format the agent touches.** [settled] Schema definition, history
checking, issue rendering, and publication are `ogun` subcommands the skill invokes —
never prose instructions asking an agent to produce well-formed JSON. This is
principle 4 at the boundary that matters most: an agent that free-hands its output
format produces a different shape every night, and nothing downstream can depend on
it. The skill says *what* to look for; the CLI decides what a finding looks like.

### 4.11 Findings

The part that determines whether this is usable in week two.

**Stable identity is a semantic fingerprint, not a hash.** [corrected] A hash of
normalized content dedupes exact repeats and nothing else. A hierarchical path
dedupes *meaning* and supports prefix matching:

```
<area>/<surface>/<invariant>/<technique>

security/public-orders/account-isolation/cross-account-id-swap
observability/order-create/correlation/forced-storage-failure
test-integrity/api-key-revocation/assertion-sensitivity/production-mutation
```

Human-readable in a UI, sortable, and a cooldown can cover a whole surface by prefix
rather than one exact string. Note what it excludes: no line number, because rebases
and unrelated edits shift lines and would mint a spurious new identity for an
unchanged finding.

The agent proposes the fingerprint; a deterministic check validates its shape and
enforces cooldowns. Renaming an attempt does not make it new — that comparison is
semantic and belongs to the history step, not to string equality.

**Every substantive attempt is recorded, not just the ones that found something.**
A no-finding run, a blocked run, and an inconclusive run each produce a durable
record. Otherwise "we looked and it was clean" is indistinguishable from "we never
looked," and coverage silently rots.

**Repeats need an explicit budget.** A revisit carries `revisit_of` and a concrete
`revisit_reason`, and is permitted only when relevant code changed, prior friction was
fixed, a merged finding needs verification, or the cooldown elapsed with no
higher-value novel work available. Without that gate, cooldowns just get worked
around.

**Dedupe against open work, not only history.** An open finding already accounts for
its surface — don't investigate it again. A closed one permits a single
fix-verification revisit; if it's still broken, that's a new related finding. A
cancelled or duplicate finding is treated as though it never existed.

**Keep history out of the reviewer's context.** Delegate the search to a subagent
pinned to a cheap model: give it the review type, current SHA, and candidate themes,
and let it grep a derived compact index and open only the full records that matter.
The index is derived and disposable — the run records are the source of truth.

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

**How it is written.** [settled] Fan-in gets sugar, because spelling out three edges
that all say the same thing is a place to make a silent mistake — a missed edge means
that reviewer's findings never reach triage and nothing complains:

```yaml
cycles:
  nightly:
    workers: [adversarial-review, security-review]
    then: triage
    schedule: "0 3 * * *"
    onDepFailure: degrade    # triage still runs if a reviewer dies
```

The general `nodes`/`edges` form stays available underneath, and the sugar expands into
it in the CLI before anything else sees it, so the control plane and UI only ever handle
one shape.

**Staging is derived from the graph, not declared on the worker.** [settled — ADR-0007]
A run stages instead of publishing when something downstream depends on it. The
alternative — a `stageOnly: true` flag on the worker — makes the same reviewer unusable
standalone, and gets out of step with the graph the moment you edit one and not the
other. The coverage ledger still records what the reviewer *reported*, so "found three
things" does not become "clean" merely because triage has not run yet.

**A worker in a cycle loses its own schedule.** [settled — ADR-0007] Every worker also
has a one-node cycle so it can be triggered alone, and that cycle carries the worker's
`schedule:`. Once a named cycle drives the worker, two schedules would fire at the same
hour and the standalone one would publish raw findings — precisely what triage exists to
prevent. Membership therefore suppresses it, `ogun project sync` says so, and the UI
shows the cycle in place of the schedule. Manual triggering by worker name is unaffected.

**Triage's input is a file, not a query.** [settled] The sandbox cannot reach the
database, so the runner fetches the upstream nodes' staged findings and writes them to
`.ogun-in/upstream.json` in the workspace. It carries every dependency, including the
ones that found nothing and the ones that failed — triage assembles the coverage
picture, and "three of four reviewers ran" is not derivable from findings alone.

### 4.13 Integrations

- **GitHub** — clone, branch, push, draft PR. Host-side only, in the runner process,
  behind one interface that is the only thing holding a credential (ADR-0009). `gh` is the
  one implementation; the PR cap is a live `gh pr list` and is written down nowhere.
- **Linear** — poll every N minutes with a *deterministic* filter (status, label,
  not-blocked) before any AI sees a ticket. Sources emit jobs; they are not workers.

**[open]** How PR lifecycle state is represented once modifier workers exist —
GitHub is authoritative per §4.4, but the specific mechanism (labels, checks,
review state, or some combination) is undecided. Phase 3 concern.

### 4.14 Architecture decision records

Decisions get their own files under `docs/adr/`, numbered and named as an assertion of
what was decided:

```
docs/adr/0001-runner-and-control-plane-talk-over-http.md
```

```markdown
---
status: accepted
---

# Runner and control plane talk over HTTP

<why the current situation forced a decision>
<what we're doing, in prose>

## Considered Options
- **In-process function calls.** Rejected — …
- **Shared database, no API.** Rejected — …

## Consequences
- …
```

The `## Considered Options` section is what makes an ADR worth writing: it records the
alternatives *and why they lost*, which is exactly the context that evaporates in six
months and gets re-litigated. A decision without its rejected options is just a
config file in prose.

The records live in `docs/adr/`, and `docs/adr/README.md` covers numbering, statuses, and
which decisions have earned one. Not every `[settled]` line here becomes an ADR — the ones
that do are the decisions a reviewer would plausibly flag as wrong without the context.

**ADRs are an agent output, not only a human one.** An architecture-review worker that
finds a structural problem should be able to propose an ADR — a draft with `status:
proposed` — rather than filing a finding that says "consider restructuring X." A
design-interview skill (`grill-with-docs`) writes them inline as understanding
sharpens. Ogun's job is to make them a first-class artifact kind alongside findings
and changes, so a proposed ADR lands as a reviewable diff.

Workers read ADRs too. A reviewer that doesn't know a decision was deliberate will
keep flagging it — the single largest source of noise a reviewer can produce is
re-litigating settled architecture.
- **Run-record export to a git repo.** [corrected] Previously deferred as "wrong for
  operational data." That's true of a *queue* — git has no cheap atomic claim — and of
  high-frequency event appends. It is not true of immutable, one-file-per-run records,
  which are an excellent fit: append-only, diffable, greppable, and durable
  independent of the database. A proven layout:

  ```
  runs/<review-type>/<year>/<month>/<run-id>.json
  ```

  Postgres remains the operational store; this is an export, and a duplicate path
  should fail rather than overwrite so a concurrent run can't silently replace a
  record. Worth building once run volume justifies it.

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
   fresh at fire time so a config edit needs no restart.

   **From the database, not from `.ogun/`.** [corrected] This said "read fresh from
   `.ogun/`", and it was never true: Foreman reads the `cycles` row, and nothing under
   `foreman/` opens a YAML file. It cannot — §4.5 forbids an absolute path in the
   database, so the control plane only learns where a repo sits from a machine-local
   file, and a hosted control plane has no checkout at all. The database is the only
   thing Foreman can always reach.

   What that costs is a publish step, and it is load-bearing: **`.ogun/config.yaml` is
   the definition, but the database is what runs.** The UI closes the gap itself — an
   edit writes the file and re-indexes in the same request — so the gap only opens when
   the file changes by some other route: a hand-edit, or a `git pull` that brings in
   someone else's. Then `ogun project sync` is what publishes it, and until it runs the
   factory is still executing the previous definition with nothing saying so. The
   triage fan-in shipped and sat inert for fourteen hours exactly this way.

   The server holds the file's content hash already — it is how the UI's compare-and-swap
   works — so detecting the drift is cheap and it should say so rather than leave it to
   be noticed. **[open]**
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

**A single job is a one-node cycle.** [settled — ADR-0007] Phase 1 creates a `CycleRun`
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

Two directions, and this section only ever described one of them.

**Getting work out of a workspace**, which is what actually runs first:

1. **Stage what the agent left** — untracked new files do not appear in `git diff <base>`,
   so an unstaged new test file is invisible to the gate.
2. **Commit the remainder if the agent did not.** `git format-patch` reads commits, so an
   agent that forgot its final commit would otherwise be recorded as a run that changed
   nothing, seconds before the workspace is deleted. The runner commits the leftovers
   under its own identity, with a message saying nobody wrote one.
3. **Refuse a HEAD that is not a descendant of the pinned base.** An `--amend` or a
   `reset` produces something `git am` cannot express against the base the host holds.
   That is an error with the file count kept, not a run that changed nothing.
4. **Bound the size.** A patch is agent output; an unbounded one is a denial of service
   against the host, as `MAX_READBACK_BYTES` already assumes for findings. Over the
   limit is an error, and the partial file is removed — a truncated mbox still applies.

`format-patch`, not a diff and not a bundle. [settled] A diff loses the commit message,
which is the first thing a PR reviewer reads, and the authorship. A bundle keeps
everything and is opaque, and this artefact is also a review surface. format-patch is
text, survives binaries and renames, and `git am` applies it.

**Putting work back into a workspace**, for the retry loop and the publisher:

1. Apply the patch.
2. **Stage it** — `git apply` leaves changes unstaged, with the same consequence as above.
3. Write any extra files.

The publisher does neither 2 nor 3, and that is not an omission. [added] It applies with
`git am` rather than `git apply`, into a **detached scratch worktree of the project's own
checkout** rather than into a workspace — so the commits, their messages and their
authorship arrive intact and there is nothing left unstaged to stage. The list above is the
retry loop's shape; the publisher's is:

1. `git worktree add --detach <scratch> <base>` — never the live working tree, so a
   publish landing mid-edit stages, stashes and checks out nothing under you.
2. `git am` the mbox, under the same hardening every other git call in agent-touched
   content gets, with a fixed committer identity so the branch does not look like you
   wrote it.
3. Push `HEAD:refs/heads/<branch>` — fully qualified, no local branch created, no rebase
   onto a moved default branch.
4. Open the pull request as a draft, then remove the worktree whatever happened.

There is deliberately no "reset the workspace to base ref" step. [corrected] It used to
lead this list, and it contradicts §5.2's settled rule that the workspace is provisioned
once and every retry reuses it, with the previous attempt's changes still present. Both
cannot hold. §5.2 is the newer and the reasoned one — reprovisioning per round turns three
cheap rounds into three full-price ones — so the reset is gone rather than left for the
retry loop to trip over.

**Path safety for anything written back from a sandbox:** reject absolute and `..`
paths, resolve symlinks on both the workspace and the target's parent and require
containment, open with `O_NOFOLLOW`, mode 0600.

**And for anything the host *runs* there.** [added] The file rules above are file-shaped
and miss the larger exposure: a workspace's `.git` is agent-authored, and git executes
repository configuration and hooks. `core.fsmonitor` fires on any command that refreshes
the index — `add`, `ls-files`, `status`, `diff` — so an agent could leave a string behind
and have the host run it as the runner, with the runner's control-plane token in its
environment. Every git call the runner makes in a workspace therefore passes
`-c core.hooksPath=/dev/null -c core.fsmonitor= -c diff.external=`, adds
`--no-ext-diff --no-textconv` to diff-producing commands, and blanks the host's own git
configuration so the result does not depend on whose machine it ran on.

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
changes             id, run_id, branch, base_sha, patch_ref, files_changed,
                    tests_run, tests_passed, pr_url
                    -- artifact record only; PR lifecycle state lives in GitHub
                    -- branch/pr_url are the publisher's, written after the report
                    -- and null when it refused: work that exists, unpublished
coverage            id, cycle_run_id, worker_id, selected, ran, outcome, reason
artifacts           id, run_id, kind, ref
                    -- kind=transcript|patch|adr-draft; large blobs on disk, never inlined

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
  .ogun/          ogun's own project config — it reviews itself
  .agents/skills/ the skills ogun runs

~/.ogun/          machine-local: config.json, skills, workspaces, cache volumes
```

Stack: Node 24+, Hono, Vite + React (no Next), Postgres + Drizzle, croner, Zod for all
config and structured-output validation, Docker.

**No build step for the server, runner, or CLI.** [settled — ADR-0008] Node strips types
natively, so `node packages/server/src/main.ts` runs TypeScript directly and `tsc` is
typecheck-only. The cost is a dialect restriction — `erasableSyntaxOnly`, so no enums
and no parameter properties — which is a fair trade for deleting a compile step from
every edit-run cycle. Vite still builds the web app, and the CLI is bundled with esbuild
into the sandbox image so it carries no `node_modules` and cannot drift from the
validator on the way in.

A CLI is a peer to the UI, not an afterthought — `ogun runner doctor` (which runtimes
and tools are present on this machine), `ogun run <worker>`, `ogun runs`,
`ogun findings`.

---

## 8. Host assumptions

Ogun requires Docker, git, Node 24 or newer, and at least one logged-in agent CLI.
Nothing else about the host is assumed, and nothing machine-specific is stored outside
`~/.ogun/config.json`.

Four constraints hold on any host and shape real decisions:

- **"Always on" isn't.** A workstation sleeps, and a VM or WSL environment stops with its
  host. Missed occurrences are therefore ordinary rather than exceptional, which is why
  scheduling derives from the last run rather than from a live timer, and why
  `onMissed` exists at all (§4.2).
- **Restarts happen.** Run the server and runner under whatever supervises services on
  that host — systemd, launchd, a Windows service — so they come back on their own.
  Nothing in Ogun depends on which.
- **Memory is the binding constraint on concurrency.** A container running an agent plus
  a project's test suite is not small, and a virtualised host often has far less RAM than
  the machine it runs on. `maxConcurrentJobs` defaults to 2; raise the host's memory
  before raising it.
- **Filesystem crossings are expensive.** Keep workspaces on the host's native
  filesystem. Working across a virtualisation boundary — a Windows drive mounted into
  Linux, a bind-mounted network share — is roughly an order of magnitude slower, and a
  workspace is cloned for every run.

**Reaching a control plane from another machine** is the one place virtualisation leaks:
an environment behind NAT has an address its own host can reach and nothing else can.
Ogun detects that case and says so before you enrol a runner (§4.5) rather than handing
over an address that cannot work.

---

## 9. Phasing

**Phase 1 — the loop works.** ✅ Built. One project, one `adversarial-review` worker,
container sandbox, manual trigger from the UI or `ogun trigger`. Foreman creates a
one-node CycleRun — the same path a nightly cycle will take, with a graph of one.
Verify gate gating findings persistence. Findings persisted with semantic fingerprints.
Run detail page with a live SSE timeline. Both runtimes normalized onto one event type.
No cron, no retry, no fan-in, no publishing.

One thing landed differently than specced and is recorded above: agent lenses in the
verify gate record as skipped rather than running (tool checks are wired, §4.10).

The other — egress shipping as `open | none` rather than the host allowlist §4.6 called
for — **is closed**. It is worth recording what the gap actually was, because it was
filed as an open question and it was a live hole: `open` was the default, so every
container had unrestricted internet *and* a mounted OAuth credential it could read. The
reason given for not building it, that a filtering proxy is a sibling container and so
ruled out by ADR-0006, was sound about the proxy's packaging and was then used to justify
the default. A unix socket bind-mounted into a `--network none` container turns out to
need no sibling and no `NET_ADMIN` at all (§4.6).

The first real run found a genuine `high` in Ogun's own finalize path — a finding marked
`fixed` that regressed stayed `fixed` and never reappeared in the inbox. That is the
loop doing the thing it exists to do, on day one.

**Phase 2 — the factory runs itself.** In progress.

Done: the job queue, the global concurrency cap, the failure breaker, and cron —
evaluated in-process, re-scanned rather than registered once so adding a worker needs no
restart, with `skip` and `runOnce` deciding what happens to an occurrence the machine
slept through. Schedules are editable from the UI. The findings inbox is the home screen.

Also done: **triage fan-in** (§4.12) — the first genuinely multi-node cycle and the first
use of `on_dep_failure: degrade`. Reviewers stage, triage publishes, and which of those a
run does is read off the graph rather than declared on the worker.

Remaining: re-adjudication, which is what stops a reviewer re-flagging what you already
dismissed.

**Phase 3 — the write path.** In progress.

Done: modifier workers with a project image that can run the project's own suite; the
tests-must-pass gate, read from the blob at the pinned base so a modifier cannot set its
own; patch extraction as a `git format-patch` mbox, with the `changes` and `artifacts`
rows to point at it; and the publisher — patch → scratch worktree → branch → draft PR —
running in the runner process, after the report, behind a one-interface credential seam,
with the PR cap as `policies.maxOpenPullRequests` (ADR-0009). Modifiers can also report
what they noticed, as ordinary findings.

Remaining: the retry loop on the existing verify gate, and modifier-profile lenses. The
`for round` shape in the runner still runs exactly once, which is what makes the first of
those an unwrapping rather than a rewrite. Arbitrary user-defined graphs if they turn out
to be wanted.

Two limits worth knowing rather than discovering: a runner with no local checkout of a
project produces a patch it cannot publish, and nothing prunes `scratch/patches/` — the
patch is also an artefact the run page serves, so the publisher deliberately does not
delete what it consumed.

**Phase 4 — Linear.** Deterministic ticket filtering, scope evaluator, ticket →
plan → implement → review → draft PR.

**Explicit non-goals:** Kubernetes, multi-tenancy, RBAC, billing, graphical workflow
canvas, auto-merge, agent memory, model auto-selection, remote runner mesh.

---

## 10. Open questions

1. **Image staleness policy.** Rebuild on Dockerfile/lockfile change is obvious; what
   the age-based trigger should be is not.
2. ~~**Codex sandbox mode inside a container.**~~ [answered] It cannot run inside ours.
   `-s read-only` shells out to bubblewrap, which needs an unprivileged user namespace,
   and the sandbox runs `--cap-drop ALL` with `no-new-privileges` — so *every* command
   execution fails, not merely the writes: `bwrap: No permissions to create a new
   namespace`. A reviewer that cannot run `ls` is not a stricter reviewer, and granting
   the container what bwrap needs would hand back the privilege the profile exists to
   remove, for a second copy of a boundary we already have.
   `--dangerously-bypass-approvals-and-sandbox` is therefore right, and the profile is
   enforced at the mount instead (§4.6).
3. **Re-adjudication mechanism.** The approach (show prior unresolved findings
   verbatim, classify) is a proposal, not a decision. Revisit at implementation.
4. **Triage prompt and calibration.** What the severity scale actually is, and how
   triage is itself evaluated. It is the one node that can silently lose real
   findings, so it needs its own quality measure — currently undefined.
5. **Workspace materialization cost on large repos.** `--no-hardlinks` copies the
   object store per job. Fine for these repos; if one gets big the escape hatch is
   dropping the flag, at the cost of a container being able to corrupt the source.
   No policy yet for when to switch.
