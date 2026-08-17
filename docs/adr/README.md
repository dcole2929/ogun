# Architecture decision records

One file per decision, numbered, named as an assertion of what was decided.
`docs/architecture.md` is the narrative — what the system is and how the parts fit. These
are the individual decisions inside it that would otherwise get re-argued, each with its
rejected alternatives attached.

## Why this directory exists

Ogun reviews itself. Every review skill orients here before it reads any code, and the
rule it carries is blunt: **a finding that contradicts an accepted ADR is not a finding.**
Re-litigating a deliberate decision is the single largest source of noise an automated
reviewer produces, and this directory is the only thing that stops it.

That cuts both ways. An ADR suppresses findings, so a vague one suppresses findings
without explaining anything — worse than not writing it. Write few, and write them
properly.

## When a decision earns an ADR

Both of these, not one:

1. **It is settled** — argued through, with the reasoning already written down. A decision
   still being made is not an ADR. `docs/architecture.md` marks those `[open]` and
   `[deferred]`, and that is where they stay until they are neither.
2. **A reviewer would plausibly flag it** — it looks wrong, backwards, or over-built
   without the context. A decision nobody would ever question needs no ADR; writing one
   costs a file and suppresses nothing that was going to be reported.

If the reasoning for a decision is not recorded anywhere, it is not ready. Write the
reasoning first.

## Format

    ---
    status: accepted
    ---

    # Assertion of what was decided

    <why the situation forced a decision>
    <what we are doing, in prose>

    ## Considered Options
    - **The alternative.** Rejected — why it lost.

    ## Consequences
    - What this costs, and what it makes true elsewhere.

`## Considered Options` is what makes the file worth writing. It records the alternatives
*and why they lost*, which is exactly the context that evaporates in six months and gets
re-litigated. A decision without its rejected options is just a config file in prose.

Two habits the records here follow:

- **Say what the ADR does not settle.** A decision with an open edge — a gap left on
  purpose, a choice marked reversible — names it, so the ADR gags the settled part and
  only the settled part. ADR-0005 settles that no credential enters the sandbox and says
  outright that the egress allowlist is still open.
- **Keep the honest caveat.** ADR-0003 records that SQLite would have been fine. That is
  more useful than a decision written as though it were obvious.

## Numbering and status

- Four digits, zero-padded, sequential. Take the next unused number.
- Numbers are never reused and files are never renumbered, including when an ADR is
  replaced. Findings, PRs and other ADRs refer to them by number.
- The filename is the assertion in kebab case: `0005-the-sandbox-never-pushes.md`.
- `status:` is one of:
  - `proposed` — argued but not accepted. A reviewer does not treat it as binding.
  - `accepted` — in force. This is the status that suppresses findings.
  - `superseded` — replaced. Keep the file and the number, and name the ADR that replaced
    it.

## Agents write these too

An ADR is an agent output, not only a human one. A reviewer that finds a structural
problem — the design is wrong, not the code — proposes an ADR with `status: proposed`
instead of filing a finding that says "consider restructuring X". The first is a
reviewable diff; the second is unactionable.

The same applies to disagreeing with what is already here. An accepted ADR you believe is
wrong is a proposed ADR that supersedes it, not a finding.

## The records

- [ADR-0001 — Runner and control plane talk over HTTP](0001-runner-and-control-plane-talk-over-http.md)
- [ADR-0002 — Git is the source of truth for worker definitions](0002-git-is-the-source-of-truth-for-worker-definitions.md)
- [ADR-0003 — Postgres holds durable state](0003-postgres-holds-durable-state.md)
- [ADR-0004 — GitHub and Linear state is read live, never mirrored](0004-github-and-linear-state-is-read-live.md)
- [ADR-0005 — The sandbox never pushes](0005-the-sandbox-never-pushes.md)
- [ADR-0006 — A job runs in one self-contained container](0006-a-job-runs-in-one-self-contained-container.md)
- [ADR-0007 — A single job is a one-node cycle](0007-a-single-job-is-a-one-node-cycle.md)
- [ADR-0008 — No build step: Node runs the TypeScript](0008-no-build-step-node-runs-the-typescript.md)
