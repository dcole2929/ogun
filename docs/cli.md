# The `ogun` command

Every command, what it does, and — where it matters — which machine to run it on.

`ogun` is the admin client. It defines projects, triggers runs, and reads what happened;
it is also the interface the *agents* use, which is why three of these commands are meant
for a skill inside the sandbox rather than for you.

```sh
ogun                     every command, one line each
ogun <command> --help    one command in full: flags, machine, what it writes
```

Help is answered before anything else runs, so `--help` works on a machine with no
control plane, no database, and nothing set up.

### Which machine

Most commands talk to the control plane over HTTP and can be run from anywhere that can
reach it. Four groups cannot:

| | run it on |
|---|---|
| `server`, `db *`, `token *`, `runner invite`, `secret *`, `linear *` | the control-plane machine |
| `runner init`, `runner join`, `runner start`, `runner doctor`, `image build` | the runner machine |
| `project add`, `project sync`, `skill new`, `skill link` | a machine with the repo checked out |
| `findings write`, `validate-findings`, `check-citations` | inside the sandbox, by a skill |

### What gets written where

| | holds |
|---|---|
| `~/.ogun/config.json` | machine-local facts: this runner's name and token, the admin token, and where repos are checked out on this disk. A path is a fact about one machine, so it never travels the wire. Also a project's own API keys, which are not a machine fact and are here because the control plane is what polls (ADR-0012) |
| the repo's `.ogun/config.yaml` | workers, policies, schedules. The one definition of a worker, in git |
| the database | projects, workers, skills, runs, findings, coverage. An index of what git already says, not a second source of truth |
| Docker | the postgres container, and the image each job runs inside |

The first is JSON because commands write it and nobody opens it; the second is YAML
because you write it, comment it, and review it in a pull request.

`OGUN_CONFIG` moves the local config file; `OGUN_SERVER_URL` points the CLI at a control
plane elsewhere (default `http://localhost:7777`).

---

## Setting a machine up

### `ogun init`

```
ogun init [--no-image]
```

Starts postgres in a container, applies migrations, and builds the `ogun/base` sandbox
image — in that order, on the machine that will run the control plane.

Idempotent, and it reports what it skipped: re-running it is how you pick up a new
migration. The image is built now rather than at first use because a nightly run that has
to build an image first is a nightly run that fails on a bad network.

Registering this machine as a runner is the last step, and the only one that needs the
control plane: name uniqueness is enforced there and nowhere else. So `ogun init` does it
if the control plane is already up, and otherwise tells you to run `ogun runner init`
after `ogun server`. Everything before that point needs nothing running, which is why
`init` comes first.

- `--no-image` — skip the image build. Quicker, but the first container job then has
  nothing to run inside.

Touches: Docker (the compose stack, the image), the database (migrations).

### `ogun db up | down | migrate | status`

The database, without having to know it is postgres in a compose file. On the
control-plane machine; nothing else talks to postgres directly.

- `up` — start it, and wait until it accepts connections. Compose reports the container
  as started well before postgres will answer, so this polls rather than returning early.
  Gives up after 30 seconds.
- `down [--volumes]` — stop it. `--volumes` deletes the data with it: every run, finding
  and coverage record, which is the whole history of what the factory has done. Never
  implied.
- `migrate` — apply anything in `packages/core/drizzle` not yet recorded. `ogun init`
  does this for you.
- `status` — is it up, and does it have a schema. The default with no subcommand.

`DATABASE_URL` overrides the connection string
(`postgres://ogun:ogun@localhost:5433/ogun`).

### `ogun image build [project-dir]`

Builds the container image a job runs inside. Run it on every machine that runs container
jobs: the image is built locally and never pulled, so it has to exist where the container
starts.

With no argument it builds `ogun/base:latest` from `images/base`, bundling the CLI into
the image first — the in-sandbox `ogun findings write` has to match the validator that
will read its output, and a bundle cannot drift from it.

With a directory it builds `ogun/project-<slug>:latest` from `<dir>/.ogun/Dockerfile`. A
project image is `FROM ogun/base` plus that project's toolchain; a `modifier` worker
needs one, because the base image is enough to read a repo and not enough to build it.

The slug comes from `project.name` in that directory's `.ogun/config.yaml`, not from the
directory name — that is the name the runner looks the image up by, so building from a
git worktree or a clone kept under a different name would otherwise produce an image no
job ever asks for. `--name <slug>` overrides it, the same way `ogun project add` does.

Touches: Docker.

---

## Running it

### `ogun server`

Starts the control plane: the API, the web UI, and the foreman that schedules cycles,
sweeps stale claims, and reconciles coverage. One machine, and it stays running. Runners
connect outward to it and it never dials a runner, which is what lets a laptop behind NAT
be one.

`--port <n>` is the one flag, because running a second control plane on one machine is a
real thing to want; it wins over `OGUN_PORT`. Everything else is environment, because
these are properties of the machine rather than of one invocation, and a systemd unit
should not have to carry an argument list.

Unknown flags are refused rather than ignored. `ogun server --prot 8080` used to start on
7777 and say so in a line nobody reads twice.

| | |
|---|---|
| `OGUN_PORT` | listen port (7777) — `--port` wins over it |
| `OGUN_BIND` | interface (127.0.0.1) |
| `OGUN_ADMIN_TOKEN` | use this instead of the stored one |
| `OGUN_BEHIND_TLS_PROXY` | something in front of this process terminates TLS — see below |
| `OGUN_STALE_CLAIM_MS` | how long a claim may go unreported before it is swept (45 minutes) |
| `DATABASE_URL` | the database |

It binds to localhost, where nothing off this machine can reach it and no token is
needed. Set `OGUN_BIND=0.0.0.0` and it generates an admin token on first start and stores
it in `~/.ogun/config.json`. This API can define workers, so an open one on a shared
network is remote code execution on this machine — it refuses to start wide and
unauthenticated.

`OGUN_BEHIND_TLS_PROXY=1` says that something in front of this process terminates TLS. It
changes exactly one thing: whether the Settings page may accept a project's API key
(ADR-0012). Ogun serves plain HTTP and cannot see past its own socket, so on a wider bind
it assumes a key typed into a browser would cross the network in cleartext and refuses to
store one, pointing at `ogun secret set` instead. This variable is how an operator
who has put nginx or Caddy in front says otherwise. It is not read as a header —
`x-forwarded-proto` is written by whoever is talking to us, which on a plain-HTTP LAN is
the client, and a guard a request can switch off is not a guard.

### `ogun runner init`

```
ogun runner init [--name <name>] [--url <url>] [--labels a,b] [--force]
```

Makes this machine a runner for a control plane on this same machine — the one-box case.
The control plane has to be running already, because registering means claiming a name on
it. Across a network use [`ogun runner join`](#ogun-runner-join) instead, which carries an
invite token.

- `--name <name>` — the name to register under. Defaults to this machine's hostname,
  lowercased with the domain stripped. Names are unique: two machines answering to one
  would share a claim identity and make every run unattributable.
- `--url <url>` — the control plane to register with. Defaults to `OGUN_SERVER_URL`, then
  `http://localhost:7777`.
- `--labels a,b` — extra capability labels for things Ogun cannot detect by looking for a
  binary: `gpu`, `staging-db`. A worker asks for one with `requires:`, and the job then
  only goes to a machine advertising it. `claude`, `codex` and `docker` are detected.
- `--force` — take a *different* identity: another name, or another control plane.
  Refused without it, since that abandons the runner identity the control plane still has
  rows for.

Re-running it with the same name and url is a **refresh**, not an error: it re-detects
capabilities and updates the labels this machine advertises, and prints what it gained.

Touches: `~/.ogun/config.json` (the runner block), creates `~/.ogun/work/`, and a runner
row on the control plane.

### `ogun runner start`

The long-running process that claims jobs and executes them. Nothing runs without it —
triggering a worker only queues a job. No flags: everything it needs is in
`~/.ogun/config.json`, written by `runner init` or `runner join`.

A job is only offered to a runner advertising every label it requires, so a machine
without Docker leaves container jobs queued for a machine that can run them rather than
claiming and failing them. On Ctrl-C or SIGTERM it stops claiming and lets in-flight jobs
finish; the stale-claim sweep exists for crashes, not for a clean stop.

| | |
|---|---|
| `OGUN_SERVER_URL` | override the control plane recorded at join time |
| `OGUN_RUNNER_TOKEN` | override the stored runner token |
| `OGUN_CLAUDE_BIN` | path to the `claude` binary, if it is not on PATH |
| `OGUN_SANDBOX_MEMORY`, `OGUN_SANDBOX_CPUS` | container limits (`4g`, `2`) |
| `OGUN_KEEP_WORKSPACES` | `1` keeps the workspace clone after a run, for debugging |
| `OGUN_CLONE_DEPTH` | shallow clone depth for a workspace (50) |
| `OGUN_IMAGE_OVERRIDE`, `OGUN_BASE_IMAGE` | run jobs against a different image |

The runner token is read from `OGUN_RUNNER_TOKEN`, deliberately not the same name as
`OGUN_ADMIN_TOKEN`: one name meaning two different secrets is how a runner ends up
holding admin powers, with nothing failing to tell you.

### `ogun runner doctor`

What this machine can actually run: git, Docker, the two agent runtimes and their
credential directories, whether the control plane answers, whether this machine has
joined, whether `ogun/base` is built, and which registered checkouts are still there.

`gh` is checked too — present *and* logged in, which are different problems with different
fixes. It is a warning rather than a failure, because a machine that only runs reviewers
never needs it; but without it a modifier gets all the way to a proved patch and then
cannot open the pull request, which is the most expensive moment to find out.

The gateway's credentials are checked the same way, and **presence is not the question**:
an expired OAuth token is present, parses, and has a token in it. A credential is `ok`
only while it outlives the next hour — the longest job this machine is likely to be handed
plus the queue wait — so "expires in 42 minutes" is a warning, and expired is a warning
that says how long ago and what to type. Never fatal: a dead Anthropic token does not stop
this box running its codex workers. On a runner nobody logs into, the fix that lasts is an
API key, which does not expire (`docs/setup.md`).

Project secrets are reported by name — `ogun/linear — set` — and never by value. It says
what is stored, not what is missing: which projects need a key is declared in each
repository, and `doctor` reads none. A key stored but blank degrades the check, because a
poller reads that as one that exists and does not work.

Run it on the machine in question — the toolchain and the map of local checkouts are
per-machine, so this is the only honest place to ask. It exits non-zero when something
blocking is wrong, so it works as a check in a script.

Labels are detected at join time, so a runtime installed since then shows up here as
something this machine *could* advertise but does not; re-run `ogun runner init` to pick
it up. No `--force` — that flag is for changing identity, and this is the same machine
saying the same name.

### `ogun trigger <project> <worker>`

Queues a run now. It goes through the same cycle machinery a schedule does, so there is no
separate "run it now" code path to diverge. The run itself happens on whichever runner
claims the job.

Admission can still refuse a job, in which case it is reported here as `skipped` and
recorded in the coverage ledger rather than silently dropped — `ogun coverage` says why.
A lapsed credential is one of those refusals, and it comes back within the second with the
fix in it, rather than after a container has started and 401'd three minutes later.

---

## Projects

### `ogun project add [dir] [--name <slug>]`

Tells *this machine* where a repo is checked out. The map is machine-local: a filesystem
path is a fact about one machine, so it never travels the wire and never lands in the
database.

Optional. A runner with no local path clones from the project's remote instead, so a
machine that joined a minute ago can already work on anything. Registering a checkout
makes runs faster, works offline, and lets a co-located control plane edit that project's
`.ogun/config.yaml`.

The directory must be the repo itself — the one with `.git` in it. The slug comes from the
repo's `.ogun/config.yaml` where there is one, so this machine's map agrees with what the
control plane calls the project; two names for one project means the path silently never
matches.

- `--name <slug>` — register under this slug instead. Needed when the repo has no
  `.ogun/config.yaml` and its directory name is not what the project is called.

Touches: `~/.ogun/config.json` (the projects map).

### `ogun project sync [dir]`

Reads the repo's `.ogun/config.yaml` and its skills, and registers the resolved
configuration with the control plane. Run it on a machine with the repo checked out: the
CLI is the half with filesystem access to a project, and the server never touches one,
which is what keeps absolute paths out of the database.

It posts the project, its workers, its cycles, its **sources**, its policies, and every
skill it can discover, then prints the workers it registered. Workers that have gone from
`config.yaml` are removed; workers created in the UI are left alone, because sync is not
their source of truth. It also registers the local path, so there is no need to run
`project add` as well.

A `sources:` block is where a ticket becomes a job (§4.13, ADR-0013), and sync is where a
source that could never fire is refused rather than left to poll quietly forever: a
`cycle:` naming nothing, or naming a cycle with more than one entry node. Each source that
does register prints the cycle it feeds. It does **not** print whether this machine holds
the API key it will need — `ogun secret list` answers that, and a source with no
key polls, refuses, and records the command that fixes it.

A skill or worker only reaches an automated run once it is **on the default branch** — the
workspace is a clone at a pinned SHA, not your working copy. Sync says so when the tree is
dirty.

Touches: `~/.ogun/config.json` (the projects map), the database (project, workers,
skills).

### `ogun project list`

Every project the control plane knows about, with its default branch and remote. The
default when `ogun project` is given no subcommand.

### `ogun secret set | list | rm`

```
ogun secret set <name> [--project <slug>] [--allow-unregistered] < key.txt
ogun secret list [--project <slug>]
ogun secret rm <name> [--project <slug>]
```

An API key a project needs that this machine did not already have. Everything else Ogun
authenticates with is on the host because a human logged in with it; a Linear key is issued
per workspace, so it has to be entered once and kept.

It was `ogun project secret …` for two days. The slug was a positional, the `project`
namespace existed to hold it, and now that the project comes from the directory you are
standing in — the way `project add` and `project sync` have always resolved one — there is
nothing left for the namespace to carry. Machine-wide credentials are `ogun token`, so
`ogun secret` is unambiguous. The old spelling is gone rather than aliased, and answers
with a line naming the new one.

Run it on the **control-plane machine** — that is what polls an integration, so that is
where the key has to be. It stores into `~/.ogun/config.json` at mode 0600 and talks to no
server at all, which is why it works before `ogun init`, with the database down, and over
SSH into a box with no browser on it. Never in the repository, never in the database, and
never in a container (ADR-0012).

The Settings page can also set one, and it writes through this same code and the same
lockfile. It is allowed when the transport can carry a secret — a loopback bind, or a wider
one where the operator has declared a TLS terminator in front with `OGUN_BEHIND_TLS_PROXY`
— and refused otherwise, pointing back here. This command is the path that always works.

```
ogun secret set linear < key.txt
op read op://vault/linear/key | ogun secret set linear
ogun secret set linear                     # no pipe: prompts, with the echo off
ogun secret set linear --project heirchive-api < key.txt
```

**The value is never a command-line argument**, and passing one is refused rather than
accepted. Anything in argv is readable by every account on the box through `ps` while the
command runs, and your shell writes the whole line into its history file. So it comes from
stdin when stdin is a pipe and from a hidden prompt when it is a terminal; nothing chooses
between them, because the shape of stdin already has. The redirection is part of every
usage line this command prints, because `ogun secret set <name>` reads as complete and is
not — the value is the whole point of the command, and a script that runs it with no stdin
blocks with nothing on screen saying why.

**The project defaults to the one you are in.** In order: `--project`, then the `name:` in
this directory's `.ogun/config.yaml`, then the registered project whose root contains this
directory, then the directory's own name. `--project` is for a repo that is not checked out
on this machine at all.

**A slug this machine has never heard of is refused, and nothing is stored.** This is the
rule the closed set of secret names exists for, applied to the other half of a key's
address: a key filed under a project nothing polls reports as set and is read by nothing.
The evidence is local, so no server is needed — the projects map in `~/.ogun/config.json`
that `project add` and `project sync` write, or a `.ogun/config.yaml` in the current
directory naming itself. `--allow-unregistered` is the way through, for a control plane
that polls repositories it has no copy of; it warns, because the slug then has to match
what the control plane polls under and nothing local can check that.

Known names: `linear`. A name Ogun does not read is refused — a secret nothing reads looks
exactly like one that works, until the night it mattered. The rejected name is **not**
quoted back: with the value on stdin, the single positional this command takes is exactly
where a mistyped invocation puts the key.

Rotation is setting it again. There is no history and no second slot: the next poll reads
the new value with no restart, and two live keys would mean nobody could say which one a
401 came from.

**The confirmation says which of the two just happened.** `linear stored for ogun` and
`linear replaced for ogun` are different events, and for two days the line was identical
for both — the only mention of replacement was boilerplate that printed either way, so it
described what the command generally does rather than what it had just done. A replace also
says that the previous value is unrecoverable from this machine, because the recovery for a
key you have overwritten is Linear's, not ours. At a terminal it says a key is already there
*before* asking for the new one, where an operator can still stop; a pipe is never blocked,
because a piped key is usually a rotation somebody wrote down deliberately, and a `[y/N]`
gate would need a `--yes` that every script would set once and forever.

- `ogun secret list [--project <slug>]` — which projects have one, by name. Presence only.
  Nothing anywhere prints a stored value back — not this command, not `runner doctor`, not
  the UI, and no endpoint. It does **not** narrow to the current directory the way `set`
  does: this is the machine's inventory, asked from a home directory over SSH, and a
  listing that answered for wherever the shell happened to be would say "none" on a machine
  holding four. It cannot say what is *missing*, either: which projects need a key is
  declared in each repository, and this command reads no repositories.
- `ogun secret rm <name> [--project <slug>]` — forget one. Says whether there was anything
  to forget, because "removed" and "there was nothing here" are different answers — and the
  second is now the interesting one, since the project is inferred from the directory and a
  `rm` run one level too high finds nothing. It names the project it looked in and where
  that name came from, and still exits 0, because a removal that finds nothing has reached
  the state it was asked for. It
  checks neither the name nor the project, where `set` checks both: `list` prints whatever
  the file holds, that file gets hand-edited, and a row you can see has to be a row you can
  remove. Validation guards writes, where an unknown name or slug creates a key nothing
  reads.

Touches: `~/.ogun/config.json` (the secrets block, on this machine only).

### `ogun linear app | connect | status | disconnect`

```
ogun linear app        [--project <slug>]     asks for a Client ID and Client Secret
ogun linear connect    [--project <slug>]     prints a URL to approve
ogun linear status     [--project <slug>]
ogun linear disconnect [--project <slug>] [--forget-app]
```

Connect a project to Linear **as an application** rather than as you (ADR-0014). A personal
API key makes every request Ogun sends appear as the person whose key it is, on a board
other people read; an application acts as itself. This is the preferred path, and the
personal key stays supported for anyone who is not an admin of their workspace, because
`actor=app` is a workspace-level install Linear requires an admin to approve.

It was `ogun project linear …` for two days, which put four words in front of a verb: a
`project` namespace whose only cargo was the slug, `linear`, `app`, and then the slug again.
The project now comes from the directory you are standing in, so the outer level is gone.
`linear` stays, because it names *which* integration — a distinction that starts earning its
keep the moment a `github` source sits beside it. The old spelling answers with a line naming
the new one.

**The usage lines say what each command asks for**, because `ogun linear app` reads as a
complete command and is not: the two things it exists to collect are a Client ID and a Client
Secret, and neither appears in its name. Ogun ships no client id — it is self-hosted, so each
workspace registers its own application at
<https://linear.app/settings/api/applications/new>. `app` prints the exact redirect callback
URL to paste into that form before it asks for anything; a mismatch there is the classic
failure of this flow and the error Linear gives for it says nothing useful.

**Neither the client secret nor a URL containing an authorization code goes on the command
line.** argv is readable by `ps` while the command runs and lands in your shell history; both
are read from prompts with the echo off. The Client ID is prompted for *visibly*, which is
the honest split: it is in every authorization URL a browser visits and on Linear's own
settings page, and hiding it would mean you cannot check you pasted the right one.

**The project comes from the directory**, resolved exactly as `ogun project add` and
`ogun secret` resolve it, with `--project` to override. `app` and `connect` refuse a slug the
control plane does not know — before the first prompt, and listing the ones that would have
worked — because an application filed under a project nothing polls reports as configured and
is read by nothing. There is no `--allow-unregistered` here, unlike `ogun secret set`: these
commands cannot work without the control plane at all, so the database is available, and the
database is the thing that decides which slugs get polled. Each command checks against the
best oracle it already depends on.

`disconnect` refuses nothing, for the same reason `ogun secret rm` does: `status` prints
whatever the store holds, so a row you can see has to be a row you can remove. Its no-op
answer names the project it looked in and where that name came from, since a `disconnect` run
one directory too high is the way to reach it.

Run `app`, `connect` and `disconnect` on the **control-plane machine** — it is what polls and
what receives Linear's callback. `status` reads `~/.ogun/config.json` directly and answers
with the control plane down, which is when the question is usually asked; it lists the whole
machine and does not narrow to the current directory, for the same reason `ogun secret list`
does not.

Touches: `~/.ogun/config.json` (the oauth block, on this machine only).

---

## Skills

A skill is instructions — prose committed to git. A worker binds one to a runtime. Where
skills resolve from, and why they live in the repo being reviewed, is in
[`setup.md`](setup.md#skills-where-they-come-from).

### `ogun skill new <name> [--dir <repo>]`

Scaffolds `.agents/skills/<name>/` in the repo: `SKILL.md`, `agents/ogun.yaml`, and a
`references/` directory. The name must be lowercase kebab-case — it becomes a directory
and a config key.

The scaffold leaves the parts that need thought marked `TODO` rather than filling them
with plausible defaults you would forget to replace.

It also links the new directory into `.claude/skills/` and `.codex/skills/`. No single
directory is read by both runtimes, so the files live in one place and each runtime's
directory points at it — otherwise a skill you authored is invisible to one of the two
agents when you open the repo yourself.

- `--dir <repo>` — the repo to write into (default: the current directory).

Touches: the repo — `.agents/skills/<name>/`, plus a relative symlink in each runtime
directory.

### `ogun skill link [--dir <repo>]`

Does that linking for skills authored before `skill new` did it, or for a checkout on a
filesystem that dropped the symlinks. An automated run never needs this — the runner
copies the one skill a job needs into the workspace regardless — only opening the repo
yourself does.

Sources are `.agents/skills/` and, inside the Ogun repo, `skills/`. The first wins,
matching how the runner resolves a worker's skill.

### `ogun skills [--project <slug>]`

Every skill the control plane knows about, where it came from, and **which workers bind
it**. A skill is the durable artifact and a worker is a thin binding of one to a runtime,
so the useful column is who uses it: a skill nothing points at is dead weight, and that is
invisible if you list skills and workers separately.

### `ogun skills show <name> [--project <slug>]`

One skill in full — its source path, version hash, the workers that bind it, its default
prompt, its invocation policy, its references, and the `SKILL.md` body a worker will
actually run.

`--project` is optional while the control plane knows one project and required after that,
because a repo may override a builtin of the same name. `ogun skill show <name>` and a bare
`ogun skills <name>` are the same command.

---

## Workers and runs

### `ogun workers [project]`

Every worker: enabled or not, its project, the skill it binds, and the runtime,
permissions and sandbox it runs with. The optional argument filters to one project and is
positional, not a flag.

Workers are defined in the repo's `.ogun/config.yaml` or created in the UI — the UI's form
writes `config.yaml` and leaves the diff uncommitted for you to review. There is one
definition of a worker and it is in git.

### `ogun cycles [project]`

Every cycle: its graph, the schedule that drives it, when that next fires, and how the
last run ended. The optional argument filters to one project and is positional, not a
flag.

A cycle is a DAG of jobs and is the unit that schedules — the nightly fan-in of two
reviewers into triage is one row here and three jobs a night. Nothing else prints one:
`ogun workers` says "via nightly" against each member and stops there, so a cycle that is
correct in `config.yaml` and absent from the database looks exactly like a healthy one.
The columns are chosen against that.

```
   CYCLE    PROJECT  GRAPH                                         SCHEDULE   NEXT    LAST RUN
●  nightly  ogun     adversarial-review, security-review → triage  0 3 * * *  in 10h  complete 14h ago
```

Single-worker cycles are left out. Every worker has one carrying its own `schedule:`, so
listing them here would be `ogun workers` again under another name; the count that was
left out is printed under the table rather than silently dropped.

The timezone is shown beside the expression only when it is not this machine's. `0 3 * * *`
means three in the morning wherever the control plane resolved it, and those are the same
string on every machine.

### `ogun cycles show <name> [--project <slug>]`

One cycle in full: every node in execution order, what each waits for, and whether it
stages or writes to the finding inbox — plus the next three occurrences and the last run.

Staging is derived from the graph rather than declared on the worker (§4.12), so this is
the only place it is written down. A reviewer that feeds triage publishes nothing itself,
and nothing in `config.yaml` says so.

The next occurrences come from the control plane, computed by the same parser the foreman
uses. The question a cron expression raises is "will *this system* fire when I think",
which a second implementation cannot answer.

- `--project <slug>` — which project owns it. Only needed when two projects have a cycle
  of the same name.

### `ogun runs`

The last 30 runs: when, project, worker, outcome, duration, and the run id. No flags and
no filter — the web UI is where you drill into one.

### `ogun coverage <project>`

What ran for a project, what did not, and why. A worker that never ran and a worker that
ran and found nothing are different facts; the ledger records both, with the reason
admission refused a job.

### `ogun findings list [--project <slug>] [--status <a,b>]`

The finding inbox: severity, fingerprint, how many runs have seen it, and the title.

- `--project <slug>` — only this project.
- `--status <a,b>` — comma-separated statuses to include. Defaults to `open,triaged` —
  the inbox, rather than everything ever found.

### `ogun findings schema`

Prints the shape of a findings document and the definition of a fingerprint. A fingerprint
names the *meaning* of an issue rather than its location, so the same problem found next
week is recognised as the same finding and a rebase does not mint a new identity for an
unchanged one.

Mostly read by a skill that needs to remind itself, but it is the quickest way to see the
format from a terminal too.

---

## Used by skills, inside the sandbox

These three run inside a job's container, invoked by a skill — not usually by you. The CLI
owns every format an agent touches, so a skill never asks for well-formed JSON in prose:
an agent that free-hands its output produces a different shape every night and nothing
downstream can depend on it.

### `ogun findings write [--out <file>]`

Reads a findings document on stdin, validates it against the schema, checks every
fingerprint, and writes it to `.ogun-out/findings.json` (or `OGUN_OUTPUT_PATH`, or
`--out`). A document that does not validate is rejected with the expected shape printed
beside the errors.

Writing an empty `findings` array is meaningful and expected: a clean review and a review
that never happened are different facts.

### `ogun validate-findings [file]`

Schema- and fingerprint-checks a document already on disk, defaulting to the same path.
Exits non-zero on a document that does not hold, which is what makes it usable as a verify
lens.

### `ogun check-citations [file]`

Checks every citation against the tree that was reviewed, via `git ls-files` in the current
directory: the path must be tracked, and the cited line must exist in it. Cheap, and it
runs before any expensive verification step.

The line half matters as much as the path — a confabulated finding names a real file at an
invented location, and a path-only check waves that through. Exits non-zero when a citation
does not hold.

---

## More machines

One control plane, N runners. Runners always connect outward; the control plane never
dials a runner. Enrolling is therefore: mint a credential on the control plane, carry it to
the other machine. The network side of this — bridging, VPNs, and what to do when the
control plane's address is private to its host — is in
[`setup.md`](setup.md#connecting-a-second-machine).

### `ogun runner invite [--note <text>] [--url <url>]`

**On the control plane.** Mints a single-use join token and prints the exact
`ogun runner join` command to run on the machine being added.

It takes no machine name. The machine has not joined yet and it is the thing that knows its
own hostname; naming it here would be guessing, and would leave a row for a machine that
may never appear.

The token is shown once. Only its hash is stored, which is what makes storing it safe — a
lost token is re-issued rather than recovered.

- `--note <text>` — a note for your own benefit ("the mac", "the NAS"), shown against the
  outstanding invite in the UI. Never a machine name.
- `--url <url>` — the address to print in the join command. Defaults to the first address
  the control plane believes it is reachable at, which it cannot verify from here; pass
  this when it is reached through a VPN, a proxy, or a bridged interface.

Touches: the database (an invite row, holding only the hash).

### `ogun runner join`

```
ogun runner join <url> --token <token> [--name <name>] [--labels a,b] [--force]
```

**On the machine being added**, with the command `ogun runner invite` printed.

It checks the URL answers before registering anything: a wrong or unreachable address is
the most likely mistake in this flow, and it is otherwise silent until the first claim
never happens.

The token becomes this machine's permanent credential. It can claim work and report on it,
and nothing else — defining a worker is defining what executes on the host, so a
compromised runner must not be able to hand itself a new prompt.

`--name` and `--labels` mean what they do for
[`runner init`](#ogun-runner-init). The local config is merged rather than replaced, so
joining does not discard repository paths already registered here.

`--force` is required to join a *different* control plane, or to join under a different
name. Joining rewrites the runner block wholesale — name, url and token — so without the
guard it silently abandoned the identity this machine already answered to, along with the
run history filed under it. Re-joining the same control plane under the same name is a
refresh and needs nothing.

Touches: `~/.ogun/config.json` (the runner block, including the token), creates
`~/.ogun/work/`, and a runner row on the control plane.

### `ogun token show [--quiet]`

**On the control-plane machine.** Prints the admin secret.

There is deliberately no create step: `ogun server` generates one the first time it binds
beyond localhost and stores it, and the CLI on that machine reads the same file — so nobody
has to carry a secret between two commands. You need to *see* it only to unlock the web UI
from another device, or to run the CLI from one (`export OGUN_ADMIN_TOKEN=…`).

Runners do not need it and should not have it; they get their own credential from
`ogun runner invite`.

- `--quiet`, `-q` — print the bare token, for `export OGUN_ADMIN_TOKEN=$(ogun token show -q)`.

### `ogun token rotate`

Replaces the admin secret. Every browser session and every exported `OGUN_ADMIN_TOKEN`
stops working; runner tokens are separate credentials and are unaffected. Restart
`ogun server` for it to take effect — the running process holds the old one.

Touches: `~/.ogun/config.json`.
