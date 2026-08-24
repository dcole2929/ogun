-- A runner reports the credentials it actually has, and the control plane stops guessing.
--
-- The credential preflight (§4.3) read `~/.claude/.credentials.json` and
-- `~/.codex/auth.json` on the machine the *control plane* runs on and called the answer
-- the runner's. That is correct only while the two are the same host — which §3 says they
-- are and ADR-0001 says they will not always be — and it was already wrong on one host:
-- an `ANTHROPIC_API_KEY` exported into the runner's systemd unit but not the server's had
-- the runner authenticating perfectly while admission refused every job with a reason
-- that read as certain. docs/setup.md carried a warning about it, which is the wrong
-- place to fix a design.
--
-- So the machine answers for its own disk. `credentials` holds the `CredentialOutlook`
-- that machine last sent — expiries only, never a token, never a refresh token, never an
-- account id (ADR-0010). It rides the claim, which is already the heartbeat, because
-- credential health is a capability fact about a host exactly like `labels`.
--
-- Both columns are nullable and null means **never reported**, which is emphatically not
-- "no credentials". A runner built before this exists sends nothing; a control plane that
-- read that as "cannot authenticate" would refuse every job on the fleet the moment it was
-- deployed. Admission admits on silence — the gateway's own `502 no_credential` and the
-- provider's 401 remain the backstop, exactly as they were.
--
-- `credentials_at` is deliberately not `last_seen_at`. A claim always advances the
-- heartbeat and only sometimes carries a report, so one timestamp for both would let a
-- downgraded runner's stale report look eternally current — and admission would go on
-- refusing over a token that was refreshed hours ago. Separate clocks; a report older than
-- the liveness window is ignored rather than trusted.

ALTER TABLE "runners" ADD COLUMN "credentials" jsonb;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "credentials_at" timestamp with time zone;
