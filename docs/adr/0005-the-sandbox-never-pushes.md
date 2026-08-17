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

The two halves are not equally built. The container half is: workspace materialization
strips the remote, the image carries no `gh` and no token, and the entrypoint drops
`origin` again in case a repository committed one. The runner and host halves — patch
extraction, branch, draft PR — are phase 3 and do not exist yet. What this ADR settles is
that when they are built they live host-side.

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
- **In-sandbox enforcement is one flag, and the gap is live and reportable.** All of it is
  `--disallowedTools Edit,Write,NotebookEdit,MultiEdit` on the claude runtime for
  non-modifier profiles, in a session that also passes `--dangerously-skip-permissions`.
  `Bash` is unrestricted, so a `reviewer` writes whatever it likes through the shell. The
  codex runtime restricts nothing at all. The container does exactly one thing with the
  profile — passes `OGUN_PERMISSIONS` into an environment nothing reads — and mounts the
  workspace read-write regardless. §4.6 claimed these were "enforced by the sandbox where
  practical"; that sentence is marked `[corrected]` there now. A finding that the profiles
  are not enforced is a real finding and must not be discarded against this ADR.
- The publisher becomes a host-side pipeline step, which is where the PR cap and the
  diff-size limit go. It is not built.
- Egress cannot be `none` for an agent run — the runtime itself calls `api.anthropic.com`
  or OpenAI's endpoint, so a reviewer container cannot be an airgap.
- **The per-host egress allowlist is not built, and this ADR does not say it should not
  be.** What ships is `egress: open | none`, and reviewers run `open`. A filtering proxy
  is a sibling container and therefore ruled out by ADR-0006; `iptables` inside the
  container needs `NET_ADMIN` plus a privilege drop, and still fails against endpoints
  whose IPs rotate. The structural protections above are what stop a container reaching
  GitHub, and they hold regardless. Exfiltration through the model API itself is a
  different and harder problem, and it is open.
