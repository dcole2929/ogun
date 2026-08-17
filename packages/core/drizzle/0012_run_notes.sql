-- What the node wrote for a person to read, kept.
--
-- Triage is required to describe a degraded night in `notes` — which reviewers did not
-- run, and therefore which surface nobody looked at. The findings document carried it
-- and finalize dropped it on the floor: no column, no reader. An inbox with three
-- findings from four reviewers looks identical to one from three reviewers, and the
-- only thing that could tell them apart was being discarded (principle 6).
--
-- Separate from `runs.detail`, which is the control plane's account of a bad ending.
-- The note that matters most comes from a run that succeeded.

ALTER TABLE "runs" ADD COLUMN "notes" text;
