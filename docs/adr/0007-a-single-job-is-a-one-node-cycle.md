---
status: accepted
---

# A single job is a one-node cycle

Phase 1 runs one worker from a button. Wrapping that in a `CycleRun` with a graph of one
node is ceremony you can see, and the obvious economy is the other way: let jobs stand
alone now, introduce cycles when fan-in actually needs them.

Every run is a cycle run. Phase 1 creates a `CycleRun` containing exactly one job. Every
worker also has a one-node cycle so it can be triggered alone, and that cycle is what
carries the worker's `schedule:`.

It costs one table and a foreign key, and it buys one code path: "run this worker now" and
"run the nightly cycle" are the same thing from the start. The coverage ledger forces it
anyway — recording which workers were selected, ran, failed, or were skipped needs a batch
identity to hang the record on, and a standalone job has none.

## Considered Options

- **Jobs stand alone; introduce cycles when fan-in needs them.** Rejected — the coverage
  ledger needs a batch identity on day one, and by phase 2 there are two paths through
  dispatch to keep in agreement for no benefit.
- **Build the general DAG engine up front.** Rejected in the other direction — triage does
  not need one. For a fixed reviewer set, fan-in is a two-stage sequential pipeline: run N
  jobs, await all, run one more, roughly thirty lines. A general engine is only needed for
  user-defined graphs, which is why triage is phase 2 and arbitrary cycles are phase 3.
- **A `stageOnly: true` flag on the worker**, marking the ones that feed triage. Rejected —
  it makes the same reviewer unusable standalone, and it gets out of step with the graph
  the moment you edit one and not the other. Whether a run stages or publishes is derived
  instead: a run stages when something downstream depends on it.

## Consequences

- **A worker in a named cycle loses its own schedule.** Two schedules would fire at the
  same hour and the standalone one would publish raw findings — precisely what triage
  exists to prevent. Membership suppresses it, `ogun project sync` says so, and the UI
  shows the cycle in place of the schedule. Manual triggering by worker name is
  unaffected.
- **A cycle is complete when every node is terminal** — succeeded, failed, or skipped. Not
  when all succeeded. Each edge declares `on_dep_failure: block | degrade`, and triage uses
  `degrade`: it runs with three of four reviewers and marks the batch incomplete.
- Fan-in gets sugar — `workers: [...]` plus `then:` — because spelling out three edges that
  all say the same thing is a place to make a silent mistake, and a missed edge means that
  reviewer's findings never reach triage with nothing complaining. The sugar expands into
  `nodes`/`edges` in the CLI, so the control plane and UI only ever handle one shape.
- The coverage ledger still records what a staging reviewer *reported*, so "found three
  things" does not become "clean" merely because triage has not run yet.
