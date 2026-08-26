# Containerising a project

The procedure for the run that writes a project's image. The mission — what to read, when
to decline — is in `SKILL.md`. This file owns the parts you cannot work out from the
repository you are looking at, because they are properties of the sandbox your files will
run in.

**Its own copy, not a pointer at `make-a-change/references/`.** A skill travels by having
its own directory copied into the workspace and nothing else, so a reference across skills
resolves in Ogun's own repository and dangles in every project that names the built-in
(ADR-0015) — silently, in the worst way: you would read "follow the procedure at …", find
nothing, and carry on without it. That decision cost `make-a-change` a merge and is not
being re-made here. What is *not* duplicated is the content: half of that procedure is
inverted for this worker. It says prove your change with the project's suite; you have no
suite yet and cannot run one. It says never touch the gates; writing one of them is your
job.

---

## 1. The image is `FROM ogun/base`, and that is not a convention

Start the Dockerfile with:

```dockerfile
FROM ogun/base:latest
```

The gate refuses an image that does not inherit it, before it runs your suite, because a
project image that misses this is broken in ways that arrive later and read as something
else. What the base carries, all of which you would otherwise have to reproduce:

- **The two agent CLIs**, `claude` and `codex`. A job in this image runs one of them.
- **The bundled `ogun` CLI** at `/opt/ogun/ogun.mjs`, on the path as `ogun`. Every skill
  shells out to it to write findings; without it, an agent in your image cannot report at
  all.
- **The entrypoint**, `/usr/local/bin/ogun-entrypoint`. It seeds the credential
  directories from a read-only mount, sets a git identity, and — this one matters —
  **removes the git remote** from `/workspace`. The never-pushes rule is structural rather
  than policed (ADR-0005): there is nothing to push with, because that line ran.
- **The egress forwarder** and the `OGUN_EGRESS_FORWARDER` marker. The container gets
  `--network none` and one bind-mounted unix socket; the forwarder bridges loopback to it.
  The runner *refuses to start a job* in an image without the marker, because the failure
  is otherwise a silent total airgap reported as an authentication error.
- **A non-root `dev` user at uid 1000**, which is why a bind-mounted workspace is writable
  without chowning the host's files.

Do not replace the entrypoint. If you need one of your own — you probably do, see §4 —
wrap it and `exec` the base one last.

## 2. What the container is actually like

Everything below is decided by the runner, not by your Dockerfile, and you cannot change
any of it from in here.

- **`--network none`.** No interface but `lo`. There is no host to reach, no other
  container to reach, and `localhost` means this container. A suite that connects to a
  database on port 5432 is connecting to *this container's* port 5432 or to nothing.
- **One unix socket out**, mounted in, with a proxy on the far side that allows CONNECT to
  an allowlist and nothing else. By default that is the model API plus the package
  registry for the runtime in use. Your suite gets it through `HTTPS_PROXY`, which the
  entrypoint sets, and most package managers honour. A project whose suite needs another
  host says so with `egress:` on the *worker*, which is a person's decision and not yours
  — mention it in your notes if you find one.
- **No `/var/run/docker.sock`, ever.** Anything holding it can start a privileged
  container mounting `/`, which would make the whole boundary decorative. So: no
  `docker compose up`, no testcontainers, no docker-in-docker.
- **The workspace is bind-mounted at `/workspace`**, read-write for a modifier, and it is
  the working directory. Files the suite writes there are on the host's disk and are
  visible to patch extraction — see §6.
- **A cache volume at `/home/dev/.cache`**, shared between runs on this machine. It is why
  a nightly does not re-download the world. Point your package manager's store inside it
  (`PNPM_HOME=/home/dev/.cache/pnpm`, `npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME`)
  and the first run pays for the download and no later one does.
- **`CI=1`** is set for the suite. Watch mode is the default for enough runners that a
  bare `pnpm test` would otherwise sit there until the job's budget ran out and be
  reported as a timeout.
- **Memory and CPU are capped** (4g / 2 cpus by default). A suite that assumes a build
  machine will be killed by the OOM killer, which reads as a crash.

**The build is the opposite.** `docker build` runs on the host's daemon with the host's
network. Everything your suite will need at run time has to be installed, downloaded and
baked **at build time**, because build time is the only time there is a network.

## 3. `USER` — end as `dev`, and know when to be root

The base leaves you as `dev`. To install packages you need root, so the shape is:

```dockerfile
FROM ogun/base:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends … \
    && rm -rf /var/lib/apt/lists/*
USER dev
```

**The last `USER` in your Dockerfile must be `dev`.** Not for tidiness: `/workspace` is a
bind mount of a directory on the host owned by uid 1000, and a suite running as root
writes root-owned files into it. The host then cannot clean them up, and patch extraction
— which starts with `git add -A` — trips over files it cannot read. The failure surfaces
long after the run, on the host, as a permissions error nobody can connect to a
Dockerfile.

Anything you create for the suite to write into (a data directory, a socket directory, a
prefix) must be `chown dev:dev` while you are still root.

## 4. A service the suite needs goes *inside* the image

This is the part that is genuinely different from every Dockerfile you have written, and
it follows from §2: there is no second container, so a suite that needs postgres gets a
postgres in this one.

Two pieces:

**Install and prepare it at build time**, as root, and do not initialise data directories
you can create later — an initialised cluster baked into an image is a fixed
`postgresql.conf` somebody has to remember exists.

**Start it in an entrypoint that wraps the base one.** Lazily starting it from
`tests.command` is worse than it looks: every invocation of the suite pays for it, and a
developer running one test file wonders why it hung.

Ogun's own image is the simple case — one service — and is worth reading in full at
`.ogun/Dockerfile` in this repository if you are in it. The shape:

```dockerfile
FROM ogun/base:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10 && npm cache clean --force
COPY .ogun/project-entrypoint.sh /usr/local/bin/ogun-project-entrypoint
RUN chmod +x /usr/local/bin/ogun-project-entrypoint \
    && mkdir -p /var/run/postgresql && chown dev:dev /var/run/postgresql \
    && mkdir -p /var/lib/postgresql/data && chown dev:dev /var/lib/postgresql/data
USER dev
ENV DATABASE_URL=postgres://ogun:ogun@localhost:5433/ogun \
    PGDATA=/var/lib/postgresql/data \
    PNPM_HOME=/home/dev/.cache/pnpm
ENTRYPOINT ["/usr/local/bin/ogun-project-entrypoint"]
```

and the entrypoint:

```sh
#!/bin/sh
set -eu
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | head -1)"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  # `trust` because this cluster is reachable only from inside this container: it
  # listens on localhost and the sandbox has no inbound network. A password here
  # would be a secret in an image, which is worse.
  "$PG_BIN/initdb" -D "$PGDATA" -U ogun --auth=trust >/dev/null 2>&1
fi
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p 5433 -k /var/run/postgresql" -w -t 30 \
  -l /tmp/pg.log start >/dev/null 2>&1 || {
  echo "postgres failed to start" >&2; tail -20 /tmp/pg.log >&2 || true; exit 1
}
"$PG_BIN/createdb" -p 5433 -U ogun ogun >/dev/null 2>&1 || true
exec /usr/local/bin/ogun-entrypoint "$@"
```

Four things in there are the general rules rather than postgres trivia:

1. **`exec` the base entrypoint last.** Wrapping, never replacing. Replace it and you have
   silently dropped the credential seeding, the git identity, the remote removal and the
   egress forwarder.
2. **Wait for readiness, do not sleep.** `pg_ctl -w`, a health loop, a socket poll —
   anything that blocks until the service answers. A `sleep 5` is a race that passes on
   your machine and fails on a loaded runner, and the symptom is a connection refused in
   one test.
3. **Start it idempotently.** The entrypoint runs on every `docker run`, and the gate runs
   at least two containers from your image.
4. **No secrets.** `trust` auth on a loopback-only service in an airgapped container is
   correct; a password in a `Dockerfile` is a secret in an image somebody will later push.

### Several services in one container

A suite that needs a database, an auth server, a storage API and a gateway — the shape a
Supabase or a LocalStack stack takes — is the same pattern with a longer entrypoint and
one extra concern: **something has to keep them all up, in order, and fail loudly if one
of them dies.**

- Start them in dependency order, waiting for each. The compose file in the repository
  already encodes that order in its `depends_on`; read it as the answer rather than
  deriving one.
- Take the versions from the compose file too, and pin them. `postgres:15.1` in compose
  means the suite has never run against 16.
- Take the ports and credentials from the compose file's `environment` blocks. The suite
  is configured to expect exactly those, and changing them means changing the suite, which
  you may not do.
- Prefer starting each service directly over installing a process supervisor: an
  entrypoint that starts four daemons, waits for four ports, and then `exec`s is about
  thirty lines and needs nothing installed. If you do reach for `supervisord`, its config
  is another file under `.ogun/`, which is allowed.
- **A service whose only distributable form is a container image cannot go in.** If the
  stack's components are only published as images and cannot be installed into one, that
  is a decline that names them — not a reason to reach for the docker socket, which is not
  there.

## 5. `tests.command`

Add or replace exactly this block in `.ogun/config.yaml`, leaving the rest of the file
alone:

```yaml
tests:
  command: pnpm install --frozen-lockfile && pnpm -s test
```

It is run by a shell, in `/workspace`, inside your image, so `&&` and pipes are fine.

- **Install first.** The workspace is a fresh clone with no `node_modules`. With the store
  in the cache volume, only the first run pays for it.
- **Frozen, not resolving.** `--frozen-lockfile`, `npm ci`, `--locked`. A command that may
  resolve new versions is a suite that can go red because somebody else published.
- **Run the whole suite the project runs.** If the project's own CI runs a linter and a
  type check too, `&&` them on: a repository that lints in CI is a repository whose
  patches should lint. If it does not, do not add one.
- **It must exit non-zero when the suite fails**, which is the only thing the gate reads.
  Check that the runner you are invoking does not swallow failures behind a reporter.
- **It must be the real suite.** A command that cannot fail is refused by name, and one
  that runs a tenth of the tests is worse because nothing catches it. This command gates
  every patch this project ever produces.

## 6. What the gate does after you exit, and how to help it

The host builds `.ogun/Dockerfile` with the **repository root as the build context** — so
`COPY .ogun/project-entrypoint.sh …` is right and `COPY project-entrypoint.sh …` is not,
even though the Dockerfile sits in `.ogun/`. Then it runs your `tests.command` inside the
image it just built, on `--network none`, and only if that passes does your patch become a
draft pull request.

Both halves come out of the job's one timeout — there is no separate budget for the build
— which has two consequences you can act on:

- **Order the layers so a retry is cheap.** Put the slow, stable steps first (`apt-get`,
  a toolchain install) and the things you are most likely to have got wrong last. If you
  are given a second round, docker reuses every layer above the first line you changed,
  and the difference is a rebuild in seconds rather than in minutes.
- **Keep the build context small.** If the repository has no `.dockerignore` and does have
  a `node_modules` or a `target/` or a `.venv`, the whole thing is sent to the daemon
  before the first instruction runs. You are allowed to add a root `.dockerignore` for
  exactly this reason. Keep it to build artefacts and dependency directories; it is a file
  every other build in the repository also reads.

**A note on test databases.** Ogun's own suite creates a per-run database from the one the
entrypoint made. If this project's suite does something similar, the entrypoint only has to
provide the server and a role to connect as; if it expects a specific database to exist,
create it in the entrypoint.

## 7. How your work leaves this sandbox

There is no git remote and no credential here, by design (ADR-0005). What you produce is
commits; the runner turns them into a patch after you exit and the host opens a draft pull
request. Three rules, each of which has cost a whole round somewhere:

- **Never rewrite history.** No `commit --amend`, `reset --hard`, `rebase`, or checking
  out another ref. Extraction refuses a `HEAD` that is not a descendant of the pinned base,
  and everything you did is deleted with the workspace seconds later. Commit forward; a
  mistake gets a second commit.
- **Never try to push.** There is no remote and no route to one.
- **Anything uncommitted is committed for you**, under a message saying nobody wrote one.
  That is a net for work that would otherwise vanish, not a workflow.

Before you finish, run `git status --porcelain` and account for every line. Reading a
repository leaves nothing behind, so there should be two or three, and the gate refuses
anything outside `.ogun/` and `.dockerignore`.

## 8. The commit message

Exactly one commit lends its subject to the pull request title, so prefer one commit. The
full body is reproduced verbatim in the pull request and is the review brief. Somebody is
deciding whether to trust this image against every future patch, so tell them:

- **what the suite actually needs**, and how you know — name the CI workflow or compose
  file you read it from;
- **what you put in the image and why that version**;
- **what you left out and why**, especially anything you decided the suite does not really
  need;
- **the command you chose**, and what it runs;
- **what you could not check**, which is most of it: you cannot build this image or run
  this suite from in here, and saying so is honest rather than weak.

**Never write a closing keyword** — not `Closes #14`, `Fixes #14`, `Resolved #14` or any
of those followed by an issue URL, in any case, on any line. GitHub acts on them when the
branch merges and nothing downstream can strip one without rewriting the artefact a person
is reviewing. The gate refuses the patch before it builds anything, and there is no second
attempt, because the only repair is rewriting history. Refer to issues in prose instead —
"the bug reported in #14" links and does not close.

No `@mentions`, and no `Co-authored-by:` trailer naming a person.

## 9. Say what happened

Through the CLI, never by hand:

```sh
ogun findings schema     # print the shape
ogun findings write <<'JSON'
{ "findings": [], "notes": "..." }
JSON
```

A run that declined and explained why is a good result and a common one here. A run that
produced an image should still write the note: what is in it, what you could not verify,
and what the next person should check first.

**Something you noticed and did not fix is a finding, not an edit.** You will read a lot of
this repository and you may well notice real problems in it — a flaky test, a suite that
depends on a service nobody documents, a lockfile that does not match the manifest. Write
them up with a fingerprint and citations exactly as a reviewer would; that is the entire
alternative to fixing them, because the gate refuses a patch that touches anything outside
`.ogun/`.
