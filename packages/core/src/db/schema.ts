import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Postgres owns exactly what GitHub and Linear cannot represent (§4.4): runs, events,
 * cost, and findings identity. PR state and ticket state are read live from those
 * systems and never mirrored here.
 *
 * States and outcomes are text columns rather than pg enums on purpose — adding a
 * value to a pg enum is a migration, and this vocabulary is still moving.
 */

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  remoteUrl: text('remote_url'),
  defaultBranch: text('default_branch').notNull().default('main'),
  /**
   * The hash of the `.ogun/config.yaml` this project was last indexed from.
   *
   * `config.yaml` is the definition, but the database is what the foreman actually reads
   * (§5.1) — and the two only meet when something publishes the file. The UI does that
   * itself; a hand-edit or a `git pull` does not, and nothing noticed. The triage fan-in
   * merged and sat inert for fourteen hours exactly this way, with every command
   * reporting success against a definition nobody was running.
   *
   * Storing the hash makes the difference computable: the file on disk hashes to
   * something else, or it does not. Null for a project registered before this existed,
   * which reads as "unknown" rather than as drift.
   */
  configHash: text('config_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for a global skill living in ~/.ogun/skills. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Repo-relative for a project skill; never an absolute host path (§4.5). */
    sourcePath: text('source_path').notNull(),
    versionHash: text('version_hash').notNull(),
    displayName: text('display_name'),
    shortDescription: text('short_description'),
    defaultPrompt: text('default_prompt'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** project | global — where it was discovered, which is also its precedence. */
    origin: text('origin').notNull().default('project'),
    /**
     * The SKILL.md text, so the UI can show what a worker will actually do without the
     * server reaching into a project's filesystem (§4.5). An index of git, not a second
     * source of truth: `ogun project sync` overwrites it wholesale every time.
     */
    body: text('body'),
    /** Reference files beside SKILL.md, repo-relative. The shared procedure lives here. */
    referencePaths: text('reference_paths').array().notNull().default(sql`'{}'::text[]`),
    allowImplicitInvocation: boolean('allow_implicit_invocation').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_project_name_idx').on(t.projectId, t.name)],
)

export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    skillId: uuid('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    skillRef: text('skill_ref').notNull(),
    runtime: text('runtime').notNull(),
    /** A role, not a tier — `worker` | `reviewer`, resolved by the model router (§4.7). */
    modelRole: text('model_role').notNull().default('worker'),
    permissions: text('permissions').notNull().default('reviewer'),
    sandbox: text('sandbox').notNull().default('container'),
    /**
     * Bumped when the worker's resolved config changes. With skill_version on every
     * run it answers: did this finding stop appearing because we fixed the code, or
     * because I edited the worker?
     */
    versionHash: text('version_hash').notNull(),
    config: jsonb('config').notNull().$type<Record<string, unknown>>(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every sync, so "did this change?" is answerable without diffing config. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workers_project_name_idx').on(t.projectId, t.name)],
)

export const cycles = pgTable(
  'cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** nodes[] + edges[] {from, to, onDepFailure}. A single worker is a one-node cycle. */
    definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('cycles_project_name_idx').on(t.projectId, t.name)],
)

export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id')
    .notNull()
    .references(() => cycles.id, { onDelete: 'cascade' }),
  cron: text('cron').notNull(),
  tz: text('tz').notNull().default('UTC'),
  /** skip | runOnce — WSL2 stops when Windows sleeps, so this is load-bearing (§4.2). */
  onMissed: text('on_missed').notNull().default('skip'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(true),
})

export const cycleRuns = pgTable(
  'cycle_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null once that cycle is gone from config.yaml; the two snapshots below survive it. */
    cycleId: uuid('cycle_id').references(() => cycles.id, { onDelete: 'set null' }),
    /** Snapshot, so history stays readable after a rename or a removal. */
    cycleName: text('cycle_name').notNull(),
    /**
     * The definition this run was created from, frozen at creation.
     *
     * Not a convenience: `cycles.definition` is rewritten in place on every
     * `ogun project sync`, and release and staging decisions used to re-read that live
     * row mid-flight. Editing config.yaml while a cycle was running could therefore
     * strand a dependent that had already been given its `dependsOn`, or flip a reviewer
     * from staging to publishing raw between starting and finishing. A run is executed
     * against the graph it began with.
     */
    definition: jsonb('definition').notNull(),
    trigger: text('trigger').notNull(),
    state: text('state').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('cycle_runs_cycle_started_idx').on(t.cycleId, t.startedAt)],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleRunId: uuid('cycle_run_id')
      .notNull()
      .references(() => cycleRuns.id, { onDelete: 'cascade' }),
    /**
     * Null once that worker is gone from config.yaml; `workerName` below survives it.
     *
     * This used to cascade, which made a job a child of a config row rather than a
     * historical fact — so renaming a worker (a delete plus an insert, as far as
     * `reindexProject` is concerned) silently took every run, event and coverage row it
     * had ever produced with it. §4.4 is explicit that runs and coverage are what this
     * database exists to own; they cannot be deleted by editing a file.
     */
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    /** Snapshot, so history stays readable after a rename or a removal. */
    workerName: text('worker_name').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The node key inside the cycle definition this job was created from. */
    nodeKey: text('node_key').notNull(),
    /** The literal text handed to the agent, not a reference the runner expands (§5.1). */
    prompt: text('prompt').notNull(),
    dependsOn: text('depends_on').array().notNull().default(sql`'{}'::text[]`),
    /** Capability labels a runner must advertise to claim this (§4.5). */
    requires: text('requires').array().notNull().default(sql`'{}'::text[]`),
    state: text('state').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_claimable_idx').on(t.state, t.availableAt, t.priority),
    uniqueIndex('jobs_cyclerun_node_idx').on(t.cycleRunId, t.nodeKey),
  ],
)

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Null once that runner is forgotten; the name below survives it. */
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    /** Snapshot, so history stays readable after a rename or a forget. */
    runnerName: text('runner_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    outcome: text('outcome'),
    /** Why, when the outcome alone doesn't say — gate failure reason, error message. */
    detail: text('detail'),
    repoSha: text('repo_sha'),
    workerVersion: text('worker_version'),
    skillVersion: text('skill_version'),
    runtime: text('runtime'),
    model: text('model'),
    sessionId: text('session_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** List-price estimate where a runtime reports one. Never a bill (§4.7). */
    costCents: integer('cost_cents'),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('runs_job_idx').on(t.jobId), index('runs_started_idx').on(t.startedAt)],
)

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  },
  (t) => [
    /** Makes batch POSTs idempotent — a retried flush collides instead of duplicating. */
    uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq),
  ],
)

/** Pre-triage and queryable. Reviewers write here; only triage writes to `findings`. */
export const stagedFindings = pgTable(
  'staged_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /**
     * Null once that worker is gone. Staged output is a run artifact — §4.12 keeps it
     * precisely so a finding triage discarded is recoverable rather than gone — so it
     * outlives the worker that produced it, like everything else under a run.
     */
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    /** Snapshot, so history stays readable after a rename or a removal. */
    workerName: text('worker_name').notNull(),
    raw: jsonb('raw').notNull().$type<Record<string, unknown>>(),
  },
  (t) => [index('staged_findings_run_idx').on(t.runId)],
)

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    fingerprint: text('fingerprint').notNull(),
    path: text('path'),
    line: integer('line'),
    snippet: text('snippet'),
    severity: text('severity').notNull(),
    confidence: integer('confidence'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('open'),
    statusReason: text('status_reason'),
    /**
     * Set when a reviewer re-reports a finding under the revisit budget (§4.11). These
     * were previously validated on the way in and then dropped, which made a
     * confirmed-still-broken re-report indistinguishable from a routine repeat.
     */
    revisitOf: text('revisit_of'),
    revisitReason: text('revisit_reason'),
    /**
     * The fingerprint this finding was merged into, set alongside `status = 'duplicate'`.
     *
     * Kept as a pointer rather than folded away, because triage never deletes, it marks
     * (§4.12). A merge that turns out to be wrong has to be visible and reversible — and
     * "these four rows are one bug" is itself worth reading, since it says something
     * about the reviewers rather than about the code.
     */
    duplicateOf: text('duplicate_of'),
    /**
     * The run that last set `status`, so a status nobody can account for is impossible.
     * Distinct from `lastSeenRun`, which is the last run that *reported* the finding —
     * re-adjudication changes a status precisely when nothing reported it again.
     */
    statusRun: uuid('status_run').references(() => runs.id, { onDelete: 'set null' }),
    firstSeenRun: uuid('first_seen_run').references(() => runs.id, { onDelete: 'set null' }),
    lastSeenRun: uuid('last_seen_run').references(() => runs.id, { onDelete: 'set null' }),
    seenCount: integer('seen_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Identity is (project, fingerprint) — the same issue found twice is one row. */
    uniqueIndex('findings_project_fingerprint_idx').on(t.projectId, t.fingerprint),
    index('findings_status_idx').on(t.projectId, t.status),
  ],
)

/** Artifact record of what a run produced. PR lifecycle state lives in GitHub (§4.4). */
export const changes = pgTable('changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  branch: text('branch'),
  baseSha: text('base_sha'),
  patchRef: text('patch_ref'),
  filesChanged: integer('files_changed'),
  testsRun: boolean('tests_run'),
  testsPassed: boolean('tests_passed'),
  prUrl: text('pr_url'),
})

/**
 * The coverage ledger (principle 6). Recording which workers ran in a batch requires a
 * batch identity to hang it on — which is why cycle_runs exists in phase 1.
 */
export const coverage = pgTable(
  'coverage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleRunId: uuid('cycle_run_id')
      .notNull()
      .references(() => cycleRuns.id, { onDelete: 'cascade' }),
    /** Null once that worker is gone; `workerName` survives it. */
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    /** Snapshot, so history stays readable after a rename or a removal. */
    workerName: text('worker_name').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    selected: boolean('selected').notNull().default(true),
    ran: boolean('ran').notNull().default(false),
    outcome: text('outcome').notNull(),
    findingCount: integer('finding_count').notNull().default(0),
    reason: text('reason'),
  },
  /**
   * Keyed on the name rather than the id, because the id is now nullable and Postgres
   * lets NULLs repeat in a unique index — an upsert targeting it would start inserting
   * duplicate rows into the one table whose entire job is to be true (principle 6).
   * The constraint is the same either way: one row per worker per cycle run.
   */
  (t) => [uniqueIndex('coverage_cyclerun_worker_idx').on(t.cycleRunId, t.workerName)],
)

/** Large blobs live on disk; this is the pointer. Never inlined into postgres. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** transcript | patch | adr-draft | raw-output */
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    bytes: integer('bytes'),
  },
  (t) => [index('artifacts_run_idx').on(t.runId)],
)

export const runners = pgTable('runners', {
  /**
   * A real identity, separate from the name. The name is a label you chose and may want
   * to change; the id is what a run points at, so renaming a machine does not orphan its
   * history and a name freed by revocation can be reused without the old runs silently
   * re-attaching to the new machine.
   */
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
  maxConcurrency: integer('max_concurrency').notNull().default(2),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * sha256 of the enrollment token. Per-runner rather than one shared secret so a lost
   * laptop is one revocation rather than a rotation across every machine.
   *
   * Null for a runner that connected before enrollment existed, or on a localhost
   * control plane where no token is required at all.
   */
  tokenHash: text('token_hash'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  /** Set rather than deleted, so a revoked runner's runs keep a name to point at. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Never connected yet — the enrollment command has been issued but not run. */
  pending: boolean('pending').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Unique among live runners only, so revoking frees the name for reuse while the old
  // row keeps its own identity.
  uniqueIndex('runners_live_name_idx')
    .on(t.name)
    .where(sql`${t.revokedAt} is null`),
])

/**
 * A join token minted on the control plane and not yet used.
 *
 * Separate from `runners` because an invite is not a machine: nobody has joined yet, and
 * the machine is the thing that knows its own name. Creating a runner row up front would
 * mean inventing a name for something that may never connect.
 */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  /** For the operator's benefit — "the mac". Not a machine name. */
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Single use: set when a machine joins, along with the name it chose for itself. */
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedBy: text('used_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

/**
 * Breaker state lives here, not in process memory (§4.3). On WSL2 an in-memory breaker
 * resets on every Windows update — exactly when you'd want it to hold.
 */
export const breakers = pgTable(
  'breakers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('breakers_worker_idx').on(t.workerId)],
)
