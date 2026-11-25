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
  over: {
    permissions?: string
    sandbox?: string
    skillOrigin?: string | null
    /** `false` puts the "no services" pill on the row; absent is the ordinary worker. */
    services?: boolean
  } = {},
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
    config: over.services === undefined ? {} : { services: over.services },
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
    // Reads a ticket and opens no connection — the case the pill is for.
    worker('scope-a-ticket', 'ogun', { permissions: 'observer', services: false }),
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
  /** `null` for a run no source started — the dash case the Ticket column has to show. */
  ticket: Record<string, unknown> | null = { key: 'HEI-167', url: 'https://linear.app/heirchive/issue/HEI-167' },
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
  /**
   * A ticket on every fixture row, because the column that replaced `Commit` is only
   * worth photographing with something in it — and because the previous fixture set's
   * blind spot (no row ever exercised an empty state) is what let a vanished heading
   * ship. `run-notickets` below is the other half: a run no source started.
   */
  ticket,
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
    run('run-approved', {}, {}, {}, null),
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

/**
 * `GET /api/system` — what the Settings page is built out of.
 *
 * Every value here is invented. This is the one page in the app whose subject is
 * credentials, so a fixture copied from a real machine would put a real path, a real
 * account name or a real client id into a PNG on a public branch. `0000` and
 * `/home/dev/...` are obviously neither.
 *
 * `projectSecretWrites.allowed` is true because the forms this fixture exists to
 * photograph do not render otherwise — the server refuses a key over a non-loopback
 * transport, and the page hides the form rather than offering one that will 403.
 */
export const SYSTEM = {
  controlPlane: {
    bind: '127.0.0.1',
    port: 7777,
    tokenRequired: true,
    addresses: ['http://127.0.0.1:7777'],
    reachabilityWarning: null,
    configPath: '/home/dev/.ogun/config.json',
  },
  host: {
    git: '2.43.0',
    docker: '27.3.1',
    claude: '2.0.1',
    codex: null,
    baseImage: true,
    claudeCredentials: true,
    codexCredentials: false,
    isRunner: true,
    runnerName: 'this-machine',
  },
  projectSecrets: [{ project: 'heirchive-api', name: 'linear', state: 'present' as const }],
  projectSecretWrites: {
    allowed: true,
    reason: null,
    names: ['linear', 'github'],
  },
  checkouts: [
    { slug: 'heirchive-api', path: '/home/dev/src/heirchive-api', present: true },
    { slug: 'ogun', path: '/home/dev/src/ogun', present: true },
  ],
  counts: { projects: 2, runs: 128, openFindings: 3, queuedJobs: 0 },
}

/** `GET /api/oauth/github` with nothing connected — the state the App form is for. */
export const GITHUB_SETTINGS = {
  connections: [],
  registerUrl: 'https://github.com/settings/apps/new',
}

/** `GET /api/oauth/linear`, which the Settings page reads beside the GitHub card. */
export const LINEAR_OAUTH = {
  apps: [],
  redirectUri: 'http://127.0.0.1:7777/api/oauth/linear/callback',
  registerUrl: 'https://linear.app/settings/api/applications/new',
  scopes: ['read', 'write'],
  actor: 'the app',
  writesAllowed: true,
  failures: {},
}

export const ROUTES: Record<string, unknown> = {
  '/api/projects': PROJECTS,
  '/api/system/status': STATUS,
  '/api/system': SYSTEM,
  '/api/oauth/github': GITHUB_SETTINGS,
  '/api/oauth/linear': LINEAR_OAUTH,
  '/api/oauth/applications': { applications: [] },
  '/api/skills': SKILLS,
  '/api/workers': WORKERS,
  '/api/findings': { findings: [] },
  '/api/runs': { runs: [], pending: [], onlineRunners: 1, liveRunners: 1 },
  '/api/runners': { runners: [], addresses: [], tokenRequired: false, reachabilityWarning: null },
}

/**
 * One timeline row. `offset` is seconds after the run started, because that is the column
 * the page renders — an absolute `ts` here would be a number nobody can check against the
 * `+12s` in the picture.
 */
const event = (seq: number, offset: number, type: string, payload: Record<string, unknown>) => ({
  id: `e${seq}`,
  seq,
  ts: new Date(Date.parse('2026-10-16T12:00:00.000Z') + offset * 1000).toISOString(),
  type,
  payload,
})

/**
 * A run with a timeline in it, event by event.
 *
 * `RUN_DETAIL` above carries `events: []`, which is all the click-through test needs and
 * exactly nothing of what the timeline renders. Every payload shape here was copied off a
 * real run out of a live control plane (`/api/runs/:id`), because the timeline's whole job
 * is formatting payloads nobody designed for it: `Bash` carries `command` plus a prose
 * `description`, `Read` carries `file_path` and sometimes a line window, `Grep` carries a
 * `pattern`, and codex calls the same shell tool `command_execution` instead of `Bash`.
 * A fixture written from the UI's assumptions would photograph those assumptions.
 *
 * Finished, for the same reason `RUN_DETAIL` is: an in-flight run attaches an
 * `EventSource` the route stub cannot answer.
 */
export const RUN_WITH_EVENTS = {
  ...run('run-events', { model: 'claude-opus-5' }, {}, { nodeKey: 'implement' }),
  worker: { id: 'w-3', name: 'implement' },
  job: {
    id: 'job-run-events',
    nodeKey: 'implement',
    state: 'succeeded',
    cycleRunId: 'cr-2',
    prompt: 'build the plan at .ogun-in/upstream.json',
  },
  produced: {
    findings: [],
    suppressed: [],
    promoted: [],
    changes: [
      {
        id: 'ch-1',
        branch: 'ogun/implement/15ad22c',
        filesChanged: 2,
        testsPassed: true,
        prUrl: 'https://github.com/Heirchive/heirchive-api/pull/412',
      },
    ],
  },
  artifacts: [],
  events: [
    event(0, 0, 'runner.note', {
      note: 'skill make-a-change (builtin) at .claude/skills/make-a-change',
      path: '.claude/skills/make-a-change',
      skill: 'make-a-change',
      origin: 'builtin',
      injected: true,
    }),
    event(1, 1, 'run.started', {
      runtime: 'claude',
      model: 'claude-opus-5',
      tools: 26,
      sessionId: '38a31b06-1686-4e61-a91b-0ee8b3358300',
    }),
    event(2, 3, 'agent.message', {
      text: "I'll start by reading the skill and my inputs.",
    }),
    event(3, 4, 'tool.started', {
      name: 'Bash',
      callId: 'c1',
      input: {
        command: 'cat /workspace/.claude/skills/make-a-change/SKILL.md',
        description: 'Read the make-a-change skill',
      },
    }),
    event(4, 6, 'tool.completed', {
      name: 'Bash',
      callId: 'c1',
      isError: false,
      output:
        '---\nname: make-a-change\ndescription: Take one item of work and build it.\n---\n\n# Make a change\n\nYou are the step that turns one item of work into a commit somebody can read.',
    }),
    event(5, 8, 'tool.started', {
      name: 'Read',
      callId: 'c2',
      input: { file_path: '/workspace/apps/web/src/components/layout/Sidebar.tsx', offset: 120, limit: 60 },
    }),
    event(6, 9, 'tool.completed', {
      name: 'Read',
      callId: 'c2',
      isError: false,
      output: '   120\tconst handleSignOut = async () => {\n   121\t  try {\n   122\t    await signOut()',
    }),
    event(7, 11, 'tool.started', {
      name: 'Grep',
      callId: 'c3',
      input: { pattern: 'text-destructive', path: 'apps/web/src', output_mode: 'files_with_matches' },
    }),
    event(8, 12, 'tool.completed', {
      name: 'Grep',
      callId: 'c3',
      isError: false,
      output: 'apps/web/src/components/ui/alert.tsx\napps/web/src/components/ui/form.tsx',
    }),
    /** The multi-line case: a heredoc is the shape a one-line row cannot show. */
    event(9, 20, 'tool.started', {
      name: 'Bash',
      callId: 'c4',
      input: {
        command:
          "cd /workspace && python3 - <<'EOF'\np = 'apps/web/src/components/layout/Sidebar.tsx'\ns = open(p).read()\ns = s.replace('Exit', 'Sign out')\nopen(p, 'w').write(s)\nEOF\ngrep -n 'Sign out' apps/web/src/components/layout/Sidebar.tsx",
        description: 'Rename the label',
        timeout: 120000,
      },
    }),
    event(10, 22, 'tool.completed', {
      name: 'Bash',
      callId: 'c4',
      isError: false,
      output: "87:            <span className=\"sr-only\">Sign out</span>",
    }),
    event(11, 24, 'tool.started', {
      name: 'Edit',
      callId: 'c5',
      input: {
        file_path: '/workspace/apps/web/src/components/layout/Sidebar.tsx',
        old_string: 'catch { href = "/auth/signin" }',
        new_string: 'catch (e) { setError(message(e)) }',
        replace_all: false,
      },
    }),
    event(12, 25, 'tool.completed', { name: 'Edit', callId: 'c5', isError: false, output: 'ok' }),
    event(13, 27, 'tool.started', {
      name: 'Write',
      callId: 'c6',
      input: {
        file_path: '/workspace/apps/web/src/components/layout/Sidebar.test.tsx',
        content: 'import { render, screen } from "@testing-library/react"\n'.repeat(4),
      },
    }),
    event(14, 28, 'tool.completed', { name: 'Write', callId: 'c6', isError: false, output: 'ok' }),
    /** The failing command, which the row has to say out loud rather than collapse. */
    event(15, 40, 'tool.started', {
      name: 'Bash',
      callId: 'c7',
      input: { command: 'pnpm --filter heirchive-web test', description: 'Run the web suite' },
    }),
    event(16, 95, 'tool.completed', {
      name: 'Bash',
      callId: 'c7',
      isError: true,
      exitCode: 1,
      output:
        'FAIL  src/components/layout/Sidebar.test.tsx\n  ● renders the error instead of navigating\n\n    expect(window.location.href).toBe("/dashboard")\n\n    Received: "/auth/signin"\n\nTests: 1 failed, 52 passed',
    }),
    /** Codex names the same tool `command_execution`, and carries no description. */
    event(17, 120, 'tool.started', {
      name: 'command_execution',
      callId: 'c8',
      input: { command: 'pnpm --filter heirchive-web test' },
    }),
    event(18, 150, 'tool.completed', {
      name: 'command_execution',
      callId: 'c8',
      exitCode: 0,
      isError: false,
      output: 'Tests: 53 passed, 9 files',
    }),
    /** What an agent's closing message actually looks like: markdown, and a page of it. */
    event(19, 160, 'agent.message', {
      text: [
        'Done — one commit, clean tree.',
        '',
        '## What I built',
        '',
        'The plan at `.ogun-in/upstream.json` was my specification; every claim it made',
        'held at this commit.',
        '',
        '- Label `Exit` → **Sign out**. The app settles the tiebreak: every auth control',
        '  says "Sign in" and the button\'s own `title` already said "Sign out".',
        '- The error handling was the bigger half. `handleSignOut` caught the rejection,',
        '  bound it to nothing, and navigated from *both* branches.',
        '',
        '## Verification',
        '',
        '```',
        'pnpm --filter heirchive-web test   53 passed, 9 files',
        'tsc --noEmit                       clean',
        '```',
        '',
        'One thing to be straight about: the gate\'s command is api-only, so it cannot see',
        'this change at all.',
      ].join('\n'),
    }),
    event(20, 162, 'run.completed', {
      result: 'approved',
      usage: { inputTokens: 4100, outputTokens: 900 },
    }),
  ],
}
