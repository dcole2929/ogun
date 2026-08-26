# Containerising a project

The procedure for the run that writes a project's image. The mission — what to read, when
to decline — is in `SKILL.md`. This file owns the parts you cannot work out from the
repository you are looking at, because they are properties of the sandbox your files will
run in.

**Its own copy, not a pointer at another skill's reference directory.** A skill travels by having
its own directory copied into the workspace and nothing else, so a reference across skills
resolves in Ogun's own repository and dangles in every project that names the built-in
(ADR-0015) — silently, in the worst way: you would read "follow the procedure at …", find
nothing, and carry on without it. That decision cost `make-a-change` a merge and is not
being re-made here. What is *not* duplicated is the content: half of that procedure is
inverted for this worker. It says prove your change with the project's suite; you have no
suite yet and cannot run one. It says never touch the gates; writing one of them is your
job.

**Everything quoted below is quoted in full for the same reason.** The two worked examples
are Ogun's own single-service image and a real Supabase-shaped one — 58 suites, 500 tests,
one `--network none` container, 27 seconds — and neither of those repositories is on the
disk you are working on. The excerpts are the example. There is no file to go and open.

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

You may still take *parts* of other images, and for a multi-service stack you will: a
multi-stage `COPY --from=` out of a pinned upstream image is how a service that only ships
as an image gets into yours. §4.3 is about how far that goes.

## 2. What the container is actually like

Everything below is decided by the runner, not by your Dockerfile, and you cannot change
any of it from in here.

- **`--network none`.** No interface but `lo`. There is no host to reach, no other
  container to reach, and `localhost` means this container. A suite that connects to a
  database on port 5432 is connecting to *this container's* port 5432 or to nothing.
  There is no DNS either, so every service-to-service URL you write is a literal
  `127.0.0.1:<port>` and never a compose file's `db`, `rest` or `auth`.
- **One unix socket out**, mounted in, with a proxy on the far side that allows CONNECT to
  an allowlist and nothing else. By default that is the model API plus the package
  registry for the runtime in use. Your suite gets it through `HTTPS_PROXY`, which the
  entrypoint sets, and most package managers honour. A project whose suite needs another
  host says so with `egress:` on the *worker*, which is a person's decision and not yours
  — mention it in your notes if you find one.
- **No `/var/run/docker.sock`, ever.** Anything holding it can start a privileged
  container mounting `/`, which would make the whole boundary decorative. So: no
  `docker compose up`, no testcontainers, no docker-in-docker.
- **`CI=1`** is set for the suite. Watch mode is the default for enough runners that a
  bare `pnpm test` would otherwise sit there until the job's budget ran out and be
  reported as a timeout.
- **Memory and CPU are capped** (4g / 2 cpus by default). A suite that assumes a build
  machine will be killed by the OOM killer, which reads as a crash. It also means every
  service you start shares two cores with the test runner — see §4.6, rule 6.

### 2.1 The workspace is a bind mount, and that is a different filesystem

`/workspace` is a directory on the host, bind-mounted in, and it is the working directory.
It is not part of your image and it is **not on the same filesystem as anything in your
image**. `/home/dev/.cache` is a *named volume*, mounted the same way, and is a third
filesystem again. Inside the container:

```
$ df -P /workspace / /home/dev/.cache
Filesystem  … Mounted on
/dev/sdd    … /workspace          ← the host's disk
overlay     … /                   ← your image
/dev/sde    … /home/dev/.cache    ← a named volume shared between runs
```

This is the single most expensive thing on this page, because nothing about it announces
itself. Three consequences, and every one of them has cost a build:

1. **A hardlink between the workspace and your image fails.** `EXDEV`, cross-device link.
   Tools that hardlink to save space — a package store into `node_modules` is the common
   case — either warn and copy, or, worse, quietly move to somewhere the link *does* work.
   §6 is the whole of what that costs.
2. **A named volume hides whatever your image baked underneath it.** Docker seeds a volume
   from the image's contents only when the volume is *empty*. `/home/dev/.cache` on a
   runner that has ever run another job is not empty, so a store you baked at that path is
   invisible on precisely the machines that matter — and visible on a fresh laptop, which
   is how it passes review. Bake caches somewhere the runner does not mount over:
   `/opt/<something>` is safe, `/home/dev/.cache` is not.
3. **Files your suite writes to `/workspace` are on the host's disk** and are visible to
   patch extraction. That is what §3 is about, and why the last `USER` matters.

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
prefix, a package store) must be `chown dev:dev` while you are still root. This bites
hardest with services packaged for a machine where they run as their own system user:
nginx's Debian package puts its temp paths under `/var/lib/nginx`, which is root-owned, so
a config running as uid 1000 has to point every `*_temp_path` somewhere writable.

## 4. A service the suite needs goes *inside* the image

This is the part that is genuinely different from every Dockerfile you have written, and
it follows from §2: there is no second container, so a suite that needs postgres gets a
postgres in this one.

Two pieces:

**Install and prepare it at build time**, as root, because build time is the only time
there is a network. `docker build` runs on the host's daemon with the host's network;
everything your suite needs at run time has to be installed, downloaded and baked before
the first `docker run`.

**Start it in an entrypoint that wraps the base one.** Lazily starting it from
`tests.command` is worse than it looks: every invocation of the suite pays for it, and a
developer running one test file wonders why it hung.

### 4.1 One service: the whole shape in twenty lines

Ogun's own image, which is the simple case and the one to copy when a suite needs a
database and nothing else:

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
    PGDATA=/var/lib/postgresql/data
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
  echo "postgres failed to start" >&2; tail -20 /tmp/pg.log >&2; exit 1
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

### 4.2 Several services: the service list is what the suite calls

A suite that needs a database, an auth server, a storage API and a gateway — the shape a
Supabase or a LocalStack stack takes — is the same pattern with a longer entrypoint. The
worked example below is a real one: a `docker-compose.supabase.yml` with thirteen services
became **four services and a router**, and the resulting image runs 58 suites and 500 tests
in 27 seconds under `--network none`, with nothing on the host.

**The compose file is evidence, not a specification.** It is the best evidence you have of
versions, ports and credentials, and it is a bad answer to "which services do I need",
because it was written to serve a developer with a dashboard and a log pipeline as well as
a test run. Derive the list from what the suite actually calls:

> What the suite actually needs, established by reading it rather than by copying the
> compose file: 34 calls across exactly three prefixes on one origin — `/auth/v1/*` (16,
> gotrue), `/rest/v1/*` (14, postgrest), `/storage/v1/*` (4, storage-api) — plus the
> database under them. So four services and a router.

Nine services were dropped, and the useful part is that each one has a reason a reader can
check:

> * studio/meta are a dashboard. Nothing calls `/pg/` or the Studio catch-all.
> * analytics/vector are log shipping. Dropping them also drops the `_supabase` database
>   and the `_analytics` schema that only exist to serve them.
> * realtime is a websocket the suite never opens.
> * inbucket is a mail sink, and `GOTRUE_MAILER_AUTOCONFIRM=true` means no mail is sent.
> * edge crash-loops in the compose file as committed. Nothing in the suite calls
>   `/functions/v1`, so it goes.
> * supabase-migrate is a one-shot psql runner; its work moves to the entrypoint.

Note the shape of each: *this is what it does, and here is the thing in the suite that
would notice if it were gone.* A dropped service you cannot write that sentence about is
one you have not finished checking. This is also the line between "the suite needs less
than the compose file", which is usually true and worth acting on, and "the suite tests
less than it did", which is the decline in `SKILL.md`.

**A component can be replaced by a smaller one, if you check what the suite asserts about
it first.** Kong was the compose file's gateway; nginx replaced it:

> Kong is in the compose file because upstream Supabase ships it, and upstream needs it:
> key-auth consumers, ACL groups, opaque-key-to-asymmetric-JWT translation in Lua,
> basic-auth on the Studio catch-all, a websocket route for realtime. Every one of those
> is about a gateway facing a network. This container has no network. Reading what the
> suite actually sends — 34 calls across three prefixes, every one already carrying
> `Authorization: Bearer <jwt>` — what is left of Kong's job here is: strip a two-segment
> prefix, pick one of three upstreams. So: nginx, ~5 MB from apt, four location blocks,
> versus 139 MB of OpenResty plus a generated declarative config. Dropping it also drops
> the one thing Kong would add that this stack does not want — key-auth returning 401
> before a request reaches gotrue. **Checked before dropping it: no test in the suite
> asserts a gateway 401.** Every 401 the suite expects comes from gotrue rejecting a token
> or from RLS returning nothing.

The check in bold is the whole of the difference between a substitution and a hole in the
suite. Grep the tests for the status codes, headers and error bodies the thing you are
removing produces, *before* you remove it, and say in your commit message that you did.

**A route the stack deliberately does not carry should say so**, rather than 404 as if the
path were wrong:

```nginx
location / {
  default_type application/json;
  return 501 '{"message":"not served by the in-container stack: only /auth/v1, /rest/v1 and /storage/v1 exist here"}';
}
```

A 404 from a router is indistinguishable from a typo in a test's URL. A 501 naming what
exists turns a future test against a dropped service into one line of output that explains
itself — which matters, because the person reading it is a modifier six months from now
who has never seen your Dockerfile.

### 4.3 A service that is not a static binary

Some of what you need lifts out of an image as one file. Some does not, and this is where
a build goes wrong quietly. Three cases, in increasing order of cost:

- **A statically linked binary.** `COPY --from=upstream /bin/postgrest /usr/local/bin/`
  and you are done. Check with `ldd`: "not a dynamic executable" or "not a valid dynamic
  program" is the answer you want. A distroless image with no shell is not an obstacle
  here — the single file *is* the image.
- **A binary plus data it compiles a path to.** GoTrue's migrations ship as loose SQL at a
  compiled-in path, and `gotrue migrate` will not run without them, so they come too. When
  a `COPY --from` of the binary alone fails at run time with a missing-file error, this is
  almost always what happened.
- **An interpreted application built against another libc.** The expensive one. Supabase's
  storage-api is a Node application built for Alpine which hard-requires one native addon
  (`fs-xattr`), loaded unconditionally by the storage backend this stack uses.

The reasoning on that last one is worth reproducing, because the rejected options are the
attractive ones:

> **Rejected: run its `dist` on the base image's own Node.** Every other dependency is
> pure JavaScript, so this nearly works — but `fs-xattr` is a musl-built `.node` and would
> have to be rebuilt, which means node-gyp, python and a C toolchain in the builder, a
> `NODE_MODULE_VERSION` that has to match, and a native addon this repository has now
> taken responsibility for compiling.
>
> **Rejected harder: stubbing `fs-xattr` out.** It is how the file backend stores object
> metadata, and the four tests that matter here are precisely about objects round-tripping
> through it.
>
> **Taken instead: carry the interpreter the upstream image was built with.** Node 24.14.0
> out of the same pinned image, plus the three musl libraries it links, loaded by musl's
> dynamic linker. glibc and musl coexist without conflict — different loader path,
> different sonames, and Debian keeps `libstdc++`/`libgcc` under
> `/usr/lib/x86_64-linux-gnu/` while musl looks in `/lib:/usr/local/lib:/usr/lib`, so
> nothing shadows anything. The application then runs byte-identical to upstream, which is
> the property the pin was for. It costs ~630 MB, and that is the honest price of the one
> service in this stack that is not a static binary.

Generalise it as: **stubbing out the thing a test is about is not a containerisation, it
is a deleted test.** Carrying an interpreter is ugly and large and it preserves the
property you actually wanted — that the service in your image behaves like the service the
developer runs. If neither works, because the component exists only as an image and cannot
be extracted, or because extracting it means compiling something you would then own, that
is a decline that names it, and not a reason to reach for the docker socket.

### 4.4 Pin the versions, in one place, in a way a typo cannot survive

Take versions from the compose file exactly, so the stack in the image is the stack the
developer runs. Named build stages, rather than inline `COPY --from=<image>`, keep the pins
together and make a mistyped tag a build failure instead of a silent `:latest` pull:

```dockerfile
FROM public.ecr.aws/supabase/postgrest:v14.5     AS postgrest
FROM public.ecr.aws/supabase/gotrue:v2.187.0     AS gotrue
FROM public.ecr.aws/supabase/storage-api:v1.41.8 AS storage

FROM ogun/base:latest
…
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
```

**Not everything has to come from the vendor's image.** Supabase's postgres image is
1.96 GB, and its value is a set of extensions compiled against its own postgres build.
Stock `postgresql-15` plus `postgresql-contrib` was used instead, on evidence:

> Every migration was checked for what it actually asks for. The complete list is
> `uuid-ossp`, `citext`, and pgcrypto by way of `extensions.digest` and
> `extensions.gen_random_bytes`. All three are in postgresql-contrib.

That is a `grep` over the migrations, not a judgement call. Do the grep. The parts of the
vendor image that *were* load-bearing were its SQL init scripts — the role graph, the
default privileges, the base schemas — and those are text, so they were lifted into a file
under `.ogun/`, at the pinned version, with a comment against each omission. Text you can
read and pin beats a 2 GB image you cannot.

### 4.5 One shell file, sourced by the build and by the entrypoint

At more than one service, the ports, credentials and environment blocks are needed twice:
once at build time, to run migrations against the cluster, and once at run time, to serve
it. Two copies drift, and the way they drift is that the build bakes a schema against a
database the entrypoint then serves on a different port or as a different role — which
surfaces as a test failure with no plausible cause.

So: one `.ogun/stack.sh` holding the definitions and the start/stop functions, `.`-sourced
by both `.ogun/stack-build.sh` and `.ogun/project-entrypoint.sh`. Both are files under
`.ogun/`, which the gate allows.

```sh
# .ogun/stack.sh — sourced by stack-build.sh (image build) and project-entrypoint.sh
# (every container start), so the two cannot drift.
PG_BIN=/usr/lib/postgresql/15/bin
PG_PORT=5432
STACK_LOGS=/tmp/ogun-stack

start_postgres() {
  "$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -l "$STACK_LOGS/postgres.log" \
    -o "-p $PG_PORT -k /var/run/postgresql -c listen_addresses=127.0.0.1 \
        -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null 2>&1 || { tail -40 "$STACK_LOGS/postgres.log" >&2; return 1; }
}

gotrue_env()    { export GOTRUE_API_PORT=9999 …; }
postgrest_env() { export PGRST_SERVER_PORT=3000 …; }
storage_env()   { export SERVER_PORT=5000 …; }
```

`fsync=off` and friends are not a shortcut: this cluster's whole lifetime is one container,
its data directory is an image layer, and a crash means the job is lost anyway. Durability
buys nothing and costs the whole of the migration replay, which is on the cold-start path.

Keep the services' environment *inside those functions* rather than in `ENV` on the image.
A jest worker has no business holding a database URL and a JWT signing secret, and the
subshell that starts a service is the natural scope for them. Only what the *test process*
reads goes in `ENV` — see §7.

### 4.6 The entrypoint at four services: what waits on what, and what fails loudly

```sh
#!/bin/sh
set -eu
. /opt/ogun-stack/stack.sh
mkdir -p "$STACK_LOGS"

fail() { echo "ogun-project-entrypoint: $1" >&2; shift
         for f in "$@"; do [ -f "$f" ] && { echo "--- $f"; tail -40 "$f"; } >&2; done; exit 1; }

# 30s at 100ms. A stack that has genuinely failed should fail the job rather than eat
# its timeoutMs.
wait_http() {
  i=0
  while ! curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -gt 300 ] && return 1; sleep 0.1
  done
}

start_postgres || fail "postgres failed to start" "$STACK_LOGS/postgres.log"

# gotrue and storage do not read the public schema, so they come up while the repo's
# migrations are still replaying. postgrest does — it builds a schema cache at connect
# and this stack has no DDL event trigger to invalidate it — so it starts after them.
( gotrue_env;  exec /usr/local/bin/gotrue serve ) >"$STACK_LOGS/gotrue.log" 2>&1 &
( cd /opt/storage-api/app && storage_env && exec "$STORAGE_NODE" dist/start/server.js ) \
    >"$STACK_LOGS/storage.log" 2>&1 &

# …replay the repository's own migrations here — §5…

( postgrest_env; exec /usr/local/bin/postgrest ) >"$STACK_LOGS/postgrest.log" 2>&1 &
nginx -c /opt/ogun-stack/gateway.conf || fail "router failed to start" "$STACK_LOGS/nginx-error.log"

wait_http "http://127.0.0.1:54321/auth/v1/health"    || fail "gotrue not ready"    "$STACK_LOGS/gotrue.log"
wait_http "http://127.0.0.1:54321/storage/v1/status" || fail "storage not ready"   "$STACK_LOGS/storage.log"
wait_http "http://127.0.0.1:54321/rest/v1/"          || fail "postgrest not ready" "$STACK_LOGS/postgrest.log"

exec /usr/local/bin/ogun-entrypoint "$@"
```

Six rules in there, none of them about Supabase:

1. **Every service's stdout goes to a file, and every failure tails it.** A stack that
   fails to come up otherwise produces "connection refused" in 500 tests and no cause. The
   `fail` helper exists so the *first* line of the job's output is the reason.
2. **Order by data dependency, not by convention.** Two of these services never read the
   schema under construction, so they start in parallel with it; the one that caches the
   schema at connect starts after. Working that out means reading each service's start-up,
   and it is what turns a ninety-second cold start into a ten-second one.
3. **Probe readiness through the thing the suite talks to.** Not each service directly —
   the suite talks to the router, so the router is what has to answer. And ask a question
   only a *working* service can answer: `/rest/v1/` returns 200 only once PostgREST has
   loaded a schema cache.
4. **Do not trust the compose file's healthchecks.** Two bugs in the one here would have
   been imported by copying it faithfully. `postgrest --ready` fails on v14.5 even when the
   service is fine and has logged `Schema cache loaded` — on its own, cosmetic. But
   `storage` had `depends_on: rest: {condition: service_healthy}`, so storage never started
   at all: on a host bring-up its container sat in `Created` forever and the four storage
   tests failed. A readiness probe you wrote and understand is worth more than one you
   inherited.
5. **No process supervisor.** Four daemons, four waits, then `exec`, is about forty lines
   and installs nothing. `supervisord` is allowed — its config is another file under
   `.ogun/` — and is rarely worth the layer.
6. **Production defaults are flake generators; change them deliberately and say so.** Two
   real examples, both of which failed a suite before they were found:

   - GoTrue rate-limits signup and token endpoints to 30 requests per 5 minutes per IP.
     Behind a router, every one of 58 test files is the same IP, and the suite creates
     users constantly, so the default turns green into a wall of 429s that reads as a code
     failure. Raised to a million.
   - The vendor SQL sets `statement_timeout` to 3s and 8s. Here the cluster shares two
     capped cores with jest running 58 suites in parallel workers, so an 8s timeout fails
     tests for reasons that have nothing to do with the code under test. Raised to 60s —
     **raised, not removed**, so a genuinely runaway query still fails rather than eating
     the job's `timeoutMs`.

   And watch for *which* role's setting actually applies. PostgREST connects as one role
   and then `SET ROLE`s, so it is the connecting role's per-role GUC that governs every
   query the suite makes; raising the timeout only on the roles named in the JWT achieves
   nothing at all.

## 5. Two phases of schema, and the two roles that follow from it

A stack with a database has schema from two places, and they must not be baked the same
way.

**Vendor schema is baked at build time.** The base bootstrap, the auth service's own
migrations, the storage service's own migrations — all of them come out of images pinned in
the compose file. None of them can change when a modifier edits the repository, so running
them at 3am is paying for the same answer twice. Bake them into `$PGDATA`, which is an
image layer, from a `.ogun/stack-build.sh` that sources the same `stack.sh`.

**The repository's own migrations are replayed at entrypoint, from the workspace, on every
start.** This is the one place the cold-start budget is spent on purpose:

> The image is built once, when the project is added; the workspace is a fresh clone of
> whatever commit the job pinned, and a modifier is entitled to add a migration. A schema
> baked at image-build time would give that patch a green suite against a database that
> does not have its table in it — the exact failure a tests gate exists to catch, produced
> by the gate itself.

Replay them by calling the repository's *own* migration script out of `/workspace`, rather
than by reimplementing its loop, so the schema the suite meets in the container is the
schema `make db-reset` gives a developer on the host. Keep a plain `psql` fallback for a
workspace that turns out not to have that script.

### 5.1 Two phases means two roles, and role-scoped state must name both

This is the second wall, and it cost 327 failing tests.

The two phases run as different database roles. The vendor half runs at build time as
whatever `initdb` made the bootstrap superuser. The repository's half runs at entrypoint as
whatever role its migration script connects as. **Anything in postgres scoped to "the role
that created the object" therefore has to name both roles, explicitly.**

`ALTER DEFAULT PRIVILEGES` is the one that bites. Without a `FOR ROLE` clause it applies to
objects created by *whoever executes the statement* — so defaults set during the bake, by
the build-time superuser, do nothing whatever for tables created at entrypoint by the
migration role:

```sql
-- Wrong. Silently. The stanza is present, it parses, and it does nothing for the tables
-- that matter, because it binds to the role running this file.
alter default privileges in schema public
  grant all on tables to postgres, anon, authenticated, service_role;
```

```sql
-- Right: name every role that will create an object in this schema.
alter default privileges for role postgres, supabase_admin in schema public
  grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges for role postgres, supabase_admin in schema public
  grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges for role postgres, supabase_admin in schema public
  grant all on sequences to postgres, anon, authenticated, service_role;
```

What the wrong version looks like from the outside:

```
Tests: 327 failed, 173 passed, 500 total
  ● … permission denied for table stripe_customers
```

Note what makes this expensive: the stanza was *there*, with a comment correctly predicting
this exact failure if it were missing. Presence is not the check. The check is "which role
creates this object, and is that role named". In that repository only 14 of 35 migrations
write an explicit `GRANT`; the other 21 create tables and rely entirely on these defaults
for the API roles to see them at all.

The same question applies to everything else in postgres that hangs off a role rather than
off an object: per-role `search_path`, per-role GUCs such as `statement_timeout`, ownership,
and `GRANT … ON ALL TABLES IN SCHEMA`, which is a snapshot at the moment it runs rather than
a rule and does nothing for a table created afterwards. If you set it in the bake and the
thing it governs is created at entrypoint, check it twice.

**And the choice of bootstrap superuser is not a detail.** The obvious reading is that the
role the repository's migrations connect as should be the one `initdb` creates. That works
until a migration says `CREATE EXTENSION IF NOT EXISTS citext` after that role has been
demoted out of superuser: PostgreSQL installs a *trusted* extension by switching to the
bootstrap superuser for the duration of its script, so demoting that role makes the switch
a no-op and a trusted extension stops being installable by anyone. Make the bootstrap
superuser a separate role from the one the migrations use — exactly as the vendor image
does, and for exactly this reason — and demote the migration role at the end of the bake.

## 6. A baked cache is only used if the command names it

The first wall, and the one that generalises furthest.

An image that bakes a package store, a compiler cache or a downloaded toolchain has put it
on the image's filesystem. The suite runs in `/workspace`, which by §2.1 is a different
filesystem. A tool that co-locates its cache with its output so it can hardlink will notice
that and **silently relocate the cache**, and the only symptom is that the thing you baked
did nothing.

pnpm is the worked case. The image bakes 850 MB at `/opt/pnpm/store` and sets
`PNPM_HOME=/opt/pnpm`. Inside that image, with the workspace mounted:

```
$ pnpm store path
/workspace/.pnpm-store/v11        ← 1.1 MB, not the 850 MB you baked
```

The mechanism, from pnpm's own store-path resolution: it creates a temp file in the project
directory and tries to **hardlink** it beside the store it would like to use. If that link
fails — which is exactly what a cross-device link does — it walks up to the project's
mountpoint and uses `<mountpoint>/.pnpm-store` instead. Run the same image with a working
directory that is *not* a bind mount and it resolves to `/opt/pnpm/store/v11`. The bind
mount is the whole of the difference, and nothing warns.

The fix is to name the store in `tests.command`, where no filesystem probe can overrule it:

```yaml
tests:
  command: >-
    pnpm install --frozen-lockfile --offline --store-dir=/opt/pnpm/store
    && pnpm --filter <package> test
```

```
Progress: resolved 1036, reused 1036, downloaded 0, done in 3.5s
```

Four things to carry away, in the order they will matter to you:

- **Name the cache location in the command, explicitly.** `--store-dir`, `CARGO_HOME`,
  `GOMODCACHE`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GRADLE_USER_HOME`, `CCACHE_DIR`,
  `MAVEN_OPTS -Dmaven.repo.local`. An environment variable set in the image is a
  *preference* that a tool is free to reconsider; a flag on the command is the answer.
- **Bake it under `/opt`, never under `/home/dev/.cache`.** That path is a named volume the
  runner mounts (§2.1, point 2), and docker seeds a volume from the image only when the
  volume is empty. A store baked there is invisible on any runner that has run a job
  before — and visible on a clean machine, so it passes review and fails in production.
  Two different mechanisms, one lesson: **anything the image bakes is only there if the
  runner is not mounting something over it and the tool is not choosing somewhere else.**

  The volume is not useless, it is for the other job. A cache that should survive *between*
  runs on a machine belongs there, and a cache that should be *in the image* belongs under
  `/opt`. Both need naming in the command for the same reason; only the second is destroyed
  by being baked at a mounted path.
- **The failure mode is silence, so prove it once.** Run the install with whatever offline
  flag your package manager has, and read the "downloaded 0" line. Without that, a cache
  being ignored looks exactly like a cache that is working, only slower — and "slower" is
  invisible at 3am.
- **Decide deliberately whether the offline flag stays in the command.** It is not free: a
  modifier is entitled to add a dependency, and a strictly offline install fails that patch
  at the gate with a network error rather than a test result. Against that, it is the only
  thing that keeps the gate honest about the store, and a gate that goes red because a
  registry was slow records "this patch broke the tests", which is the most expensive wrong
  answer a gate can give. Whichever you choose, say which in the commit message. The
  store-dir flag is not optional either way.

## 7. Environment: what the *test process* sees

Only what the suite itself reads belongs in `ENV` on the image. Services get theirs from
`stack.sh` (§4.5).

Two rules that are easy to get backwards:

- **Know whether the image or the checkout wins.** Many suites call something like
  `dotenv.config()` at start-up, which does **not** override an existing `process.env`
  entry. So the image decides and the checkout's committed `.env` fills the gaps — which is
  usually what you want. Check the direction before relying on it, though: a loader
  configured to override turns your image's careful values into whatever a developer last
  committed.
- **Audit every value you bake, and write the audit down.** An image is a thing somebody
  will later push to a registry. For each variable, say which of three it is: a real
  credential, a public demo value, or something generated for this container. A vendor's
  published demo keypair that appears verbatim in the vendor's own `.env.example` and in
  the repository's committed compose file is not a secret. A key generated in the
  Dockerfile to satisfy a start-up assertion, whose ciphertext lives and dies inside one
  container, is not a secret. A value copied out of a working `.env` may very well be — and
  that file may hold something live the suite never needs, in which case the right move is
  to bake nothing and note it. (In the worked example the tracked `.env` held a live Stripe
  test key; the four billing suites set their own dummy and never wanted it.)

## 8. `tests.command`

Add or replace exactly this block in `.ogun/config.yaml`, leaving the rest of the file
alone:

```yaml
tests:
  command: pnpm install --frozen-lockfile && pnpm -s test
```

It is run by a shell, in `/workspace`, inside your image, so `&&` and pipes are fine.

- **Install first.** The workspace is a fresh clone with no `node_modules`.
- **Point it at the store you baked** (§6). This is the only place that can happen.
- **Frozen, not resolving.** `--frozen-lockfile`, `npm ci`, `--locked`. A command that may
  resolve new versions is a suite that can go red because somebody else published.
- **Skip install scripts if one of them downloads from a host you cannot reach**, and say
  so. A dev dependency whose postinstall fetches a binary from a release page will fail
  under the egress allowlist. `--ignore-scripts` is the answer when the suite does not use
  the thing being fetched; when it does, the answer is `egress:` on the worker, which is a
  person's decision and not yours.
- **Run the whole suite the project runs.** If the project's own CI runs a linter and a
  type check too, `&&` them on: a repository that lints in CI is a repository whose patches
  should lint. If it does not, do not add one.
- **Scope it to what your image was built for, and be explicit.** A monorepo whose second
  package has its own test runner and its own dependencies is a second piece of work; a
  `--filter` naming what this image was built and measured against is honest, and
  pretending to run everything is not. This is a fine line: narrowing to make a red suite
  green is the decline in `SKILL.md`, and narrowing to the boundary you actually
  containerised is a sentence in the commit message.
- **It must exit non-zero when the suite fails**, which is the only thing the gate reads.
  Check that the runner you are invoking does not swallow failures behind a reporter.
- **It must be the real suite.** A command that cannot fail is refused by name, and one
  that runs a tenth of the tests is worse because nothing catches it. This command gates
  every patch this project ever produces.

## 9. What the gate does after you exit, and how to help it

The host builds `.ogun/Dockerfile` with the **repository root as the build context** — so
`COPY .ogun/project-entrypoint.sh …` is right and `COPY project-entrypoint.sh …` is not,
even though the Dockerfile sits in `.ogun/`. Then it runs your `tests.command` inside the
image it just built, on `--network none`, and only if that passes does your patch become a
draft pull request.

Both halves come out of the job's one timeout — there is no separate budget for the build —
which has three consequences you can act on:

- **Order the layers so a retry is cheap.** Put the slow, stable steps first (`apt-get`, a
  toolchain install, a `COPY --from` of a large upstream image) and the things you are most
  likely to have got wrong last. If you are given a second round, docker reuses every layer
  above the first line you changed, and the difference is a rebuild in seconds rather than
  in minutes.
- **Copy manifests into a dependency layer, never source.** A layer that pre-populates a
  package store must be invalidated by a lockfile change and by nothing else. Copy the root
  manifest, the lockfile and each workspace package's manifest into a scratch directory,
  install there, throw the `node_modules` away and keep the store. Copying the repository
  in first means every edit to a test file re-downloads the world — on the retry round,
  which is the round you cannot afford.
- **Keep the build context small.** If the repository has no `.dockerignore` and does have
  a `node_modules` or a `target/` or a `.venv`, the whole thing is sent to the daemon
  before the first instruction runs. You are allowed to add a root `.dockerignore` for
  exactly this reason. Keep it to build artefacts and dependency directories; it is a file
  every other build in the repository also reads.

A warning about the obvious tool for that dependency layer: the purpose-built "fetch from
the lockfile" commands are worth trying and are not always right. `pnpm fetch`, given only
the lockfile, resolves the root importer and stops, so the later install dies with
`ERR_PNPM_NO_OFFLINE_TARBALL` on the first dependency belonging to a workspace package. A
real install against all of the workspace's manifests walks the whole graph. Whatever you
use, the proof is §6's "downloaded 0".

**A note on test databases.** Ogun's own suite creates a per-run database from the one the
entrypoint made. If this project's suite does something similar, the entrypoint only has to
provide the server and a role to connect as; if it expects a specific database to exist,
create it in the entrypoint.

## 10. How your work leaves this sandbox

There is no git remote and no credential here, by design (ADR-0005). What you produce is
commits; the runner turns them into a patch after you exit and the host opens a draft pull
request. Three rules, each of which has cost a whole round somewhere:

- **Never rewrite history.** No `commit --amend`, `reset --hard`, `rebase`, or checking out
  another ref. Extraction refuses a `HEAD` that is not a descendant of the pinned base, and
  everything you did is deleted with the workspace seconds later. Commit forward; a mistake
  gets a second commit.
- **Never try to push.** There is no remote and no route to one.
- **Anything uncommitted is committed for you**, under a message saying nobody wrote one.
  That is a net for work that would otherwise vanish, not a workflow.

Before you finish, run `git status --porcelain` and account for every line. Reading a
repository leaves nothing behind, so there should be a handful — the Dockerfile, the config,
and whatever entrypoint and stack files you wrote — and the gate refuses anything outside
`.ogun/` and a root `.dockerignore`.

## 11. The commit message

Exactly one commit lends its subject to the pull request title, so prefer one commit. The
full body is reproduced verbatim in the pull request and is the review brief. Somebody is
deciding whether to trust this image against every future patch, so tell them:

- **what the suite actually needs**, and how you know — name the CI workflow or compose
  file you read it from, and give the numbers if you counted them (how many calls, to which
  prefixes);
- **what you put in the image and why that version**;
- **what you left out and why**, especially anything you decided the suite does not really
  need — one sentence per dropped service, naming the thing in the suite that would have
  noticed;
- **what you replaced with something smaller**, and the check you ran before replacing it;
- **the command you chose**, what it runs, whether its install is offline, and what that
  costs;
- **what you could not check**, which is most of it: you cannot build this image or run
  this suite from in here, and saying so is honest rather than weak.

**Never write a closing keyword** — not `Closes #14`, `Fixes #14`, `Resolved #14` or any of
those followed by an issue URL, in any case, on any line. GitHub acts on them when the
branch merges and nothing downstream can strip one without rewriting the artefact a person
is reviewing. The gate refuses the patch before it builds anything, and there is no second
attempt, because the only repair is rewriting history. Refer to issues in prose instead —
"the bug reported in #14" links and does not close.

No `@mentions`, and no `Co-authored-by:` trailer naming a person.

## 12. Say what happened

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
depends on a service nobody documents, a lockfile that does not match the manifest, a
compose file whose healthcheck keeps a service from ever starting. Write them up with a
fingerprint and citations exactly as a reviewer would; that is the entire alternative to
fixing them, because the gate refuses a patch that touches anything outside `.ogun/`.
