# Setting up Ogun

Two topics people get wrong, because both involve two machines and it is never obvious
which command runs where. Every command below says.

---

## Skills: where they come from

A skill is instructions — prose committed to git. A worker binds one to a runtime.
Skills resolve from three places, **later wins**:

| | where | travels with | use for |
|---|---|---|---|
| `builtin` | Ogun's `skills/` | the Ogun install | universal disciplines |
| `machine` | `~/.ogun/skills/` | nothing — this box only | experiments |
| `project` | the repo's `.agents/skills/`, `.claude/skills/`, `.codex/skills/` | the repo | most skills |

**Most skills belong in the repo being reviewed.** What "security review" means in a
payments service is not what it means in a static site, and that difference is a property
of the codebase. Put it in the repo and it travels with the code, gets reviewed in a PR,
and applies to every machine that runs against it.

**A repo skill overrides a builtin of the same name.** That is the specialisation path:
start with Ogun's `adversarial-review`, and when a project needs its own take, run
`ogun skill new adversarial-review` inside that repo. Nothing to unregister.

### You keep one copy

Copies happen at run time, into the throwaway workspace clone — never into your repo:

```
your repo:   .agents/skills/nightly-review/        the one you edit
                    │
                    │  the runner clones the repo, then copies the ONE skill this job needs
                    ▼
clone (temp):  .claude/skills/nightly-review/      if the worker's runtime is claude
               .codex/skills/nightly-review/       if it is codex
               (git-excluded, and deleted with the workspace)
```

Ogun's own `.agents/skills/` is **not** the library — that is Ogun reviewing itself,
exactly the relationship any project has to its own skills. What Ogun *ships* lives in
`skills/`.

Why per runtime: measured with the agents' own search tools disabled, so only native
discovery could answer —

| | `claude` | `codex` |
|---|---|---|
| `.claude/skills/` | yes | no |
| `.codex/skills/` | no | yes |
| `.agents/skills/` | no | yes |

There is no location both find, so the destination depends on which runtime is about to
run. `.agents/skills/` is where `ogun skill new` writes; the other two are read as well,
so a repo that already has skills does not have to move them.

### Adding a skill to a project

```sh
cd ~/dev/your-project
ogun skill new staging-error-review    # scaffolds .agents/skills/staging-error-review/
$EDITOR .agents/skills/staging-error-review/SKILL.md
ogun project sync                      # index it
```

Then give a worker that skill, and a schedule, from the Workers page — or in
`.ogun/config.yaml` directly:

```yaml
workers:
  staging-errors:
    skill: staging-error-review
    runtime: claude
    schedule: "0 3 * * *"    # every day at 3am, in the control plane's timezone
    onMissed: skip           # asleep at 3am? wait for tomorrow rather than run at 11
```

Then point a worker at it, in the UI or in `.ogun/config.yaml`. Note that a skill only
reaches an automated run **once it is on the default branch** — the workspace is a clone
at a pinned SHA, not your working copy.

---

## Connecting a second machine

One control plane, N runners. **Runners always connect outward; the control plane never
dials a runner.** That is what lets a laptop be one: a machine that sleeps, changes
networks, and sits behind NAT can still ask for work when it is awake, with no inbound
port and no fixed address.

So enrolling is: mint a credential on the control plane, carry it to the other machine.

### One machine

Nothing to configure. The control plane binds to localhost, where nothing off this
machine can reach it, so there is no token to manage.

```sh
ogun init           # database, schema, sandbox image
ogun server         # control plane and UI on :7777
ogun runner init    # this machine becomes a runner for it
ogun runner start
```

### 0. Make the control plane reachable

Only needed when the runner is a *different* machine.

The control plane binds to `127.0.0.1` by default. Set `OGUN_BIND=0.0.0.0` and it
generates an admin token on first start and stores it — you never create or paste one.

Ogun detects the addresses it believes it is reachable at and offers them when you enrol
a runner. If one of them works from the other machine, there is nothing else to do.

**If the control plane runs inside a VM or a container-based Linux environment**, its
address may be private to the host — reachable from the host itself and from nowhere
else. Ogun detects the common case of this and says so before you enrol, rather than
handing you an address that cannot work. Two general answers:

- **Bridge the network** so the environment shares the host's LAN address. On WSL2 that
  is `networkingMode=mirrored` in `.wslconfig`; on other hypervisors it is usually a
  "bridged" rather than "NAT" adapter.
- **A mesh VPN** such as Tailscale, installed where the control plane runs. It gives a
  stable address that works from any network, not just this one — the right answer if a
  runner is ever somewhere else entirely.

Port forwarding also works and tends to break whenever the private address changes.

### 1. On the CONTROL PLANE — start it

```sh
OGUN_BIND=0.0.0.0 ogun server
```

```
ogun-server listening on http://0.0.0.0:7777
  generated an admin token — stored in /home/doug/.ogun/config.json
  reachable from the network; the UI will ask for the token once
```

The admin token can define workers, which is to say define what runs on this machine. It
stays here. The CLI on this machine reads the same file, so you never export it — you only
need to *see* it (`ogun token show`) to unlock the web UI from another device.

### 2. On the CONTROL PLANE — mint a join token

```sh
ogun runner invite
```

**No machine name.** The machine has not joined yet, and it is the thing that knows its
own hostname. It prints:

```
  ogun runner join http://192.168.1.20:7777 --token ogr_d1c0e964…

  It names itself from its hostname. Add --name <label> to choose.
```

Single use, shown once. Only its hash is stored, which is what makes storing it safe.

### 3. On the NEW MACHINE — join and start

```sh
ogun runner join http://192.168.1.20:7777 --token ogr_d1c0e964…
ogun runner start
```

That token is now this machine's permanent credential. It can claim work and report on
it, and nothing else. No environment variable — `join` stored it.

### Telling a runner where a repo is

Optional. A runner with no local path clones from the project's remote, so a machine that
joined a minute ago can already work on anything.

Registering a checkout makes it faster, works offline, and lets a co-located control plane
edit that project's `config.yaml`:

```sh
cd ~/dev/heirchive-api
ogun project add .
```

Both halves read the same `~/.ogun/config.json` — a machine has one filesystem, so it has
one map of where things are on it.

```sh
ogun project add ~/dev/heirchive-api           # slug comes from its .ogun/config.yaml
ogun project add ~/dev/api --name heirchive-api  # or name it explicitly
```

### What labels are for

A worker's requirements come from its config — a `codex` runtime requires `codex`, a
`container` sandbox requires `docker`. A runner advertises what it has. **A job is only
offered to a runner advertising every label it needs**, which is how a Mac without Docker
leaves a container job queued for a machine that can actually run it, rather than
claiming it and failing.

They are detected by looking for the binaries. Add your own for anything Ogun cannot see,
and match it from a worker's `requires:`:

```sh
ogun runner init --labels gpu,staging-db
```

A worker's `requires:` is **added to** what its shape already implies — `requires: [gpu]`
on a container worker still needs `docker`. Nothing waives a derived label, because
writing "this also needs a GPU" is not saying "and it no longer needs Docker".

Asking for a label nothing advertises is not an error, because the machine that has it
may be joining this afternoon — but it is never silent. `ogun project sync` names the
worker and the label it cannot satisfy, and the Runs page separates a job whose capable
machine is *offline* from one nothing here has ever advertised. A job queued forever with
no explanation is the one outcome that is not allowed.

### Keeping an unattended runner logged in

A container never holds a credential. The runner's in-process gateway reads
`~/.claude/.credentials.json` and `~/.codex/auth.json` on the host and splices the real
value into each request on the wire (ADR-0010). What it does **not** do is refresh
anything — it re-reads the file that the host's own `claude` rewrites *when a human runs
it*.

On a workstation that is invisible: you use `claude` most days, so the token is always
fresh. On a runner you do not personally log into, nothing refreshes it, the OAuth access
token lapses, and every 3am job fails on auth until somebody notices.

**Use an API key on a machine nobody logs into. An API key does not expire.**

```sh
# Visible to BOTH the control plane and the runner — see the warning below.
ANTHROPIC_API_KEY=sk-ant-api03-…
OPENAI_API_KEY=sk-…
```

The gateway prefers an explicit key over the subscription token, so setting one takes
effect immediately and needs nothing else configured. It also points runs at a different
account than the host's `claude` is logged into, which is the other reason to set one.
The trade is that an API key is billed per token where a subscription is not — on a
workstation you use daily, leaving the OAuth token in place is still the cheaper answer.

**Export it where both halves can see it.** Ogun checks the credential *before* a job
starts, and the check runs on the control plane. A key exported into the runner's service
unit but not the server's means the control plane sees only a stale OAuth token and
refuses jobs the runner could have run perfectly well. The repo-root `.env` is read by
both; a systemd drop-in should cover both units.

**Checking it, ahead of the night rather than after it:**

```
$ ogun runner doctor
  warn  gateway anthropic     oauth, only 42m left — a job starting now would 401
                              partway. run `claude` on this host, or set
                              ANTHROPIC_API_KEY for an unattended runner
```

`ok` means the credential outlives the longest job this machine is likely to be handed.
`warn` means it does not, and the line says which fix applies. If a job is dispatched
anyway it is refused rather than run, and the run's coverage row carries the same
sentence — so a night lost to a lapsed token says so in words instead of leaving a
provider 401 buried in an agent transcript.

### Names are unique

Two machines answering to one name would share a claim identity and a run history, and
neither would be attributable. Registering refuses a name a live runner already holds:

```
a runner called "desktop" is already registered and was last seen 3 minutes ago.
Choose another name with --name, or revoke that one from the Runners page if it is
the same machine being re-registered.
```

Revoking frees the name.

### The two tokens

They are different credentials with different powers, and they never mix.

| | admin | runner |
|---|---|---|
| looks like | `ogun_…` | `ogr_…` |
| comes from | generated by `ogun server`, shown by `ogun token show` | `ogun runner invite` |
| lives on | the control-plane machine | one runner machine |
| there are | one | one per machine |
| can | everything, including define a worker | claim jobs and report on them |
| env var | `OGUN_ADMIN_TOKEN` | `OGUN_RUNNER_TOKEN` |

**Neither environment variable is normally needed.** Both are read from
`~/.ogun/config.json` on the machine that owns them. Set one only to run the CLI against a
control plane on another machine, or to keep a secret in a systemd unit instead of a file.

They deliberately do not share a name. An admin token satisfies a runner-scoped route, so
a single `OGUN_TOKEN` exported in a shell would hand the runner admin powers and quietly
undo the split below — with nothing failing to tell you.

A runner token cannot define a worker on purpose: defining a worker is defining what
executes on the host, so a compromised runner must not be able to hand itself a new
prompt. Revoke one machine from the Runners page without touching the others.

---

## What "claim" means

Triggering a worker does not send work anywhere. It puts a row in the queue:

```
ogun trigger my-project nightly-review
   → job: queued, claimed_by: null, requires: {claude, docker}

runner polls          → takes it     claimed_by: macbook
another runner polls  → gets nothing (already taken)
a runner without docker → gets nothing (requires docker)
```

The take is atomic (`FOR UPDATE SKIP LOCKED`), so two runners polling the same instant
get disjoint sets — no coordinator, no leases. It is also why the control plane never
pushes: work waits in the queue until a machine that *can* do it asks, so a sleeping
laptop costs nothing and a job is never dispatched into the void.

A job only goes to a runner advertising every label it requires. Those come from the
worker: a `container` sandbox requires `docker`, a `codex` runtime requires `codex`.
