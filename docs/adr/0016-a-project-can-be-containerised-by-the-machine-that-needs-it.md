---
status: accepted
---

# A project can be containerised by the machine that needs it, and the image is the gate

Adding a project to Ogun costs one file that nobody wants to write. `.ogun/Dockerfile` has
to be `FROM ogun/base`, know that the docker socket is never mounted, know that the
container runs `--network none`, know that a service the suite needs therefore goes inside
the image, and know that the last `USER` has to be `dev` or patch extraction trips over
root-owned files days later. None of that is knowledge a project's owner has any reason to
have, and until now the only way to acquire it was to read `images/base/Dockerfile` and
§4.6.

It is also the one file Ogun could not be asked to write, and the shape of that refusal is
a clean circle. Two lines hold it:

```ts
// pipeline.ts
export const imageFor = (job) =>
  job.permissions === 'modifier' ? projectImage(job.projectSlug) : baseImage()
```

```ts
// admission.ts — modifierReadiness
`${slug} has no .ogun/Dockerfile, so a modifier would run in ogun/base — which
 has none of this project's toolchain and cannot run its suite`
```

A modifier needs the project image. The project image comes from a file only a modifier
could write. So the refusal names the file that would fix it and refuses the only thing
that could produce it.

## The escape was in the reason, not in the rule

The image exists so a patch can be verified **against the project's real toolchain**. That
is true of every patch except one. A patch whose entire content is `.ogun/Dockerfile` plus
a `tests:` block does not need the toolchain to be verified — it needs the Dockerfile to
*build*, and the project's suite to pass *inside the result*.

That is a different gate, and like `git push` it is host-side, because `docker build` is:
the socket is never mounted into a sandbox, since anything holding it can start a
privileged container mounting `/`. So the shape was already there. `publish.ts` is the
precedent for host-side work after the container exits, and it is the precedent for taking
the dangerous capability as a parameter — `PublishRemote` there, `ImageBuilder` here — so
that everything above it can be exercised without a daemon.

**The alternate gate is strictly stronger than the one it replaces.** The ordinary tests
lens runs the project's suite in the project's image and *assumes the image works*. This
one builds the image and then runs the suite in it, which is the only place in Ogun that
ever checks. A containerisation patch is held to more than an ordinary patch, not less.

## `bootstrap: project-image`, and why it cannot be spelled on an ordinary worker

The exemption is a named field on a worker, whose value is a closed set with one member:

```yaml
workers:
  containerise:
    skill: containerise-a-project
    permissions: modifier
    sandbox: container
    bootstrap: project-image
```

A boolean was the obvious alternative and loses to the same argument `connections:` makes:
a second bootstrap kind is a thing somebody will want, and `bootstrap: true` would have to
be reinterpreted the day it arrives. An unrecognised value fails to parse rather than being
ignored.

The requirement was that the wrong thing be **hard to express**, not merely discouraged,
because the moment this can be written on an ordinary worker it becomes the way people
bypass the tests gate. Two independent answers, and the second is the one that matters.

**The schema refuses it.** `workerSchema` requires a `bootstrap:` worker to be a
`modifier`, in a `container`, bound to `containerise-a-project`. Writing the field on a
worker that fixes findings does not produce a worker that skips its test gate; it produces
a config that does not parse, naming the three fields. Binding the skill *by name* is the
part that makes this narrow: to spell the exemption you must also point the worker at the
skill whose entire text is "read this repository and write its Dockerfile", at which point
it is no longer the worker you were trying to exempt. A repository may still ship its own
`containerise-a-project` under `.agents/skills/`, which overrides the built-in — the
documented specialisation path, deliberately left open, because the gate does not care who
wrote the skill.

**And if the schema were bypassed, it would buy nothing.** The `project-image` lens refuses
any patch that is not a containerisation: no `.ogun/Dockerfile` in the diff, or one line
changed outside `.ogun/` (plus a root `.dockerignore`, see below), and the gate fails
naming the file. There is no path through here that publishes application code no suite has
been run over. **The exemption is from *which* gate applies, never from being gated**, and
that is what lets it be narrow rather than merely policed.

The path restriction is doing real work rather than being tidy. The gate's suite is a
command *this same patch wrote*, running in an image *this same patch built*. That proves
the image and the command. It proves nothing whatever about a change to `src/`, so a patch
containing one is refused rather than blessed by proximity.

`.dockerignore` at the repository root is the one exception, and a grudging one. A build
context is the whole repository, and a monorepo with `node_modules` in it sends a gigabyte
to the daemon before the first `RUN` — turning a two-minute build into a twenty-minute one,
out of a budget the job also has to write a patch in. Against that: it is a root file every
*other* docker build in that repository reads, so this worker changing it is a change to
somebody else's build. Allowed, because the alternative is a gate that routinely times out,
and tolerable because a two-file diff is one a person actually reads.

## The failure modes, and what each one does

- **A Dockerfile that builds and whose suite fails.** The ordinary red-suite case: the gate
  fails, the patch is not published, and the suite's output goes back to the agent verbatim
  with one more round.
- **A Dockerfile that builds and whose suite passes for the wrong reason.** The specific
  worry is a suite reaching a service on the *host* — a postgres on 5432 that will not be
  there at 3am. The gate's own run is `--network none`, because it goes through the same
  `buildRunArgs` every job goes through, so "it passed here" and "it will pass there" are
  the same claim. That is why the suite is run through `sandbox.exec` with an image
  override rather than through a second `docker run` written beside the gate.
- **A `tests.command` that is trivially green.** The worst artefact this path can produce:
  a project registered with a gate that passes forever, so every future patch is "proved"
  by a command that proves nothing. Three answers, none of them complete. A narrow
  whole-string pattern refuses `true`, `:`, `exit 0` and a bare `echo` — which catches the
  *accident*, an agent that could not get a suite green and wrote something that exits
  zero, and would be theatre against an adversary. The measured duration is reported on the
  timeline and in the pull request body, which is how a person notices a suite that "passed
  in 0s". And the `self-gating` lens announces the `.ogun/config.yaml` edit, so nobody
  reviews the diff without being told where to look.
- **An image that builds and is not `FROM ogun/base`.** It would work well enough to pass a
  suite and would silently lack the entrypoint that seeds credentials and strips the git
  remote, the bundled `ogun` CLI, the egress forwarder — so every job in it would be a
  total airgap reported as an authentication failure — and the uid-1000 `dev` user. The
  gate asks the same question the runner already asks before it will enforce an allowlist
  (`OGUN_EGRESS_FORWARDER`), between the build and the suite, so the failure lands on the
  agent that can fix it in a round it still has.
- **A build that takes twenty minutes.** It shares the job's one clock, on `testsCheck`'s
  argument: a timeout of its own would be a second number able to disagree with
  `timeoutMs`. A build killed at the deadline fails the gate, and gets no retry, because
  nothing measured how long a build takes — only how much time was left, and handing that
  number to the retry loop would be quoting the budget back at itself. The reason says so
  and names the two repairs: a longer `timeoutMs`, or slow layers earlier in the file.
- **A build that reaches the network.** It does, and it cannot not: an image whose purpose
  is to carry a toolchain has to install one. `docker build` runs commands an agent wrote,
  on the runner's daemon, with the daemon's network, and the sandbox's `--network none` does
  not apply to it. What bounds it is that the build is an unprivileged container, that it
  runs *after* the patch is extracted so nothing it writes can reach the artefact, that its
  context is a repository the agent already had in full, and that the `only .ogun/` rule
  makes the reviewer's diff two or three files. What does not bound it is anything
  technical. This is a real widening of what an agent's output can cause on the runner, and
  it is recorded here rather than implied to be handled.

## The retry, and why this worker needs it most

The retry loop already existed and its reserve is measured from what the gate cost. Two
changes.

`VerifyOutcome` grows an `image` field on the same three-way split `tests` and `review`
use, and `retryDecision`'s reserve becomes suite + review + build. A reserve covering only
the suite would send a round out with enough budget to write a Dockerfile and not enough to
build it — the exact failure the reserve exists to prevent, arriving through the door added
here, which is precisely what ADR-0015 said about adding the review.

The second is about what a bootstrap round can do with its time. **This agent cannot build
its own image or run its own suite**: there is no docker socket in a sandbox, and it is
sitting in `ogun/base` rather than in the image it is describing. So the gate is the only
thing that ever tells it whether any of this works, and the round after the gate is its
first and only sight of a build log. The retry is not an improvement on the loop here; it
*is* the loop. `retryPrompt` therefore says something different at the end: the ordinary
advice is "run the suite yourself while you still have time to act on what it says", and
repeating that to an agent with no docker is how a round gets spent looking for a socket
that is not there.

What is *not* retryable is anything that produced no measurement: a patch with no
Dockerfile in it, a build that never finished, a suite killed mid-run. Each gets its own
sentence rather than a shared "not retryable", because the repairs are unrelated — one is a
run that did something else, one is a job that needs longer, one is a suite that hangs.

## The `self-gating` lens fires every time, and that is the point

A containerisation patch edits `.ogun/config.yaml` on every run, because writing the
`tests:` block is half of what it is for. The `self-gating` lens — which passes, always,
and says out loud when a patch edits the file that decides how it is judged — therefore
announces every one of these runs.

It stays. This is the case it was built for: the one legitimate patch that changes its own
gates. Suppressing it for the worker that trips it most would leave an announcement that
fires only on the suspicious cases, which is an announcement nobody has calibrated, and the
skill tells the agent to expect it and to make the commit message the answer to the
question it raises.

The gate itself is not compromised by the edit, and the mechanism is worth stating because
it is the exact reverse of every other gate here. `tests.command` is normally read from the
blob at the pinned base, because a modifier can write to its checkout and a gate the agent
sets for itself is not a gate. Here there is no command at the pinned base — writing one is
the job — so the gate reads the agent's own proposal. What makes that safe is that the
proposal is not taken on trust: it is *executed*, inside an image the same patch proposed,
and a command that does not exit zero fails the run. The agent is not marking its own work;
it is being made to demonstrate.

## What happens after the pull request merges

Nothing builds the image. §4.6 is explicit that images are built at `ogun project add` and
never at 2am, so that a night does not fail on a bad network — which means a merged
Dockerfile with no `ogun image build` behind it leaves the *next* modifier failing on an
image docker cannot find. That is an error about a thing nobody built, arriving days later
on somebody who never saw this run.

Two answers, and neither is automation.

The pull request body says it, in front of whoever is about to press merge:
`git pull && ogun image build . && ogun project sync .`. That is the only place a person
reliably is at the right moment.

And the image the gate built is **deleted**, deliberately. Tagging it
`ogun/project-<slug>:latest` on success was the obvious shortcut and is rejected: it would
install an image built from an unmerged branch as the one every future modifier is verified
in — a change to the machine made by a run whose patch a person may then reject. The
candidate is tagged `ogun/project-<slug>:candidate-<run>`, keyed on the run so two gates
cannot collide, and removed in a `finally`. The build *cache* is left alone, which is what
makes a retry's rebuild seconds rather than minutes.

## Whether the exemption expires

It expires by construction, and that turned out to be better than expiring it by rule.

`modifierReadiness` reports `bootstrappable` only when everything missing is something this
worker writes. A project that already has both files never reaches that branch: it passes
ordinary readiness on its own terms, and a containerise worker run against it is admitted
without any exemption being spent. A project the control plane cannot find on disk is
refused exactly as any other modifier is, because nothing has confirmed the repository can
be reached and the fix is `ogun project sync` rather than a worker.

So the second run of a containerise worker is an *upgrade* — a legitimate thing to want,
since a toolchain moves — held to the same `project-image` gate, which builds the new
Dockerfile and runs the new command inside it. Refusing it outright was considered and
rejected: it would make the only way to change a project image the same by-hand edit this
whole mechanism exists to remove. The gate says which of the two it was on the timeline
("this project's first image" versus "replaced this project's image"), because the diff
shows a Dockerfile being rewritten and says nothing about what depended on the old one.

## `containerise-a-project` is its own skill with its own `references/`

ADR-0015 recorded the shared-procedure lesson: `ensureSkillAvailable` copies a skill's own
directory into the workspace and nothing else, so a second skill pointing at
`../make-a-change/references/` resolves in Ogun's own repository — where the workspace is
the whole repo — and **dangles in every project that names the built-in**, which is the one
case `skills/` exists for. Silently, in the worst way: the agent reads "follow the
procedure at …", finds nothing, and proceeds without the half of the instructions that
keeps a run from being lost.

That ruled out a pointer. It did not rule out the other option ADR-0015 chose — one skill
with two missions — and that is what was weighed. It loses here, because the missions are
not the same mission. `make-a-change` is "take one item of work and change the code";
this is "read a repository and describe the machine its tests need", with no inbox, no
plan, and a different set of things that are out of scope.

More decisively: half of `references/making-a-change.md` is *inverted* for this worker.
"Prove it with the project's own suite" — there is no suite yet and this agent cannot run
one. "Never touch the gates" — writing one of them is the job. A shared procedure whose
safety half has to be read as "except when it does not apply" is worse than two documents,
because the reader cannot tell which sentences were meant for them.

So: two skills, two references, and the duplication is small and named. What is genuinely
shared is §7–§9 of the new reference — how work leaves the sandbox, the closing-keyword
rule, and reporting through the CLI — because those are properties of the harness rather
than of the mission, and they are the sentences that lose whole rounds when they are
missing.

## Considered and rejected

- **A `skipTests: true` on any worker.** The general form of the exemption, and the reason
  this whole ADR is about narrowness. It is one word away from being the way a project
  publishes unverified code, and the day somebody copies a stanza that worked, nothing
  says otherwise.

- **A fourth permission profile.** `permissions:` says what an agent may do *inside* the
  sandbox, and this worker wants exactly what a modifier wants: write and commit. A profile
  would put an orthogonal question — which gate grades the patch — into the field that
  answers a different one, and every switch on `permissions` in the codebase would need a
  fourth arm.

- **Letting the agent build the image itself**, by mounting the docker socket for this one
  worker. It would give the agent a real feedback loop, which is the thing it most lacks.
  It also hands an unattended agent a socket that can start a privileged container mounting
  `/`, for the *first* worker a project ever runs, against a repository nobody has vetted.
  §4.6 has refused the socket since it was written and this is not the case to make an
  exception for.

- **Tagging the candidate image as the project image on success.** See above: it installs
  an unreviewed image as the one that verifies everything after it.

- **Running the gate's suite without the gateway session**, as a genuine airgap. Cleaner in
  principle, and it fails every honest project: `pnpm install --frozen-lockfile` is the
  first half of most `tests.command`s and needs the registry. The gate uses the same
  session the agent had — one allowlist, one token, one denial log — which is also what the
  ordinary tests gate does.

- **A `bootstrap` worker that also writes `.ogun/config.yaml`'s `workers:` block**, so one
  run makes a project fully operational. Rejected for now, and it is the obvious second
  bootstrap kind: which workers a project runs, on what schedule, with what policies, is a
  set of decisions about how somebody's repository is worked on, and it is not the same
  question as "what does this suite need to run". The closed set is spelled so that adding
  one later is a value rather than a redesign.

## Amended: what the first real image cost, and what a compose file could not have told us

The skill was written before a worked example existed. Its references described what the
image has to be from Ogun's own single-service image plus reasoning over a compose file,
and the honest expectation recorded below — that a reference describing a sandbox it cannot
run in will go stale silently — turned out to understate the problem. It was not stale. It
was *incomplete in ways only a green suite reveals*, and the gap between "the stack comes
up" and "the suite passes" was two bugs.

A four-service Supabase-shaped image now exists for a real repository and passes: 58 suites,
500 tests, zero failures, one `--network none` container, 27 seconds, nothing on the host.
It was built by hand against this skill's reference rather than by the worker, so the
consequence below still stands. What it produced is two findings that are properties of
*this sandbox contract*, not of that project, and both are now in the reference.

### The bind mount is a different filesystem, and that is a property of §4.6

`/workspace` is a bind mount of a host directory. Every path in a project image is on the
image's overlay. `/home/dev/.cache` is a named volume. Three filesystems, and the
consequence is not the obvious one about `EXDEV` — which `container.ts` already recorded —
but that **a tool which co-locates a cache with its output will silently move the cache
rather than fail.**

Measured in the image that now passes:

```
$ pnpm store path                 # cwd = /workspace, a bind mount
/workspace/.pnpm-store/v11        # 1.1 MB — not the 850 MB baked at /opt/pnpm/store

$ pnpm store path                 # same image, cwd = /tmp/w, not a bind mount
/opt/pnpm/store/v11
```

pnpm decides where its store goes by writing a temp file in the project directory and
trying to hardlink it beside the store it would prefer; a cross-device link fails, so it
walks up to the project's mountpoint and uses `<mountpoint>/.pnpm-store`. Nothing warns.
The image's baked closure was ignored and the install went to the registry, which reads as
"a bit slow" and never as an error. Naming the store on the command line —
`--offline --store-dir=/opt/pnpm/store` — turned it into `reused 1036, downloaded 0, done
in 3.5s`.

This joins the finding this ADR's own branch already recorded, that `/home/dev/.cache` is
a named volume and docker seeds a volume from the image only when the volume is empty — so
a store baked at that path is invisible on any runner that has run a job before, and
visible on a clean laptop. Two different mechanisms; one lesson, which the reference now
teaches as the lesson rather than as its two instances: **anything an image bakes is only
there if the runner is not mounting something over it and the tool is not choosing
somewhere else.**

It is recorded here rather than only in the skill because it constrains every project image
ever written for this sandbox, **including Ogun's own**, which turned out to be subject to
it. `ogun/project-ogun` sets `PNPM_HOME=/home/dev/.cache/pnpm` so that a nightly "does not
re-download the world"; the volume contained a metadata cache and no store at all, because
`pnpm install` in `/workspace` resolved its store to `/workspace/.pnpm-store/v10` every
time and a fresh clone throws that away. So the cache volume — which §4.6 has asked for
since it was written, and which `container.ts` spends thirty lines justifying the safety of
— was not caching the thing it exists to cache, on the repository that wrote it.

Three changes, and the third is the one that generalises. `container.ts`'s comment is
corrected: the claim that the store "lands inside this volume, which is the intent" was
true of the intent and never of the behaviour. Ogun's own `tests.command` now names
`--store-dir`, which took the same install from `reused 0, downloaded 97` to
`reused 97, downloaded 0`. And §4.6 states the three-filesystem property directly, because
a rule about how to write a project image belongs where project images are specified rather
than only in the skill that happens to write them.

### A two-phase schema is two actors, and role-scoped state must name both

The other bug was 327 of 500 tests failing on `permission denied for table`, from a
`ALTER DEFAULT PRIVILEGES` stanza that was present, parsed, and carried a comment
correctly predicting that exact failure if it were absent. It was written without
`FOR ROLE`, and without that clause the defaults bind to whoever executes the file.

The split that produced two roles is the right design and the reference now teaches it
first. Vendor schema — the base bootstrap, the auth service's migrations, the storage
service's migrations — comes out of pinned images, cannot change when a modifier edits the
repository, and is baked into `$PGDATA` at build time. The repository's own migrations are
**not** baked: they are replayed from `/workspace` on every container start, because a
modifier is entitled to add a migration and a schema baked before it existed would hand
that patch a green suite against a database missing its table. That is the exact failure a
tests gate exists to catch, produced by the gate itself — the same argument this ADR makes
for why the gate's suite runs on `--network none`.

The cost of the split is that the two halves run as different roles, so anything scoped to
"the role that created the object" has to name both. That is the general shape, and it is
not only `ALTER DEFAULT PRIVILEGES`: per-role GUCs, per-role `search_path`, ownership, and
`GRANT … ON ALL TABLES IN SCHEMA` (a snapshot, not a rule) all have the same trap. The
reference teaches the split and its consequence in one section, because separating them is
how somebody keeps the design and re-earns the bug.

## Consequences

- **Nothing here has run end to end.** No repository has been containerised by this worker:
  the slice was exercised against a faked `ImageBuilder`, a scripted sandbox and real git,
  and never once against a real repository with a real daemon. The first live run should be
  watched, which is also why no `containerise` worker is added to Ogun's own
  `.ogun/config.yaml` — this repository already has an image, so a worker here could only
  ever exercise the *upgrade* path, which is the rarer of the two and the less interesting
  one to watch first.

- **The gate needs a longer `timeoutMs` than any other worker.** A build plus a suite plus
  the agent's own round, in one budget. A project whose image installs a database from
  packages is minutes of build before the first test runs, and the reserve arithmetic makes
  a too-short job legible rather than mysterious — but it is still a job that produced no
  pull request. Ninety minutes is a sane starting point and there is no evidence behind
  that number yet.

- **The runner now runs `docker build` on behalf of an agent.** Stated again here because
  it is the consequence most worth being reminded of when reading this file later: the
  build is the only part of an agent's output in this system that executes with the host
  daemon's network.

- **`ExecOptions` grows an `image` override**, which is a second way to decide what a
  command runs in. It is documented as having exactly one caller and the worktree sandbox
  throws rather than ignoring it, because a suite run on the host under the claim "inside
  the image this patch proposes" would be the most misleading pass this system could
  record.

- **A project's first image is written by an agent that cannot run it.** Everything the
  skill knows about the sandbox comes from being told, and if `images/base/Dockerfile`
  changes — a new marker, a different user, another environment variable — the skill's
  reference goes stale silently. Nothing detects that today. The `OGUN_EGRESS_FORWARDER`
  check in the gate is the one property that is enforced rather than described, and the
  honest expectation is that it will not be the last one that needs to be.

  The first real image amended this rather than confirming it. Staleness was the worry;
  incompleteness was the problem. Both of the bugs above are things the reference *never
  said*, in a document written by reasoning over a compose file, and neither produced an
  error naming its cause — a package store that quietly moved, and a grant that applied to
  the wrong half of a schema. A reference for a sandbox nobody can run in accumulates gaps
  faster than it goes stale, and the only thing that closes one is a suite going green.
  The second project containerised will find a third gap; the fix is to fold it back in
  here the same way, not to expect the document to have been complete.

- **The one property that could be enforced instead of described, and is not.** The store
  finding is checkable: a project image could be asked, at build time, whether the cache it
  baked is the cache its `tests.command` resolves to, and refuse otherwise. It is not,
  because the check is per-package-manager and the gate is not — asking pnpm's question of
  a Cargo project is how a gate starts refusing correct images. The measured install
  duration in the pull request body is what a person has instead, and "the install took
  four minutes" is the only signal that a baked store was ignored.
