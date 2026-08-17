-- Skills are not in config.yaml; sync discovers them from the repo and ships them
-- alongside it. Hashing only the config would report "synced" after a SKILL.md edit
-- while the indexed copy went stale.

ALTER TABLE "projects" ADD COLUMN "skills_hash" text;