---
status: accepted
---

# A dismissal is enforced by the control plane, and lapses with the code it was about

Every automated reviewer eventually exhibits the same failure: you dismiss a finding, the
nightly runs again, and it comes straight back. Two nights of that and the inbox is noise;
three and nobody opens it — at which point every other thing this factory does is worth
nothing, because the inbox is where all of it lands. §4.11 named the mechanism
"re-adjudication" and §9 listed it as the last remaining phase 2 item.

Before this, "I already dismissed this" was represented and not enforced. The status
existed, the reviewer skills were *told* to respect it in prose, and `finalizeRun` held the
status on a re-sighting — while rewriting the row's title, body and severity from tonight's
report, and recording nowhere that anything had been silenced. Three separate holes: an
instruction an agent can forget, a dismissal whose subject could be swapped out underneath
a person's reasons, and an absence indistinguishable from a reviewer that looked and found
nothing.

So:

**Suppression is deterministic and it happens at the promotion boundary.** A reported
finding whose row is `wontfix` — or whose row is a `duplicate` pointing at one — does not
reach the inbox. The decision is made in `foreman/suppression.ts`, in the same transaction
that ends the run, over rows the control plane owns. No model is consulted.

**A dismissal is anchored to code, and the anchor is what makes it revocable.** When a
person dismisses a finding, the API freezes the *cited code as the runner last read it off
disk* (`findings.snippet` → `dismissed_basis`) together with the severity they dismissed.
On every later run the runner searches the current tree for that text, normalized for
whitespace, and reports `intact | moved | unreadable`. Intact holds the dismissal; moved
lapses it and the finding reopens with a reason. A re-sighting at a **higher severity than
was dismissed** lapses it too.

**The agent's contribution is to widen a dismissal, never to apply one.** Prior findings
are still shown verbatim — `/api/jobs/:id/history` writes the inbox into the workspace,
index plus write-ups — and triage may still file a `duplicate-of` verdict saying tonight's
rephrasing is the same issue as a dismissed one. That widens the dismissal, but only
through a row with a pointer, a reason and a run attached: visible, auditable, reversible.
What it cannot do is decide the silence.

**Suppression is recorded.** `staged_findings.suppressed_by` and `suppression_reason` say
which dismissal silenced which reported finding and on what evidence, and the run detail
API serves them. "Suppressed because dismissed in run X" and "not found this time" are
different facts and now wear different values (principle 6).

This closes **§10 open question 3**. The proposal there — show prior unresolved findings
verbatim and have the reviewer classify each — is adopted for *what the agent sees* and
rejected for *what decides*, for the reasons below.

## Considered Options

- **The §10.3 proposal as written: the reviewer classifies each prior finding, and the
  classification decides.** Rejected for the deciding half, kept for the showing half. The
  two mistakes are not symmetric. An agent that wrongly says "this is different" costs one
  duplicate row a person dismisses in a click. An agent that wrongly says "this is the one
  you dismissed" removes a real finding from the only place anybody would ever have seen
  it — silently, with no downstream reviewer, and with nothing in the ledger to notice.
  Principle 4 says deterministic code before AI and names dedupe as ordinary code; this is
  dedupe against a *person's decision*, which is a stronger claim than dedupe against last
  night. It is also the wrong node: putting suppression in the reviewer puts it in N
  reviewers, which §4.12 already rejected for exactly this class of work.
- **Match findings by embedding or text similarity, so a rephrasing is caught
  automatically.** Rejected. It fails in the direction that cannot be seen: two findings
  about *different* techniques on one surface read almost identically, because the
  hierarchy that separates them is a taxonomy and not prose. A threshold that catches the
  rephrasings also catches the siblings, and the sibling it silences is a bug nobody ever
  looked at. It would also put a second, opaque identity function beside the fingerprint,
  and §4.11 is explicit that the semantic comparison belongs to the history step.
- **Widen a dismissal by fingerprint prefix.** Rejected, and it is the tempting one:
  §4.11 builds the hierarchy so a *cooldown* can cover a whole surface by prefix. A
  cooldown is temporary and loud. A dismissal is permanent and silent, and
  `…/account-isolation/` has two techniques under it precisely because they are two
  different bugs. Widening by prefix silences the second on the strength of a decision
  about the first. Matching is exact, or one hop through a `duplicate_of` pointer somebody
  filed on purpose — never two hops, so a chain that arrived by some other route cannot
  quietly extend a dismissal across findings nobody compared.
- **Leave a dismissal permanent.** Rejected — this was the status quo and it is the one
  outcome worse than the noise. Dismiss "this retry loop is fine", let somebody rewrite the
  retry loop into something genuinely broken, and the one worker positioned to notice never
  speaks again. §9 already records a real `high` in this path from the other direction: a
  finding marked `fixed` that regressed stayed `fixed` and never reappeared. Re-adjudication
  must not reintroduce that failure wearing a different status.
- **Expire a dismissal after N days.** Rejected. It re-flags exactly the thing the user
  dismissed, on a schedule, for no new reason — the failure this ADR exists to remove,
  arriving more slowly. What changes a judgement is the code changing or the stakes
  changing, and both are covered by evidence. The pressure a timer was meant to create is
  produced honestly instead: `seen_count` keeps rising under suppression, so "you dismissed
  this and reviewers have re-found it forty times" is visible, and the person decides.
- **`repo_sha` as the basis: lapse when the repository moved.** Rejected. It is the field
  §5.1 names for "did this change since I last saw it", and at whole-repo granularity it
  answers "did *anything* change", which on an active repository is yes, nightly.
- **A digest of the cited file.** Rejected for the same reason one notch down: any edit
  anywhere in `finalize.ts` would lapse every dismissal about `finalize.ts`. Dismissals on
  the files people actually work in would survive about a day.
- **Store `path:line` and re-read that line.** Rejected — §4.11 already excludes line
  numbers from a fingerprint because rebases and unrelated edits shift them, and the
  argument is stronger here: an insertion forty lines above would be reported as a rewrite.
  The basis is *searched for* in the file instead, so movement within the file is not a
  change.
- **Compare the code verbatim.** Rejected — a formatter run across the repository would
  lapse every dismissal in it, and nobody re-decided anything. Whitespace and blank lines
  are normalized away on both sides. A rename *inside* the region still lapses it, which is
  the point.
- **Let the control plane perform the basis check itself.** Rejected — it cannot. §4.5
  forbids an absolute repository path in the database and a hosted control plane has no
  checkout at all, which is the same reason the grounding check lives in the runner. The
  runner reads the tree and reports three states; the control plane decides. The basis is
  deliberately *not* written into the workspace: it is the project's own source and holds
  no secret, so this is separation of duties rather than confidentiality — the anchor is
  the one input to a dismissal's fate no agent may influence, and a copy in the sandbox is
  a copy some future skill starts arguing with.
- **A `dismissals` table.** Rejected as a second place for the same fact. A dismissal is a
  status a finding is in, it has exactly one subject, and a table would need its own
  lifecycle rules to stay in step with `findings.status` — one more pair of things that can
  disagree. Four nullable columns on the row, cleared whenever the status leaves `wontfix`,
  cannot drift from the status they belong to.
- **Let triage mark something `wontfix` when it is confident enough.** Rejected, and
  already refused in code before this change. Dismissal is a person accepting a risk. A
  confidence threshold is a number chosen from nothing that converts a model's certainty
  into the system's silence.
- **Drop a suppressed finding rather than staging it.** Rejected — triage never deletes,
  it marks (§4.12). The staged row plus its reason *is* the audit trail, and it is also
  triage's input: a rephrasing can only be merged into a dismissal by a node that can see
  both.

## Consequences

- **A dismissal made before this existed has no anchor, and suppresses anyway.** Refusing
  to honour a person's decision because Ogun failed to record enough would punish the wrong
  party. Every suppression it produces says `unrecorded` rather than reading as a check that
  passed. Such a row does acquire a `snippet` on its next suppressed sighting — filled, never
  overwritten — so re-affirming the dismissal anchors it; nothing anchors it automatically,
  because anchoring a decision to code the person never saw is exactly the silent failure the
  anchor exists to prevent. **There is no UI for that remedy yet, and a finding that the
  Findings page should show which dismissals are unanchored is a real finding.**
- **A dismissal is only ever as good as the fingerprint underneath it.** The fingerprint was
  built to answer "have I seen this before"; "should I stay silent about this forever" is a
  stronger claim to hang on the same hook, and it is being hung on it. The honest assessment:
  it is strong enough *because* nothing is inferred from it — exact equality only, one
  explicit hop, no prefixes, no similarity. Its remaining weakness is the other direction: an
  agent that mints a slightly different fingerprint for the same issue defeats suppression
  entirely, and the only repair is triage filing `duplicate-of`. So a run where triage does
  not adjudicate is a run where the inbox slowly re-fills with rephrasings. **A finding that
  fingerprint minting is too loosely governed for what now depends on it is a real finding.**
- **Severity is the one input to the decision an agent supplies, and it is wired one-way.**
  Inflating a severity can only make the system louder — it lapses a dismissal and produces a
  row somebody dismisses again. Deflating it changes nothing, because a lower severity is not
  a new claim. A model cannot buy silence with it. It is compared against the severity frozen
  at dismissal, not the row's current one, because the row's severity is rewritten by whichever
  reviewer last described it.
- **A lapse reopens the dismissed finding, not the sighting that revealed it.** When a
  rephrasing arrives under an alias and the anchor has moved, the row that reopens is the one
  the person dismissed; the alias keeps its `duplicate` status and its pointer, so the reader
  is sent to one row rather than two.
- **The runner reads a handful of extra files per run.** One per finding cited, one per
  standing dismissal, cached per path, host-side after the container exits. Every dismissal is
  checked rather than only the ones tonight's reviewer mentioned — otherwise a reviewer could
  keep a lapsed dismissal alive by never bringing it up.
- **A report with no checks in it is not treated as a pass.** An older runner, a run that
  could not reach `/history`, an unreadable file: each suppresses and each says which of those
  it was. All three produce silence, so a boolean would have worked and the ledger would have
  been useless.
- **The `snippet` column is now written, and holds project source.** It has been on the
  findings table since it was created with nothing filling it. It is a few normalized lines of
  the project's own code, in the project's own database, and the UI can show it — but it is
  new content in postgres and worth knowing about.
- **One migration: `0013_dismissal_basis.sql`.** Four nullable columns on `findings`, two on
  `staged_findings`. No backfill: an existing `wontfix` keeps a null basis rather than a date
  copied out of `updated_at`, because null reads as "nobody recorded one" and the copy would
  read as evidence.
