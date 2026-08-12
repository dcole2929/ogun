-- Runners get a real identity, separate from their name.
--
-- Hand-written, because the generated version could not survive existing data: it cast
-- `runners.id` straight to uuid, but those values are names like 'desktop-846nqve', and
-- it added NOT NULL columns with no default to tables that already had rows. Both would
-- have failed outright — or worse, dropped the link between a run and the machine that
-- executed it.
--
-- The order matters: capture the old text keys before rewriting them, so `runs` can be
-- re-pointed at the new uuids afterwards.

--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "name" text;
--> statement-breakpoint
UPDATE "runners" SET "name" = "id" WHERE "name" IS NULL;
--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "name" SET NOT NULL;

-- Snapshot the executing machine's name onto each run first. This is what keeps history
-- readable after a rename or a forget, and it has to be taken while runner_id still
-- holds the name.
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_name" text;
--> statement-breakpoint
UPDATE "runs" SET "runner_name" = "runner_id" WHERE "runner_name" IS NULL;
--> statement-breakpoint
UPDATE "runs" SET "runner_name" = 'unknown' WHERE "runner_name" IS NULL;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "runner_name" SET NOT NULL;

-- Now mint uuids. The old text key is carried in a temporary column so the runs table
-- can be joined against it once both sides have changed type.
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "legacy_id" text;
--> statement-breakpoint
UPDATE "runners" SET "legacy_id" = "id";
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT IF EXISTS "runners_pkey";
--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "id" SET DATA TYPE uuid USING gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "runners" ADD PRIMARY KEY ("id");

-- Re-point runs at the new uuids, matching on the name that was just snapshotted.
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "runner_uuid" uuid;
--> statement-breakpoint
UPDATE "runs" SET "runner_uuid" = "runners"."id"
  FROM "runners" WHERE "runners"."legacy_id" = "runs"."runner_id";
--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "runner_id";
--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "runner_uuid" TO "runner_id";
--> statement-breakpoint
ALTER TABLE "runners" DROP COLUMN "legacy_id";

--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_id_runners_id_fk"
  FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null;

-- Unique among live runners only, so revoking frees the name for reuse while the old row
-- keeps its own identity and its runs.
--> statement-breakpoint
CREATE UNIQUE INDEX "runners_live_name_idx" ON "runners" USING btree ("name")
  WHERE "runners"."revoked_at" is null;
