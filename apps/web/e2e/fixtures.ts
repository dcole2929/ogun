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

export const ROUTES: Record<string, unknown> = {
  '/api/projects': PROJECTS,
  '/api/system/status': STATUS,
  '/api/skills': SKILLS,
  '/api/workers': WORKERS,
  '/api/findings': { findings: [] },
  '/api/runs': { runs: [], pending: [], onlineRunners: 1, liveRunners: 1 },
  '/api/runners': { runners: [], addresses: [], tokenRequired: false, reachabilityWarning: null },
}
