---
status: accepted
---

# Runner and control plane talk over HTTP

The runner and the control plane run on the same machine, as the same user, against the
same Postgres. Nothing physically prevents the runner from importing the server's claim
function or issuing `FOR UPDATE SKIP LOCKED` itself, and either would be less code than
a client.

The runner claims jobs, re-checks admission, streams run events, and fetches an upstream
node's staged findings over `http://localhost:7777`. It never opens a database
connection. The API is the only thing between the two halves.

The reason is where this ends up rather than where it is. A control plane on a VPS with
runners on more than one machine is the shape this is heading toward, and from here that
is a URL change. The boundary also gets exercised every night by the component that
stresses it hardest, rather than only by a browser.

## Considered Options

- **In-process function calls — one process that both schedules and executes.** Rejected
  — it is the cheapest thing to write and the only one that cannot be moved. A second
  runner on a home server has no way to exist, and separating the halves later is a
  rewrite of every call site rather than a change of base URL.
- **Shared database, no API — the runner claims with its own `SKIP LOCKED` query.**
  Rejected — the claim primitive works, but then the schema is the contract between the
  halves, every runner needs database credentials, and neither survives the control plane
  moving off the box. The protocol that works for a runner on another machine is the HTTP
  one, and writing it now costs nothing.

## Consequences

- Everything the runner needs from the control plane is an endpoint: claim, the admission
  re-check at claim time, batched run events carrying a per-run sequence number, and the
  staged upstream findings a fan-in node consumes.
- The cost is JSON over loopback, against jobs that run an agent for minutes. It does not
  register.
- The runner holds no database credentials, so exactly one process writes to Postgres.
- A hosted control plane becomes a deployment question rather than an architectural one.
  The one thing it cannot do — edit a project's `config.yaml` with no local checkout — is
  a separate decision, ADR-0002.
