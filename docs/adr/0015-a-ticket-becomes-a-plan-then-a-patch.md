---
status: accepted
---

# A ticket becomes a plan, then a patch, and the review of it is a lens

ADR-0013 settled where a source sits and what it may do, and said outright what it did not
settle: *"the pipeline is not built… §9's ticket → plan → implement → review → draft PR is
the next slice."* This is that slice. Four things had to be decided and each one turned out
to be forced by machinery that already exists rather than by taste.

## The pipeline is three nodes, and the fourth is a lens

```
source ──▶ scope ──block──▶ plan ──block──▶ implement ──▶ draft PR
                          reviewer          modifier
                                            gate: commit-message, self-gating, tests, review
```

**Publication happens inside the modifier's own job.** `executeJob` reports, reads back the
outcome the control plane recorded, and calls `publishIfReady` — all before the foreman has
released anything downstream (ADR-0009). So a *review node* running after the modifier
reviews a pull request that is already open. It can annotate; it cannot block. §5.1's rule
that a failed dependency must not silently produce an unreviewed result would be violated
by the shape of the graph itself, not by any bug in it.

The verify gate is where a patch is stopped, and it is the only place (§4.10). So the
review of the diff is a **lens** — `packages/runner/src/review.ts`, declared by a worker as
`verify.expectations: [{ name: review, method: agent }]`. Being a lens buys three things a
node could not have:

- **It blocks.** A failed gate derives `dispatched` down to `changes-requested` in
  `finalizeRun`, and `refuseBefore` publishes nothing that is not `dispatched`. No new gate
  was written; the existing one grew a lens.
- **It feeds the retry loop.** §5.2's loop is a property of a job, because it resumes the
  provider session in the container that still holds the workspace. A separate node's
  verdict has nowhere to go: the agent that wrote the patch was disposed with its job. As a
  lens, the reviewer's refusal is handed back verbatim by `retryPrompt`, exactly as the
  suite's output is — and it is the *more* actionable of the two, because it is prose
  written for this agent about this patch.
- **It is measured.** `retryDecision`'s reserve was "what the suite just cost", on the
  grounds that a constant would be a second number able to disagree with `timeoutMs`. The
  reserve is now the suite *plus the review*, both measurements, because a round sent out
  with budget for a patch and not for the gate that judges it produces a refusal reading
  like a broken harness — the exact failure the reserve exists to prevent, arriving through
  the door added after it.

**Silence is not approval.** A review that produced no readable verdict — no file, prose
instead of JSON, a runtime that died — *fails*, and reports `ran: false` so no round is
spent asking a modifier to repair somebody else's silence. Skipping was the behaviour every
agent lens had, and skipping here publishes an unreviewed patch from a worker that asked to
be reviewed.

**The blocking cut is `critical` and `high`, and the prompt defines the word.** For a patch,
`high` means "a reason a person should not merge this". Anything below it is an observation:
it reaches the run timeline through the gate's detail and never stops the run, because a
reviewer that blocked on a `medium` would end runs over taste, and taste is what a draft
pull request is for.

**This is not a default lens.** §4.10 argues that a rubric guessed at before there is output
to calibrate against is the wrong rubric permanently, and that argument is about defaults —
nothing here is added to any profile's default set. A worker asks for this lens by name, and
`review.ts` owns the prompt rather than reading `lens.prompt`, because a rubric a worker can
rewrite in its own stanza is a worker grading its own exam.

## `implement` is not a new skill: `fix-a-finding` is generalised into `make-a-change`

The two missions are the same mission. "Take one item of work, confirm it against the code,
change it, prove it with the suite, commit it for the person who will read the pull request,
or decline" does not vary with where the work came from. Comparing them section by section,
only one differs: *choosing* from an inbox, versus being handed a plan. Everything else —
mission, confirmation, the decline taxonomy, what is out of scope, how to report — is
shared, and so is the whole of `references/making-a-change.md`, which was already written as
"the shared procedure for any modifier skill".

Two skills over one shared reference is the obvious alternative and it does not work,
because of how a skill *travels*. `ensureSkillAvailable` copies a skill's own directory into
the workspace and nothing else. A second skill pointing at `../make-a-change/references/`
resolves in this repository — where the workspace is the whole repo — and dangles in every
project that names the built-in, which is the one case `skills/` exists for. The failure is
silent in the worst way: the agent reads "follow the procedure at …", finds nothing, and
proceeds without the half of the instructions that keeps a run from being lost.

That leaves duplication, and duplication is what the task was to avoid. Two copies of a
procedure drift, and the half that drifts is never the mission — it is the safety half,
where every rule was written down because a run had already been lost to it.

The rename is not cosmetic: a skill named `fix-a-finding` whose text is about a plan derived
from a ticket is a lie in the most-read artefact in the system. The *worker* stays
`fix-a-finding` — §4.8's distinction, finally load-bearing: two workers (`fix-a-finding`,
`implement`) bind one skill and differ only in where their work comes from.

## A plan is a staged finding, because that is the only channel between nodes

A plan that lives in a transcript cannot be reviewed or reused. A plan written into the
workspace is deleted with it: every job clones its own. The channel between two nodes of a
cycle is `/api/jobs/:id/inputs` → `.ogun-in/upstream.json`, and what it carries is the
upstream node's **staged findings**. There is no second one.

So the plan is one finding-shaped record, and the shape is doing real work rather than being
tolerated:

- **Staging is exactly right.** A node with dependents stages instead of publishing
  (`nodesWithDependents`), so a plan never reaches the findings inbox — which is what the
  mechanism was built for when triage needed it.
- **`citations` are checked.** The `grounded` tool lens opens every cited file and refuses
  the run if one is not in the tree or the line is past its end. A plan invented from the
  ticket text is therefore *unpublishable*, deterministically, and that is the difference
  between "I read the code" and "I described what a codebase like this would contain".
- **The fingerprint gives identity.** `plan/<ticket>/<surface>/<change>` makes everything
  about one ticket a prefix, which is the property §4.11 gives as the reason for a
  hierarchical fingerprint over a hash.

What is forced rather than natural is `severity`, and it is written down rather than
smoothed over: a plan reports `info` unless the ticket describes a defect the plan confirmed
in the code, in which case it is graded as a reviewer would grade it. A required field
carrying a convention is the cost of using the one channel that exists.

## The ticket reaches every node of its cycle, not only the entry node

`emit` handed `ticketBrief` to the entry node alone. That is right for a one-node cycle and
wrong for anything longer: the planning node two hops in would plan from whatever the node
before it wrote down, and **a ticket retyped by a model is not the ticket** — the words
somebody filed are the whole of what the deterministic filter admitted, and nothing
downstream can reach Linear to check a paraphrase against them. The node that builds the
change needs them from the other end: it is the only node positioned to notice that the plan
it was handed would not give the person who filed the ticket what they asked for.

ADR-0013's "exactly one entry node" rule is untouched and still enforced. That rule is about
there being one place work *starts*; which nodes may *read* the ticket is a different
question, and the entry node was only ever the right answer to it by accident of the graph
being one node long. The layering is unchanged (§5.1): the brief is appended to each node's
own resolved prompt.

## `block`, not `degrade`, on every edge in this chain

`degrade` is right for a fan-in: triage over three of four reviewers, with the batch marked
incomplete, beats a night that produces nothing. It is wrong for a chain, and the rule that
separates them is what the dependent's job *is*. Triage's job is to report on a batch, so a
partial batch is a partial report. A planner's job is to act on a verdict and a modifier's
is to act on a plan — a chain where each node is the sole input to the next has nothing to
degrade to. `degrade` on `scope → plan` plans a ticket nobody admitted; on
`plan → implement` it writes code with no confirmed plan.

**A declined plan is not a failed one, and it does not need the edge.** The scope
evaluator's slice already built the word for this: a run carrying `scope: { verdict:
"decline", reason }` ends `declined`, and `releaseDependents` blocks its dependents
whatever `onDepFailure` says, because that edge answers "what if this node broke" and a
decline is not a break. `findings.ts` says outright that the mechanism is not tied to one
skill — *"a planner that cannot find a plan is answering the same question one stage
later"* — so the plan node declares the same `verdict` lens and answers the same field.

That is strictly better than what this record originally said, which was that a declined
plan would report `approved` with no findings and let the implement node start, read the
empty result and decline in turn. It cost a container to produce a second run saying the
same thing, and it left a `degrade` edge able to send a modifier at a plan that does not
exist. Adopting the verdict costs nothing and removes both. The `block` edges stay: they
are what covers a node that *crashed*, which is a different question and the one
`onDepFailure` was written for.

## No node declares `connections: [linear]`

ADR-0013's amendment opened the door for exactly this pipeline — "a skill handed a ticket
may need to read its comments, follow a linked issue" — and the door stays shut. The grant
is per worker and cannot be narrower than the whole workspace the project's OAuth grant
covers, and the plan node's output is piped directly into the instructions of the node that
writes code. Declaring it would convert "a ticket a person filed" into "anything anybody
wrote in this Linear workspace" as input to a modifier, and `api.anthropic.com` is on every
allowlist, so anything the agent reads it can also send.

A plan that turns on something only in the comments should say so and decline; a person
moves it into the description. If real runs show that is too limiting, the line goes on the
**plan** node and only there — which is a reason the split exists at all, independently of
everything above: `plan` and `implement` are separate workers partly so that the node which
may one day need Linear is never the node that writes code.

## Considered Options

- **`review` as a fourth cycle node.** Rejected, and it is the option this record exists to
  reject. Publication happens inside the modifier's job (ADR-0009), so a node after it can
  only annotate a pull request that is already open, and §5.1's `on_dep_failure` cannot help:
  the harm has landed before the edge is evaluated. Deferring publication so a later node
  could do it means the review node's runner needs the upstream patch, the base sha and the
  project checkout — a second publication path, exercised by nobody, whose first act is
  pushing to somebody's remote.

- **`review` as a deterministic tool lens.** Rejected: nothing on §4.10's list — one change
  or four, a test weakened to pass, a message that explains the repair — is decidable by a
  regex. The two checks that *are* decidable already exist and already run first.

- **Wiring agent lenses generally, with rubrics from `verify.expectations[].prompt`.**
  Rejected. It re-opens the calibration argument §4.10 settled, and it puts the rubric in
  the worker's own stanza, where a worker can weaken the check it is judged by — the same
  objection that keeps the test gate out of `skipDefaultLenses`.

- **Two modifier skills sharing `references/making-a-change.md` by relative path.** Rejected:
  `ensureSkillAvailable` copies one directory, so the reference resolves here and dangles
  everywhere the skill is shipped, silently.

- **Two modifier skills with byte-identical copies of the procedure, held together by a
  test.** Considered seriously — self-contained skills are what the packaging wants, and a
  test does catch drift. Rejected because the test only runs in *this* repository, so it
  protects the copy that was never at risk, and because the mission halves turned out to be
  ~85% identical too: the duplication would not have stopped at the reference.

- **A new `plan` artefact: its own report field, column, and `/inputs` key.** Rejected. It
  is a second thing meaning "what the node before you produced", sitting beside staged
  findings, and the first bug would be a plan in one and not the other — the same objection
  ADR-0013 makes to a second queue of emitted work. `/inputs` already is the channel.

- **A plan as several findings, one per step.** Rejected. One plan is one pull request a
  person can hold against one claim; a plan that arrives as a list of steps is a diff nobody
  can review, pre-authorised. A ticket needing three changes is a decline that names them.

- **A deterministic lens failing a plan node that produced no plan**, so `block` skips the
  implement node. Rejected, and it is the shape `scope.verdict` exists to make unnecessary:
  it files "I decided not to" as "the gate refused me", and a `gate-failed` coverage row for
  a node that worked correctly is the collapse principle 6 forbids. The `verdict` lens does
  the opposite and is why it is there — it fails a node that answered *nothing*, which is a
  malfunction, and records a node that answered "no" as `declined`.

- **Planning inside the implement node — no plan node at all.** Rejected on three counts:
  the plan would exist only in a transcript, so a retry re-derives it; a decline would cost
  a modifier round instead of a reviewer one; and the node that may eventually need
  `connections: [linear]` would be the node holding the pen.

## Consequences

- `skills/fix-a-finding` becomes `skills/make-a-change`, and **`.ogun/config.yaml`'s
  `fix-a-finding` worker must change its `skill:` line to match.** Until it does,
  `own-config.test.ts` fails with the worker's name in the message, which is the drift
  detector doing its job rather than an incidental breakage.

- The review lens costs a model round inside the job's budget, so a worker declaring it
  wants a longer `timeoutMs` than one that does not. The reserve arithmetic makes the
  failure legible rather than mysterious — a job too short for its own gate is refused with
  both measurements in the sentence — but it is still a job that produced no pull request.

- The reviewer runs in the modifier's container, which is mounted read-write for the
  modifier's profile. It is invoked with `permissions: 'reviewer'`, which makes claude
  withhold the edit tools and does nothing at all on codex (§4.7). **This is legibility, not
  containment.** What actually bounds it is ordering: the patch is extracted before the gate
  runs, so nothing written during a review can reach it, and `sweepGateArtifacts` removes
  untracked leavings before a retry — a reviewer that modified *tracked* content ends the
  loop, exactly as a suite that does.

- The reviewer reads a diff written by an agent that knew it would be reviewed. The prompt
  says so and tells it to report such an attempt rather than obey it, and that is a
  mitigation rather than a defence. The defences are unchanged and elsewhere: nothing
  merges, the sandbox holds no credential, a person reads the draft.

- A plan and a review are both `findings` documents, which means the findings document now
  carries three different kinds of claim. Only one of them ever reaches the inbox: a plan is
  staged because its node has a dependent, and a review is read by the gate off a path of
  its own and never reported at all.

- **Nothing here has run end to end.** The source has now polled a real workspace (§9), but
  no ticket has been carried from a poll through a plan to a patch: this slice was exercised
  against scripted runtimes and real git, and not once against a real ticket. The first live
  run should be watched, for the same reason `fix-a-finding` still has no schedule:
  `maxOpenPullRequests` bounds the damage of an unattended modifier and is not a substitute
  for having seen one work.

- **The scope evaluator's `reason` does not reach the plan node**, and the plan skill says
  so rather than pretending otherwise. `/inputs` carries an upstream node's *staged
  findings* plus its outcome and `runs.detail`, and the runner sets `detail` from the
  verdict only on a decline — so an admitted ticket arrives at the planner with the fact
  that it was judged and nothing about what the judge thought. That is survivable: the
  planner has the ticket and the repository, which is more than the evaluator had. It is
  worth closing when somebody is next in `/inputs`, and the fix is one field rather than a
  new channel.

- **The `review` lens is one rubric, and it has calibrated against nothing.** It is opt-in
  precisely so that being wrong about it costs one worker rather than every modifier, and
  the honest expectation is that its first weeks are spent finding out that it blocks on the
  wrong things. The place to change that is the prompt in `review.ts`, and the thing to
  resist is moving it into config where a worker can soften it.
