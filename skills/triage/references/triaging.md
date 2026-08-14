# Triaging a night's findings

This is the shared procedure for any triage worker. A triage skill points here and
carries only its own mission.

## 1. Read the input before the code

`.ogun-in/upstream.json` is the subject. Count what you have before you form a view:
how many workers ran, how many produced findings, how many produced nothing, how many
failed. Those four numbers go in your notes, and they change how you read everything
after.

A night where one reviewer produced nine findings and three produced none is a
different night from one where four produced two or three each. The first usually means
one reviewer lost its discipline, and its findings deserve more scepticism, not less.

## 2. Check what is already known

You are publishing into an inbox with history. A finding that duplicates an open one is
noise no matter how well the reviewer argued it:

```sh
ogun findings list --project <project> --status open,triaged
```

- Matches an **open** finding → drop it, and note the merge in that finding's terms.
- Matches a **fixed** finding → this is a regression. Publish it, at the reported
  severity or higher, and say explicitly that it was previously fixed.
- Matches a **wontfix** finding → drop it. That was a decision, and re-litigating it
  through a different reviewer is still re-litigating it.

## 3. Merge on the invariant, not the location

Two staged findings are the same finding when they describe the same way the same
invariant can be violated. Not when they cite the same file, and not when they use the
same words.

- Same invariant, same path to violating it → **one finding.** Keep the clearest
  statement of the problem and the strongest piece of evidence, which are often from
  different reviewers.
- Same invariant, genuinely different paths to violating it → **one finding**, listing
  both. A reader fixes an invariant once.
- Same file, different invariants → **two findings.** Merging these is how a real
  problem gets buried inside a summary of a smaller one.

When you merge, the surviving finding cites every path and line the inputs cited. You
are compressing the argument, not the evidence.

## 4. Drop what cannot be defended

Drop a staged finding when:

- **It has no evidence.** No path, no line, or a citation that does not say what the
  reviewer claimed. Open the file and check — this is the single highest-value thing
  you do, and reviewers get it wrong often enough to be worth the minutes.
- **It is a preference.** "This would be cleaner as" is not a finding. If it is a real
  structural argument, it is a proposed ADR (see the reviewer procedure), not an inbox
  item.
- **It is speculative.** "This could be a problem if" with no demonstration of the if.
- **It contradicts an accepted ADR.** `docs/adr/` is the record of decisions already
  argued through.

Dropping is not deletion. Everything stays staged and attributed, so a dropped finding
can be recovered by looking at the run. Say what you dropped and why in `notes` —
briefly, in aggregate, not one line per item.

## 5. Rank what survives

Severity is about consequence, not about how interesting the problem is.

- **critical** — a way to violate a security or data-integrity invariant that is
  reachable from outside the system.
- **high** — a demonstrated correctness or security failure with a concrete trigger.
- **medium** — a real defect whose trigger is narrow, or whose consequence is
  contained.
- **low** — real, demonstrated, and minor. If you are reaching for a justification, it
  belongs in the dropped pile instead.

You may lower a severity freely — a reviewer arguing its own finding is not a neutral
judge of it. Raise one only when merging revealed something the individual reviewers
could not see: two mediums that compose into a high is exactly the thing only triage is
positioned to notice, and it is the strongest argument for running triage at all.

## 6. Publish through the CLI

```sh
ogun findings schema     # print the shape
ogun findings write      # validate stdin and write it
```

The CLI owns the schema. The same grounding check that applies to reviewers applies to
you: a cited path that is not in the tree discards the entire run — including the merge
work. Confirm citations as you carry them across.

Publishing nothing is a legitimate result. Four reviewers producing only speculation is
a clean night, and saying so plainly is worth more than promoting the best of a bad
set.

## 7. Leave the tree clean

Do not commit, do not create branches, do not modify source files. Your entire output
is the findings document.
