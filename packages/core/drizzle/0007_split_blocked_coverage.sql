-- `blocked` used to mean three different things: admission refused the job, a dependency
-- failed, and the job ended without running. Splitting them changed what the existing
-- value means, so rows written under the old vocabulary have to be reinterpreted — left
-- alone they would assert something specific and false.
--
-- The reason text is what distinguishes them, because it is the only record of which of
-- the three actually happened.

--> statement-breakpoint
UPDATE "coverage" SET "outcome" = 'abandoned'
  WHERE "outcome" = 'blocked' AND "reason" LIKE '%without reporting a run%';

--> statement-breakpoint
UPDATE "coverage" SET "outcome" = 'refused'
  WHERE "outcome" = 'blocked' AND ("reason" LIKE '%breaker open%' OR "reason" LIKE '%disabled%');

--> statement-breakpoint
UPDATE "coverage" SET "outcome" = 'cancelled'
  WHERE "outcome" = 'blocked' AND "reason" LIKE '%cancelled%';

-- Anything still `blocked` genuinely was: a dependency in its cycle did not succeed,
-- which is the meaning the name keeps.
