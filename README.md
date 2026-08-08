# Ogun

A local-first software factory — scheduled AI workers that review, maintain, and
eventually implement code across a set of repositories.

> **Status: design.** No code yet. The architecture is worked out in
> [`docs/architecture.md`](docs/architecture.md); this repo exists to hold it while
> phase 1 gets built.

## The idea

Point Ogun at a repository and give it workers: an adversarial reviewer, a security
scanner, an idiomatic-code checker, a dependency-health auditor. They run on a
schedule, in isolated containers, and produce **findings** — structured, deduplicated,
and tracked across runs so the same issue doesn't get re-reported every night.

Later phases add a write path: workers that open draft pull requests, and a Linear
intake that turns tickets into queued work.

Two constraints shape everything:

- **Runs happen on-device.** Wherever the control plane lives, execution stays on a
  machine holding your Claude/Codex subscription credentials. That's the cost model —
  the factory should be close to free to operate.
- **The sandbox never pushes.** Containers get no git credential and no remote. They
  produce a patch; the host publishes it.

## Shape

```
WSL2 host — always-on, systemd
│
├── ogun-server ──────────────── postgres (container)
│     ├── foreman: schedules, admission, dependency release
│     ├── api :7777 (hono)
│     └── web UI (vite/react)
│
├── ogun-runner ──── HTTP ────→ claims jobs
│     ├── sandbox: container (default) | worktree (opt-in)
│     │     mounts ~/.claude:ro, ~/.codex:ro — no socket, no gh, no remote
│     └── runtime: claude | codex
│
└── publisher (host-side)
      patch → branch → draft PR
```

The control plane and the runner talk over HTTP even on one machine, so moving the
control plane to a server later is a URL change rather than a rewrite.

## Design

[`docs/architecture.md`](docs/architecture.md) is the real document — components,
execution model, data model, phasing, and a list of what's still open. Decisions are
tagged `[settled]`, `[deferred]`, or `[open]` so it's clear which parts have been
argued through and which are placeholders.

## Stack

TypeScript on Node 22. Hono for the API, Vite + React for the UI, Postgres via
Drizzle, croner for scheduling, Zod for config and structured-output validation,
Docker for sandboxing. Claude Code and Codex CLIs as the agent runtimes.

## The name

[Ogun](https://en.wikipedia.org/wiki/Ogun) is the Yoruba orisha of iron, metalwork,
and tools — the patron of blacksmiths and craftsmen, and the one who clears paths
through the wilderness. Seemed apt for something that runs a forge overnight.
