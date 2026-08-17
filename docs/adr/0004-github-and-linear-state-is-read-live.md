---
status: accepted
---

# GitHub and Linear state is read live, never mirrored

The UI wants to show a finding, the branch that fixed it, and whether that PR merged, on
one screen. The reflex is to sync PR and ticket state into Postgres so the screen is one
query.

Postgres owns exactly what GitHub and Linear cannot represent: runs, events, cost, and
findings identity. PR state and ticket state stay where they are and are read live.

The split is not ownership in the abstract. A review producing thirty observations with
severity, status, and cross-run identity does not fit in a PR label. "This PR is awaiting
review" does not need a row in our database. Each system holds what the other cannot
express.

## Considered Options

- **Mirror PR and ticket state into Postgres.** Rejected — it creates a second answer to
  a question GitHub and Linear already answer authoritatively, and ours is the copy that
  can be wrong. One screen is not worth that.
- **Push findings out to GitHub instead — labels, PR comments, issues.** Rejected — the
  same argument in the other direction. Severity, status, a semantic fingerprint, and a
  seen-count across runs do not fit in a label, and cross-run identity is the entire point
  of the findings table.

## Consequences

- `changes` is an *artifact record* of what a run produced — branch, diff, test result,
  resulting PR URL — and not the source of truth for where that PR is in its lifecycle.
- Anything needing current PR or ticket state makes a call at read time. That is a latency
  and rate-limit cost, and it is the cost that was chosen.
- Linear is polled with a deterministic filter — status, label, not-blocked — before any
  AI sees a ticket. Polling is not mirroring: nothing about the ticket is written down.
- How PR lifecycle state is *represented* once modifier workers exist — labels, checks,
  review state, or some combination — is still open, and is a phase 3 concern. This ADR
  settles where that state lives, not how it is expressed.
