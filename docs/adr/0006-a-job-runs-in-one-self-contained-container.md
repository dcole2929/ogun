---
status: accepted
---

# A job runs in one self-contained container

A modifier worker has to run the project's test suite, and a real suite often wants
postgres or redis. The two standard answers are to mount `/var/run/docker.sock` so the job
can start what it needs, or to bring services up as sibling containers with compose.

Neither. Everything a job needs runs inside its own container. A project's
`.ogun/Dockerfile` builds `FROM ogun/base` and installs its own toolchain and services;
the entrypoint starts them before the agent runs. The job stays one unit with nothing to
orchestrate.

## Considered Options

- **Mount `/var/run/docker.sock`.** Rejected — the socket is root-equivalent on the host.
  Anything holding it can start a privileged container mounting `/`, which makes the
  container boundary decorative. This is the load-bearing difference between an attended
  convenience sandbox and an unattended one.
- **Docker-in-docker as the escape hatch.** Rejected — it needs `--privileged`, which is
  no better than the socket.
- **Sibling containers via compose.** Rejected — it turns a job from one thing the runner
  starts and waits on into a set of things with their own lifecycle, and getting them
  started needs the same daemon reach the socket provides.

## Consequences

In the order these bite:

- **Reviewers need no services at all.** They read code and reason about it. Phases 1–2
  never reach this question.
- **A modifier needing postgres or redis gets them inside the image.** This is what
  per-project images are for. Tag by content hash of Dockerfile plus lockfile, rebuild
  when either changes, build at `ogun project add` rather than at 2am, and mount a
  persistent package-manager cache volume or every nightly run re-downloads the world.
- **A project whose suite genuinely requires orchestrating multiple containers is out of
  scope for autonomous runs**, until there is a better answer. That is a recorded
  limitation rather than a solved problem, and reaching for the socket is not the answer
  to it.
- A filtering egress proxy would be a sibling container, so this decision is also why the
  per-host allowlist named in ADR-0005 has no cheap implementation.
