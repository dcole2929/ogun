-- How many rounds of deliver-and-grade a run took (§5.2), which only a modifier's retry
-- loop can push above one.
--
-- Nullable and undefaulted on purpose. `runs.gates` is not stored, and the report carries
-- only the *last* round's verdict — it has to, because `finalizeRun` reads any failed gate
-- as the gate's answer and would derive a retried-then-passing run down to
-- `changes-requested`. So this column is the only durable thing that tells a run which
-- passed first time from one which passed on its second attempt. Backfilling the existing
-- rows with 1 would be inventing that evidence for nights nobody measured, which is the
-- collapse principle 6 forbids: null means "no runner said".
--
-- Distinct from `jobs.attempts`, which counts claims of a job by a runner rather than
-- deliveries to the agent inside one run.

ALTER TABLE "runs" ADD COLUMN "rounds" integer;
