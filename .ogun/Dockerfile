# ogun/project-ogun — Ogun's own image, so Ogun can run a modifier on itself.
#
# A project image is `FROM ogun/base` plus whatever its own suite needs (§4.6). Reviewers
# never reach this: they read code and reason, and the base image is enough. A *modifier*
# does, because its patch is only publishable once the suite has been run against it, and
# a suite that cannot run is a modifier that cannot be verified.
FROM ogun/base:latest

USER root

# §4.6 is explicit that a suite needing a service gets it *inside* the image: the Docker
# socket is never mounted and docker-in-docker needs --privileged, so sibling containers
# are not available to us. Ogun's server tests claim jobs with `FOR UPDATE SKIP LOCKED`,
# which is the reason postgres is a hard dependency rather than a preference (§4.4) — they
# cannot be faked out with an in-memory double.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*

# Deliberately no edit of /etc/postgresql: the cluster this image runs is created by
# `initdb` in the entrypoint, not the one the Debian package sets up, so the packaged
# config is never read. Configuring it in two places is how they end up disagreeing.

# pnpm installed at build time, not fetched at run time. `corepack enable` defers the
# download to first use, which puts a registry round-trip inside a 3am job — the thing
# §4.6 builds images ahead of time to avoid. A pinned major here is reproducible and
# offline.
RUN npm install -g pnpm@10 && npm cache clean --force

# The base image's entrypoint seeds credentials and execs; this wraps it so postgres is
# already accepting connections by the time the agent's first command runs. Starting it
# lazily from the test command instead would make every invocation of the suite pay for
# it, and would make a developer running one test file wonder why it hung.
# Paths are relative to the build context, which is the repo root — the Dockerfile lives
# in .ogun/ but is built from above it.
COPY .ogun/project-entrypoint.sh /usr/local/bin/ogun-project-entrypoint
RUN chmod +x /usr/local/bin/ogun-project-entrypoint \
    && mkdir -p /var/run/postgresql && chown dev:dev /var/run/postgresql \
    && mkdir -p /var/lib/postgresql/data && chown dev:dev /var/lib/postgresql/data

USER dev
ENV DATABASE_URL=postgres://ogun:ogun@localhost:5433/ogun \
    PGDATA=/var/lib/postgresql/data \
    # pnpm's store in the cache volume the runner already mounts, so a nightly does not
    # re-download the world (§4.6).
    PNPM_HOME=/home/dev/.cache/pnpm

ENTRYPOINT ["/usr/local/bin/ogun-project-entrypoint"]
