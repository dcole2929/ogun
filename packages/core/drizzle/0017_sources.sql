CREATE TABLE "source_emissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid,
	"source_name" text NOT NULL,
	"external_id" text NOT NULL,
	"external_key" text NOT NULL,
	"digest" text NOT NULL,
	"cycle_run_id" uuid,
	"outcome" text DEFAULT 'emitted' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid,
	"source_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"seen" integer DEFAULT 0 NOT NULL,
	"admitted" integer DEFAULT 0 NOT NULL,
	"emitted" integer DEFAULT 0 NOT NULL,
	"trimmed" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"cycle_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_emissions" ADD CONSTRAINT "source_emissions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_emissions" ADD CONSTRAINT "source_emissions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_emissions" ADD CONSTRAINT "source_emissions_cycle_run_id_cycle_runs_id_fk" FOREIGN KEY ("cycle_run_id") REFERENCES "public"."cycle_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_polls" ADD CONSTRAINT "source_polls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_polls" ADD CONSTRAINT "source_polls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_emissions_project_external_idx" ON "source_emissions" USING btree ("project_id","external_id");--> statement-breakpoint
CREATE INDEX "source_emissions_cycle_run_idx" ON "source_emissions" USING btree ("cycle_run_id");--> statement-breakpoint
CREATE INDEX "source_polls_source_started_idx" ON "source_polls" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_project_name_idx" ON "sources" USING btree ("project_id","name");