-- Hold the policies a project syncs, instead of throwing them away on arrival.
--
-- `policies:` was declared in config.yaml, parsed, posted by `ogun project sync`, and
-- then dropped: there was no column and `applySync` never read the field. Setting
-- `failureBreakerThreshold: 5` got you three, from a constant in admission.ts that the
-- Workers page also kept its own copy of.
--
-- Only the control-plane half lives here — the scheduling and admission keys the agent
-- cannot influence. `allowSandboxDowngrade` and `maxOpenPullRequests` are gates on what
-- an agent's own work may become and are read by the runner from the git blob at the
-- pinned base (§4.6, ADR-0009); a stored copy of one of those would be a second answer to
-- a question that must only have one.
--
-- Nullable: a project that has not synced since this existed has never told us its
-- policies, and reads as the defaults. That is not the same fact as a row holding the
-- default values, which is a config we have read (principle 6), and the two stay
-- distinguishable because one is null and the other is an object.

ALTER TABLE "projects" ADD COLUMN "policies" jsonb;
