# check=skip=InvalidDefaultArgInFrom
# ^ that check wants `ARG NODE_VERSION=<something>`. Giving it one is exactly the second
#   place to write the pin that the arg exists to avoid — see the comment above FROM.

# ogun/base — the substrate every reviewer runs in.
#
# Derived from ~/dev/claude-sandbox's base image, with a changed posture. That one is a
# convenience sandbox: it protects the host from Claude's mistakes while a human watches
# a --dangerously-skip-permissions session. This one runs unattended overnight, so six
# things are deliberately different (§4.6):
#
#   - no docker CLI and no /var/run/docker.sock. Anything holding the socket can start a
#     privileged container mounting /, which makes the boundary decorative.
#   - no gh, and no GitHub token. The container never talks to GitHub; every outbound
#     git operation happens host-side after it exits.
#   - no sudo. There is nothing in here the agent needs root for.
#   - no credentials at all. Placeholder files arrive read-only at the staging path the
#     real ones used to occupy, and are copied to a writable home; the real token stays on
#     the host and is spliced into requests by the egress gateway (ADR-0010). `egress:
#     open` is the one opt-out that still mounts a real credential, and the runner says so
#     on every run that uses it.
#   - no git remote in the workspace. The never-pushes rule is structural rather than
#     policed: there is nothing to push with.
#   - no unrestricted egress. The container runs --network none and reaches the world only
#     through a unix socket the runner mounts in, on the far side of which is a proxy that
#     allows CONNECT to the worker's allowlisted hosts and nothing else.
#
# This header used to claim "worst case for a misbehaving agent is burning rate limit".
# That was never true and it is worth recording why, because it is the assumption the
# whole posture rested on: the credentials copied to a writable home used to be live OAuth
# tokens, readable by anything running in here. With unrestricted egress — which is what
# shipped — the worst case was a prompt-injected agent reading its own credential and
# POSTing it somewhere. Not a hypothetical agent that turns malicious: an
# `adversarial-review` worker is pointed at untrusted repository content on purpose, so a
# crafted README, a test fixture or a dependency's source is the delivery mechanism. The
# allowlist bounded where it could go; the gateway removed the thing worth sending. The
# honest version now is that the worst case is bounded by what an attacker can do through
# the model API itself, which is a smaller and harder problem, and still open.

# The Node the repo pins, not a version chosen here. `.tool-versions` is the single
# source of truth and `ogun image build` passes it in; there is deliberately no default,
# because a default is a second place to write the version down and the two drift. A bare
# `docker build` without the arg fails on an unparseable tag rather than quietly building
# a Node the suite was never run against.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

# Tools an agent actually reaches for while reading a codebase. Deliberately not a
# full build-essential toolchain — a *project* image adds what its own suite needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq ripgrep fd-find less \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(which fdfind)" /usr/local/bin/fd

# uid 1000 so bind-mounted workspaces are writable without chowning the host's files.
# No sudoers entry, no docker group.
RUN userdel -r node 2>/dev/null || true; \
    useradd -m -s /bin/bash -u 1000 -U dev

USER dev
WORKDIR /home/dev

# Claude Code, installed as dev so it lands under ~dev.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/dev/.local/bin:/home/dev/.npm-global/bin:${PATH}"

# Codex, installed into a user-owned prefix rather than global node_modules.
RUN npm config set prefix /home/dev/.npm-global \
    && npm install -g @openai/codex \
    && npm cache clean --force

# The ogun CLI is what a skill shells out to for findings, validation, and grounding
# (§4.10). Bundled to one file rather than installed from a registry: it must match the
# control plane that will read its output, and a bundle means no node_modules and no
# chance of the in-sandbox CLI drifting from the one that validates on the way in.
COPY --chown=dev:dev cli/ogun.mjs /opt/ogun/ogun.mjs
RUN printf '#!/bin/sh\nexec node /opt/ogun/ogun.mjs "$@"\n' > /home/dev/.local/bin/ogun \
    && chmod +x /home/dev/.local/bin/ogun

# The container half of the egress allowlist. Bridges loopback to the unix socket the
# runner mounts in, because HTTPS_PROXY cannot name a socket file (§4.6).
COPY --chown=dev:dev egress-forwarder.mjs /opt/ogun/egress-forwarder.mjs

COPY --chown=dev:dev entrypoint.sh /usr/local/bin/ogun-entrypoint
USER root
RUN chmod +x /usr/local/bin/ogun-entrypoint
USER dev

ENV CLAUDE_CONFIG_DIR=/home/dev/.claude \
    CODEX_HOME=/home/dev/.codex \
    OGUN_IN_SANDBOX=1 \
    # Declares that this image's entrypoint knows how to start the egress forwarder. The
    # runner refuses to enforce an allowlist against an image without it, because the
    # failure is otherwise silent and backwards: the container gets --network none and
    # nothing to bridge to, so it is a total airgap that reports itself as an agent
    # unable to reach its model API. Project images inherit this from `FROM ogun/base`
    # and so pick it up on their next rebuild (§4.6).
    OGUN_EGRESS_FORWARDER=1 \
    # Findings land here; the runner reads them back through the bind-mount.
    OGUN_OUTPUT_PATH=/workspace/.ogun-out/findings.json

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/ogun-entrypoint"]
