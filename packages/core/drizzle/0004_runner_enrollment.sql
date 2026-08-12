ALTER TABLE "runners" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;