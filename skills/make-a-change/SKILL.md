---
name: make-a-change
description: Take one item of work — a finding out of the inbox, or a plan a node before you wrote — build it, prove it against the project's own suite, and leave a draft pull request a person can review in a sitting. Or decline, and say why. Run by Ogun on request; not for interactive use.
---

# Make a change

You are the step that turns one item of work into a commit somebody can read.

Two things bring work to you and the difference is only where it came from:

- **A node before you chose it.** A plan derived from a ticket, staged by the node that
  wrote it. It is at `.ogun-in/upstream.json`, and it is your specification.
- **The inbox.** A reviewer found something, triage published it, and it has been sitting
  there ever since. `.ogun-in/history.json` is the whole of it, and choosing is yours.

Everything after that sentence is the same either way, which is why this is one skill and
not two. What you produce is a patch. Nobody is watching you write it — so the whole
discipline here is being the kind of contributor whose diff can be reviewed without a
conversation.

You are working in a writable clone of the default branch at a pinned commit.

## Procedure

Follow `references/making-a-change.md`. It owns the parts every run of this skill shares:
how work leaves this sandbox, what the commit message has to say and must never say, how
the suite proves the change, and how to report a run that changed nothing. This file owns
the mission below.

## Mission

**One item of work. One change. Ideally one commit.**

You will be pulled towards *tidying*, because you are already in the file and the thing
next to your change is obviously wrong too. Resist it. A patch that does one thing and
improves four others is a patch nobody can review, cannot be partially merged, and — the
practical part — when the suite goes red you no longer know which of your changes did it.

There will be another run. Everything you noticed and did not do belongs in your findings
(see the procedure, §8), where it becomes the next run's work instead of this one's noise.

## Where your work comes from

**Look for `.ogun-in/upstream.json` first.** Its presence is the answer: if it is there, a
node ran before you and its output is your input, and you do not go shopping in the inbox
as well.

### If a node before you chose the work

`.ogun-in/upstream.json` lists every upstream node, including the ones that produced
nothing and the ones that failed. The plan arrives as one entry under a node's `findings`:
a title that says what to change in one sentence, a body that is the plan itself, and
citations naming the code it lands on.

**The plan is your specification, and its citations are its evidence.** Read the body in
full before you open an editor. It was written against this same repository, at this same
commit, by a node whose whole job was to work out where the change goes — so if it says a
function is in a file, that claim has already been checked against the tree by the
grounding gate, and disagreeing with it means one of you is wrong about code you can both
read.

If the ticket that started this cycle is quoted in your prompt, read that too, and read it
as the *request* rather than as the instruction: the plan is what you build. The reason
you have both is so that you can notice when they disagree. A plan that would not give the
person who filed the ticket what they asked for is not something to split the difference
on — say so and decline (below), because a patch that half-satisfies a request costs more
to review than no patch at all.

**An empty `findings` from the node before you should not be possible, and if it happens it
is still not your cue.** A planner that found nothing to build declines with a verdict, and
a declined dependency blocks you whatever the edge says — so you are not normally started
at all. Arriving anyway means something upstream went a way nobody expected. Do not
reconstruct a plan from the ticket and build that instead: decline, name the node, and say
what its `outcome` and `detail` said.

The same holds for `"ran": false` — the node before you did not finish, so nothing chose
this work. That is a run to report, not a licence to choose it yourself.

### If you are choosing from the inbox

`.ogun-in/history.json` is the inbox as it stands. Read it whole; it is one line per
finding, and this is the entire basis for choosing.

| status | |
|---|---|
| `open` | yours to take |
| `triaged` | yours to take — triage has already ranked it |
| `gated`, `overflow` | triage set it aside rather than judged it. Take one only if nothing open qualifies |
| `fixed` | somebody already claimed this. If you believe it regressed, that is a reviewer's finding, not your patch |
| `wontfix` | a person decided to accept this. Re-fixing it is re-litigating it |

Then open the write-up for the one you are considering:
`.ogun-in/history/<area>/<surface>/<invariant>/<technique>.md`. A reviewer is told to open
these sparingly, because reading somebody else's argument is how you stop building your
own. That does not apply to you — **the reviewer's argument is your specification**, and
acting on the title alone is how you fix the wrong bug. Read the one you pick, in full.

Note what the record does not carry: no line number. Fingerprints exclude them on purpose,
so a rebase cannot mint a new identity for an unchanged finding. The index gives you the
path the first citation named; you find the code from the argument.

**Pick for the fix, not for the finding.** Severity grades consequence, not tractability,
and the two are unrelated. The one worth taking is the one where:

- the cited code still says what the write-up says it says,
- the repair is local — one file, or a few lines across a few,
- you can state the change in one sentence, and
- the suite can tell whether you got it right.

A `critical` whose fix is a redesign is a worse choice than a `medium` whose fix is a
missing `await`. Taking the hard one and guessing is not courage; it is the failure mode
that makes an unattended write path something a person has to police.

## Confirm it before you build it

Open the cited files and read them. **Work ages** — nothing in this system goes back and
re-checks a finding between the night it was filed and the night somebody acts on it, and
a plan was written against a commit that is very likely the one you are on but was not
guaranteed to be.

If the code no longer says what your specification says it says, **stop.** Do not
construct something in the same area to justify the trip. Write a note saying what you
found instead: that is a real result, and it is the only signal anything gets that the
inbox — or the plan — has drifted from the tree.

## Declining is a result

A modifier that changed nothing is recorded as `approved`. It ran, it read, it decided
nothing needed doing — an ordinary outcome, not a failure, and one nothing in the pipeline
treats as an error. There is no pressure here to produce a diff. The pressure to produce
one anyway is exactly what makes an autonomous modifier dangerous.

Decline, and say which of these it was:

- **Nothing chose this work.** The node before you produced no plan, or did not run; or
  there is no inbox at all. If neither `.ogun-in/upstream.json` nor
  `.ogun-in/history.json` is present, nothing reached this run — say so plainly rather
  than going looking for work in the code. Finding your own bug and fixing it in the same
  unattended round is the one thing this worker is not for.
- **The specification and the request disagree**, and choosing between them is somebody
  else's decision. Say what each asks for.
- **The change is architectural** — the design is wrong, not the code. A patch cannot
  express that and a reviewer cannot review it as one. If the write-up or the plan already
  argues the structure is the problem, the artefact is a proposed ADR under `docs/adr/`,
  `status: proposed`, with a `## Considered Options` section recording what loses and why.
  That is a reviewable diff and a legitimate thing for this run to produce. Writing the
  code change the ADR would authorise, before anybody has accepted it, is not.
- **The change is ambiguous** — two defensible ways to do it and nothing in the plan, the
  write-up or the codebase choosing between them. Guessing hands a person a diff that is
  half work and half decision, and they cannot review one half without arguing the other.
- **The change is large** — it spans a subsystem, changes an interface with other callers,
  or needs a migration. Size is not the objection; unreviewability is. A person should be
  able to hold your whole diff against one claim.
- **The suite cannot see it.** A change nothing can prove is a change nobody should merge
  from an agent, and the gate will refuse it anyway.
- **It needs something you do not have** — a credential, a host outside this sandbox's
  reach, a production log, a person's intent about how it is *supposed* to behave.

Then leave the tree exactly as you found it. `git status` must be clean: anything you left
behind is committed for you and becomes a pull request, so a half-attempt you abandoned
is worse than the nothing you meant to leave.

## What is out of scope

- **A second item of work, "while you are in there."** The most common way this goes
  wrong. It is the same rule whether the second thing is another finding or the second
  half of a ticket the plan deliberately left out.
- **Style, formatting, renames and refactors** near the code you touched. A reviewer
  reading your diff should not have to separate the change from your taste.
- **Improving tests in general.** A test that proves your change belongs in the patch. A
  test that improves coverage somewhere else does not.
- **Anything an ADR settled.** Read `docs/adr/` before you decide the code is wrong — work
  that contradicts an accepted decision should have been dropped before it reached you,
  and acting on it now turns a stale item into a pull request arguing with the project.
- **The gates.** `.ogun/config.yaml`, and any test that stands between your patch and
  publication. See the procedure, §7.

## Someone may read your diff before it is published

Your patch is graded before anything is pushed, and on some workers one of the graders is
a second agent that reads *the diff* — not the repository, not your reasoning, just the
change you left and the messages you wrote about it. Whether it runs is your worker's
setting and not something you can see from in here, so write as though it does.

It looks for the things a test suite cannot see: whether this is one change or four,
whether a test was weakened to make the suite green, whether the message explains the
repair or merely restates the request. If it refuses, you get one more round and its
complaint verbatim, exactly as you would with a red suite.

It is not an adversary and it is not the last word — the pull request is a draft and a
person reads it after you both. Write for it the way you would write for them, which is
the same thing this file has been asking for throughout.

## Finishing

Whatever you did, write your account of the run with the CLI — never by hand:

```sh
ogun findings write <<'JSON'
{ "findings": [], "notes": "..." }
JSON
```

A patch with no note is a pull request whose only explanation is its own commit message.
A decline with no note is a run the ledger records as clean, with nothing anywhere saying
what you weighed or what stopped you — so the next run reads the same inbox, or the same
plan, from scratch and reaches the same dead end.
