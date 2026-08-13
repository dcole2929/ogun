# Ogun

A local-first software factory — scheduled AI workers that review, maintain, and
eventually implement code across a set of repositories.

> **Status: phase 2.** Workers run on a schedule, in isolated containers, and produce
> findings tracked across runs. No write path yet — nothing opens pull requests. The
> design is in [`docs/architecture.md`](docs/architecture.md).

## The idea

Point Ogun at a repository and give it workers: an adversarial reviewer, a security
scanner, an idiomatic-code checker, a dependency-health auditor. They run on a schedule,
in isolated containers, and produce **findings** — structured, deduplicated, and tracked
across runs so the same issue isn't re-reported every night.

Later phases add a write path: workers that open draft pull requests, and a Linear intake
that turns tickets into queued work.

Two constraints shape everything:

- **Runs happen on-device.** Wherever the control plane lives, execution stays on a
  machine holding your Claude/Codex subscription credentials. That's the cost model — the
  factory should be close to free to operate.
- **The sandbox never pushes.** Containers get no git credential and no remote. They
  produce a patch; the host publishes it.

## Shape

```
one host (any OS that runs Docker)
│
├── ogun server ─────────────────── postgres (container)
│     ├── foreman: schedules, admission, dependency release
│     ├── api :7777 (hono)
│     └── web UI (vite/react)
│
├── ogun runner start ── HTTP ───→ claims jobs
│     ├── sandbox: container (default) | worktree (opt-in)
│     │     mounts credentials read-only — no socket, no gh, no remote
│     └── runtime: claude | codex
│
└── publisher (host-side)
      patch → branch → draft PR
```

The control plane and the runner talk over HTTP even on one machine, so moving the
control plane to a server later is a URL change rather than a rewrite. Adding a second
machine is two commands — see [`docs/setup.md`](docs/setup.md).

## Prerequisites

| | why |
|---|---|
| **Docker** | runs the database, and the sandbox each job executes in |
| **Node 24+** | Ogun runs TypeScript directly, with no build step |
| **git** | workspaces are clones of your repositories |
| **`claude` and/or `codex`**, logged in | the agent runtimes. At least one |

Any operating system that runs those. Ogun keeps nothing machine-specific outside
`~/.ogun/config.json`, which is written for you.

## Running it

```sh
pnpm install          # the only package-manager step; everything after is `ogun`
./bin/ogun init       # database, schema, sandbox image
```

`init` reports what it did and what was already done, so re-running it is the normal way
to pick up a new migration or a rebuilt image.

Then, in two terminals:

```sh
ogun server           # control plane and UI on http://localhost:7777
ogun runner start     # claims and executes jobs
```

`ogun runner init` once, before the first `runner start`, to register this machine.

To use `ogun` from anywhere, symlink the launcher — it finds a new enough Node whatever
the directory you're in pins:

```sh
ln -s "$PWD/bin/ogun" ~/.local/bin/ogun
```

### Pointing it at a repository

```sh
cd ~/dev/your-project
ogun project add .    # tell this machine where the repo is (optional — see below)
ogun project sync     # register it, reading .ogun/config.yaml
ogun trigger your-project nightly-review
```

`project add` is an optimisation, not a requirement: a runner with no local path clones
from the project's remote instead. Registering one makes runs faster, works offline, and
lets a co-located control plane edit that project's `.ogun/config.yaml`.

Ogun is registered as a project in its own repo, so the first thing you can point it at
is itself.

### Everything else

```sh
ogun                        list every command
ogun db status              is the database up, and is the schema current
ogun runner doctor          what this machine can actually run
ogun skill new <name>       scaffold .agents/skills/<name>/
ogun skills                 every skill, and which workers bind it
ogun workers                every worker, its schedule, and when it next runs
ogun runs                   recent runs
ogun findings list          the inbox
ogun coverage <project>     what ran, what didn't, and why
```

## Skills and workers

**Skills live in the repo being reviewed**, with a small built-in library for universal
ones. A repo defining a skill by the same name overrides the built-in — what "security
review" means is a property of the codebase, not of the tool.

**A skill is prose you iterate on**, so `ogun skill new` scaffolds it and you edit the
files. **A worker is a handful of fields** — which skill, which runtime, which schedule —
so the UI has a form for it. That form writes `.ogun/config.yaml` in your repo and leaves
the diff uncommitted for you to review. There is one definition of a worker and it is in
git.

Both, plus connecting a second machine, are covered in [`docs/setup.md`](docs/setup.md).

## Design

[`docs/architecture.md`](docs/architecture.md) is the real document — components,
execution model, data model, phasing, and what's still open. Decisions are tagged
`[settled]`, `[deferred]`, or `[open]` so it's clear which parts have been argued through
and which are placeholders.

## Stack

TypeScript on Node 24+, run directly — type stripping is native, so there is no build
step for the server, runner, or CLI. Hono for the API, Vite + React for the UI, Postgres
via Drizzle, croner for scheduling, Zod for config and structured-output validation,
Docker for sandboxing. Claude Code and Codex CLIs as the agent runtimes.

Both runtimes were spiked end to end and their headless JSONL event formats mapped onto a
single normalized event type — Claude Code is API-message shaped, codex is
item-lifecycle shaped, and both carry enough to drive one timeline. The mapping, and three
gotchas the spike turned up, are in [§4.7](docs/architecture.md#47-runtimes).

## The name

[Ogun](https://en.wikipedia.org/wiki/Ogun) is the Yoruba orisha of iron, metalwork, and
tools — the patron of blacksmiths and craftsmen, and the one who clears paths through the
wilderness. Apt for something that runs a forge overnight.
