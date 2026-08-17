---
status: accepted
---

# Git is the source of truth for worker definitions

A worker can arrive two ways: someone writes it into `.ogun/config.yaml` and commits it,
or someone creates it in the UI. Two authoring paths against one definition is a question
that has to be answered before there are enough workers for it to hurt.

A worker lives in exactly one place: `.ogun/config.yaml`, in the repo. Creating one in
the UI writes that file and re-indexes from it. There is no second place a worker can
exist, and no "which copy wins" question.

Two designs were tried before this one; both are below. What this one costs is that the
control plane needs a local path for a project in order to edit it. That is recoverable
rather than fundamental, because the rule that actually holds is *no absolute path in the
database* — `/home/doug/dev/x` and `/Users/doug/dev/x` are the same project. The path map
is therefore machine-local (`~/.ogun/config.json`, written by `ogun project add` and
`ogun project sync`) and never crosses the API.

## Considered Options

- **Keep UI workers in the database alongside file workers.** Rejected — it needs an
  `origin` column, a shadowing rule, and a promotion step: three concepts to hold before
  anyone can answer where a worker came from. Worker definitions also stop travelling
  with the repo, which is most of what putting them in the repo was for.
- **Route the write through the runner.** Rejected — it would have worked. But the
  runner's job is to clone *out* of your repositories, never to write into them, and
  widening that was a worse trade than widening the server's.

## Consequences

- A control plane with no local copy reports that it cannot edit, and returns the YAML
  block to paste by hand. That is the hosted case, and it is the seam where `ConfigStore`
  grows a second implementation that writes through the GitHub API.
- Editing a file a person hand-wrote is only acceptable under four properties, and all
  four hold: writes go through the YAML Document API so comments, key order and quoting
  survive; only fields differing from the schema default are written, so the diff stays
  readable; the result is validated before it lands and the write is atomic via rename;
  and edits are compare-and-swap on a content hash, so two tabs — or a tab racing your
  editor — fail loudly instead of one silently winning.
- **The file is written, never committed.** The uncommitted diff is the review step, and
  auto-committing to someone's working branch is not the control plane's call.
- Nothing about the sandbox changes. This is the host-side control plane writing one
  file. No agent gains a capability and ADR-0005 is untouched.
- The file is the definition, but the database is what runs. `ogun project sync`
  publishes it, and a file changed by another route — a hand-edit, a `git pull` — leaves
  the factory executing the previous definition. **Detecting that drift is open, not
  settled**: the server already holds the file's content hash and does not yet report the
  mismatch. A finding about undetected config drift is a live finding.
