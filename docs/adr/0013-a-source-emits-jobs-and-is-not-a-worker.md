---
status: accepted
---

# A source emits jobs and is not a worker

§4.13 says of Linear: *"poll every N minutes with a deterministic filter (status, label,
not-blocked) before any AI sees a ticket. Sources emit jobs; they are not workers."* That
last clause is the only place in the design that says what a source is, and everything
about the shape of this follows from taking it seriously.

The obvious implementation is a worker. Ogun already has skill + runtime + sandbox +
schedule, and "poll Linear every five minutes and start work on what you find" reads like a
job. It is not one, and the reasons are not stylistic. A worker executes inside a container
that holds no credential (ADR-0010) and reaches the network through an allowlist, so a
polling worker needs a Linear API key mounted into a sandbox and `api.linear.app` on that
allowlist — two rules broken to build a trigger. A worker also produces a *run*: traces,
events, a verify gate, findings. A source produces none of those. What it produces is
**jobs**, which is the noun §4.2 already has a word for: `integration` is a trigger kind,
listed beside `cron` and `manual`.

So a source is a trigger. Concretely:

**It lives in `.ogun/config.yaml` under `sources:`, a peer of `workers:` and `cycles:`.** It
declares which outside system, which team, the deterministic filter, a poll cadence, and
the **cycle** an admitted ticket starts. It declares no skill, no runtime and no sandbox,
because it runs none. `ogun project sync` writes it to a `sources` row for the same reason
every other definition becomes a row: the foreman cannot open a YAML file (§5.1).

**It runs in the control-plane process, on the host, holding the credential.** The API key
comes from the per-project secret store (ADR-0012, `readProjectSecret`) and is used in one
header, in one file, by the one function in the tree that opens a socket to Linear. The
poll's credential never reaches a sandbox and the ticket reaches an agent as **prompt
text**. *(A later slice lets a skill call Linear about a ticket it was already given, over
the gateway, holding a placeholder — see the amendment in Consequences. Selection is still
host-side and still enforced by the brand.)*

**What it emits is a `CycleRun`, through `startCycleRun` — the same function cron and the
manual trigger call.** There is no second path into the queue. Admission, the failure
breaker, `maxConcurrentModifiers`, the credential preflight and the coverage ledger apply
to a ticket exactly as they apply to a nightly review, and they apply because nothing was
built to make them.

**The deterministic filter is pure code in `@ogun/core`, and the type system enforces that
it runs first.** `admitsTicket` is a total function over a plain `Ticket` value, in a
package with no HTTP client and no database in it. It returns a branded `AdmittedTicket`
that nothing else can mint, and everything downstream — the prompt brief, the emitter —
takes that brand. §4.13's "before any AI sees a ticket" is therefore checked by `tsc` on
every commit rather than by the order of statements in a function. The way this rule
actually gets broken is a caller added six months from now that fetches a ticket for some
other purpose and passes it along; a comment does not survive that and a type does.

**The remote query narrows on the team and nothing else.** Pushing status and labels into
Linear's GraphQL filter is the obvious optimisation, and it moves the rule onto a server
this repository cannot test against. `StringComparator.in` is case-sensitive where the local
rule folds case; `hasBlockedByRelations` counts a relation to an issue that closed in March
where the local rule does not. Both disagreements hide tickets rather than admit them, which
is invisible forever — a source that stops seeing half its queue looks exactly like a quiet
week. Any future narrowing must be a condition implied by `admitsTicket` for *every*
possible ticket, and somebody has to be able to say so out loud before adding it.

**Idempotency is a ledger keyed on `(project, external ticket id)`.** Ogun writes nothing
back to Linear (ADR-0004), so nothing about a ticket ever changes to record that it has been
dealt with: the card sits in `Todo` with its label until a person moves it, and every poll
until then admits it again. `source_emissions` has a unique index on that pair, the row is
inserted **before** the cycle run is created, and only the caller that got a row back
proceeds — the insert *is* the claim, so two overlapping polls produce one run rather than
two nothing downstream could tell apart. An emission is once per ticket for good: a ticket
edited afterwards is **reported and not re-emitted**, because an edit is not new work and
re-emitting on a changed digest means a person tightening a description three times gets
three jobs.

**A poll has no missed-run policy, and the absence is structural.** A schedule has
occurrences, so a machine that slept through six of them has six facts to decide about and
needs `onMissed` (§4.2). A poll asks what matches *now*, so six missed polls collapse into
one question with one answer. That property is bought by asking the level question rather
than the edge one, and it is the reason there is no "issues updated since `lastPolledAt`"
cursor anywhere in this design.

**The scope evaluator is a worker, and it is the entry node of the cycle a source feeds.**
The deterministic filter answers everything that code can answer; whatever is left is a
judgement about whether this is work Ogun should attempt at all, which is a judgement about
*the codebase* and not about the ticket text — so it needs the repo, which means a sandbox,
which means a worker. Being a worker, it produces a run, an outcome and a coverage row, so
"this ticket was looked at and declined" is a recorded fact rather than a silence
(principle 6). The source names the cycle; the cycle's graph already says which node runs
first, and `ogun project sync` refuses a source whose cycle does not have exactly one entry
node.

**Ogun writes nothing back to Linear in this slice.** The GraphQL document is a module
constant and is not a parameter of anything, so there is no way to ask the client to send a
mutation. A human moves the ticket.

## Considered Options

- **A source as a worker with a polling skill.** Rejected, and it is the option §4.13's one
  sentence exists to reject. It puts a Linear API key inside a container that ADR-0010 says
  holds no credential, puts `api.linear.app` on a sandbox's egress allowlist, and spends a
  container, a workspace clone and an agent round on a filter that is forty lines of
  deterministic code. *(The allowlist half of that objection was later answered rather than
  waived — a sandbox reaches Linear through the gateway, holding a placeholder, and only
  when its worker asked. The part that stays rejected is running the filter in there at all;
  see the amendment in Consequences.)* It also makes the filter unauditable: a rule enforced by a prompt is a
  rule that holds most nights.

- **A source as a new queue of "emitted work" that the foreman later converts into jobs.**
  Rejected. It is a second thing meaning "work has been requested", with its own states,
  sitting beside `jobs` — and the first bug would be a row in one and not the other.
  `startCycleRun` already is the emit path, and using it means admission and the coverage
  ledger apply without a line being written.

- **Sources declared inside a cycle (`cycles.x.from: linear`) rather than as their own
  block.** Considered seriously, since that is where `schedule:` lives and a source is the
  same kind of thing. Rejected because a source carries substantial configuration of its own
  — team, filter, cadence, caps, and a credential it fetches — and burying that under a
  cycle makes the cycle definition two unrelated documents. The current shape keeps the
  reference in the direction that reads: a source names its cycle, the way a schedule row
  points at one.

- **Keying idempotency on `(source, ticket)` rather than `(project, ticket)`.** Rejected. A
  ticket is one piece of work for one repository however Ogun came to notice it, and a
  source-scoped key re-emits an entire backlog the day somebody renames a source in their
  yaml — an ordinary tidy-up with a night of unwanted jobs behind it.

- **Re-emitting when a ticket is edited after its job was emitted.** Rejected. Linear bumps
  `updatedAt` for a comment, an assignee or a drag in the backlog view, so a policy keyed on
  it fires constantly; and even keyed on a content digest, a person refining a description
  gets a job per revision. The edit is reported on the poll and a human decides.

- **Filtering server-side with Linear's `IssueFilter`.** Rejected as the *authority*, for
  the case-folding and stale-blocker disagreements above. The cost of that rejection is
  real — a team's issues are read and filtered locally on every poll — and it is the cost
  ADR-0004 already chose in the same direction.

- **A cursor poll: "issues updated since last time".** Rejected. Smaller and faster, and
  wrong in both directions: a machine down for a day re-emits everything the gap spans, and
  a ticket that reaches the trigger status without being updated — moved by someone else's
  automation, unblocked by another issue closing — is never seen at all.

- **A scope evaluator that is deterministic, or half-deterministic.** Rejected. The
  evaluator is defined as exactly the residue the deterministic filter cannot decide, and
  giving it deterministic rules of its own creates a second place where such a rule can
  live. Then "the filter is the whole deterministic story" stops being true, and the thing
  §4.13 promises is auditable is spread across two files with different testing stories.

## Consequences

- Three new tables (migration `0017_sources`): `sources`, `source_emissions`,
  `source_polls`. The second is the whole of idempotency; the third is the coverage ledger
  for a trigger — a source whose key expired stops doing *nothing visible*, and "looked and
  nothing matched", "could not look" and "was never started" would otherwise share a name.
  `source_polls` grows ~288 rows a day per source and nothing prunes it, which it shares
  with `run_events`.

- `source_emissions` stores a **hash** of the ticket's title, status and description, never
  the text. That keeps it a record of what Ogun did rather than a copy of what Linear says,
  which is the line ADR-0004 draws. It can answer "has this changed since we acted" and
  cannot answer "what does this ticket say now".

- §5.1 says a source "may override" the job's prompt. The implementation **appends** rather
  than overrides, and the divergence is recorded in §5.1: the resolved prompt is the sentence
  naming the skill, and replacing it leaves the agent holding a feature request with no idea
  what it is being asked to do about it. The layers decide what to do; the source decides
  what to do it to.

- **The pipeline is not built.** This slice emits jobs into whatever cycle a project points
  it at, and ships no scope-evaluation skill and no plan/implement/review graph. A project
  configuring a source today gets cycle runs for its tickets and whatever worker it named;
  §9's *ticket → plan → implement → review → draft PR* is the next slice. What this ADR
  settles is where a source sits and what it may do, not what the pipeline downstream of it
  looks like.

- **The key comes from ADR-0012's store, consumed whole.** `readProjectSecret(slug,
  'linear')` is the seam, taken as a parameter of `pollSources` only so the tests need no
  `~/.ogun/config.json`. Its four states are carried through to four different refusal
  sentences rather than collapsed into "no key": `absent` tells an operator to set one,
  `empty` tells them something wrote a blank over the one they set, and `unreadable` says
  the store itself is broken and their key is probably fine. A poller that reported all
  three as the first would send somebody to overwrite a config file that is already failing
  to parse. `expose()` is called once, at the wire, into the header — the value is never in
  a variable this code logs or records.

- **[amended] A sandbox can now reach `api.linear.app`, and the rule above is intact.**
  This record says of the rejected "source as a worker" option that it "puts
  `api.linear.app` on a sandbox's egress allowlist", and that sentence was written as a
  reason to reject a shape. A later slice put the host within reach of a sandbox
  deliberately, and the two are about different things — so this note exists to stop the
  next reader concluding the rule was quietly abandoned.

  What was rejected, and stays rejected, is **selection inside a sandbox**: a container
  asking Linear which tickets to work on. That is not enforced by an allowlist and never
  was. `admitsTicket` is a pure function in `@ogun/core` returning a branded
  `AdmittedTicket` that only the filter can mint, and `ticketBrief` and the emitter take
  the brand — so a container with unrestricted access to Linear's API still cannot produce
  a job, because it cannot produce the brand. `packages/core/test/ticket-filter.test.ts`
  holds a `@ts-expect-error` asserting that an unbranded ticket does not compile. That is
  the guarantee, and nothing about connections touches it.

  What is new is **acting on a ticket that was already selected**. A skill handed a ticket
  may need to read its comments, follow a linked issue, or post its result. That is a
  runtime API call from inside a sandbox, which is what ADR-0010's gateway is for: the
  container holds a placeholder, the real credential is spliced in at the wire on the host,
  and there is nothing in the container to steal. The mechanism is deliberately the same
  one `api.anthropic.com` already uses rather than a second path.

  Four things bound it, and each one is a decision rather than an implementation detail:

  - **It is off by default and per worker.** `connections: [linear]` on the worker, absent
    everywhere else. The obvious implementation — the host on `DEFAULT_ALLOWED_HOSTS` —
    would have given `adversarial-review` a credentialed path to the project's issue
    tracker, and that worker is aimed at untrusted repository content on purpose. The grant
    lives on the gateway *session*, which is per job, so no worker inherits another's.
  - **Only `POST /graphql`.** `api.linear.app` also serves `/oauth/revoke`, and a sandbox
    that could reach it would end the project's connection using the credential the gateway
    had just attached — reconnecting needs a workspace admin. That is a destructive
    capability no allowlist entry expresses.
  - **Only an OAuth grant; a personal API key is refused.** A personal key is everything
    its owner can do in that workspace, forever, and Linear attributes every write to them
    by name (ADR-0014). The poll may authenticate with one; a sandbox may not. The refusal
    names the fix rather than falling back.
  - **`egress: open`, `egress: none` and `sandbox: worktree` refuse the declaration at
    parse.** All three would mean a connection with no gateway between the agent and the
    credential, and all three fail silently if allowed: the agent reaches Linear with a
    placeholder and reports that Linear rejected the credential.

  **The cost, stated rather than mitigated.** A worker with `connections: [linear]` can
  issue arbitrary GraphQL reads against the whole workspace the grant covers — every issue,
  comment, document and attachment in every team it can see, plus the member list — not
  just the ticket it was given. Linear has no per-ticket or per-team scope on an access
  token, so nothing below Linear can narrow this, and a gateway that told a query from a
  mutation by parsing the document would be a policy engine (rejected in ADR-0010) one
  alias away from being wrong while claiming a guarantee. Because `api.anthropic.com` is on
  every allowlist, anything the agent can read it can also put in a prompt and send out;
  ADR-0005 and ADR-0010 both name that as a different and harder problem, and it is still
  open. **A finding that `connections:` is too coarse a grant is a real finding.** The
  answer would be a narrower Linear scope, or write-back performed host-side from a
  structured request the agent produces — not a check in the gateway that cannot hold.

- Nothing here has been run against a live Linear workspace. The client is built against
  recorded responses whose every field, nullability and enum value was taken from Linear's
  published GraphQL schema and developer documentation, and `test/linear-fixtures.ts` states
  exactly that and exactly what it does not prove. The first real API key that reaches this
  project should be pointed at `linearHttp` once by hand, and any difference fixed in the
  fixture rather than in the parser.
