-- What a dismissal is anchored to, and what a run stayed silent about.
--
-- Re-adjudication (§4.11) makes "I already dismissed this" produce silence. Silence is
-- the most dangerous output this system has, so it gets two things it did not have:
--
--   * an anchor. `dismissed_basis` is the text of the code the finding cited, frozen at
--     the moment a person dismissed it, with the severity they dismissed. While that
--     text is still in the file the decision is about code that still exists; when it is
--     gone the dismissal has lost its subject and lapses. Without this a dismissal is
--     permanent by accident — rewrite the retry loop somebody said was fine and the one
--     worker positioned to notice never speaks again.
--
--   * a record. `staged_findings.suppressed_by` / `suppression_reason` say which
--     dismissal silenced a reported finding and on what evidence. "Suppressed because
--     dismissed in run X" and "not found this time" are completely different facts and
--     must never wear the same value (principle 6) — before this they both wore the
--     absence of a row.
--
-- Existing wontfix rows are left with a null basis rather than a backfilled guess. Null
-- reads as "nobody recorded one", which is true; a date copied out of `updated_at` would
-- read as evidence, which it is not. They still suppress, and every suppression says the
-- basis is unrecorded.

ALTER TABLE "findings" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "dismissed_basis" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "dismissed_basis_path" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "dismissed_severity" text;--> statement-breakpoint
ALTER TABLE "staged_findings" ADD COLUMN "suppressed_by" text;--> statement-breakpoint
ALTER TABLE "staged_findings" ADD COLUMN "suppression_reason" text;