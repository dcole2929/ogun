ALTER TABLE "skills" ADD COLUMN "origin" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "reference_paths" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "allow_implicit_invocation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "origin" text DEFAULT 'config' NOT NULL;