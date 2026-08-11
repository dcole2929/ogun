---
name: adversarial-review
description: Probe a codebase for issues a normal review would pass over — assume the code is wrong and try to prove it. Run by Ogun on a schedule; not for interactive use.
---

# Adversarial review

A normal review reads a diff and asks "does this look right?". That question has a
strong prior toward yes, which is why review catches typos and misses the bug that
ships. This review asks a different one: **assume something here is wrong, and go find
it.**

You are reviewing a clone of the default branch at a pinned commit. There is no diff —
the unit of review is a *surface*, not a change.

## Procedure

Follow `references/running-a-review.md` for orientation, novelty rules, and
publication. It owns the parts every review shares. This file owns only the mission
below.

## Mission

Pick **one or two surfaces** and go deep. A surface is a boundary where an invariant is
supposed to hold: an authorization check, a state machine, a retry path, a cache
invalidation, a concurrency boundary, a parser.

Breadth is the failure mode here. Twelve shallow observations across twelve files is
worth less than one demonstrated way to violate an invariant, and it floods the inbox
so the real finding gets skimmed past.

For each surface:

1. **State the invariant** the code is trying to maintain, in one sentence. If you
   cannot state it, you do not understand the surface yet — keep reading.
2. **Construct an attack.** Concretely: which call, in which order, with what input,
   produces a state the invariant forbids.
3. **Trace it in the actual code.** Follow the path. If a guard stops you, say so and
   move on — a defeated attack is not a finding, it is evidence the surface is sound.
4. **Only then write it up.**

## Evidence standard

A finding must name a concrete change. "Consider adding validation" is not a finding.
"`getOrder` reads `accountId` from the body and never compares it to the session, so
`GET /orders/{any-id}` returns another tenant's order" is.

Every finding cites a real `path` and `line` in this tree. A citation that does not
exist fails the grounding check and the whole run's findings are discarded — so check
your paths.

## What is out of scope

- **Style, formatting, naming.** A linter does this better and for free.
- **Anything an ADR already settled.** Read `docs/adr/` first. Re-litigating a
  deliberate decision is the single largest source of noise a reviewer produces, and it
  is the fastest way to get ignored.
- **Speculative refactors.** "This would be cleaner as X" is not an issue.
- **Missing tests, in the abstract.** A specific untested path that you can show is
  broken is a finding. "Coverage is low" is not.

## Severity

Calibrate against consequence, not effort:

| | |
|---|---|
| `critical` | Data loss, auth bypass, or silent corruption reachable in production |
| `high` | A correctness bug a user will hit, or a security issue behind one condition |
| `medium` | A real bug on an uncommon path, or a footgun the next change will trip |
| `low` | A latent problem that needs another change to become live |
| `info` | Worth knowing, not worth doing anything about today |

If you are hesitating between two levels, pick the lower one. A reviewer that grades
everything `high` has said nothing.

## Finishing

Write your findings with the CLI — never by hand:

```sh
ogun findings write <<'JSON'
{ "findings": [ ... ] }
JSON
```

If you looked and found nothing, **still write the file with an empty array.** A clean
review and a review that never happened are different facts, and only one of them means
the surface is covered.
