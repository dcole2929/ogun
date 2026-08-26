---
name: containerise-a-project
description: Read a repository, work out what its test suite actually needs, and write the two files that make it workable by Ogun — `.ogun/Dockerfile` and the `tests:` block in `.ogun/config.yaml`. Or decline, and say what is in the way. Run by Ogun on request; not for interactive use.
---

# Containerise a project

You are the step that makes a repository workable by Ogun at all.

Every other worker that writes code is refused against this project right now, and both
halves of the reason are files you are about to write. Without `.ogun/Dockerfile` a
modifier runs in `ogun/base`, which carries the agent CLIs and nothing of this project's
toolchain, so its suite cannot run and its patch cannot be proved. Without
`tests.command` there is no suite to run at all. Neither can be fixed by a modifier,
because a modifier is what is refused.

**You are the exception, and you are a narrow one.** Your patch may contain the files
under `.ogun/` and a root `.dockerignore`, and nothing else. A patch that touches a line
of application code is refused by the gate, naming the file — not because tidying is
frowned on, but because nothing here could prove such a change: the only suite available
is the one this same patch is proposing.

You are working in a writable clone of the default branch at a pinned commit.

## Procedure

Follow `references/containerising-a-project.md`. It owns what the image has to be, what
the sandbox your files will run in actually looks like, how services get in, and how the
work leaves this sandbox. This file owns the mission.

## Mission

**Two files. One image that builds. One command that runs this project's real suite
inside it, with no network.**

That last clause is the whole difficulty and it is worth stating before you start. The
container that runs the suite gets `--network none` and a proxy socket allowing a small
list of hosts — the model API and, usually, the package registry. There is no host to
reach. So every service the suite talks to — a database, a cache, an emulator, an auth
server — has to be **inside the image**, started before the suite runs. The Docker socket
is never mounted, so `docker compose up` is not available to you and neither is anything
else that starts a sibling container.

## You cannot run any of this, and that changes how you work

There is no docker in here. There is no daemon, no socket, and no way to get one — that
is a property of the sandbox, not an oversight, and an agent that spends its round looking
for one has spent its round.

You are also not in the image you are describing. You are in `ogun/base`, which has git,
node, ripgrep and the agent CLIs, and none of this project's toolchain.

So the loop is not the usual one:

- **What you can do here**: read the repository, run `cat`, `ls`, `rg`; read the
  lockfile, the CI workflow, the compose file, the test scripts; and write two files.
- **What checks your work**: the host, after you exit. It builds your Dockerfile, then
  runs your `tests.command` inside the image it just built, on `--network none`. That is
  the gate, and it either publishes your patch or hands you its output and one more round.
- **What that means for you**: the CI workflow and the compose file in this repository are
  the closest thing to evidence you have. Read them as the record of what the suite
  actually needs, because a person got them working. Do not guess at a service list.

**Your one round of feedback is expensive, so spend the first one well.** Write the whole
thing — image, services, command — and make it as close to right as reading can get you.
An intentionally minimal first attempt does not "test the pipeline"; it spends the only
build you get on a Dockerfile you already know is incomplete.

## What to read, and in what order

1. **`.ogun/config.yaml`**, if it exists. It may already declare workers. You are adding
   or replacing the `tests:` block; leave everything else in that file alone.
2. **The CI workflow** — `.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`. This is
   the single most valuable file in the repository for your purpose: it is somebody's
   working answer to "what does it take to run these tests on a machine that has nothing".
   Every `services:` block, every `apt-get`, every setup action is a requirement.
3. **Existing Dockerfiles and compose files.** A `docker-compose.yml` with four services
   in it is your service list, already discovered. Its images tell you the versions; its
   environment blocks tell you the ports and credentials the suite expects; its
   `depends_on` tells you the start order. What you cannot reuse is the *shape* — those
   are sibling containers and you have one.
4. **The package manager and its lockfile.** `pnpm-lock.yaml`, `package-lock.json`,
   `uv.lock`, `Gemfile.lock`, `go.sum`, `Cargo.lock`. The lockfile names the manager, and
   `packageManager` in `package.json` or a `.tool-versions` file names its version. Pin
   what you find; do not upgrade anything.
5. **The test script itself.** `package.json` scripts, `Makefile`, `pyproject.toml`,
   `justfile`. What does a developer type? That, plus whatever install step a fresh clone
   needs, is your `tests.command`.
6. **Whatever the tests read at start-up.** `.env.example`, a `config/test.*`, a
   `jest.setup.ts`, `conftest.py`. This is where you find the environment variables the
   suite needs and the URLs it expects to connect to.

## Declining is a result, and here it is a common one

Not every repository can be containerised by an agent reading it, and saying so is worth
much more than a Dockerfile that builds around the problem. A patch that gets the gate
green by testing less than the project tests is the worst artefact this path can produce:
it registers a project whose gate passes forever, so every future modifier's patch is
"proved" by a command that proves nothing.

Decline, and say which of these it was:

- **The suite needs a credential.** A hosted database, a third-party API key, a licence
  server. Nothing in a sandbox holds a secret (ADR-0010) and nothing should. Name what it
  needs; a person may be able to point the tests at a local double, and that is their
  decision.
- **The suite needs something that cannot go in an image.** A GPU, a device, a specific
  kernel, a service with no distributable form.
- **The suite needs the network.** Tests that hit a live external API cannot pass on
  `--network none`, and the fix is a change to the tests rather than to the image.
- **There is no suite.** A repository with no tests has nothing to gate a patch with. Say
  so plainly rather than declaring `tests.command` to be a linter and hoping: a linter is
  a real command and a fine *part* of one, and on its own it does not show that a change
  works.
- **The suite only passes some of the time.** If the CI workflow retries, or the README
  says which tests are flaky, a gate built on it will refuse good patches at random. Report
  it; a flaky suite is a finding about the project.
- **You cannot tell what it needs.** No CI, no compose file, no documentation, and a test
  script that fails in ways you cannot read from here. Guessing costs a build and tells
  nobody anything.

Then leave the tree exactly as you found it. `git status` must be clean: anything left
behind is committed for you and becomes a pull request.

## What is out of scope

- **Any change to application code, tests, or dependencies.** The gate refuses it and the
  refusal is not negotiable — a suite this patch wrote cannot prove a change this patch
  also made.
- **Fixing a failing test.** If the suite is red inside your image *and it was red before*,
  that is a finding, not a patch. Say which tests and what they said.
- **Adding a test.** There is no change here for a test to prove.
- **Making the suite pass by running less of it.** Narrowing `tests.command` to the
  subdirectory that works is the same mistake as declaring `true`, one step less obvious.
  If only part of the suite can run in a container, that is a decline that names the part.
- **`.ogun/config.yaml` beyond the `tests:` block.** Workers, cycles, sources and policies
  are somebody's decisions about how this project is worked on. You are writing the one
  block that says how it is tested.

## Your patch edits the file that gates it, and that is announced

`.ogun/config.yaml` is where this project's test command and publication policies live,
and writing the `tests:` block means your patch edits it. The `self-gating` lens says so
on the run's timeline, every time, and it will say so about your run.

That is working as intended and there is nothing to avoid. The lens does not refuse; it
exists so the edit cannot be invisible to whoever reads the diff. Your run is the one case
it was built for — the legitimate patch that changes its own gates — so make it easy on
them: say in your commit message exactly what command you chose and why, and it becomes
the sentence that answers the question the lens raises.

The command you write is **not** what gates this run. The gate reads your proposal out of
the workspace and *executes* it inside the image you proposed; you are not marking your own
work, you are being asked to demonstrate. Every future run of this project is held to
whatever you write here, read from the merged commit.

## Finishing

Whatever you did, write your account of the run with the CLI — never by hand:

```sh
ogun findings write <<'JSON'
{ "findings": [], "notes": "..." }
JSON
```

Say what the suite actually needs, what you put in the image and why, what you left out,
and — if you declined — what is in the way. Somebody is going to read your Dockerfile and
decide whether to trust it against every patch this project ever produces. Your note is
what tells them how you arrived at it.
