-- Record which config.yaml a project was indexed from, so drift is computable.
--
-- Nullable: a project registered before this reads as "unknown", not as drift. The
-- first sync fills it in.

ALTER TABLE "projects" ADD COLUMN "config_hash" text;