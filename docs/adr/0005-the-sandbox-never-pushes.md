---
status: accepted
---

# The sandbox never pushes

A modifier worker produces a branch and a draft PR. The direct implementation puts `gh`
in the image, mounts `~/.config/gh`, and lets the agent open the PR itself — which is what
`claude-sandbox`, the image `ogun/base` otherwise borrows from, does.

Instead the credential never enters the container, and neither does the remote:

```
container:  clone at pinned SHA → agent works → commit locally → exit
runner:     extract git format-patch / bundle from the workspace
host:       apply to scratch worktree → push branch → gh pr create --draft
```

The workspace is a local clone (`git clone --local --no-hardlinks`, so a container cannot
corrupt the source repository's object store), mounted read-write, with no remote
configured and no `gh` installed. Every outbound git operation — fetch, push, PR creation
— happens on the host after the container has exited.

That makes the rule structural rather than policed. There is no credential to misuse and
no remote to push to, so an agent that decides to publish cannot, and no prompt has to ask
it not to.

Both halves are built now. [updated] The container half is: workspace materialization
strips the remote, the image carries no `gh` and no token, and the entrypoint drops
`origin` again in case a repository committed one. The host half is: extraction writes a
`git format-patch` mbox to the runner's disk, and the publisher applies it to a scratch
worktree, pushes a branch and opens a draft pull request — in the runner process, with the
credential behind one interface (ADR-0009). What this ADR settled before either existed is
that they live host-side, and they do.

## Considered Options

- **Install `gh` and mount `~/.config/gh` read-write, as `claude-sandbox` does.** Rejected
  — it hands the container a GitHub token. `claude-sandbox` is a convenience sandbox: it
  protects the host from Claude's mistakes while a human watches a session. An unattended
  3am run needs a different posture, and this is one of the settings that changes with it.
- **A publisher permission profile — publishing as an agent capability, granted per
  worker.** Rejected — publishing wants gates that are not judgment calls: tests green,
  diff under N lines, PR cap not exceeded. Those belong in ordinary host-side code, and
  once they live there the profile has nothing left to grant. The profile collapses into a
  pipeline step.

## Consequences

- **What is structural is what this ADR settles.** No credential and no remote reach a
  container; the image has no `gh`; the socket is never mounted (ADR-0006); the container
  runs `--cap-drop ALL` with `no-new-privileges`. Those hold for every profile and are
  what make the never-pushes rule true.
- Permission profiles describe what an agent may do *inside* the sandbox: `observer`
  (read), `reviewer` (read, run tests and scanners, emit findings), `modifier` (write and
  commit). This ADR settles their scope. **It does not settle that they are enforced.**
- **In-sandbox enforcement is the mount.** [updated] The tree under review is mounted
  read-only for `observer` and `reviewer`, read-write only for `modifier`, with
  `.ogun-out/` layered over it writable so a reviewer can still report. At the mount
  because it is the one place both runtimes go through — a guarantee expressed as a
  runtime flag is applied by whichever runtime happens to support it. Codex's own sandbox
  cannot be used here: it needs an unprivileged user namespace that `--cap-drop ALL` plus
  `no-new-privileges` denies, so every command fails rather than just the writes.

  What this replaced, kept because it is why the ADR said what it said: All of it is
  `--disallowedTools Edit,Write,NotebookEdit,MultiEdit` on the claude runtime for
  non-modifier profiles, in a session that also passes `--dangerously-skip-permissions`.
  `Bash` is unrestricted, so a `reviewer` writes whatever it likes through the shell. The
  codex runtime restricts nothing at all. The container does exactly one thing with the
  profile — passes `OGUN_PERMISSIONS` into an environment nothing reads — and mounts the
  workspace read-write regardless. §4.6 claimed these were "enforced by the sandbox where
  practical"; that sentence is marked `[corrected]` there now. A finding that the profiles
  are not enforced is a real finding and must not be discarded against this ADR.
- The publisher becomes a host-side pipeline step, which is where the PR cap and the
  diff-size limit go. [updated] Both halves are built. A modifier's work leaves the
  container as a `git format-patch` mbox on the runner's disk with an `artifacts` row and a
  `changes` row; the publisher then applies it, pushes, and opens a draft pull request, and
  it runs **on the runner** — the only machine with both a checkout and a GitHub credential
  (ADR-0009). The diff-size limit landed at extraction as `MAX_PATCH_BYTES` rather than at
  publish: a patch over it never becomes an artefact, so there is nothing for a later gate
  to reject. The PR cap is `policies.maxOpenPullRequests`, applied at publish.

  That places a credential on the runner *host*; this ADR's rule is about the *container*,
  and the container still has neither credential nor remote. It is also a person's `gh`
  credential today, which is the right posture for a runner that is your own machine and
  the wrong one for a runner that is not — ADR-0009 names that as the condition for a
  repo-scoped installation token, and it is not built.
- Egress cannot be `none` for an agent run — the runtime itself calls `api.anthropic.com`
  or OpenAI's endpoint, so a reviewer container cannot be an airgap.
- **The per-host egress allowlist is built.** [updated] A worker declares the hosts its
  sandbox may reach and anything else is refused; absent a declaration it gets the model
  API for its runtime plus the npm registry, and `open` survives as an explicit, logged
  opt-out. Enforcement is `--network none` plus a forward proxy in the *runner process*
  reached over a bind-mounted unix socket, so there is no sibling container and no
  `NET_ADMIN` — see §4.6 for the mechanism and the rejected alternatives.

  What this replaced, kept because it is why the ADR said what it said: "The per-host
  egress allowlist is not built, and this ADR does not say it should not be. What ships is
  `egress: open | none`, and reviewers run `open`. A filtering proxy is a sibling
  container and therefore ruled out by ADR-0006; `iptables` inside the container needs
  `NET_ADMIN` plus a privilege drop, and still fails against endpoints whose IPs rotate."
  Every clause of that was true about the options considered, and the conclusion still did
  not follow — a unix socket is not a container and not a network interface, and it was
  not on the list. The cost of the error was not the missing feature but the *default*:
  `open` meant every sandbox had unrestricted internet and a mounted OAuth credential it
  could read, which is a much larger exposure than the rate limit §4.6 named as the worst
  case.
- The structural protections above are what stop a container reaching GitHub, and they
  hold regardless of egress. Exfiltration through the model API itself is a different and
  harder problem, no allowlist closes it, and it is open.
