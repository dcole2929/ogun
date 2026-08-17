---
status: accepted
---

# Postgres holds durable state

Something has to hold the job queue, run history, events, and findings identity. The
choice is load-bearing in one place: claiming a job from a queue that more than one
runner may be looking at.

Postgres, in a container next to the server, with Drizzle for schema and queries.

Docker is already a hard dependency for sandboxing, so the container costs nothing new.
`FOR UPDATE SKIP LOCKED` is the correct claim primitive rather than an approximation of
one. JSONB suits run-event payloads and cycle definitions. And there is no migration on
the day the control plane moves off this box.

This is marked reversible on purpose. SQLite would serve a single-host factory of this
size perfectly well, and the honest position is that switching is a ~2-hour migration,
not a one-way door.

## Considered Options

- **SQLite.** Rejected, but not on capability — at this size it would be fine. It loses
  on the claim primitive and on the move off the box, and it wins nothing that is
  currently scarce, because the container it would have saved was already paid for by the
  sandbox.
- **Git as the operational store — one file per record, committed.** Rejected — git has
  no cheap atomic claim, which is the one thing a queue needs, and high-frequency event
  appends are the wrong shape for it. The narrower version of the idea is not rejected:
  immutable one-file-per-run records exported to a repo are append-only, diffable,
  greppable, and durable independently of the database. That is an export alongside
  Postgres, worth building once run volume justifies it.

## Consequences

- Claiming is `FOR UPDATE SKIP LOCKED`. Retry is an `attempts` column and an
  `available_at` timestamp. There is no queue broker.
- Breaker state persists in Postgres rather than process memory, so it survives the
  restarts a workstation makes routine — which is exactly when you want it to hold.
- Large blobs — transcripts, patches — are written to disk with a pointer in `artifacts`,
  never inlined into a row.
- Because this is reversible, an argument for SQLite does not contradict this ADR. What
  would contradict it is code that assumes SQLite semantics while Postgres is what runs.
