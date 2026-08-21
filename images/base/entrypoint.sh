#!/bin/sh
# Seed writable credential directories from the read-only host mounts, then exec the
# agent. Nothing here needs root — the whole point is that this container has none.
#
# Why copy rather than mount the real path writable: both CLIs write session state, so a
# bare read-only mount at ~/.claude makes them fail. Mounting the host's directory
# writable would let a container corrupt the credentials it was lent. Copying gives the
# agent a working home it cannot use to damage the host's own (§4.6).
#
# What arrives at /host-credentials is a *placeholder* (ADR-0010) — real enough in shape
# for the CLI to decide it is logged in, worth nothing to whoever steals it. The real token
# never leaves the host; the egress gateway splices it in at the wire. Nothing in this file
# had to change for that, which was the deciding factor between several bootstrap shapes:
# the stubs land at exactly the paths the real files used to, so `seed` below copies
# whatever is there without knowing or caring which it got.
#
# This block used to say the credential's "worst-case damage is burning rate limit", which
# was false — what landed in that home was a live OAuth token, and an agent that can read it
# and reach the internet can send it anywhere. The --network none plus host-side proxy
# below bounded where it could go; the gateway removed the thing worth sending.
set -eu

seed() {
  src="$1"
  dst="$2"
  [ -e "$src" ] || return 0
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    # -L so a symlinked credential file on the host arrives as content, not a dangling
    # link pointing at a path that does not exist in here.
    cp -RL "$src/." "$dst/" 2>/dev/null || true
  else
    cp -L "$src" "$dst" 2>/dev/null || true
  fi
  chmod -R u+rwX "$dst" 2>/dev/null || true
}

# Create them unconditionally: codex warns and degrades if CODEX_HOME does not exist,
# and a run with no credentials mounted should fail on auth with a clear message rather
# than on a missing directory.
mkdir -p /home/dev/.claude /home/dev/.codex

# The runner mounts individual files, never a whole config directory — see
# credentialMounts() in container.ts for why. This copies whatever arrived, which under
# every policy but `egress: open` is a placeholder plus the CLI's own settings.
seed /host-credentials/claude /home/dev/.claude
seed /host-credentials/codex  /home/dev/.codex

# Git needs an identity to read some repository state even when it never commits.
git config --global user.email "ogun@localhost" 2>/dev/null || true
git config --global user.name  "ogun" 2>/dev/null || true
git config --global --add safe.directory /workspace 2>/dev/null || true

# Belt and braces: the runner already removes the remote when materializing the
# workspace, but a project could commit one into .git/config.
git -C /workspace remote remove origin 2>/dev/null || true

# The container half of the egress allowlist (§4.6). Only when the runner mounted a
# socket: `egress: none` mounts nothing and this container is a genuine airgap, and
# `egress: open` runs on a normal bridge where there is nothing to forward to.
if [ -n "${OGUN_EGRESS_SOCKET:-}" ]; then
  OGUN_EGRESS_READY=/tmp/.ogun-egress-ready
  export OGUN_EGRESS_READY
  rm -f "$OGUN_EGRESS_READY"
  node /opt/ogun/egress-forwarder.mjs &

  # Block until it is actually listening. The agent's first act is an API call, and
  # starting it against a port nothing has bound yet produces an authentication failure
  # rather than a connection error — a race that hides on a laptop and shows up on a
  # loaded runner. 100 x 0.05s = 5s, which is two orders of magnitude more than node
  # needs to bind a socket and still short enough that a genuinely broken forwarder fails
  # the job rather than eating its budget.
  i=0
  while [ ! -e "$OGUN_EGRESS_READY" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "ogun-entrypoint: egress forwarder did not start; this container has no route out" >&2
      exit 1
    fi
    sleep 0.05
  done
fi

exec "$@"
