---
status: accepted
---

# The runner publishes, and reports before it does

ADR-0005 settled that the container never pushes and that the branch and draft PR happen
host-side. It did not settle *which* host process does it, when, or how the credential
gets there. Those three are this file, and they are decided together because each one
makes the next one cheap.

**The publisher is `packages/runner/src/publish.ts`** — the mirror of `patch.ts`, in the
same package, running in the same process as the job that produced the patch. Extraction
writes an mbox to the runner's own disk and the runner is the process co-located with the
repositories; a publisher anywhere else would need both of those shipped to it. The
control plane is the thing ADR-0001 wants to be able to move to a VPS, and a control plane
that has to hold every project's checkout and every runner's scratch directory cannot
move anywhere.

**It runs automatically when a job finalizes, and it reports first.** The runner sends its
report, reads back the outcome the control plane *recorded*, and only then publishes:

```
extract patch → cp.report(...) → outcome === 'dispatched'? → worktree → am → push → PR
                                                            → cp.published(branch, url)
```

Publish-then-report fails in the direction nothing recovers from. The push and the pull
request are on GitHub; if the report then fails — control plane restarting, token expired,
network gone — there is a live pull request with no `changes` row, no run outcome, and
nothing in the database that knows either exists. This order fails to a `changes` row with
a null `branch`, which is a state the schema already has a name for and the run page
already shows: work that exists and is not published. Visible, inspectable, and the state a
retry would start from anyway.

Reporting first also puts the gate in the right place. `finalizeRun` derives a
`dispatched` run whose verify gate failed down to `changes-requested`; the outcome the
runner *proposed* is exactly the claim the gate exists to overrule, so the publisher reads
the recorded one.

**The credential reaches it through one two-method interface**, `PublishRemote`: count the
pull requests already open under the `ogun/` branch prefix, and get one branch to the
remote with a draft pull request on it. Everything else — every gate, the scratch worktree,
`git am`, the branch name, the PR body — is ordinary local work that needs no secret. There
is one implementation, `githubCli`, shelling out to the host's `git` and `gh`.

**A second implementation is expected, and the condition is named: a runner that is not
the machine you are sitting at.** `gh`'s credential is a person's, it is long-lived, and it
reaches every repository that person can. That is a fair trade while the runner is your own
laptop and the blast radius is your own account; it is the wrong posture the day a runner
is a box in a cupboard, for the same reason ADR-0005 gives about unattended 3am runs. The
replacement is a short-lived, repo-scoped GitHub App installation token. A third — a
credential-injecting proxy, so the runner holds nothing at all — is ADR-0005's argument
about the container applied one level out, and has no condition yet.

## Considered Options

- **Publish from the control plane.** Rejected — the patch is on the runner's disk and the
  checkout is on the runner's machine, so this moves both across the boundary ADR-0001
  drew, and does it for the one component that is meant to become remote. It also puts a
  GitHub credential on the process that already holds the database and every runner's
  enrolment token.
- **A separate `ogun publish` command a person runs.** Rejected as the *default*, not as an
  idea. A factory whose output waits for someone to remember a command is a factory that
  produces a scratch directory of unpublished patches. The gates are the review here; the
  pull request is a draft precisely so that "a human looks at it" happens after it exists,
  where GitHub is already good at it.
- **Publish first, then report.** Rejected — see above. Every failure mode is an orphan
  pull request the database has never heard of.
- **Fold `branch` and `pr_url` into the run report.** Rejected — they do not exist yet when
  the report is sent, and sending an empty branch is indistinguishable from a report
  written before the publisher existed.
- **Ambient `gh` at every call site.** Rejected — that is what `claude-sandbox` does and
  what ADR-0005 refused for the container; refusing it there and scattering it here would
  leave the credential's shape undiscoverable and make the installation-token version a
  rewrite instead of a file.
- **A full provider abstraction — GitHub, GitLab, Gitea behind an interface.** Rejected —
  two methods with one implementation is a seam; the same two methods with a factory, a
  registry and a config key is a framework for a second provider nobody has asked for. The
  seam is where the credential is, not where a hypothetical forge is.
- **Rebase onto the current default branch before opening the PR.** Rejected — a pull
  request from a slightly stale base is what every human contributor opens, and resolving
  conflicts unattended at 3am against a tree nobody reviewed is not a thing this should be
  able to do.

## Consequences

- **A `changes` row is still not a work queue.** The publisher selects on the run's
  terminal outcome being `dispatched` and on `tests_passed === true`, because a row exists
  for a gate-failed run, for a run whose patch was too large to extract, and for a run that
  changed nothing.
- **`tests_passed` null and false are refused differently.** Null means nobody said —
  recorded before the gate existed, or the patch was unextractable — and refusing on the
  absence of evidence is not the same act as refusing on evidence (principle 6). Both
  refuse; the reasons are different sentences and the tests assert that they are.
- **The PR cap is `policies.maxOpenPullRequests`, default 3**, counted live against open
  pull requests whose head branch starts with `ogun/` (ADR-0004). By branch prefix and not
  by author, because the three credential implementations authenticate as three different
  identities and a cap counted by author would silently start counting nothing. `0` is
  valid and useful: it stops publishing without stopping modifiers.
- **The policies are read from the blob at the pinned base**, like `tests.command` already
  is. The workspace is a tree the modifier can write, and a cap a patch can raise is not a
  cap. An unreadable config refuses rather than falling back to the defaults.
- **Branch names are built, never passed through.** `ogun/<worker>/<run>`, out of an
  allowlist, re-checked against a shape before use. Nothing here goes near a shell, so the
  quoting attack is already dead; argument injection is not — a ref beginning with `-` is
  an option to git, and `--upload-pack=<command>` on a push is arbitrary code.
- **The same git hardening as extraction.** `git am` runs hooks and refreshes the index,
  and a worktree shares `.git/config` and `core.hooksPath` with the repository it came
  from. `GIT_ENV`'s blanking of the host's global config is deliberately *not* applied to
  the push, because that is where `gh auth setup-git` writes the credential helper.
- **Commit messages are not sanitised, and cannot be.** The PR body puts them inside a
  code fence sized to their content, so `Closes #12` and `@mentions` in agent prose do not
  close tickets or notify people from the body. GitHub also scans commit messages
  themselves on merge, and rewriting those would destroy the artefact. **That gap is
  real and reportable**; this ADR does not settle it.
- **Push and pull-request creation are one interface method but two operations**, so
  there is a window in which the branch is on the remote and the pull request is not. The
  run says so on its timeline and the `changes` row stays null, which reads correctly —
  unpublished — but the branch is left behind. Deleting it on failure was rejected: the
  push is the expensive, fragile half, and throwing it away to tidy up would mean a
  transient `gh` failure discards work that had already arrived. Re-running the worker
  produces a new run id and therefore a new branch rather than colliding with it.
- **A runner with no local checkout of a project cannot publish for it.** It could clone
  from the remote and push from that, but the first thing that path would do for the first
  time is push to somebody's default remote, and nothing exercises it. The patch survives
  and the run says so on its timeline; `ogun project add` on that machine fixes it. Not
  settled, just not built.
- **Nothing prunes `scratch/patches/` still.** The publisher is the step that knows a patch
  has been consumed, but the patch is also an `artifacts` row served from the run detail
  page, so deleting it there would break the review surface. Open, and the same gap
  transcripts have.
- **`directPush: true` has no implementation.** Nothing in the publisher can write to a
  branch it did not construct, and the `ogun/` prefix means it never constructs the default
  branch. The policy is checked anyway, against the one case the prefix does not cover — a
  project whose default branch is itself under `ogun/` — so that a direct-push path, if one
  is ever built, finds the gate already in the right shape.
