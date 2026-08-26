# Making a change

The procedure for every run that writes code. The mission — what to change, and how the
work reached you — is in `SKILL.md`; none of what follows depends on it, because the
extractor, the test gate, the patch lenses and the publisher are the same machinery behind
every worker that writes, and most of the ways to lose a run to them are invisible from
inside the sandbox.

**One copy of this file, on purpose.** A second modifier skill would mean a second copy,
and the half of a duplicated procedure that drifts is never the mission — it is this one,
the safety half, where every rule was written down because a run was already lost to it.

## 1. Know how your work leaves this sandbox

You are in a container, on a writable clone of the default branch at a pinned commit.
There is no git remote and no credential here, by design — the sandbox never pushes
(ADR-0005). What you produce is commits.

After you exit, on the host: the runner runs `git format-patch <base>..HEAD` against the
tree you left, the project's own suite is run against that tree, and only if it passes
does the host apply the patch to a scratch worktree, push a branch, and open a **draft**
pull request. Nothing merges. A person reads it.

Three consequences, each of which has cost a whole round:

- **Never rewrite history.** `commit --amend` on the pinned commit, `reset --hard`,
  `rebase`, or checking out another ref makes `HEAD` stop being a descendant of the base
  the host is holding. Extraction refuses that outright — it cannot express your work as a
  patch against a commit you moved away from — and the run is recorded as work that could
  not be extracted. Everything you did is deleted along with the workspace seconds later,
  and there is no retry: an unextractable patch is a fact about the run, not a question
  another round could answer. Commit forward. A mistake gets a second commit, not an
  amended first one — and that holds on a retry too, where the temptation to tidy the
  history you are being asked to fix is at its strongest.
- **Never try to push, and do not go looking for a way.** There is no remote, no token and
  no route to one. An agent that spends its round trying to publish its own work learns
  that the hard way with nothing to show for it.
- **Anything you leave uncommitted is committed for you**, under a message that says
  nobody wrote one. That is a safety net for work that would otherwise vanish, not a
  workflow: a pull request whose entire content arrived that way is a sign the agent was
  not doing what it was told, and the message is meant to be unmistakable in `git log`.

## 2. Write a change that looks like it belongs

Before you edit anything, find out what this repository's conventions actually are.
`CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`, `docs/adr/` where they exist; and, always,
the code immediately around the thing you are changing. How it handles errors, how it
names things, whether it comments, how its tests are written.

This is not politeness. A patch that is correct and idiomatically foreign is one a
reviewer rewrites rather than merges, and rewriting it costs them more than the bug did.
It is also the difference a human notices first about an agent's diff, which makes it the
thing that decides whether the next one gets read at all.

Match what is there, including where you think it is wrong. Improving the convention is a
separate change and a separate conversation.

## 3. Commit your own work, and write the message for the person who reviews it

The commit message is the first thing a human reads about your change, and the publisher
builds the pull request out of it: **exactly one commit lends its subject to the pull
request title.** Two or more and the title becomes `<worker>: 2 commit(s)`, which tells
the reader nothing at the one moment they are deciding whether to open it. So prefer one
commit. Split only when the change genuinely has two parts a reviewer would want to read
separately, and accept the worse title when you do.

The full message body is reproduced verbatim in the pull request. It is the review brief,
so write it as one:

- **Subject**: imperative, specific, under about 70 characters. `Reject a port of 0 in
  parseAuthority`, not `Fix bug` and not `Do what the plan said`.
- **Body**: what was actually wrong and how you know; what you changed, and why this
  repair rather than the other one you considered; what you checked, including the suite;
  and an identifier for what you worked from — the finding's fingerprint, or the
  ticket the plan came from — so a reader can find the argument behind the change.
- **What you did not do** belongs here too. The first question anyone asks of an agent's
  patch is what else it touched, and "I saw X nearby and deliberately left it" answers it.

Write it in your own words. A message that restates the finding's title, or the plan's,
and nothing else tells the reviewer only that you can read your input.

## 4. Never write a closing keyword

Not `Closes #14`. Not `Fixes #14`, `Resolved #14`, `close #14`, `fixes owner/repo#14`, or
any of those followed by an issue URL. GitHub accepts close/closes/closed, fix/fixes/fixed
and resolve/resolves/resolved, in any case, and it does not care which line of the message
they appear on.

The pull request *body* is safe: the runner fences your commit text so GitHub does not
interpret anything inside it. **The commit message itself is not, and cannot be made
safe** — GitHub scans commit messages when a branch merges, and stripping the line would
mean rewriting the artefact a person is reviewing (ADR-0009).

So the gate refuses instead. The `commit-message` lens reads every message in your patch
before the suite is even run, and one closing keyword ends the run: no pull request, and
**no second attempt**, because the only way to take the line back out is to rewrite
history and that is the one thing §1 says loses everything. A whole round, thrown away
over a sentence you did not have to write.

The failure it prevents is quiet and it lands on somebody else: the draft is merged weeks
later and an issue nobody connected to this work closes itself, citing your commit as the
reason. "Fixes #14" is the most natural sentence in the world to write about a bug fix,
which is exactly why it needs saying out loud.

Refer to issues in prose instead — "the bug reported in #14", "the finding recorded as
`security/gateway/host-allowlist/trailing-dot`". Both link. Neither closes, and neither
trips the lens: it only fires when the issue reference immediately follows the keyword,
which is the same rule GitHub applies.

Same reasoning, smaller stakes: no `@mentions`, and no `Co-authored-by:` trailer naming a
person. Nobody co-authored this, and a trailer is a claim about someone who never saw it.

## 5. Prove it with the project's own suite

Read `tests.command` from `.ogun/config.yaml` and run exactly that. The image you are in
was built for this repository so that you could.

The runner runs the same command again after you exit, against the tree you left, and a
patch whose suite is red is never published. What happens then is that you may be handed
the suite's output and asked again — **there is a retry, and it is short**. The runner
resumes this same session, your commits are still in the workspace, and you get what is
left of the job's timeout minus what the gate needs to run the suite one more time — and,
where your worker asks for one, minus what the review of your diff costs as well. If there
is not enough left for that, there is no second attempt at all and the run ends refused.

So the only thing running the suite yourself changes is whether you are still here, with
budget, to fix what it says. Skipping it does not save the time; it spends most of it and
leaves the repair to a round that has almost none.

- **Run it once before you change anything.** A suite that was already red is not your
  patch's fault, and that is a fact you can only establish before you touch the tree. If
  it was already red, say so in your notes — it is worth more than a guess about why.
- **Add a test that fails before your change and passes after**, wherever the change is
  the kind of thing a test can see. Write it first and watch it fail. Without that, "the
  suite passed" only means you broke nothing, which is not the claim you are making.
- **Leave room in the budget.** The gate's clock is what remains of the job's timeout, not
  a fresh one, and neither is the retry's. A gate that starts with nothing left records
  that the suite *never ran* — not that it failed — and that refuses to publish for a
  reason which reads like a broken harness rather than a bad patch. It also means no
  retry: the runner only grants one when what remains would cover the suite twice over,
  once for you and once for the gate. Start the suite while you can still act on what it
  says.
- **A suite you cannot get green is an answer.** It usually means the change is wrong, or
  bigger than it looked. Reverting to a clean tree and declining (§8) is a better run than
  a red patch nobody can publish.

## 6. Leave nothing in the tree that is not the change

Running a suite writes into the tree: `node_modules/`, a coverage directory, a compiled
`dist/`, a database dump, a cache. Extraction begins with `git add -A`, so anything the
repository does not already ignore is committed for you and arrives in the pull request
under somebody else's name.

Before you finish, run `git status --porcelain` and account for every line. Delete what is
not yours. Do not add it to `.gitignore` to make it disappear — that is a change to the
repository inside a patch about something else, and it is exactly the kind of unrelated
edit §7 is about.

## 7. Never touch the gates, and never weaken a test to pass

`.ogun/config.yaml` — `tests.command`, `policies` — is read from the blob at the pinned
commit, never from your workspace. Editing it here changes nothing about how you are
judged. What it does do is put "the agent tried to set its own exam" into a diff a person
is about to read, and it is not left to them to notice: the `self-gating` lens says so on
the run's timeline whether or not anybody opens the diff. That lens does not refuse — this
file is a file like any other and a finding about it deserves a fix. If the work you were
given genuinely requires a change there, make it and say so plainly in the message, and
expect the old command to be what you are held to.

If your change turns a test red, there are exactly two honest cases:

- the test encodes something your change got wrong — fix the change; or
- the test asserts the behaviour your work says is wrong — change the test, say so in
  the commit message, and make the new assertion at least as strong as the old one.

Deleting the test, loosening the assertion, or marking it skipped is neither, and it
produces the one artefact this whole path exists to prevent: a green suite over a bug.

**Do not add or upgrade a dependency.** Adding one is a supply-chain decision a person
makes, this sandbox reaches only the package registry and the model API, and a lockfile
change buried inside a bug fix is the least reviewable diff there is. If the work
cannot be done without one, decline and say which package and why.

## 8. Say what happened, including when the answer is "nothing"

Your account of the run goes through the CLI, never by hand:

```sh
ogun findings schema     # print the shape
ogun findings write <<'JSON'
{ "findings": [], "notes": "..." }
JSON
```

A modifier that changed nothing is recorded as `approved` — it ran, it read, and it
decided nothing needed doing. That is an ordinary outcome and not a failure. The note is
what turns it from silence into a result: say what you were given or what you chose, what
the code actually said, and what stopped you.

- **Something you noticed but did not fix is a finding, not an edit.** Write it up with a
  fingerprint and citations exactly as a reviewer would; a modifier's findings reach the
  inbox the same way. That is the alternative to fixing it now, and it is what keeps "one
  item, one change" from meaning "the second bug is lost".
- **Do not adjudicate.** `adjudications` change what the inbox says about findings that
  already exist, and yours would be wrong: your patch is a draft nobody has merged, so
  `fixed` is false until a person merges it — and an inbox claiming `fixed` while the bug
  is still on the default branch is worse than one that says `open`, because the next
  reviewer reads it as a surface already accounted for. Triage adjudicates, from the
  merged tree, on the next cycle. That is its job and not yours.
- **Cite what exists, and check it yourself.** A reviewer's citations are verified before
  anything is persisted; a modifier's are not — the only gate on your run is the suite, so
  nothing between you and the inbox is going to open the file and look. `ogun findings
  write` validates the document's shape and the fingerprints, and stops there. A path or a
  line you reconstructed from memory instead of reading will simply be published wrong.
  `ogun check-citations` runs the reviewer's check by hand, locally, against the tree you
  are in — one command, and it is the difference between a note somebody can follow and
  one they have to re-derive.
