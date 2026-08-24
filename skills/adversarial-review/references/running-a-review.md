# Running a review

The shared procedure. Every review skill delegates orientation, novelty, and
publication here and carries only its own mission, evidence standard, and severity
ladder. One procedure, not one per reviewer — that is what keeps a fleet of reviewers
consistent as it grows.

## 1. Orient before you read code

Spend the first few minutes on context, not source:

- `docs/adr/` — every accepted decision. **A finding that contradicts an accepted ADR
  is not a finding.** If you believe an ADR is wrong, that is a proposed ADR, not a
  finding (see below).
- `README.md` and any `docs/architecture.md` — what this system is supposed to be.
- `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` — conventions that are deliberate.

Then orient in the code: what are the entry points, where does state live, what crosses
a trust boundary.

## 2. Check what has already been said

You are one run in a series. Re-reporting something already known is worse than
reporting nothing: it costs the reader attention and teaches them to skim.

Before investigating a surface, check whether it is already accounted for. The inbox is
in your workspace — you have no network, so do not reach for a command that queries it:

```sh
cat .ogun-in/history.json
```

One line per known finding: fingerprint, status, severity, title, path. Read it whole.
That is enough to answer the only question you are asking right now, which is *"is this
surface taken?"*

Full write-ups live under `.ogun-in/history/`, one file per finding, nested by
fingerprint — so a whole surface is one directory:

```sh
ls .ogun-in/history/security/runner-enrollment/     # every finding on that surface
cat .ogun-in/history/security/runner-enrollment/single-use-invite/parallel-redemption.md
```

**Open those sparingly, and only after you have chosen your surface.** A write-up carries
the previous reviewer's argument, and reading a stack of arguments is how you stop
constructing your own attack and start recognising someone else's. You need the body in
two cases: to check whether a finding you are about to file is the same problem in
different words, and to verify a `fixed` finding actually got fixed.

If `.ogun-in/history.json` is absent, no history reached this run. Say so in your notes —
it means you could not tell whether what you found is new.

Rules:

- An **open** finding already accounts for its surface. Do not investigate it again.
- A **fixed** finding permits exactly one revisit to verify the fix. If it is still
  broken, that is a new, related finding — say so explicitly.
- A **wontfix** finding is a decision. Treat it like an ADR. Re-reporting one is not
  merely poor manners — the control plane refuses it: a sighting of a dismissed finding
  never reaches the inbox, it is recorded as suppressed, and the night's work has bought
  nothing. If you genuinely believe the decision no longer holds, the honest routes are
  the two the machine already understands: report it at a *higher severity* than it was
  dismissed at, if that is true, or write a proposed ADR that supersedes the reasoning.
  Both put the argument in front of a person; re-filing the same finding does not.
- A **duplicate** or cancelled finding is treated as though it never existed.

Renaming an attempt does not make it new. If your finding is the same problem in
different words, it is the same finding.

## 3. Revisiting needs a reason

If you do return to a surface that has been reviewed, the finding must carry
`revisitOf` and a concrete `revisitReason`. A revisit is permitted when:

- the relevant code changed since the finding was recorded,
- a fix was merged and needs verifying,
- prior friction that blocked investigation has been resolved, or
- the cooldown elapsed and there is no higher-value novel work available.

"I want to look again" is not a reason. Without this gate, cooldowns just get worked
around and the inbox fills with the same three issues.

## 4. Ground every claim

Every finding cites `path` and `line` in the tree you are reviewing. Before writing it
up, open the file and confirm the line says what you think it says.

The grounding check is deterministic and runs before anything is persisted: if a cited
path is not in the tree, **the entire run's findings are discarded.** One careless
citation throws away the real work alongside it.

Quote the smallest amount of code that makes the problem visible. A reader should be
able to see the bug without opening the file.

## 5. Classify honestly

Three outcomes, and only one of them is "I found something":

- **Found** — you can demonstrate a concrete problem. Write it up.
- **Clean** — you examined the surface and the invariant holds. Say so, with an empty
  findings array. This is a real result and it is what makes coverage mean anything.
- **Inconclusive** — you could not reach a conclusion: missing context, a dependency
  you could not read, a tool that failed. Say that in `notes`. Do not convert an
  inconclusive investigation into a low-severity finding to have something to show.

The pressure to produce output is the thing to resist. A run that says "I examined the
auth boundary carefully and it is sound" is worth more than four speculative mediums.

## 6. Publish through the CLI

Never hand-write the output file, and never invent a format:

```sh
ogun findings schema     # print the shape
ogun findings write      # validate stdin and write it
```

The CLI owns the schema. If your document is rejected, fix the document — the schema is
not negotiable, and a run that writes a malformed file has its findings thrown away.

## 7. Propose an ADR instead, when it is architectural

If what you found is not a bug but a structural problem — the design is wrong, not the
code — write a proposed ADR rather than a finding:

```
docs/adr/NNNN-<assertion>.md
---
status: proposed
---
```

with a `## Considered Options` section recording the alternatives and why they lose.
A finding that says "consider restructuring X" is unactionable; a proposed ADR is a
reviewable diff.

## 8. Leave the tree clean

Do not commit. Do not create branches. Do not modify source files. Your entire output
is the findings document and, where warranted, a proposed ADR. Anything else you write
into the workspace is discarded when the sandbox exits.
