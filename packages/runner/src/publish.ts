import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PinnedPolicies, RunOutcome } from '@ogun/core'
import { GIT_HARDENING, RUNNER_IDENTITY, gitIn } from './workspace.ts'

const run = promisify(execFile)

/**
 * Putting a modifier's work back into a repository, on the host, after the container has
 * exited (ADR-0005, §5.3's second half).
 *
 * The mirror of `patch.ts`. Extraction turns a workspace the runner is about to delete
 * into an mbox on disk; this turns that mbox into a branch on the remote and a draft pull
 * request. Between them they are the whole of the crossing, and the container is on
 * neither end of it: it has no remote and no credential, so the only way its work reaches
 * GitHub is through these two files.
 *
 *   patch → scratch worktree → git am → push → gh pr create --draft
 *
 * **A scratch worktree of the project's own checkout, not a fresh clone.** The worktree
 * shares the object store, so `git am` costs nothing to set up and the commits it writes
 * are already in the repository the push reads from. It is also the only arrangement in
 * which the user's actual working tree is never touched: `git worktree add --detach`
 * checks the base out somewhere else entirely, so a publish that lands while you are
 * mid-edit does not stage, stash, or check out anything under you.
 *
 * **Nothing is rebased.** The branch is the agent's commits on top of the commit the
 * workspace was pinned to, even when the default branch has moved since. A pull request
 * from a slightly stale base is what every human contributor opens; resolving conflicts
 * unattended, at 3am, against a tree nobody reviewed, is not something this should be
 * able to do.
 *
 * **No local branch is created.** The push is `HEAD:refs/heads/<branch>` from the scratch
 * worktree, so the branch exists on the remote and nowhere else. Ogun proposes; it does
 * not leave forty stale branches in your checkout to prove it.
 */

/**
 * Every branch this ever creates begins here, and the prefix is load-bearing twice over.
 *
 * It is how the PR cap recognises Ogun's own pull requests without asking who authored
 * them — the three planned credential implementations authenticate as three different
 * identities (a personal `gh` login, a GitHub App installation, a proxy), and a cap that
 * counted by author would silently start counting nothing the first time that changed.
 * The branch name is the one part that stays the same.
 *
 * It is also what makes "never push to the default branch" true by construction rather
 * than by a check: a ref under `ogun/` is not `main`.
 */
export const BRANCH_PREFIX = 'ogun/'

/**
 * What the publisher did, in the same shape `PatchExtraction` uses: the thing it produced
 * when it worked, and a reason when it did not.
 *
 * `refused` is set for every non-publish, including the ordinary ones — a run the gate
 * rejected, a project whose cap is full. It is not an error channel. A caller that wants
 * to know why there is no pull request has exactly one place to look, and the difference
 * between "the suite failed" and "no suite result was recorded" survives to the timeline
 * instead of being flattened into a boolean (principle 6).
 */
export type Publication = {
  pr?: { branch: string; url: string }
  /** Always set when `pr` is absent. Written to be read by a person, on the run timeline. */
  refused?: string
}

/**
 * The one thing in the publisher that holds a credential.
 *
 * Everything else in this file — the gates, the worktree, `git am`, the branch name — is
 * ordinary local work that needs no secret and can be tested without one. This type is
 * where that stops, and it is deliberately the smallest surface that can still do the
 * job: count what Ogun already has open, and get one branch to the remote with a draft
 * pull request on it.
 *
 * There is exactly one implementation today, `githubCli`, which shells out to the host's
 * `git` and `gh`. Two more are expected, and the seam exists so that they arrive as new
 * implementations of these two methods rather than as a rewrite of the publisher:
 *
 *   - **A short-lived, repo-scoped GitHub App installation token.** The condition is a
 *     runner that is not the machine you are sitting at. `gh`'s credential is a person's,
 *     it is long-lived, and it can reach every repository that person can — fine while
 *     the runner is your laptop and the blast radius is your own account, wrong the
 *     moment a runner is a box in a cupboard. An installation token is scoped to one
 *     repository and expires in an hour.
 *   - **A credential-injecting proxy**, when a runner should not hold a credential at
 *     all — the same argument ADR-0005 makes about the container, applied one level out.
 *
 * Neither is built, and neither should be built before its condition is met. What matters
 * now is that adding one means writing `push` and `count` against a token instead of
 * against a CLI, and touching nothing that decides *whether* to publish.
 */
export type PublishRemote = {
  /**
   * Pull requests open on this repository right now whose head branch starts with
   * `branchPrefix`. Read live and written down nowhere (ADR-0004) — merging or closing one
   * has to make room immediately, and a mirrored count would be the copy that is wrong.
   */
  countOpenPullRequests(input: { repo: string; branchPrefix: string }): Promise<number>
  /** Get `from`'s HEAD to the remote as `branch`, and open a draft pull request for it. */
  publish(input: {
    /** The project's checkout on this host. How the remote and its credential are found. */
    repo: string
    /** The scratch worktree holding the applied commits. Its HEAD is what goes up. */
    from: string
    branch: string
    /** The branch the pull request targets — the project's default branch. */
    base: string
    title: string
    body: string
  }): Promise<{ url: string }>
}

/**
 * Branch-name characters, and the reason this is an allowlist rather than an escape.
 *
 * The name reaches `git push` and `gh pr create` as argv. Nothing here is interpolated
 * into a shell — every call in this file is `execFile` — so the classic quoting attack is
 * already dead. What is not dead is **argument injection**: a name beginning with `-` is
 * read by git as an option, and `--upload-pack=<command>` on a push is arbitrary code on
 * whatever the other end is. A worker name is project config today, but a branch derived
 * from anything an agent wrote is one feature away, and by then this file will not be the
 * one anybody re-reads.
 *
 * So the name is *built*, never *passed through*: everything outside `[a-z0-9._-]`
 * becomes a hyphen, and `BRANCH_SHAPE` below re-checks the finished string. Two layers
 * because the sanitizer is what produces the name and the shape is what proves it — an
 * edit that quietly widens the first is caught by the second, and the test suite asserts
 * against the second.
 */
const MAX_COMPONENT = 40

/** The only branch names this module is allowed to emit, checked after they are built. */
const BRANCH_SHAPE = /^ogun\/[a-z0-9][a-z0-9._-]*\/[a-z0-9]{4,}$/

/** A base commit is a hex object name and nothing else — it is also handed to git. */
const SHA_SHAPE = /^[0-9a-f]{7,40}$/

function slug(raw: string): string {
  let out = raw
    .toLowerCase()
    // Anything not in the allowlist, which includes every leading `-`, every quote,
    // every space, every path separator, and everything git's ref rules forbid.
    .replace(/[^a-z0-9._-]+/g, '-')
    // `..` and `@{` are illegal in a ref; `..` is also how a path escapes a directory,
    // and this string ends up in one.
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_COMPONENT)

  // Loop rather than one pass: trimming `.lock` can expose a separator and trimming a
  // separator can expose `.lock`. Git rejects a ref component that ends either way.
  let previous = ''
  while (out !== previous) {
    previous = out
    out = out.replace(/^[-._]+/, '').replace(/[-._]+$/, '').replace(/\.lock$/, '')
  }
  return out
}

/**
 * `ogun/<worker>/<run>` — the prefix that identifies Ogun's branches, the worker so a
 * person can tell what opened it, and the run id so two nights of the same worker never
 * collide. Nothing is derived from the diff or from anything the agent wrote.
 */
export function branchFor(input: { workerName: string; runId: string }): string {
  // `modifier` rather than a throw: a worker whose entire name is punctuation is a silly
  // config, not a reason to strand a patch that already passed every gate.
  const worker = slug(input.workerName) || 'modifier'
  const run = input.runId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  const branch = `${BRANCH_PREFIX}${worker}/${run}`
  if (!BRANCH_SHAPE.test(branch)) {
    // Reached only if the sanitizer above stops doing its job, which is the case worth
    // failing loudly on — a branch name that got here unsanitised is an argument to git.
    throw new Error(`refusing to use "${branch}" as a branch name`)
  }
  return branch
}

export async function publishPatch(input: {
  /** The project's checkout on this host. The worktree and the push both come from it. */
  repo: string
  /** The runner's scratch root; the worktree is made under it and removed after. */
  scratch: string
  runId: string
  workerName: string
  /** What the pull request targets, and what must never be pushed to. */
  defaultBranch: string
  /** The commit the workspace was pinned to and the patch was made against. */
  baseSha: string
  /** Path to the `git format-patch` mbox `extractPatch` wrote. */
  patchRef: string
  /**
   * The outcome **the control plane recorded**, not the one the runner proposed. The two
   * differ exactly when a gate failed, and that difference is the whole reason this is a
   * parameter rather than something read off the report.
   */
  outcome: RunOutcome
  /** The two test columns as reported, absent and false kept apart on purpose. */
  tests: { run?: boolean; passed?: boolean }
  /** From the blob at `baseSha`. `undefined` means it could not be read, and refuses. */
  policies?: PinnedPolicies
  remote: PublishRemote
}): Promise<Publication> {
  const gate = refuseBefore(input)
  if (gate) return { refused: gate }
  // Narrowed by `refuseBefore`, which returns a reason when it is absent.
  const policies = input.policies!

  const branch = branchFor({ workerName: input.workerName, runId: input.runId })

  /**
   * The prefix already makes this impossible, and it is checked anyway. **Kept
   * deliberately** — the question was asked, so here is the answer.
   *
   * `directPush: false` is the rule that Ogun proposes rather than pushes, and the only
   * way this module could break it is a project whose default branch is itself under
   * `ogun/`. That is a legal branch name — `git branch -m ogun/fixer/a1b2c3d4e5f6` costs
   * nothing and nothing warns — and it is the one case `branchFor`'s structure does not
   * cover. It is not a hypothetical the check has to be justified by, either: the branch
   * this publisher would then push to is the branch the pull request would target, so
   * without this the failure is Ogun writing straight onto a project's default branch
   * with no review, which is the single thing §4.6 promises it will never do.
   *
   * So it is a guard against a narrow case rather than a check that cannot fire, and it
   * is exercised: `publish.test.ts`'s "a default branch that collides with a published
   * branch" constructs exactly that project and asserts the refusal. A check nobody can
   * make run would be the other answer to this question, and it is not this one.
   *
   * Written against the policy rather than against the prefix, so that if a direct-push
   * path is ever built it finds the gate already in the right shape. Which is the other
   * half of the honesty owed here: **there is no `directPush: true` path**. Nothing in
   * this file can write to a branch it did not construct, so a project setting the flag
   * gets the same draft pull request as a project that never heard of it. That is
   * recorded on the schema, where somebody writing the line will read it, and
   * `ogun project sync` says it out loud (`inertPolicies`) — a flag that silently does
   * nothing being the exact failure this file's neighbours were fixed for.
   */
  if (!policies.directPush && branch === input.defaultBranch) {
    return {
      refused:
        `refusing to publish onto "${branch}", which is this project's default branch, ` +
        'because policies.directPush is false',
    }
  }

  const worktree = join(input.scratch, 'publish', input.runId)
  /**
   * Stale entries from a runner that was killed mid-publish. `worktree add` refuses a
   * path git still believes is registered, so without this one crash makes every later
   * publish of that run fail on a directory that is not there any more.
   */
  await hostGit(input.repo, ['worktree', 'prune'])
  await rm(worktree, { recursive: true, force: true })
  await mkdir(join(input.scratch, 'publish'), { recursive: true })

  try {
    await hostGit(input.repo, ['worktree', 'add', '--detach', worktree, input.baseSha])

    /**
     * `git am` under the same hardening every other git call in a workspace gets.
     *
     * The tree this is applying *into* is a worktree of the user's real repository, whose
     * config and hooks are theirs and not an agent's — so the immediate exposure is
     * smaller than extraction's. It is not zero: a worktree shares `.git/config` and
     * `core.hooksPath` with the main checkout, `am` runs `applypatch-msg`,
     * `pre-applypatch` and `post-applypatch`, and this is a repository that a previous
     * publish, a previous `worktree` sandbox run, or a merged agent patch has all been
     * able to write to. The cost of neutralising it is one array.
     *
     * `--` so a patch path can never be read as an option, and `RUNNER_IDENTITY` because
     * `GIT_ENV` blanks the global config and `am` needs a committer to exist.
     */
    let applyFailure: string | undefined
    try {
      await gitIn(worktree, [...RUNNER_IDENTITY, 'am', '--', input.patchRef])
    } catch (err) {
      applyFailure = err instanceof Error ? err.message : String(err)
    }

    if (applyFailure) {
      // Otherwise the half-applied `rebase-apply` state stays behind, and the *next*
      // publish into a worktree at this path fails with a message about an operation
      // nobody started.
      await gitIn(worktree, ['am', '--abort']).catch(() => undefined)
      return {
        refused:
          `the patch does not apply to ${input.baseSha.slice(0, 12)}: ` +
          `${applyFailure.slice(-600)}`,
      }
    }

    /**
     * A patch that applied and changed nothing.
     *
     * Extraction already refuses to write a patch for a tree that does not differ from
     * its base, so this should be unreachable — but the two checks are made against
     * different trees at different times, and the one thing worse than no pull request is
     * an empty one that a person has to open to discover is empty.
     */
    const head = (await gitIn(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
    if (head === input.baseSha) {
      return { refused: 'the patch applied cleanly and left the tree identical to its base' }
    }

    /**
     * The cap, read last and read live.
     *
     * Deliberately after the patch has been applied rather than before it, even though
     * that means doing local work that may be thrown away. Two reasons, and the second is
     * the real one: a patch that does not apply is a defect worth reporting whether or not
     * the cap happens to be full, and this is the last moment before the irreversible
     * step, so the count is as fresh as it can be. Closing a pull request while a run is
     * in flight should make room for it.
     */
    const open = await input.remote.countOpenPullRequests({
      repo: input.repo,
      branchPrefix: BRANCH_PREFIX,
    })
    if (open >= policies.maxOpenPullRequests) {
      return {
        refused:
          `${open} ogun pull request(s) are already open and policies.maxOpenPullRequests ` +
          `is ${policies.maxOpenPullRequests}. The patch is kept at ${input.patchRef}; ` +
          'merging or closing one of them makes room.',
      }
    }

    // `--reverse` on both, so the pull request reads in the order the agent worked rather
    // than backwards, which is how `git log` would give it.
    const range = `${input.baseSha}..HEAD`
    const log = (await gitIn(worktree, ['log', '--reverse', '--format=%s%n%b%n', range])).stdout
    const subjects = (await gitIn(worktree, ['log', '--reverse', '--format=%s', range])).stdout
      .split('\n')
      .filter(Boolean)

    const { url } = await input.remote.publish({
      repo: input.repo,
      from: worktree,
      branch,
      base: input.defaultBranch,
      title: titleFor(subjects, input.workerName),
      body: bodyFor({
        workerName: input.workerName,
        runId: input.runId,
        baseSha: input.baseSha,
        branch,
        commits: subjects.length,
        log,
      }),
    })
    return { pr: { branch, url } }
  } finally {
    // Whatever happened. The objects `am` wrote live in the shared store and are either
    // pushed or unreferenced; what must not survive is a registered worktree pointing at
    // scratch, because that is what makes the *next* publish fail.
    await hostGit(input.repo, ['worktree', 'remove', '--force', worktree]).catch(() => undefined)
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
    await hostGit(input.repo, ['worktree', 'prune']).catch(() => undefined)
  }
}

/**
 * Every reason to refuse that can be decided without touching the repository, in the
 * order that produces the most useful message.
 *
 * Split out from `publishPatch` so the gates read as a list. They are the point of this
 * module — the mechanics below them are five git commands and could be written by anyone.
 */
function refuseBefore(input: {
  outcome: RunOutcome
  tests: { run?: boolean; passed?: boolean }
  policies?: PinnedPolicies
  patchRef: string
  baseSha: string
}): string | undefined {
  /**
   * The run's terminal outcome, and nothing else, decides whether there is anything to
   * publish.
   *
   * A `changes` row is an artifact record and not a work queue (§4.4): one exists for a
   * gate-failed run, for a run whose patch was too large to extract, and for a run that
   * changed nothing. `dispatched` means exactly "there is a patch waiting for the
   * publisher" (§5.2), and it is the only value that does. In particular a gate failure
   * derives `dispatched` down to `changes-requested` in `finalizeRun` — which is why this
   * takes the outcome the control plane recorded rather than the one the runner proposed.
   * Reading "there is a patch on disk" as "open a pull request" would publish all four.
   */
  if (input.outcome !== 'dispatched') {
    return (
      `this run is recorded as "${input.outcome}", not "dispatched" — only a run that ` +
      'ended with a patch the gate accepted is publishable'
    )
  }

  if (!input.patchRef) return 'the run reported no patch to publish'

  /**
   * The base commit is handed straight to `git worktree add` as a revision, so it is
   * checked to be what it claims to be before it gets there.
   *
   * It comes from this runner's own extraction today, which is why this is a guard rather
   * than a fix. `publishPatch` is exported and a retry path that reads `changes.base_sha`
   * back out of postgres is an obvious next caller — at which point the value has been
   * round-tripped through a database and is no longer something this file established.
   */
  if (!SHA_SHAPE.test(input.baseSha)) {
    return `"${input.baseSha.slice(0, 60)}" is not an object name, so there is nothing to apply to`
  }

  /**
   * The policy could not be established, so nothing here knows what the cap is.
   *
   * Refusing is the fail-closed direction and the cheap mistake: the patch is still on
   * disk, the `changes` row still exists, and a fixed `config.yaml` makes the run
   * publishable again. Guessing at the defaults instead would mean a project that had
   * carefully set `maxOpenPullRequests: 0` gets three pull requests the morning after
   * somebody breaks the YAML.
   */
  if (!input.policies) {
    return (
      'this project\'s .ogun/config.yaml at the pinned base could not be read, so ' +
      'policies.maxOpenPullRequests could not be established. Nothing is published on a ' +
      'guessed policy.'
    )
  }

  /**
   * The tests gate, and the whole reason it is three cases rather than two.
   *
   * `tests_passed` is nullable and **null is not false**. The column carries null for a
   * run recorded before the gate existed and for a run whose patch could not be
   * extracted — both of which said nothing at all about tests. Refusing on the absence of
   * evidence and refusing on evidence are different acts, and reporting them with the
   * same sentence is the collapse principle 6 exists to forbid: one of them is fixed by
   * re-running, and the other is fixed by fixing the code.
   *
   * All three refuse. That is not the part worth getting right — a publisher that
   * published on null would be trusting a silence. What is worth getting right is that a
   * person reading the timeline can tell which silence they are looking at.
   */
  if (input.tests.passed === undefined) {
    return (
      'this run recorded no test result at all — not a failure, an absence. Both test ' +
      'columns are null, which is what a run predating the tests gate looks like and what ' +
      'a run whose patch could not be extracted looks like. There is no evidence to ' +
      'publish on, so nothing is published; re-running the worker produces some.'
    )
  }
  if (input.tests.run === false) {
    return (
      "the project's suite never executed against this tree, so nothing showed the patch " +
      'works. That is a broken gate rather than a red one — check the run\'s tests note ' +
      'for why the command did not start.'
    )
  }
  if (!input.tests.passed) {
    return "the project's suite failed on this tree"
  }

  return undefined
}

/**
 * What the pull request is called.
 *
 * One commit lends its subject, which is the agent's own words and the best summary that
 * exists. More than one gets a manufactured line instead of the first subject, because
 * "Fix the retry loop" on a branch that also rewrote the scheduler is a title that
 * misleads exactly the person it is meant to inform.
 *
 * Agent-authored either way, so it is bounded and stripped of control characters. Not
 * because it reaches a shell — nothing here does — but because a subject containing a
 * newline turns into a `gh` argument that is two lines, and a title of 4000 characters is
 * rejected by the API after the branch has already been pushed.
 */
function titleFor(subjects: string[], workerName: string): string {
  const one = subjects.length === 1 ? clean(subjects[0] ?? '') : ''
  if (one) return one.slice(0, 120)
  return `${clean(workerName).slice(0, 60) || 'ogun'}: ${subjects.length} commit(s)`
}

/**
 * What the pull request says, and the one place agent prose is embedded in something
 * GitHub interprets.
 *
 * The commit messages go inside a code fence, and that is a real guard rather than
 * formatting. A pull request body is scanned for closing keywords — `Closes #12` in the
 * body closes issue 12 when the branch merges — and for `@mentions`, which notify people.
 * An agent writing either is not even malicious; "Fixes #14" is the most natural sentence
 * in the world for a bug-fix commit, and it should not silently close a ticket nobody
 * connected to this work. GitHub does not process either inside a fence.
 *
 * The fence is sized to the content, so a commit message that itself contains ``` cannot
 * end it early and escape into interpreted markdown.
 *
 * This does not cover the commit messages *themselves*, which GitHub also scans on merge
 * and which nothing here can rewrite without destroying the artefact. That is a real
 * remaining gap and it is recorded in ADR-0009 rather than hidden here.
 */
function bodyFor(input: {
  workerName: string
  runId: string
  baseSha: string
  branch: string
  commits: number
  log: string
}): string {
  const text = clean(input.log, { newlines: true }).slice(0, 50_000)
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  return [
    `Opened by the ogun modifier worker \`${clean(input.workerName).slice(0, 60)}\`.`,
    '',
    `- run \`${input.runId}\``,
    `- base \`${input.baseSha.slice(0, 12)}\` on \`${input.branch}\``,
    `- ${input.commits} commit(s); the project's suite passed on this tree`,
    '',
    'Nobody has read this. It is a draft because an agent wrote it and the only thing',
    "that has looked at it is the project's own test suite.",
    '',
    'What the agent said it did, verbatim:',
    '',
    fence,
    text.trim(),
    fence,
    '',
  ].join('\n')
}

const longestBacktickRun = (text: string): number =>
  Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))

/**
 * Control characters out of anything an agent wrote before it becomes an argument or a
 * document. ANSI escapes in particular: a runtime's output reaches a commit message more
 * often than you would think, and a terminal is one of the things that renders a PR body.
 */
function clean(raw: string, opts: { newlines?: boolean } = {}): string {
  const controls = opts.newlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/g
    : /[\u0000-\u001f\u007f]/g
  return opts.newlines
    ? raw.replace(controls, '')
    : raw.replace(controls, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Git run against the *project's* repository rather than against a workspace.
 *
 * Same hardening arguments as `gitIn` — this repository has been written to by merged
 * agent patches and by every previous publish — but **not** `GIT_ENV`. That is the
 * difference that matters and the reason this is not just `gitIn`: `GIT_ENV` points
 * `GIT_CONFIG_GLOBAL` at `/dev/null`, and the host's global config is where
 * `gh auth setup-git` writes the credential helper. Blanking it here would break
 * authentication for the one command whose entire job is to authenticate.
 *
 * `GIT_TERMINAL_PROMPT=0` for the same reason it is in `GIT_ENV`, and it matters more
 * here: a push with no usable credential must fail in a second, not sit on a hidden
 * prompt holding a nightly run open until morning.
 */
async function hostGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', [...GIT_HARDENING, '-C', cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

const GH_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // gh prints an update banner on stderr and will happily prompt on a tty. Neither is
  // wanted from a process nobody is watching.
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
}

/**
 * The only implementation of `PublishRemote` today: the host's `git` and `gh`, using
 * whatever credential the person who set this machine up already has.
 *
 * Right for exactly the situation Ogun is in — a runner that is your own machine, a `gh`
 * you already authenticated for your own work, and no second secret to store, rotate, or
 * leak. Wrong the moment the runner is somewhere else, which is the condition ADR-0009
 * records for the second implementation.
 */
export function githubCli(): PublishRemote {
  return {
    async countOpenPullRequests({ repo, branchPrefix }) {
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'headRefName'],
        { cwd: repo, env: GH_ENV, maxBuffer: 4 * 1024 * 1024 },
      )
      const rows = JSON.parse(stdout) as Array<{ headRefName?: string }>
      // Counted by branch prefix, not by author — see BRANCH_PREFIX. The 100 ceiling is
      // fine for a cap that is meant to be a single digit; a project already past it is
      // over any cap worth setting.
      return rows.filter((r) => (r.headRefName ?? '').startsWith(branchPrefix)).length
    },

    async publish({ repo, from, branch, base, title, body }) {
      /**
       * Fully qualified on both sides. `HEAD:refs/heads/x` cannot be resolved as anything
       * other than a branch called `x`, where a bare `HEAD:x` would consult the remote's
       * refs and could land somewhere else entirely.
       *
       * Pushed from the scratch worktree, so what goes up is the applied patch and not
       * whatever the project's checkout happens to have open. No `--force`: a branch that
       * already exists means a run id collided or a publish is being retried over
       * something, and both deserve a failure rather than an overwrite.
       */
      await hostGit(from, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`])

      /**
       * Through a file rather than an argument. Commit messages are unbounded, an argv
       * over ARG_MAX fails with an errno instead of with anything readable, and the body
       * is the one input here that is entirely agent-written.
       *
       * Not inside the worktree: `git worktree add` makes `.git` a file rather than a
       * directory, so there is no ignored place to put it there, and a stray file in the
       * tree would be picked up by anything that looks at status.
       */
      const staging = await mkdtemp(join(tmpdir(), 'ogun-pr-'))
      try {
        const bodyFile = join(staging, 'body.md')
        await writeFile(bodyFile, body, { mode: 0o600 })

        const { stdout } = await run(
          'gh',
          [
            'pr',
            'create',
            '--draft',
            '--base',
            base,
            '--head',
            branch,
            '--title',
            title,
            '--body-file',
            bodyFile,
          ],
          { cwd: repo, env: GH_ENV },
        )
        // gh prints the URL last, after whatever else it felt like saying.
        const url = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('http'))
          .pop()
        if (!url) {
          throw new Error(`gh pr create printed no pull request url: ${stdout.slice(-400)}`)
        }
        return { url }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}
