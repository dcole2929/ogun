-- Re-adjudication (§4.11): a verdict on a finding nobody re-reported.
--
-- `duplicate_of` records the merge target instead of folding the row away, because
-- triage marks rather than deletes (§4.12) — a wrong merge has to be visible and
-- reversible. `status_run` records which run last moved the status, which `last_seen_run`
-- cannot: re-adjudication changes a status precisely when nothing reported it again.

ALTER TABLE "findings" ADD COLUMN "duplicate_of" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "status_run" uuid;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_run_runs_id_fk" FOREIGN KEY ("status_run") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;