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
  The table exists; nothing writes it until the publish path does, in phase 3.
- **Both integrations are built now, and both hold to this.** This consequence used to
  read *"Neither integration is built. There is no GitHub client and no Linear client in
  the tree today."* — true when it was written, and left here rather than deleted, because
  an ADR that quietly starts claiming it always said the right thing is worse than one with
  a gap.

  GitHub arrived first: `PublishRemote` in `runner/src/publish.ts`, whose PR cap is a live
  `gh pr list` counted at publish time and written down nowhere (ADR-0009). Linear arrived
  with the source (ADR-0013), and its deterministic pre-filter — status, label, not-blocked,
  applied before any AI sees a ticket — is a filter on a live read, exactly as this ADR
  required, evaluated locally on the response rather than synced.

  The one thing the source *does* write down is worth naming, because it looks like a
  mirror and is not. `source_emissions` records that Ogun emitted a job for a ticket: the
  ticket's id, when, into which cycle run, and a **hash** of what it said at the time. Every
  column is a fact about what Ogun did. Nothing there answers "what is this ticket's status
  now", and a caller tempted to answer it from that table finds nothing to answer it with —
  which is the test this ADR actually imposes. Ogun writes nothing back to Linear at all: a
  human moves the ticket.
- Read-time calls are a latency and rate-limit cost, and it is the cost that was chosen.
  A finding that a specific call site should be cached for the length of one request is
  not contradicting this ADR; a durable table of PR state is.
- How PR lifecycle state is *represented* once modifier workers exist — labels, checks,
  review state, or some combination — is still open, and is a phase 3 concern. This ADR
  settles where that state lives, not how it is expressed.
