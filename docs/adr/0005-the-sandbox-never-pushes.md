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

- Permission profiles describe only what an agent may do *inside* the sandbox: `observer`
  (read), `reviewer` (read, run tests and scanners, emit findings), `modifier` (write and
  commit). They are enforced by the sandbox where practical, not just described in
  prompts.
- The publisher is a host-side pipeline step, which is where the PR cap and the diff-size
  limit go.
- Egress cannot be `none` for an agent run — the runtime itself calls `api.anthropic.com`
  or OpenAI's endpoint, so a reviewer container cannot be an airgap.
- **The per-host egress allowlist is not built, and this ADR does not say it should not
  be.** What ships is `egress: open | none`, and reviewers run `open`. A filtering proxy
  is a sibling container and therefore ruled out by ADR-0006; `iptables` inside the
  container needs `NET_ADMIN` plus a privilege drop, and still fails against endpoints
  whose IPs rotate. The structural protections above are what stop a container reaching
  GitHub, and they hold regardless. Exfiltration through the model API itself is a
  different and harder problem, and it is open.
