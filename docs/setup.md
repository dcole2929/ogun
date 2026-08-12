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
ogun server         # control plane and UI on :7777
ogun runner init    # this machine becomes a runner for it
ogun runner start
```

### 0. Make the control plane reachable

Only needed when the runner is a *different* machine.

The control plane binds to `127.0.0.1` by default. Set `OGUN_BIND=0.0.0.0` and it
generates an admin token on first start and stores it — you never create or paste one.

**On WSL2 there is an extra step.** WSL2's address is private to Windows; nothing else on
your network can reach it. Pick one:

```powershell
# 1. Mirrored networking — Windows 11 22H2+, simplest. In %USERPROFILE%\.wslconfig:
#      [wsl2]
#      networkingMode=mirrored
#    then:  wsl --shutdown
```

```sh
# 2. A mesh VPN inside WSL2 — the right answer if a runner is ever off your LAN,
#    because a 100.x address works from any network.
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Option 3 is `netsh interface portproxy`, which works but breaks whenever the WSL address
changes on reboot.

### 1. On the CONTROL PLANE — start it

```sh
OGUN_BIND=0.0.0.0 ogun server
```

```
ogun-server listening on http://0.0.0.0:7777
  generated an admin token — stored in /home/doug/.ogun/local.json
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

Both halves read the same `~/.ogun/local.json` — a machine has one filesystem, so it has
one map of where things are on it.

### The two tokens

| | prefix | lives on | can |
|---|---|---|---|
| admin | `ogun_` | the control plane | everything, including define a worker |
| runner | `ogr_` | one runner machine | claim jobs and report on them, nothing else |

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
