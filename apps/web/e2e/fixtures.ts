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
export const ROUTES: Record<string, unknown> = {
  '/api/projects': PROJECTS,
  '/api/system/status': STATUS,
  '/api/skills': SKILLS,
  '/api/workers': WORKERS,
  '/api/findings': { findings: [] },
  '/api/runs': { runs: [], pending: [], onlineRunners: 1, liveRunners: 1 },
  '/api/runners': { runners: [], addresses: [], tokenRequired: false, reachabilityWarning: null },
}
