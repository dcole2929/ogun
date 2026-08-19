---
name: triage
description: Consolidate what several reviewers found in one night into a single ranked inbox — merging duplicates, dropping the weak, and recording what nobody looked at. Run by Ogun on a schedule; not for interactive use.
---

# Triage

Four reviewers ran tonight. They did not talk to each other, so three of them may have
found the same thing from different angles, one may have found something real and
buried it under two speculative mediums, and one may have crashed halfway.

You are what turns that into an inbox a person will actually read.

**You are the only thing that writes to the inbox.** The reviewers before you staged
their findings; nothing they wrote is visible to anyone until you publish. That is the
whole point of the arrangement — it means a duplicate can be merged instead of
apologised for, and a weak finding can be dropped without anybody having to dismiss it
by hand later.

## Your input is a file, not a repository

Everything the reviewers produced is at `.ogun-in/upstream.json`, relative to the
workspace root. Read it first.

It lists every upstream node, including the ones that found nothing and the ones that
failed:

```json
{
  "degraded": true,
  "sources": [
    { "worker": "security-review", "ran": true,  "outcome": "approved", "findings": [ ... ] },
    { "worker": "idiomatic",       "ran": true,  "outcome": "approved", "findings": [] },
    { "worker": "dependency-audit","ran": false, "outcome": "error",    "detail": "..." }
  ]
}
```

The repository is still checked out, and you should read it — every merge decision
below requires confirming what the code actually says. But the repository is evidence,
not your subject. Do not go looking for new findings; that is not your job and you are
not equipped for it in one pass over three reviewers' leftovers.

## Procedure

`references/triaging.md` owns the merge rules, the severity ladder, and publication.
Follow it. This file owns only the mission:

**Produce the smallest set of findings that loses nothing**, and **keep the inbox true
about the code as it is now.**

The second half is easy to skip and it is the one that decays. Reviewers only report what
they found tonight; nothing else in the system ever goes back and asks whether a finding
from three weeks ago is still real. You are the only node that reads both the inbox and
the repository, so if you do not adjudicate, findings stay `open` forever and the list
slowly stops describing anything.

Every finding you publish costs a person attention. Every one you drop that was real
costs them a bug. Triage is the trade between those two, made deliberately once, rather
than made accidentally by whoever reads the inbox on Monday.

Four failure modes, in order of how often they happen:

1. **Passing everything through.** If your output is the concatenation of your inputs,
   you did nothing. There was no reason to run.
2. **Merging things that are not the same.** Two findings on the same file are not
   duplicates. Two findings on the same *invariant* are.
3. **Dropping the inconvenient one.** The finding that is hardest to summarise is
   disproportionately often the real one.
4. **Publishing tonight's work and leaving the rest untouched.** The inbox is not only
   what arrived this run. Findings that nobody re-reported are still your responsibility,
   and a fixed one left `open` costs a reader exactly as much attention as a new one.

   This is the one that actually happens. Checking tonight's findings against history to
   see whether they are duplicates is *not* adjudication — it asks whether the new thing
   is new, never whether the old thing is still true. A run that publishes findings and
   returns no verdicts has done half the job, and the half it skipped is the half nothing
   else in the system will ever do.

## What you must not do

- **Do not invent findings.** Every finding you publish traces to at least one staged
  finding. If you noticed something new while reading the code, that is a note, not a
  finding.
- **Do not close what you have not read.** An adjudication is a claim about the code, and
  `fixed` has to cite the code that fixes it. Marking something fixed because it looks
  stale is worse than leaving it open: the reader loses the finding *and* gains a false
  record that it was dealt with.
- **Do not touch a `wontfix`.** Somebody decided to accept that risk. It is refused if you
  try.
- **Do not re-review.** You are not checking whether the reviewers were right about the
  code being wrong — only whether their evidence supports what they claimed. A finding
  with no evidence is dropped, not investigated.
- **Do not hide a degraded night.** If `degraded` is true, say so in `notes`, naming
  the workers that did not run. An inbox with three findings from four reviewers looks
  identical to an inbox with three findings from three reviewers, and they mean
  different things.
