#!/bin/sh
# Bring up what Ogun's own suite needs, then hand off to the base entrypoint.
#
# Wrapping rather than replacing: the base one seeds credentials from the read-only mount
# and strips the git remote, and both still have to happen. Replacing it would silently
# drop those.
set -eu

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | head -1)"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  # `trust` because this cluster is reachable only from inside this container: it listens
  # on localhost and a unix socket, and the sandbox has no inbound network. A password
  # here would be a secret in an image, which is worse.
  "$PG_BIN/initdb" -D "$PGDATA" -U ogun --auth=trust >/dev/null 2>&1
fi

"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p 5433 -k /var/run/postgresql" -w -t 30 -l /tmp/pg.log start >/dev/null 2>&1 || {
  echo "ogun-project-entrypoint: postgres failed to start" >&2
  tail -20 /tmp/pg.log >&2 || true
  exit 1
}

# The suite creates its own test database; this is the one it connects as.
"$PG_BIN/createdb" -p 5433 -U ogun ogun >/dev/null 2>&1 || true

exec /usr/local/bin/ogun-entrypoint "$@"
