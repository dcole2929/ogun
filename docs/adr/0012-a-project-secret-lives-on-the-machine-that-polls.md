---
status: accepted
---

# A project secret lives on the machine that polls, not in the database

Every credential Ogun has needed so far was already on the machine because a human logged
in with it. `~/.claude/.credentials.json`, `~/.codex/auth.json`, `gh auth login` — ADR-0010
only had to decide *who reads them* and how to keep them out of a container. Nothing had to
be stored, because nothing had to be typed in.

Phase 4 breaks that. Ogun is about to poll Linear (§4.13), and a Linear API key is issued
per workspace: nobody's home directory has one, no CLI refreshes one, and there is no file
to read. It has to be entered once and kept. That makes containment Ogun's problem rather
than the operating system's, and it forces a decision about where the value sits.

**It sits in `~/.ogun/config.json`, under `secrets`, keyed by project slug and then by
secret name, on the machine running the control plane.** Mode 0600, beside the admin token
and the runner credential. It is never written to postgres, never sent over the runner
protocol, never returned by an API, and never mounted into a container.

The argument is short: **the control plane is what polls.** §4.13 is explicit that a source
polls host-side with a deterministic filter *before any AI sees a ticket*, so the process
that needs the key and the file that holds it are the same process on the same box, and
they move together. `server.token` is already exactly this shape — a secret that belongs to
whichever machine is currently the control plane, generated there, read there, and re-made
rather than migrated when the control plane moves. A polling key is the same kind of thing
wearing a project's name.

That the key is *about* a project rather than about a machine is the honest cost, and it is
recorded rather than argued away. `~/.ogun/config.json`'s own doc comment says paths live
there because `/home/doug/dev/x` and `/Users/doug/dev/x` are the same project — a rule
about machine facts, and this is not one. What follows from the mismatch is that moving the
control plane to a VPS (ADR-0001) means re-entering the key there. That is the right
behaviour for a credential anyway: a secret that migrates itself is a secret in a backup.

## Considered Options

- **The database, encrypted at rest, with the key held machine-side.** The serious
  alternative, and it loses on three counts.

  It does not remove the machine-local file, it adds a store on top of one. The encryption
  key has to live somewhere the control plane can read without a person present, which is
  `~/.ogun/config.json` — so the design is "two stores, both required" rather than "one
  store that survives the move". And on a single host, which is what §9 and ADR-0003
  describe, the encryption protects against an attacker who can read postgres but not the
  file. That attacker does not exist: the database runs in a container next to the server,
  as the same user, and anything that can reach one can read the other.

  The failure mode it would have bought is a fourth read state. Today a read is `present`,
  `absent`, `empty` or `unreadable`; encryption adds *present but undecryptable*, and the
  day it appears is the day someone restores a `pg_dump` onto a rebuilt machine and the
  poller stops with an authentication error that names Linear. Principle 6 says those must
  never share a name, and this one is the hardest of them to name correctly, because from
  inside the decryption there is no way to tell a rotated key from a corrupted ciphertext
  from a value that was never encrypted with this key at all.

  And it puts the value in a row. `projects` is already returned by `GET /api/projects`,
  already selected by `applySync`, already read by the foreman. A column on a travelling
  row is a value that leaves by being attached to something else — which is the exact
  shape of the leak `bbaa036` was merged for, where a credential rode out inside an error
  message nobody thought of as carrying one. Keeping it out of the schema means no
  `select *`, no serializer, no `pg_dump`, and no future endpoint can ever return it by
  accident.

- **`.ogun/config.yaml`, the project's own config file.** Rejected on sight, and named here
  only because it is where a reader would first look for a per-project setting. That file
  is committed, reviewed in a pull request, and edited in place by the UI. A secret there
  is a secret in someone's repository and in every clone of it, permanently.

- **An environment variable on the server process, `OGUN_LINEAR_TOKEN`.** Rejected — it is
  how the GitHub token is supplied today (`OGUN_GATEWAY_GITHUB_TOKEN`), so it has
  precedent. It does not scale past one project: the whole point is that the key is
  per-workspace, and `OGUN_LINEAR_TOKEN_<SLUG>` is a store with no schema, no listing, and
  no way to say which projects have one. It also puts the value in the supervisor unit
  file, which is usually in git.

- **A dedicated secrets file, `~/.ogun/secrets.json`.** Rejected — §4.5 settles that this
  machine has one file, after briefly having two that could disagree. More concretely, a
  new file would re-inherit two bugs `updateLocalConfig` has already had fixed: `writeFile`'s
  `mode` applies only on create, so a file that already existed at 0644 stayed there while
  credentials were written into it; and concurrent read-modify-write silently dropped
  whichever edit lost the race. Neither was cheap to get right. Writing through the existing
  path inherits both fixes, and the lock that serialises them.

- **An external secret manager — `pass`, 1Password, the system keyring.** Rejected for now,
  and this is the one deliberately left open. It is strictly better storage and it is a
  dependency on something the host may not have, which §8 is careful about. The seam is
  `readProjectSecret`: it returns a state and a sealed value, so a keyring implementation is
  a second branch inside one function rather than a change at the call sites. A finding that
  Ogun should support one is a real finding.

- **Handing the secret to the runner so a job could use it.** Rejected, and it is worth
  saying out loud because it is the obvious next request. §4.13 puts the filter host-side
  *before any AI sees a ticket*, so an agent never needs a Linear key — it is handed a
  prompt built from a ticket that already passed a deterministic filter. Granting one would
  reopen ADR-0010 through a door it does not cover: the gateway splices credentials for
  three providers it knows about, and a project-supplied key would have to be injected by
  configuration, which is a policy engine ADR-0010 already rejected.

## Consequences

- **Reading is one function, and it is total.** `readProjectSecret(projectSlug, name)`
  returns `present | absent | empty | unreadable` and never throws.

  [amended — ADR-0014] It now also returns `granted`, `unconnected` and `malformed`, for
  the OAuth grant that became the preferred way to reach Linear. The shape of this record
  is unchanged: still one function, still total, still the seam a keyring implementation
  would slot into. What ADR-0014 adds is that the same function decides *which* credential
  a poll uses — a grant wins over a key — so precedence cannot be answered differently by
  the poll, `doctor` and the UI. Four states because
  they have four fixes, and because a poller is a loop at 2am whose nearest `catch` would
  otherwise report a missing key as "Linear is unreachable". `empty` is only reachable by
  hand-editing the file, which §4.5 says people do, and it is kept separate from `absent`
  because one means "you have not set it" and the other means "something wrote a blank over
  the one you set".

- **A present secret arrives sealed, not as a string.** `Secret` holds its value in a
  closure and answers `[redacted]` to `toString`, `toJSON` and Node's inspector, so it
  survives `console.error('poll failed', { key })`, an assertion diff, and a printed cause
  chain without disclosing anything. `expose()` is the only way out and is meant to appear
  once per consumer, at the wire. This is `redactUrlCredentials`'s lesson applied before the
  leak rather than after: the failure there was not disclosure to a new audience, it was
  loss of containment into logs and transcripts that nothing cleans.

- **Rotation is setting it again, in place, with no history.** A rotation window belongs to
  the provider — Linear's answer is a second key and a revocation — and two live values in
  one store would mean that when a poll 401s, nothing can say which one it used. The next
  poll reads the new value; there is no restart and no cache. A superseded key is gone from
  the file rather than kept, because one that is still accepted is a live credential nobody
  is watching, and it would be in every backup of the machine.

- **Listing exists, and cannot return a value.** `doctor`, `GET /api/system` and the
  Settings page all need to say a project *has* a key. They read
  `ProjectSecretPresence`, which has `project`, `name` and `state` and no field a value
  fits in — so a future editor cannot leak one by adding a column. The value-returning
  function is reachable from the control plane's polling code and from no HTTP route at
  all.

- **Nothing reports what is *missing*.** Which projects need a Linear key is declared in
  each repository's `.ogun/config.yaml`, and neither `doctor` nor the system endpoint reads
  repositories. Both say so on the line rather than letting a green check imply coverage
  they never had. When the Linear source lands and the control plane knows which projects
  have one configured, saying "configured to poll, no key" becomes possible and is worth
  doing; it is not possible now, and guessing would be the absence-of-evidence mistake the
  credential preflight was built to avoid.

- **Setting is `ogun connect <integration>`, on the control-plane machine.** [amended —
  ADR-0014: this bullet said `ogun secret set <name>`; the namespace was subsumed, see the
  amendment above.] There is no route that accepts a
  secret, because a value in a request body is a value in a reverse proxy's access log and
  in a browser's network panel. The UI shows presence and points at the command. **This is
  a real gap for a remote control plane** — the operator has to reach a shell on that
  machine — and it is named rather than hidden. Closing it means an authenticated POST over
  TLS and a decision about request logging; a finding that the UI should be able to set one
  is a real finding.

  [amended] It is now closed, on the condition this bullet named. The sentence above —
  *"There is no route that accepts a secret, because a value in a request body is a value
  in a reverse proxy's access log and in a browser's network panel"* — gave one reason and
  two reasons that do not survive being checked against the code:

  - **Ogun's own log is not the leak.** `hono/logger` writes method, path and status.
    Nothing in the server logs a request body. That is also why the value goes in the body
    and never in the path: the path is the one part of a request this process does write to
    its journal, so `PUT /api/system/secrets/:project/:name` carries a slug and a name and
    nothing else.
  - **A proxy's access log is the operator's configuration, not Ogun's.** It is a real
    hazard, and it is one they chose, can see, and can turn off. Declining to have the
    feature does not remove their proxy; it sends them to a terminal and leaves the proxy
    exactly as it was.
  - **The browser's network panel shows the value to the person who just typed it.** That
    is not a disclosure. It is the same screen the key was pasted into.

  What is left is the one that was always load-bearing: **a secret crossing a network in
  cleartext.** Ogun serves plain HTTP — there is no TLS listener anywhere in the process —
  so the condition is the transport, not the existence of a route. `secretWriteTransport`
  in `packages/server/src/auth.ts` allows a write on a loopback bind, where the request
  never reaches an interface and the only attacker who could read it can already read
  `~/.ogun/config.json` at 0600 as this user; and refuses it on a wider one unless the
  operator has declared a TLS terminator in front with `OGUN_BEHIND_TLS_PROXY`. The refusal
  names `ogun secret set`, because a refusal on the only surface a remote operator has
  must not be a dead end.

  Deliberately **not** `x-forwarded-proto: https`. That header is written by whoever is
  speaking to us, and on the exact deployment the guard exists for — plain HTTP straight
  off a LAN — that is the client. A guard a request can switch off by asserting it is safe
  is a comment, not a guard. The environment is the one input to the decision that nothing
  on the wire can supply.

  Considered and rejected: allowing it on any bind, on the grounds that a token-protected
  control plane on plain HTTP already puts an admin token — which can define a worker,
  which is to say execute code on the host — on the wire with every request, so an
  eavesdropper who could take the Linear key already owns the machine. Nearly right, and it
  loses on blast radius: the admin token's is this host, and a project's Linear key is a
  credential in a third party's workspace that this operator may not even be able to
  revoke. Adding a new class of victim to an already-compromised channel is a fresh loss
  rather than a rounding error on an existing one, and the alternative costs one `ssh`.

  What the route does *not* change is anything else in this record. It goes through
  `setProjectSecret` and therefore through `updateLocalConfig`'s lock — one writer, not a
  second one racing the first. It validates the name against `SECRET_NAMES` and the project
  against the database, because it has a handle — the CLI checks the same fact against the
  local evidence it has instead, which is the amendment below. It returns presence and a
  character count and has no field a value fits in.
  Removal has no transport condition at all: a delete carries nothing towards the wire, and
  gating it would refuse a remote operator the one action that makes a leaked key harmless.

  [amended] The command spelling in this bullet is now `ogun secret set <name>`, and the
  project it writes under is checked. Three things about `ogun project secret set <project>
  <name>` were wrong and one of them was a hole:

  - **An unknown slug was stored in silence.** `ogun project secret set heirchive-api
    linear` on a machine whose only project was `ogun` printed `linear set for
    heirchive-api (23 characters)` and left a live key in `~/.ogun/config.json` where
    nothing would ever read it. That is the failure `SECRET_NAMES` is a closed set to
    prevent — "a secret nothing reads looks exactly like one that works, right up until the
    night it mattered" — reasoned about the secret's *name* and never about its *project*.

    The stated reason for not checking was that the CLI runs with no database. True, and it
    does not follow: `~/.ogun/config.json` carries the projects map that `ogun project add`
    and `ogun project sync` write and `resolveProjectPath` reads, so the slug is checkable
    on that machine with nothing running. The database is the better oracle and it is the
    one the route uses; its absence is an argument for the weaker local evidence, not for
    none. A `.ogun/config.yaml` in the directory the command was run from counts as
    evidence too, and is stronger: a repository declaring its own name beats this machine's
    cache of that declaration, and requiring `project add` first would make "set the key,
    then sync" impossible for no gain.

    There *is* a legitimate case for a slug this machine has no record of, and it is why
    the refusal has a door rather than being absolute: a hosted control plane polls
    projects whose repositories are checked out somewhere else entirely, so its projects
    map is legitimately empty. The key still works there — `readProjectSecret` looks a
    secret up by slug and never consults that map — so a hard refusal would lock the
    *correct* operator out of the only path that works with the database down. The escape
    is `--allow-unregistered`, named for what it permits rather than `--force`, and it
    warns. What was wrong was the silence, not the storing.

  - **The usage line hid the input the command exists for.** `ogun project secret set
    <project> <name>` reads as complete and says nothing about a key arriving at all, let
    alone on stdin. The reasoning for keeping the value out of argv was already written
    down in the source and was invisible to anyone reading `--help`, which is the one
    audience it was for. Every usage line the command prints now carries the redirection,
    and `--help` carries `/proc/<pid>/cmdline` and the shell history file by name.

  - **It was the only command in its namespace that demanded a slug.** `project add` and
    `project sync` take the current directory and read the name out of its
    `.ogun/config.yaml`; this took an explicit positional, and the `project` namespace
    existed to hold it. Inferring the project the same way empties the namespace out, so
    the command moved to the top level, where `ogun token` already establishes that a
    bare `secret` means the per-project one. The old path is dropped rather than aliased —
    it was two days old with no caller outside this repository — and answers with a line
    naming the new spelling, because muscle memory outlives a release.

  - **It never said that it had destroyed a key.** The output was byte-identical whether a
    set stored a project's first key or overwrote a working one — only the character count
    differed — and the single sentence mentioning replacement was boilerplate printed
    either way. Overwriting is still the behaviour this record settled on and it is not
    revisited here: a rotation window is the provider's to offer, and two live values means
    a 401 cannot be attributed. What was wrong was that the surface with a confirmation
    step warned and the surface where a piped one-liner destroys a credential did not. The
    Settings page has said *"already has a `<name>` key. Storing replaces it — there is no
    history"* since it was built.

    So the confirmation now reports the event — `stored for` or `replaced for` — and a
    replace adds that the previous value cannot be recovered from this machine. The fact
    comes back from `setProjectSecret`, decided inside `updateLocalConfig`'s lock in the
    same read-modify-write that performs the change, rather than from a read taken before
    it: a caller that checks and then writes reports something that was true a moment ago,
    and is wrong in exactly the case the lock exists for. A blank entry being filled in is
    its own third answer, because `empty` is what a poller reads as a key that exists and
    does not work, and calling that repair a "replace" would send somebody looking for a
    value that never worked.

    Considered and rejected: a `[y/N]` gate on a replace. It needs a `--yes` for the
    non-interactive path; every script would set that flag once and never remove it; the
    gate would then guard nobody while costing everybody a keystroke — on the operation
    this record settled as the *intended* one. A prompt on the happy path is a prompt people
    learn to answer without reading. What survives from the idea is its useful half: at a
    terminal, the warning is printed *before* the value is asked for, where an operator can
    still stop without having pasted anything, and a pipe is never blocked.

    `ogun secret rm` finding nothing to remove is the same question with a different wrong
    answer, and got the same treatment. It always distinguished the two outcomes; what
    changed is that the project is now inferred from the directory, so a `rm` run one level
    too high is a plausible way to reach that branch — it is no longer whispered in grey, it
    names the project it searched and where that name came from, and it still exits 0,
    because a removal that finds nothing has reached the state it was asked for.

  One thing got *narrower* on the way through. The CLI used to quote a rejected secret name
  back at the operator, where the route deliberately does not. With two positionals that
  said which word was wrong; with one it says nothing, and the plausible mistake becomes
  `ogun secret set lin_api_…` — someone who remembered that the key does not go in argv and
  forgot that the name does. So the CLI now withholds it too, and says instead that if that
  is what happened, the key should be treated as compromised.

  [amended — ADR-0014] **The command is now `ogun connect linear --api-key`.** The
  namespace is gone rather than renamed: setting a personal key and connecting an OAuth
  application were two vocabularies for "give Ogun access to Linear", and having two was
  the fault. Every rule in this bullet survives the move — the value stays out of the store
  unless the project checks out, the rejected name is still withheld, the confirmation
  still reports what it displaced, and `rm` — now `ogun disconnect linear` — still checks
  nothing, because a row the listing shows has to be a row you can remove. ADR-0014's
  amendment argues the subsumption; what belongs here is that nothing about *where the
  value lives* changed.

  [amended] **A value passed as an argument is now accepted with a warning, where it used
  to be refused.** This reverses a decision this record made deliberately and tested, so it
  is recorded rather than quietly dropped. The superseded sentence:

  > *"So a second positional is **refused** rather than accepted, and the refusal says both
  > of the above. Silently ignoring it would be worse than taking it: the operator would
  > believe the secret was stored and would still have leaked it."*

  Both halves of the hazard it names are unchanged and still true: `/proc/<pid>/cmdline` is
  world-readable while the process runs, and the shell writes the whole line into a history
  file nobody audits. What the argument did not weigh is the cost of the refusal itself,
  which the product owner did:

  - **A usage line that hides an input is the fault this whole change is about.** The
    signature must read `ogun connect linear --api-key <key>` — naming the value where a
    reader of `--help` will see it. Naming it and then refusing it teaches the reader that
    the documentation lies, which is worse than either alternative on its own.
  - **Refusing does not un-leak anything.** By the time the process can refuse, argv has
    already been in `/proc` and the history file has already been written. The refusal
    withholds the store and nothing else — and the operator, having leaked the key, now
    also does not have it configured.
  - **The convention is to warn.** `docker login -p` prints *"WARNING! Using --password via
    the CLI is insecure"* and proceeds. Somebody who has met that convention reads a hard
    refusal as a bug and works around it, and the workaround is usually worse than the
    thing being prevented.

  So: the value is accepted, the warning is unconditional and goes to stderr where a
  redirect cannot swallow it, and it carries the same *"treat it as compromised"* advice
  the refusal used to. **Nothing else about containment moved.** The value is normalised
  and sealed into a `Secret` exactly as a prompted one is, it is never echoed — not in the
  warning and not in the confirmation — and it never appears in an error message. The
  prompt and the pipe stay the recommended paths and every usage line says so underneath
  itself: omit the value and it prompts with the echo off at a terminal, and reads stdin
  when stdin is a pipe.

  The test that asserted the refusal is gone, replaced by one asserting the warning fires,
  the value is stored, and no surface repeats it back.

- **The value cannot enter a sandbox, and it is a test rather than a promise.** The wire
  has no field for it (`claimedJobSchema` strips one), so it cannot reach a runner; the
  runner is the only thing that builds `docker run`; and nothing the runner mounts contains
  `~/.ogun/config.json`. `packages/runner/test/sandbox-secrets.test.ts` asserts the last of
  those against the real host paths, because the hazard is one path segment wide:
  `~/.ogun/gateway/` is bind-mounted into every sandbox as individual *files* precisely
  because it also holds `ca.key`, and widening that to the directory — or its parent —
  would hand a container the whole store. That reason is a comment today, and a comment is
  one refactor away from being untrue.

- **A `JSON.parse` failure no longer quotes the file back.** V8 builds `JSON.parse`'s
  message out of a window of the offending source, and `~/.ogun/config.json` is parsed by
  the runner at startup and forwarded through `fail()` by every CLI command. A hand-edit
  that dropped a quote printed part of the admin token — and now part of a project's API key
  — to a terminal and into a systemd journal. `parseLocalConfig` keeps the fault's position
  and discards the parser's own words. The cost is a slightly less specific error on a
  malformed config, which is the right trade for a file that holds three kinds of
  credential.

- **`secrets` has to stay declared in `localConfigSchema`, and deleting it is silent.**
  [ADR-0014 added an `oauth` block beside it, under the same rule and for the same reason.]
  `updateLocalConfig` is a read-modify-write through that schema and zod strips what it does
  not name, so an undeclared block would be dropped by the next `ogun project add` or
  `ogun runner join`. The symptom would be a Linear key that stopped working on the day
  someone registered an unrelated repository. There is a test for it.

- **No migration.** Nothing about this touches the database. The last migration is still
  `0016_run_rounds`.

- **Protection is the file mode and nothing else.** The value is cleartext on disk at 0600,
  exactly like the admin token and the runner credential beside it, and `ogun runner doctor`
  already reports when that mode has slipped. An attacker who is the same user on that
  machine has it, and would equally have had the encryption key under the rejected option.
  That is the boundary this decision draws, and it is drawn where the alternative drew it
  too.
