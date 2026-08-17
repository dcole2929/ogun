-- Sever history from the definitions that produced it.
--
-- `jobs`, `coverage`, `staged_findings` and `cycle_runs` cascaded off `workers` and
-- `cycles`, which made every run a child of a config row. Since `reindexProject` deletes
-- any worker or cycle absent from config.yaml — and a rename is a delete plus an insert —
-- editing that file destroyed the run history of whatever it renamed or removed. §4.4 is
-- explicit that runs, events, cost and coverage are exactly what this database exists to
-- own, so they must outlive the file.
--
-- Each FK becomes ON DELETE SET NULL beside a name snapshot, the same shape `runs`
-- already uses for `runner_id` / `runner_name`. `cycle_runs` additionally freezes the
-- definition it was created from, so release and staging decisions read the graph the run
-- began with rather than a row `ogun project sync` can rewrite underneath it.
--
-- Columns are added nullable, backfilled, and only then made NOT NULL — every existing
-- row has a non-null FK today (that was the old constraint), so the backfill is total.

ALTER TABLE "jobs" ADD COLUMN "worker_name" text;--> statement-breakpoint
ALTER TABLE "coverage" ADD COLUMN "worker_name" text;--> statement-breakpoint
ALTER TABLE "staged_findings" ADD COLUMN "worker_name" text;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "cycle_name" text;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD COLUMN "definition" jsonb;--> statement-breakpoint

UPDATE "jobs" j SET "worker_name" = w."name" FROM "workers" w WHERE w."id" = j."worker_id";--> statement-breakpoint
UPDATE "coverage" c SET "worker_name" = w."name" FROM "workers" w WHERE w."id" = c."worker_id";--> statement-breakpoint
UPDATE "staged_findings" s SET "worker_name" = w."name" FROM "workers" w WHERE w."id" = s."worker_id";--> statement-breakpoint
UPDATE "cycle_runs" cr SET "cycle_name" = c."name", "definition" = c."definition" FROM "cycles" c WHERE c."id" = cr."cycle_id";--> statement-breakpoint

-- Belt and braces: a row whose FK somehow pointed nowhere would fail the NOT NULL below
-- and abort the whole migration. Name it rather than lose it.
UPDATE "jobs" SET "worker_name" = '(unknown)' WHERE "worker_name" IS NULL;--> statement-breakpoint
UPDATE "coverage" SET "worker_name" = '(unknown)' WHERE "worker_name" IS NULL;--> statement-breakpoint
UPDATE "staged_findings" SET "worker_name" = '(unknown)' WHERE "worker_name" IS NULL;--> statement-breakpoint
UPDATE "cycle_runs" SET "cycle_name" = '(unknown)' WHERE "cycle_name" IS NULL;--> statement-breakpoint
UPDATE "cycle_runs" SET "definition" = '{"nodes":[],"edges":[]}'::jsonb WHERE "definition" IS NULL;--> statement-breakpoint

ALTER TABLE "jobs" ALTER COLUMN "worker_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "coverage" ALTER COLUMN "worker_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_findings" ALTER COLUMN "worker_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ALTER COLUMN "cycle_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ALTER COLUMN "definition" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "coverage" DROP CONSTRAINT "coverage_worker_id_workers_id_fk";--> statement-breakpoint
ALTER TABLE "cycle_runs" DROP CONSTRAINT "cycle_runs_cycle_id_cycles_id_fk";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_worker_id_workers_id_fk";--> statement-breakpoint
ALTER TABLE "staged_findings" DROP CONSTRAINT "staged_findings_worker_id_workers_id_fk";--> statement-breakpoint

ALTER TABLE "coverage" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cycle_runs" ALTER COLUMN "cycle_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staged_findings" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "coverage" ADD CONSTRAINT "coverage_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_runs" ADD CONSTRAINT "cycle_runs_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_findings" ADD CONSTRAINT "staged_findings_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Keyed on the name, not the now-nullable id: Postgres lets NULLs repeat in a unique
-- index, so an upsert targeting the id would start inserting duplicate coverage rows.
DROP INDEX "coverage_cyclerun_worker_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "coverage_cyclerun_worker_idx" ON "coverage" USING btree ("cycle_run_id","worker_name");
