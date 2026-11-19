/**
 * What the control plane says, for a browser that is not talking to one.
 *
 * These tests are about *interaction* — a panel that opens, a handle that drags, a link
 * that changes what the next page shows. None of that is a claim about the server, and
 * running a database to assert it would make the tests slower and flakier without making
 * them truer. The real bundle is served; only the API is stubbed.
 */

export const PROJECTS = {
  projects: [
    { id: 'p1', slug: 'ogun', defaultBranch: 'main', drift: { state: 'current' } },
    { id: 'p2', slug: 'heirchive-api', defaultBranch: 'main', drift: { state: 'current' } },
  ],
}

/** Two projects in trouble, one of them not the one you are looking at. */
export const STATUS = {
  runnersOnline: 1,
  drifted: ['heirchive-api'],
  breakers: [{ worker: 'security-review', project: 'heirchive-api', failures: 3 }],
  sources: [],
}

export const ALL_CLEAR = { runnersOnline: 2, drifted: [], breakers: [], sources: [] }

const worker = (
  name: string,
  project: string,
  over: { permissions?: string; sandbox?: string; skillOrigin?: string | null } = {},
) => ({
  worker: {
    id: `${project}-${name}`,
    name,
    skillRef: name,
    runtime: 'claude',
    modelRole: 'worker',
    permissions: over.permissions ?? 'reviewer',
    sandbox: over.sandbox ?? 'container',
    enabled: true,
    versionHash: 'h',
    config: {},
  },
  project: { slug: project },
  skillOrigin: over.skillOrigin === undefined ? 'builtin' : over.skillOrigin,
  breaker: null,
  schedule: null,
  nextRun: null,
  drivenBy: null,
  effectivePrompt: { text: '', source: 'skill' },
})

export const WORKERS = {
  workers: [
    worker('adversarial-review', 'ogun'),
    worker('scope-a-ticket', 'ogun', { permissions: 'observer' }),
    worker('local-thing', 'ogun', { sandbox: 'worktree', skillOrigin: 'project' }),
    worker('security-review', 'heirchive-api'),
    worker('plan-a-ticket', 'heirchive-api'),
  ],
  editable: { ogun: true, 'heirchive-api': true },
  hashes: {},
  policies: {},
  allowSandboxDowngrade: {},
}

const skill = (name: string, project: string) => ({
  skill: {
    id: `${project}-${name}`,
    name,
    origin: 'builtin',
    sourcePath: `/repo/skills/${name}`,
    displayName: null,
    shortDescription: null,
    allowImplicitInvocation: false,
    referencePaths: [],
    bodyLength: 0,
  },
  project: { slug: project },
  workers: [],
})

/** The same built-in indexed once per project — the row that started all of this. */
export const SKILLS = {
  skills: [skill('scope-a-ticket', 'ogun'), skill('scope-a-ticket', 'heirchive-api')],
}

/** Everything the shell and the pages under test ask for, by path. */
/** One source, as `/api/projects/:slug/sources` returns it. */
export const SOURCES = {
  sources: [
    {
      id: 's1',
      project: 'ogun',
      name: 'linear-todo',
      kind: 'linear',
      cycle: 'ticket',
      enabled: true,
      pollMinutes: 5,
      maxPerPoll: 3,
      maxPages: 4,
      team: ['EXC', 'HEI'],
      conditions: {
        team: ['EXC', 'HEI'],
        status: ['Todo'],
        label: { all_of: [], any_of: ['admin', 'agent-ready'], none_of: ['needs-design'] },
        notBlocked: true,
      },
      health: {
        state: 'healthy',
        kind: null,
        detail: null,
        remedy: null,
        lastPolledAt: '2026-10-16T12:00:00.000Z',
        lastOkAt: '2026-10-16T12:00:00.000Z',
        lastAdmittedAt: null,
        lastEmittedAt: null,
        firstPollAt: '2026-09-01T12:00:00.000Z',
        pollsRecorded: 500,
      },
      polls: [],
    },
  ],
  emissions: [],
  ticket: null,
}

/**
 * What the Sources editor fetches to populate its pickers, as the live endpoint returns
 * it — a real recording, spliced with a second team so the status narrowing has something
 * to narrow. See `packages/server/test/fixtures/linear/options.json`.
 */
export const LINEAR_OPTIONS = {
  teams: [
    { key: 'HEI', name: 'Heirchive' },
    { key: 'EXC', name: 'Excelsior' },
  ],
  states: [
    { name: 'In Review', type: 'started', team: 'HEI' },
    { name: 'Backlog', type: 'backlog', team: 'HEI' },
    { name: 'Canceled', type: 'canceled', team: 'HEI' },
    { name: 'In Progress', type: 'started', team: 'HEI' },
    { name: 'Todo', type: 'unstarted', team: 'HEI' },
    { name: 'Done', type: 'completed', team: 'HEI' },
    { name: 'Todo', type: 'unstarted', team: 'EXC' },
    { name: 'Icebox', type: 'backlog', team: 'EXC' },
  ],
  labels: [
    { name: 'MVP', team: null },
    { name: 'design', team: null },
    { name: 'infrastructure', team: null },
    { name: 'backend', team: null },
    { name: 'frontend', team: null },
    { name: 'Bug', team: null },
    { name: 'Feature', team: null },
    { name: 'admin', team: 'EXC' },
    { name: 'agent-ready', team: null },
  ],
  reachable: true,
  reason: null,
}

/** The same endpoint when the project's grant has lapsed — the case that keeps freeform. */
export const LINEAR_OPTIONS_UNREACHABLE = {
  teams: [],
  states: [],
  labels: [],
  reachable: false,
  reason: 'linear rejected the oauth access token for Heirchive: Authentication required',
}

/** The project's cycles, as the cycle picker reads them. */
export const CYCLES = {
  cycles: [
    { id: 'c1', name: 'ticket', standalone: false },
    { id: 'c2', name: 'nightly-review', standalone: false },
    { id: 'c3', name: 'scope-a-ticket', standalone: true },
    { id: 'c4', name: 'plan-a-ticket', standalone: true },
  ],
}

/**
 * The Runs list, with rows in it.
 *
 * **Deliberately not in `ROUTES`.** Every fixture reachable by default is one the
 * screenshot pass can photograph, and `screenshots.ts` is explicit that nothing it
 * captures may render a relative time — "3 days ago" is a pixel difference every morning,
 * and a screenshot that changes on its own is a diff nobody reads. These rows carry
 * timestamps, so they are handed to the tests that ask for them and `/api/runs` stays
 * empty for everybody else.
 *
 * One finished run, one in flight, one `dispatched` with a pull request, and one job
 * blocked behind a dependency that has already finished — the four shapes the list has to
 * tell apart.
 */
const run = (
  id: string,
  over: Record<string, unknown> = {},
  produced: Record<string, unknown> = {},
  job: Record<string, unknown> = {},
) => ({
  run: {
    id,
    outcome: 'approved',
    detail: null,
    notes: null,
    startedAt: '2026-10-16T12:00:00.000Z',
    endedAt: '2026-10-16T12:07:00.000Z',
    durationMs: 420_000,
    rounds: 1,
    repoSha: 'ab12cd34ef56ab78',
    runtime: 'claude',
    model: 'sonnet',
    inputTokens: 4100,
    outputTokens: 900,
    ...over,
  },
  job: { id: `job-${id}`, nodeKey: 'review', state: 'succeeded', cycleRunId: 'cr-1', ...job },
  worker: { id: 'w-1', name: 'adversarial-review' },
  project: { slug: 'ogun' },
  produced: { findings: 2, changed: false, branch: null, prUrl: null, ...produced },
})

export const RUNS = {
  runs: [
    // `job.state` matters here: a run with no `endedAt` whose job has been swept to
    // `failed` is abandoned, not in flight, and the list has to tell them apart.
    run(
      'run-inflight',
      { outcome: null, endedAt: null, durationMs: null, repoSha: null },
      {},
      { state: 'running' },
    ),
    run(
      'run-dispatched',
      { outcome: 'dispatched' },
      {
        changed: true,
        branch: 'ogun/implement/3f2a9c',
        prUrl: 'https://github.com/Heirchive/heirchive-api/pull/412',
      },
    ),
    /**
     * The three the taxonomy exists to keep apart, all on one page: a worker that read the
     * work and said no, a gate that refused the output, and a crash. They are four words
     * for "it didn't work" to anybody who has not read `outcomes.ts`, which is what the
     * status key is for — so the fixture has to contain them for the key to be testable.
     */
    run('run-declined', {
      outcome: 'declined',
      detail: 'the ticket names no acceptance criteria, so there is nothing to build against',
    }),
    run('run-rejected', { outcome: 'changes-requested' }),
    run('run-error', { outcome: 'error', detail: 'the container exited 137' }),
    run('run-approved'),
  ],
  pending: [
    {
      job: {
        id: 'job-blocked',
        nodeKey: 'implement',
        state: 'blocked',
        createdAt: '2026-10-16T11:00:00.000Z',
        cycleRunId: 'cr-9',
        dependsOn: ['plan'],
      },
      requires: ['claude', 'docker'],
      cycle: { name: 'ticket' },
      dependencies: [{ nodeKey: 'plan', state: 'skipped', terminal: true }],
      worker: { id: 'w-2', name: 'implement' },
      project: { slug: 'ogun' },
      reach: 'claimable',
      missing: [],
    },
  ],
  onlineRunners: 1,
  liveRunners: 1,
}

/**
 * One run as `/api/runs/:id` returns it — so a row click lands on a page that renders
 * rather than on an error, which is the half of "the row is clickable" that matters.
 *
 * Finished, not in flight: `RunDetailPage` attaches an `EventSource` for a run with no
 * `endedAt`, and the route stub answers with JSON rather than an event stream, so the
 * browser would reconnect in a loop and `networkidle` would never arrive.
 */
export const RUN_DETAIL = {
  ...run('run-approved'),
  job: {
    id: 'job-run-approved',
    nodeKey: 'review',
    state: 'succeeded',
    cycleRunId: 'cr-1',
    prompt: 'look for isolation bugs',
  },
  produced: { findings: [], suppressed: [], promoted: [], changes: [] },
  events: [],
  artifacts: [],
}

export const ROUTES: Record<string, unknown> = {
  '/api/projects': PROJECTS,
  '/api/system/status': STATUS,
  '/api/skills': SKILLS,
  '/api/workers': WORKERS,
  '/api/findings': { findings: [] },
  '/api/runs': { runs: [], pending: [], onlineRunners: 1, liveRunners: 1 },
  '/api/runners': { runners: [], addresses: [], tokenRequired: false, reachabilityWarning: null },
}
