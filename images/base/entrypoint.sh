#!/bin/sh
# Seed writable credential directories from the read-only host mounts, then exec the
# agent. Nothing here needs root — the whole point is that this container has none.
#
# Why copy rather than mount the real path writable: both CLIs write session state, so a
# bare read-only mount at ~/.claude makes them fail. Mounting the host's directory
# writable would let a container corrupt the credentials it was lent. Copying gives the
# agent a working home whose worst-case damage is burning rate limit (§4.6).
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

# The runner mounts individual credential files, never a whole config directory — see
# credentialMounts() for why. This copies whatever arrived.
seed /host-credentials/claude /home/dev/.claude
seed /host-credentials/codex  /home/dev/.codex

# Git needs an identity to read some repository state even when it never commits.
git config --global user.email "ogun@localhost" 2>/dev/null || true
git config --global user.name  "ogun" 2>/dev/null || true
git config --global --add safe.directory /workspace 2>/dev/null || true

# Belt and braces: the runner already removes the remote when materializing the
# workspace, but a project could commit one into .git/config.
git -C /workspace remote remove origin 2>/dev/null || true

exec "$@"
