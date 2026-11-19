import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { ReactElement } from 'react'
import { Markdown } from '../src/Markdown.tsx'
import { SkillsPage } from '../src/pages/Skills.tsx'
import { WorkersPage } from '../src/pages/Workers.tsx'
import { FindingsPage } from '../src/pages/Findings.tsx'
import { RunsPage } from '../src/pages/Runs.tsx'
import { RunDetailPage } from '../src/pages/RunDetail.tsx'
import { CoveragePage } from '../src/pages/Coverage.tsx'
import { labelSuggestions, SourcesPage, stateSuggestions } from '../src/pages/Sources.tsx'
import { RunnersPage } from '../src/pages/Runners.tsx'
import { SettingsPage } from '../src/pages/Settings.tsx'
import { Notifications, troublesFrom } from '../src/Notifications.tsx'
import type { LinearOauth, SystemInfo } from '../src/api.ts'
import { ProjectScopeProvider } from '../src/scope.tsx'
import { duration, STATUS_HELP } from '../src/ui.tsx'
/**
 * Reached by relative path rather than through `@ogun/core`'s package name, on purpose.
 * `apps/web` has no dependency on that package and must not grow one — the bundle does
 * not want zod or a database driver — but this test file is bundled by esbuild for node,
 * so it can read the one module whose contents the UI is claiming to reproduce.
 */
import { JOB_STATES, RUN_OUTCOMES } from '../../../packages/core/src/outcomes.ts'

/**
 * A smoke test, not a snapshot. It renders every page with no data and no server, which
 * is exactly the state a page is in for its first paint — and the state that catches the
 * mistakes worth catching here: a bad hook order, a missing provider, a `.map` on
 * something undefined before the query resolves.
 *
 * Bundled through esbuild by `pnpm --filter @ogun/web test`, since node cannot strip JSX.
 */
const render = (el: ReactElement, seed?: (qc: QueryClient) => void): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(qc)
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The same, with the project scope set — the state every page is in once one is picked. */
const renderScoped = (
  el: ReactElement,
  scope: string,
  seed?: (qc: QueryClient) => void,
  /** The URL to render at, for a page that reads its own search params. */
  at = '/',
): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(qc)
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <ProjectScopeProvider initial={scope}>{el}</ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const TWO_PROJECTS = { projects: [{ id: '1', slug: 'ogun' }, { id: '2', slug: 'heirchive-api' }] }

/** One indexed skill, as `/api/skills` returns it. */
const skillRow = (name: string, project: string) => ({
  skill: {
    id: `${project}-${name}`,
    name,
    origin: 'builtin',
    sourcePath: `/repo/skills/${name}`,
    displayName: null,
    shortDescription: null,
    allowImplicitInvocation: false,
  },
  project: { slug: project },
  workers: [],
})

test('every page renders with no data', () => {
  for (const [name, el] of [
    ['skills', <SkillsPage />],
    ['workers', <WorkersPage />],
    ['findings', <FindingsPage />],
    ['runs', <RunsPage />],
    ['coverage', <CoveragePage />],
    ['sources', <SourcesPage />],
    ['runners', <RunnersPage />],
    ['settings', <SettingsPage />],
  ] as const) {
    const html = render(el)
    assert.ok(html.length > 0, `${name} rendered nothing`)
  }
})

/**
 * A control plane with a project secret already stored, rendered against real data rather
 * than the empty first paint above.
 */
const systemWith = (writes: SystemInfo['projectSecretWrites']): SystemInfo => ({
  controlPlane: {
    bind: writes.allowed ? '127.0.0.1' : '0.0.0.0',
    port: 7777,
    tokenRequired: !writes.allowed,
    addresses: [],
    reachabilityWarning: null,
    configPath: '/home/x/.ogun/config.json',
  },
  host: {
    git: 'git version 2.43.0',
    docker: null,
    claude: null,
    codex: null,
    baseImage: false,
    claudeCredentials: false,
    codexCredentials: false,
    isRunner: false,
    runnerName: null,
  },
  projectSecrets: [{ project: 'ogun', name: 'linear', state: 'present' }],
  projectSecretWrites: writes,
  checkouts: [],
  counts: { projects: 1, runs: 0, openFindings: 0, queuedJobs: 0 },
})

/**
 * The property: the field a key is typed into is write-only, and a stored key is shown as
 * a state rather than as a value.
 *
 * The ordinary way to build this form is the wrong one. An input pre-filled with dots to
 * represent the existing key puts a secret in the DOM, in the page's memory and in
 * anything reading either — in exchange for a reassurance the "set" pill already gives.
 * The server makes it impossible on its side (`ProjectSecretPresence` has no field a value
 * fits in), and this is the browser half of the same rule: no input on this page ever
 * renders with a value it did not just receive from the person typing.
 */
test('the project-secret field is write-only, even when one is already stored', () => {
  const html = render(<SettingsPage />, (qc) =>
    qc.setQueryData(['system'], systemWith({ allowed: true, reason: null, names: ['linear'] })),
  )

  assert.match(html, /type="password"/, 'the key field should be a password field')
  assert.match(html, /pill green">set/, 'an existing key should show as a state')
  assert.ok(
    !/<input[^>]*value="[^"]/.test(html),
    'an input rendered with a value — nothing on this page may be seeded from a stored key',
  )
})

/**
 * The property: when the transport cannot carry a secret, there is no field at all.
 *
 * Not a disabled one. A disabled input still collects the key — it is typed, it is in the
 * page, and only the submit is missing — which is the one thing the refusal exists to
 * prevent. And the page must say what to do instead, or a refusal on the only surface an
 * operator has is a dead end.
 */
test('a control plane that cannot carry a secret offers the CLI, not a form', () => {
  const html = render(<SettingsPage />, (qc) =>
    qc.setQueryData(
      ['system'],
      systemWith({
        allowed: false,
        reason: 'this control plane is bound to 0.0.0.0 and serves plain HTTP',
        names: ['linear'],
      }),
    ),
  )

  assert.ok(!html.includes('type="password"'), 'a key field was rendered on a refusing bind')
  // React splits the interpolated secret name with a comment node, so this matches the
  // two halves rather than the rendered string.
  assert.match(html, /ogun connect .*linear.* --api-key/, 'the refusal has to name the path that works')
  /**
   * The usage line the refusal prints has to name the value, not only the command.
   *
   * This is the fault the whole `connect` change is about, arriving on the surface where it
   * costs the most: an operator being sent from a browser to a terminal on another machine
   * has one chance to be told what the command will ask for.
   */
  assert.match(html, /&lt;key&gt;|<key>/, 'the usage line has to name the key it needs')
  assert.match(html, /plain HTTP/, "the server's reason should be shown, not paraphrased")
})

/**
 * A control plane with one project connected to Linear and one halfway there.
 */
const linearOauth = (over: Partial<LinearOauth> = {}): LinearOauth => ({
  apps: [
    {
      project: 'ogun',
      provider: 'linear',
      clientId: 'client-1',
      clientSecretSet: true,
      redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
      connected: true,
      scopes: ['read'],
      actor: 'app',
      expiresAt: Date.now() + 7 * 36e5,
      obtainedAt: Date.now() - 17 * 36e5,
      workspace: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    },
  ],
  redirectUri: 'http://localhost:7777/api/oauth/linear/callback',
  registerUrl: 'https://linear.app/settings/api/applications/new',
  scopes: ['read'],
  actor: 'app',
  writesAllowed: true,
  failures: {},
  ...over,
})

/**
 * The property: the exact redirect callback URL is on the page, as text, before anything
 * else about the connection.
 *
 * This is the failure the whole card is arranged around. A redirect URI that differs from
 * the registered one by a port, a scheme or a trailing slash is the classic way an OAuth
 * integration fails, and Linear's error for it names nothing an operator can act on — so a
 * page that documents "register a callback URL" and leaves them to construct it has left
 * the one hard step to guesswork. It is generated by the server that will receive the
 * callback, which is the only thing that knows.
 *
 * The status beside it says the workspace and the actor rather than just "connected",
 * because *who Linear attributes activity to* is the entire reason for connecting an
 * application instead of pasting a personal key.
 */
test('the linear card shows the exact callback url, and who the grant acts as', () => {
  const html = render(<SettingsPage />, (qc) => {
    qc.setQueryData(['system'], systemWith({ allowed: true, reason: null, names: ['linear'] }))
    qc.setQueryData(['linearOauth'], linearOauth())
  })

  assert.match(html, /http:\/\/localhost:7777\/api\/oauth\/linear\/callback/)
  assert.match(html, /linear\.app\/settings\/api\/applications\/new/)
  assert.match(html, /Acme/, 'the workspace the grant belongs to should be shown')
  assert.match(html, /the app/, 'who Linear attributes activity to is the point of this')
  // React splits interpolated text with a comment node, so the rendered string is
  // `actor=<!-- -->app` rather than `actor=app`.
  assert.match(html, /actor=(<!-- -->)?app/)
})

/**
 * The property: no token, and no client secret, reaches the DOM.
 *
 * The server makes it structurally impossible — `LinearApp` has no field a credential fits
 * in — and this is the browser half of the same rule, asserted against the rendered HTML
 * rather than against props. A card that rendered a masked token would put the value in
 * the page's memory and in anything reading it, in exchange for a reassurance the pill
 * already gives.
 */
test('the linear card renders no credential, and no input seeded with one', () => {
  const html = render(<SettingsPage />, (qc) => {
    qc.setQueryData(['system'], systemWith({ allowed: true, reason: null, names: ['linear'] }))
    qc.setQueryData(['linearOauth'], linearOauth())
  })

  assert.ok(!html.includes('lin_secret'), 'a client secret reached the page')
  assert.ok(
    !/<input[^>]*value="[^"]/.test(html),
    'an input rendered with a value — nothing here may be seeded from a stored credential',
  )
})

/**
 * The property: when the transport cannot carry a client secret, there is no field for
 * one — the same rule, and the same reason, as the API key form beside it.
 *
 * A client secret is the same kind of value as a personal key: a credential in a third
 * party's workspace, typed by a person. A card that offered a disabled input would collect
 * it anyway, which is the one thing the refusal prevents.
 */
test('a control plane that cannot carry a secret offers the CLI for linear too', () => {
  const html = render(<SettingsPage />, (qc) => {
    qc.setQueryData(
      ['system'],
      systemWith({ allowed: false, reason: 'plain HTTP', names: ['linear'] }),
    )
    qc.setQueryData(['linearOauth'], linearOauth({ writesAllowed: false }))
  })

  assert.match(html, /ogun connect linear/, 'the refusal has to name the path that works')
  assert.match(
    html,
    /client-id/,
    'the usage line has to name the two values the command will ask for',
  )
})

test('SKILL.md renders every block type it uses', () => {
  // cwd is apps/web. skills/ is the library ogun ships; .agents/skills is ogun
  // reviewing itself, which is a different thing.
  const source = readFileSync('../../skills/adversarial-review/SKILL.md', 'utf8')
  const html = renderToString(<Markdown source={source} />)
  for (const cls of ['md-frontmatter', 'md-h1', 'md-h2', 'md-table', 'md-code', 'md-list']) {
    assert.match(html, new RegExp(cls), `missing ${cls}`)
  }
  assert.match(html, /<strong>/)
})

/**
 * A project whose source is failing, and one whose filter has matched nothing for a week.
 *
 * Both come off the same route and both are abnormal; only one of them is a fault, and the
 * page has to keep them apart in the two ways a reader actually perceives — the word and
 * the colour.
 */
const sourcesPayload = () => ({
  sources: [
    {
      id: 'a1',
      project: 'ogun',
      name: 'tickets',
      kind: 'linear',
      cycle: 'ticket-pipeline',
      enabled: true,
      pollMinutes: 5,
      team: 'HEI',
      filter: { status: ['Todo'], labels: ['ogun'], excludeLabels: [], notBlocked: true },
      health: {
        state: 'failing' as const,
        kind: 'auth' as const,
        detail: 'auth: linear rejected the credential',
        remedy: 'The credential, not the network. `ogun connect linear --project ogun`',
        lastPolledAt: new Date().toISOString(),
        lastOkAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastAdmittedAt: null,
        lastEmittedAt: null,
        firstPollAt: new Date(Date.now() - 86_400_000).toISOString(),
        pollsRecorded: 40,
      },
      polls: [],
    },
    {
      id: 'b2',
      project: 'ogun',
      name: 'quiet',
      kind: 'linear',
      cycle: 'ticket-pipeline',
      enabled: true,
      pollMinutes: 5,
      team: 'HEI',
      filter: { status: ['To Do'], labels: [], excludeLabels: [], notBlocked: true },
      health: {
        state: 'silent' as const,
        kind: null,
        detail: 'nothing matched; the statuses on those tickets were: Todo, In Progress',
        remedy: 'Polling normally — this is not a failure.',
        lastPolledAt: new Date().toISOString(),
        lastOkAt: new Date().toISOString(),
        lastAdmittedAt: null,
        lastEmittedAt: null,
        firstPollAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        pollsRecorded: 5000,
      },
      polls: [],
    },
  ],
  emissions: [
    {
      externalKey: 'HEI-42',
      externalId: 'uuid-42',
      sourceName: 'tickets',
      outcome: 'emitted',
      detail: null,
      cycleRunId: 'run-1',
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    },
  ],
  ticket: null,
})

/**
 * **The property: a failing source names which kind of failing, on the page.**
 *
 * `auth`, `ratelimited`, `transport` and `local` are kept apart all the way from
 * `LinearUnavailable` to the ledger column because the remedies differ — a rejected
 * credential needs a person and a throttled poll needs nobody. The last step is where that
 * is cheapest to lose: one red "failing" pill renders all four identically and is the
 * obvious way to build this. If the kind stops reaching the DOM, four remedies have
 * collapsed into one and nothing else would notice.
 */
test('a failing source shows which kind of failure it is, not just that it failed', () => {
  const html = render(<CoveragePage />, (qc) => {
    qc.setQueryData(['projects'], { projects: [{ slug: 'ogun' }] })
    qc.setQueryData(['sources', 'ogun'], sourcesPayload())
  })

  assert.match(html, /pill red">failing/, 'a failing source is red')
  assert.match(html, />auth</, 'the kind reaches the page, beside the state')
  assert.match(html, /tickets/)
})

/**
 * The other half, and the one it is easier to get wrong in the expensive direction.
 *
 * A source that matches nothing is *working* — `ok` covers "looked and found nothing" on
 * purpose. Rendering `silent` in red would teach a reader that red on this page means
 * "probably fine", which costs the reds that are not fine: the dead credential three rows
 * up. So it is yellow, and it is said, because a filter matching nothing for a week is far
 * more likely to be `status: [To Do]` against a column called `Todo`.
 */
test('a source that has matched nothing is a remark, not a failure', () => {
  const html = render(<CoveragePage />, (qc) => {
    qc.setQueryData(['projects'], { projects: [{ slug: 'ogun' }] })
    qc.setQueryData(['sources', 'ogun'], sourcesPayload())
  })

  assert.match(html, /pill yellow">silent/, 'silence is a remark and must not be red')
  assert.ok(!/pill red">silent/.test(html))
  // The statuses the poll actually saw are the diagnosis, and they have to be readable
  // without opening anything: `To Do` in the filter against `Todo` on the tickets.
  assert.match(html, /statuses on those tickets/)
})

/**
 * Ogun writes nothing back to Linear (ADR-0004), so a ticket that has been completely dealt
 * with sits in `Todo` with its label on, looking exactly like one nothing ever saw. The
 * emission row is the only record anywhere that anything happened, and it had no reader.
 */
test('tickets that already produced work are named on the page', () => {
  const html = render(<CoveragePage />, (qc) => {
    qc.setQueryData(['projects'], { projects: [{ slug: 'ogun' }] })
    qc.setQueryData(['sources', 'ogun'], sourcesPayload())
  })
  assert.match(html, /HEI-42/)
  assert.match(html, /looks untouched/)
})

/** A project with no sources renders no panel at all — most projects have none. */
test('a project with no sources gets no source panel', () => {
  const html = render(<CoveragePage />, (qc) => {
    qc.setQueryData(['projects'], { projects: [{ slug: 'ogun' }] })
    qc.setQueryData(['sources', 'ogun'], { sources: [], emissions: [], ticket: null })
  })
  assert.ok(!html.includes('Whether anything is'), 'an empty panel is chrome nobody reads')
})

test('markdown never emits markup from its source', () => {
  const hostile = [
    '# Title',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '[fine](https://example.com)',
    '[relative](./references/running-a-review.md)',
  ].join('\n\n')
  const html = renderToString(<Markdown source={hostile} />)

  // The renderer emits React elements, so raw HTML in the source becomes text content
  // and React escapes it. Assert on the escaped form: the literal substrings still
  // appear in the output, and checking for those would pass even if it were live markup.
  assert.ok(!html.includes('<script'), 'a script tag survived as markup')
  assert.ok(html.includes('&lt;script'), 'the script tag should appear as escaped text')
  assert.ok(!html.includes('<img'), 'an img tag survived as markup')
  assert.ok(html.includes('&lt;img'), 'the img tag should appear as escaped text')
  assert.ok(!html.includes('href="javascript'), 'a javascript: href survived')
  assert.ok(!html.includes('href="data:'), 'a data: href survived')
  // The safe ones still work, or the escaping would be useless.
  assert.match(html, /href="https:\/\/example\.com"/)
  assert.match(html, /href="\.\/references\/running-a-review\.md"/)
})

/**
 * The duplicate that started this. A built-in skill is indexed once per project — the
 * unique key is `(project_id, name)` — so `scope-a-ticket` is two rows the moment two
 * projects are registered, with the same source path and the same version hash.
 *
 * The list showed every row, so it read as a bug in the data. It was a missing filter.
 */
test('a project scope collapses the same built-in skill down to that project', () => {
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['skills', 'all'], {
      skills: [skillRow('scope-a-ticket', 'ogun'), skillRow('scope-a-ticket', 'heirchive-api')],
    })
    qc.setQueryData(['skills', 'ogun'], { skills: [skillRow('scope-a-ticket', 'ogun')] })
  }

  // Counted by card link rather than by name: exactly one per rendered row, and it does
  // not move when the card's markup does.
  const rows = (html: string) => html.match(/href="\/skills\//g)?.length ?? 0

  const unscoped = renderScoped(<SkillsPage />, 'all', seed)
  assert.equal(rows(unscoped), 2, 'across all projects it is listed once per project')

  const scoped = renderScoped(<SkillsPage />, 'ogun', seed)
  assert.equal(rows(scoped), 1, 'scoped to one project, one row')
  assert.ok(!scoped.includes('heirchive-api'), 'and nothing from the other project')
})

/**
 * The quiet half of the same gap. `CoveragePage` opened with
 * `const slug = projects[0]?.slug` — a stand-in for a selector that did not exist — so
 * with two projects registered the second one's coverage could not be reached at all.
 * Not a duplicate: a page that silently showed you the wrong project's data.
 */
test('coverage follows the scope rather than showing whichever project sorts first', () => {
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['sources', 'heirchive-api'], sourcesPayload())
  }

  const scoped = renderScoped(<CoveragePage />, 'heirchive-api', seed)
  assert.match(scoped, /HEI-42/, "the selected project's ledger is the one rendered")

  // And the first project is still reachable, which is the half that already worked.
  const first = renderScoped(<CoveragePage />, 'ogun', seed)
  assert.ok(!first.includes('HEI-42'), "another project's data does not leak into it")
})

/**
 * A scope pinned to a project that has since been removed must not render an empty app
 * with no explanation — the worst failure available to a control whose job is to narrow.
 */
test('a scope naming a project that no longer exists falls back to all', () => {
  const html = renderScoped(<SkillsPage />, 'deleted-project', (qc) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['skills', 'all'], { skills: [skillRow('triage', 'ogun')] })
  })
  assert.match(html, /triage/, 'it shows everything rather than nothing')
})

/**
 * Runners is outside the project scope on purpose: a runner serves every project, so
 * scoping the page to one would be scoping it to nothing. It still filters.
 */
test('runners ignores the project scope and filters on its own terms', () => {
  const runners = {
    runners: [
      { id: 'a', name: 'desktop', labels: ['claude', 'docker'], online: true, revokedAt: null },
      { id: 'b', name: 'laptop', labels: ['codex'], online: false, revokedAt: null },
    ],
    addresses: [],
    tokenRequired: false,
    reachabilityWarning: null,
  }
  const scoped = renderScoped(<RunnersPage />, 'ogun', (qc) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['runners'], runners)
  })
  assert.match(scoped, /desktop/, 'a project scope hides no machine')
  assert.match(scoped, /laptop/)
})

/** One worker row, as `/api/workers` returns it. */
const workerRow = (
  name: string,
  over: { permissions?: string; sandbox?: string; skillOrigin?: string | null } = {},
) => ({
  worker: {
    id: name,
    name,
    skillRef: name,
    runtime: 'claude',
    modelRole: 'reviewer',
    permissions: over.permissions ?? 'reviewer',
    sandbox: over.sandbox ?? 'container',
    enabled: true,
    versionHash: 'h',
    config: {},
  },
  project: { slug: 'ogun' },
  skillOrigin: over.skillOrigin === undefined ? 'builtin' : over.skillOrigin,
  breaker: null,
  schedule: null,
  nextRun: null,
  drivenBy: null,
  effectivePrompt: { text: '', source: 'skill' as const },
})

const WORKERS = {
  workers: [
    workerRow('adversarial-review'),
    workerRow('fix-a-finding', { permissions: 'modifier' }),
    workerRow('scope-a-ticket', { permissions: 'observer' }),
    workerRow('local-thing', { sandbox: 'worktree', skillOrigin: 'project' }),
    workerRow('renamed', { skillOrigin: null }),
  ],
  editable: { ogun: false },
  hashes: {},
  policies: {},
  allowSandboxDowngrade: {},
}

const seedWorkers = (qc: QueryClient) => {
  qc.setQueryData(['projects'], TWO_PROJECTS)
  qc.setQueryData(['allWorkers', 'ogun'], WORKERS)
}

/**
 * The three axes that are worker properties rather than runner ones: what a run is
 * allowed to do, how it is isolated, and whether the skill behind it is one of Ogun's or
 * one this repo wrote.
 */
test('workers filter by role, sandbox and where the skill came from', () => {
  const page = renderScoped(<WorkersPage />, 'ogun', seedWorkers)
  for (const name of ['adversarial-review', 'fix-a-finding', 'local-thing', 'renamed']) {
    assert.match(page, new RegExp(name), `${name} is listed unfiltered`)
  }

  // The options are derived from the rows, so a value nothing has is never offered — and
  // every value something has is.
  for (const option of ['observer', 'modifier', 'worktree', 'container']) {
    assert.match(page, new RegExp(`value="${option}"`), `${option} is offered as a filter`)
  }
  assert.match(page, /value="unindexed"/, 'a worker whose skill is not indexed is filterable')
  assert.match(page, /this repo's|this repo&#x27;s/, "a project skill's origin is offered in words")
})

/**
 * A filter that empties a section must not offer to create a worker. The project may be
 * full of them, and inviting a second `adversarial-review` is how duplicates get made.
 */
test('an emptied section says it is filtered rather than offering to create', () => {
  const html = renderScoped(<WorkersPage />, 'ogun', (qc) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['allWorkers', 'ogun'], { ...WORKERS, workers: [] })
  })
  assert.match(html, /no workers yet/, 'a genuinely empty project still invites one')
})

/**
 * The tray replaced a stack of tinted boxes in the sidebar. The behaviour worth pinning
 * is not the styling — it is that the collapsed line says how much is wrong without the
 * detail, and that nothing is lit when nothing is.
 */
test('the notifications tray summarises without spilling detail into the sidebar', () => {
  const status = {
    runnersOnline: 0,
    drifted: ['ogun', 'heirchive-api'],
    breakers: [{ worker: 'security-review', project: 'ogun', failures: 3 }],
    sources: [],
  }
  // Server rendering splits an interpolated value from the text beside it with an empty
  // comment, so assertions about what a reader sees have to ignore those.
  const html = render(<Notifications />, (qc) => qc.setQueryData(['status'], status)).replaceAll(
    '<!-- -->',
    '',
  )

  assert.match(html, /4 problems/, 'the collapsed line counts everything')
  // Two of the four stop work outright, and that is carried by the dot rather than by a
  // second count beside the label — which did not fit. See the e2e test that measures it.
  assert.match(html, /tray-trigger lit stopped/, 'the trigger says something is stopped')
  assert.ok(
    !html.includes('consecutive failures'),
    'the explanatory sentences stay in the panel, which is closed',
  )
})

test('nothing is lit when nothing is wrong', () => {
  const html = render(<Notifications />, (qc) =>
    qc.setQueryData(['status'], { runnersOnline: 2, drifted: [], breakers: [], sources: [] }),
  )
  assert.match(html, /All clear/)
  assert.ok(!html.includes('class="tray-trigger lit'), 'the trigger is not lit')
  assert.match(html, /disabled/, 'and there is no panel to open')
})

/**
 * The bug the tray had once the app grew a hard project scope: a notification about
 * another project navigated you to a page that then filtered out the very thing you
 * clicked. Two halves — the link has to carry the project, and it has to name the worker
 * so the destination can put it in front of you.
 */
test('a notification names the project and the worker it is about', () => {
  const troubles = troublesFrom({
    runnersOnline: 0,
    drifted: ['heirchive-api'],
    breakers: [{ worker: 'security-review', project: 'heirchive-api', failures: 3 }],
    sources: [
      { project: 'ogun', source: 'linear', state: 'failing', kind: 'auth', detail: null },
    ],
  })

  const by = (fragment: string) => troubles.find((t) => t.key.startsWith(fragment))

  // Every project-specific entry carries its project, so following it moves the scope.
  assert.equal(by('breaker')?.project, 'heirchive-api')
  assert.equal(by('drift')?.project, 'heirchive-api')
  assert.equal(by('source')?.project, 'ogun')

  // And the machine-wide one deliberately does not: Runners is outside the scope, so
  // there is nothing to move, and moving it would be a side effect nobody asked for.
  assert.equal(by('runners')?.project, undefined)

  // The halted worker is named in the URL rather than leaving you to find it.
  assert.equal(by('breaker')?.to, '/workers?focus=security-review')
})

/**
 * `focus` overrides the rest of the bar rather than combining with it. Arriving from a
 * notification with a stale `Role` filter still set would otherwise land you on a page
 * that hides the worker the tray just told you was halted.
 */
test('a focused worker survives filters that would otherwise hide it', () => {
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['projects'], TWO_PROJECTS)
    qc.setQueryData(['allWorkers', 'ogun'], WORKERS)
  }

  const focused = renderScoped(
    <WorkersPage />,
    'ogun',
    seed,
    '/workers?focus=scope-a-ticket',
  )
  assert.match(focused, /scope-a-ticket/, 'the worker asked for is shown')
  assert.ok(!focused.includes('adversarial-review'), 'and the rest of the list is not')
  // It must also be visible *as* a filter, or the page is quietly lying about how much
  // it is showing.
  assert.match(focused, /class="chip"/, 'the focus is shown as a removable chip')
  assert.ok(!focused.includes('placeholder="name, skill, model'), 'the overridden controls go')
})

/** A focus naming a worker in another project says so, rather than rendering nothing. */
test('a focus that matches nothing in scope explains itself', () => {
  const html = renderScoped(
    <WorkersPage />,
    'ogun',
    (qc) => {
      qc.setQueryData(['projects'], TWO_PROJECTS)
      qc.setQueryData(['allWorkers', 'ogun'], WORKERS)
    },
    '/workers?focus=something-else',
  )
  assert.match(html, /is not in this project/)
  assert.match(html, /All projects/, 'and says where to look instead')
})

/**
 * The status picker offers HEI's columns to a HEI source, and not EXC's.
 *
 * A workflow state belongs to a team, so a picker that ignores the source's teams
 * suggests values that cannot ever match — it would be helping somebody write the exact
 * silent-empty-poll this whole surface exists to prevent.
 */
test('statuses are narrowed to the teams the source names', () => {
  const options = {
    teams: [
      { key: 'HEI', name: 'Heirchive' },
      { key: 'EXC', name: 'Excelsior' },
    ],
    states: [
      { name: 'Todo', type: 'unstarted', team: 'HEI' },
      { name: 'In Progress', type: 'started', team: 'HEI' },
      { name: 'Icebox', type: 'backlog', team: 'EXC' },
    ],
    labels: [],
    reachable: true,
    reason: null,
  }

  assert.deepEqual(
    stateSuggestions(options, ['HEI']).map((s) => s.value),
    ['Todo', 'In Progress'],
  )
  // No team chosen yet is not a reason to offer an empty dropdown.
  assert.deepEqual(
    stateSuggestions(options, []).map((s) => s.value).sort(),
    ['Icebox', 'In Progress', 'Todo'],
  )
  // The config matches teams ignoring case, so the picker has to as well.
  assert.deepEqual(
    stateSuggestions(options, ['hei']).map((s) => s.value),
    ['Todo', 'In Progress'],
  )
})

/**
 * Two teams with a column of the same name are one suggestion, because the rule matches
 * on the name — two identical rows would be a dropdown implying a distinction the filter
 * cannot make.
 */
test('statuses are deduplicated by name and ordered by how likely they are to be wanted', () => {
  const suggestions = stateSuggestions(
    {
      teams: [],
      states: [
        { name: 'Done', type: 'completed', team: 'HEI' },
        { name: 'Todo', type: 'unstarted', team: 'HEI' },
        { name: 'Todo', type: 'unstarted', team: 'EXC' },
      ],
      labels: [],
      reachable: true,
      reason: null,
    },
    [],
  )
  assert.deepEqual(
    suggestions.map((s) => s.value),
    ['Todo', 'Done'],
  )
  assert.deepEqual(
    suggestions.map((s) => s.group),
    ['not started', 'done'],
  )
})

/** A label can belong to a team or to the workspace, and the team is worth showing. */
test('labels carry their team when they have one', () => {
  assert.deepEqual(
    labelSuggestions({
      teams: [],
      states: [],
      labels: [
        { name: 'agent-ready', team: null },
        { name: 'admin', team: 'HEI' },
      ],
      reachable: true,
      reason: null,
    }),
    [{ value: 'admin', hint: 'HEI' }, { value: 'agent-ready' }],
  )
})

/**
 * Runs — the list, against data rather than an empty first paint.
 *
 * Everything below was broken or absent in a way `renderToString` can see: a row whose
 * only click target was four characters of relative time, a pill naming neither the
 * dependency nor its state, a run in flight rendered as a finished one with every column
 * empty, and a pull request that existed on the detail route and nowhere a person
 * scanning the list would find it.
 */

const runRow = (
  over: Record<string, unknown> = {},
  produced: Record<string, unknown> = {},
  job: Record<string, unknown> = {},
) => ({
  run: {
    id: 'r1',
    outcome: 'approved',
    detail: null,
    notes: null,
    startedAt: '2026-10-16T12:00:00.000Z',
    endedAt: '2026-10-16T12:04:00.000Z',
    durationMs: 240_000,
    rounds: 1,
    repoSha: 'abcdef1234567890',
    runtime: 'claude',
    model: 'sonnet',
    inputTokens: 1200,
    outputTokens: 300,
    ...over,
  },
  job: { id: 'j1', nodeKey: 'review', state: 'succeeded', cycleRunId: 'cr1', ...job },
  worker: { id: 'w1', name: 'adversarial-review' },
  project: { slug: 'ogun' },
  produced: { findings: 2, changed: false, branch: null, prUrl: null, ...produced },
})

const pendingRow = (over: Record<string, unknown> = {}) => ({
  job: {
    id: 'pj1',
    nodeKey: 'implement',
    state: 'blocked',
    createdAt: '2026-10-16T11:00:00.000Z',
    cycleRunId: 'cr9',
    dependsOn: ['plan'],
  },
  requires: ['claude', 'docker'],
  cycle: { name: 'ticket' },
  dependencies: [{ nodeKey: 'plan', state: 'skipped', terminal: true }],
  worker: { id: 'w2', name: 'implement' },
  project: { slug: 'ogun' },
  reach: 'claimable',
  missing: [],
  ...over,
})

const runsPayload = (over: Record<string, unknown> = {}) => ({
  runs: [runRow()],
  pending: [],
  onlineRunners: 1,
  liveRunners: 1,
  ...over,
})

/**
 * The complaint that started this: the timestamp was the only thing in the row you could
 * click. The link stays — it is the keyboard path and the only accessible one — and what
 * is asserted here is that the row advertises itself as a target, which is what was
 * missing.
 */
test('a run row is marked as clickable and still carries a real link', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload()),
  )
  assert.match(html, /href="\/runs\/r1"/, 'the row still has a real link to the run')
  assert.match(html, /class="rowlink"/, 'the row is marked as a click target')
  assert.match(html, /class="chev"/, 'and says so before the cursor arrives')
})

/**
 * `waiting on a dependency` named neither the node nor what became of it, on the one page
 * where that is the entire question. The data was always a join away.
 */
test('a blocked job names the dependency it is waiting on and its state', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload({ pending: [pendingRow()] })),
  )
  assert.match(html, /waiting on plan \(skipped\)/)
  assert.doesNotMatch(html, /waiting on a dependency/, 'the bare pill is gone')
})

/**
 * And the distinction that pill could not make. A dependency that is still running will
 * release this job on its own; one that has already gone terminal will not, and the two
 * were the same sentence.
 */
test('a dependency still in flight is not reported as a job going nowhere', () => {
  const moving = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload({
      pending: [
        pendingRow({ dependencies: [{ nodeKey: 'plan', state: 'running', terminal: false }] }),
      ],
    })),
  )
  assert.match(moving, /waiting on plan \(running\)/)
  assert.doesNotMatch(moving, /already finished/)

  const stuck = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload({ pending: [pendingRow()] })),
  )
  assert.match(stuck, /already finished/)
  assert.match(stuck, /blocked<\/strong> behind dependencies that have already finished/)
})

/** A pending job has no run, so the row opens instead of navigating. */
test('a waiting row offers a disclosure rather than a link to a run that does not exist', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload({ pending: [pendingRow()] })),
  )
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /show what implement is waiting for/)
  assert.doesNotMatch(html, /href="\/runs\/pj1"/, 'no invented run id')
})

/**
 * An in-flight run had no outcome, no duration and no result, so it rendered as a row of
 * dashes — indistinguishable from a run that finished having produced nothing.
 */
test('a run in flight reads as running rather than as finished and empty', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(
      ['runs'],
      runsPayload({
        runs: [
          runRow(
            { outcome: null, endedAt: null, durationMs: null, repoSha: null },
            {},
            { state: 'running' },
          ),
        ],
      }),
    ),
  )
  assert.match(html, /class="live"/, 'the same pulsing marker the run page uses')
  assert.match(html, /nothing recorded yet/, 'and says why its result column is empty')
})

/**
 * The pull request, in the list. It was on the run page and only there, so finding which
 * of last night's patches need reviewing meant opening each `dispatched` run in turn.
 */
test("a dispatched run's pull request is scannable from the list", () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(
      ['runs'],
      runsPayload({
        runs: [
          runRow(
            { outcome: 'dispatched' },
            {
              changed: true,
              branch: 'ogun/implement/3f2a',
              prUrl: 'https://github.com/Heirchive/heirchive-api/pull/412',
            },
          ),
        ],
      }),
    ),
  )
  assert.match(html, /href="https:\/\/github\.com\/Heirchive\/heirchive-api\/pull\/412"/)
  assert.match(html, /#412/, 'as a number, not a url filling the column')
})

/**
 * A patch that exists and that nobody can see is the row most worth noticing, and a
 * missing link renders it as nothing at all (§4.4).
 */
test('a patch that was never published says so instead of rendering blank', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(
      ['runs'],
      runsPayload({
        runs: [runRow({ outcome: 'dispatched' }, { changed: true })],
      }),
    ),
  )
  assert.match(html, /patch, not published/)
})

/** The key is closed until asked for; twelve definitions above the table is in the way. */
test('the status key is offered and not forced', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(['runs'], runsPayload()),
  )
  assert.match(html, /what do these mean\?/)
  assert.doesNotMatch(html, /class="key-list"/)
})

/**
 * The one thing keeping the glossary honest.
 *
 * `apps/web` deliberately does not depend on `@ogun/core` — it would drag zod, the config
 * loader and the Linear client into a browser bundle for the sake of some prose — so
 * `STATUS_HELP` is a copy of what `outcomes.ts` documents. A copy maintained by
 * convention rots: somebody adds an outcome, the taxonomy grows a word, and the UI shows
 * a pill no reader can decode while every test passes. This imports the vocabularies
 * directly and fails instead.
 */
test('every outcome and job state core declares has a definition in the UI', () => {
  for (const value of [...RUN_OUTCOMES, ...JOB_STATES]) {
    assert.ok(
      STATUS_HELP[value],
      `${value} is in core's vocabulary with no sentence in STATUS_HELP — see ui.tsx`,
    )
  }
})

/**
 * The run page showed no Result section at all while a run was in flight, so the page you
 * land on after pressing run has a gap where the answer goes. There is nothing to show,
 * and that is a fact about the write path rather than an absence to leave unexplained.
 */
test('a running run detail says why its result is empty instead of omitting it', () => {
  const html = renderScoped(
    <Routes>
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>,
    'all',
    (qc) =>
      qc.setQueryData(['run', 'r1'], {
        ...runRow({ outcome: null, endedAt: null, durationMs: null }, {}, { state: 'running' }),
        produced: { findings: [], suppressed: [], promoted: [], changes: [] },
        events: [],
        artifacts: [],
      }),
    '/runs/r1',
  )
  assert.match(html, /Result/, 'the heading is there while the run is going')
  assert.match(html, /still running/)
  assert.match(html, /Nothing is recorded as produced yet/)
})

/**
 * The row that made `endedAt === null` the wrong test on its own.
 *
 * A run whose runner died never reports, so it has no `endedAt` and no outcome, and the
 * sweep moves its job to `failed`. Reading only the run, that row is indistinguishable
 * from one that started four seconds ago — so it would carry a pulsing dot and a clock
 * counting up, days after it stopped. An absence rendered as a dash is a gap; an absence
 * rendered as "running" is a claim, and the wrong one.
 */
test('a run abandoned by its runner is not reported as still going', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) =>
    qc.setQueryData(
      ['runs'],
      runsPayload({
        runs: [
          runRow({ outcome: null, endedAt: null, durationMs: null }, {}, { state: 'failed' }),
        ],
      }),
    ),
  )
  assert.doesNotMatch(html, /class="live"/, 'nothing is in flight here')
  assert.match(html, /pill red[^>]*>failed/, 'the job state is what there is to say')
})

/**
 * `duration` grew an hours branch when it started formatting elapsed time on a run that
 * has not finished. A finished run is capped at its worker's `timeoutMs`; a running one
 * is capped by nothing, and the first screenshot of the in-flight row read `180m 0s`.
 */
test('a duration past an hour reads in hours', () => {
  assert.equal(duration(null), '—')
  assert.equal(duration(450), '450ms')
  assert.equal(duration(45_000), '45s')
  assert.equal(duration(7 * 60_000), '7m 0s')
  assert.equal(duration(59 * 60_000), '59m 0s')
  assert.equal(duration(3 * 3_600_000), '3h 0m')
  assert.equal(duration(3 * 3_600_000 + 25 * 60_000), '3h 25m')
})

/**
 * Both buckets are named even when one is empty.
 *
 * "Finished" used to render inside the `pending.length > 0` block, on the reasoning that
 * it reads as a contrast to "Waiting". That holds until nothing is waiting — and then the
 * only table on the page has no heading and the page looks like it lost a section, which
 * is exactly how it was reported. The buckets are a fact about the page, not about how
 * much happens to be queued.
 */
test('the runs page names both buckets with nothing waiting', () => {
  const html = renderScoped(<RunsPage />, 'all', (qc) => {
    qc.setQueryData(['runs'], {
      runs: [],
      pending: [],
      onlineRunners: 1,
      liveRunners: 1,
    })
  })
  assert.match(html, />Waiting</)
  assert.match(html, />Finished</)
  assert.match(html, /Nothing is queued or blocked/)
})

/**
 * The timeline, which is most of the run page and is built entirely out of payloads
 * nobody designed for it. Every shape below was copied off a live control plane.
 */
const timeline = (events: Array<Record<string, unknown>>): string =>
  renderScoped(
    <Routes>
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>,
    'all',
    (qc) =>
      qc.setQueryData(['run', 'r1'], {
        ...runRow(),
        produced: { findings: [], suppressed: [], promoted: [], changes: [] },
        artifacts: [],
        events: events.map((e, i) => ({
          id: `e${i}`,
          seq: i,
          ts: '2026-10-16T12:00:10.000Z',
          ...e,
        })),
      }),
    '/runs/r1',
  )

/**
 * `Bash cd /workspace && pnpm test` — the tool's name in front of every shell command on
 * the page, where the command is the content and the name is a fact about the harness.
 */
test('a shell command is set as a command rather than labelled with its tool', () => {
  const html = timeline([
    {
      type: 'tool.started',
      payload: {
        name: 'Bash',
        callId: 'c1',
        input: {
          command: 'pnpm --filter heirchive-web test',
          description: 'Run the web suite',
        },
      },
    },
    {
      type: 'tool.completed',
      payload: { name: 'Bash', callId: 'c1', isError: false, output: 'Tests: 53 passed' },
    },
  ])

  assert.match(html, /class="cmd"/, 'the command needs a block of its own')
  assert.match(html, /cmd-sigil/, 'and a prompt saying what it is')
  assert.match(html, /pnpm --filter heirchive-web test/)
  assert.doesNotMatch(html, /tool-name/, 'a command carries no label — the prompt is the label')
  // The intent claude sends with most Bash calls, kept without a second line per row.
  assert.match(html, /title="Run the web suite"/)
  // The collapsed output is the flow this change is not allowed to disturb.
  assert.match(html, /output \(16 chars\)/)
  assert.match(html, /output-toggle/, 'the gap between the outcome and the link is a class')
})

/**
 * Keyed off the payload, not the name. Codex calls the shell `command_execution` and
 * claude calls it `Bash`; a name list would be one row per runtime, forever.
 */
test('a shell command from another runtime is still a command', () => {
  const html = timeline([
    {
      type: 'tool.started',
      payload: {
        name: 'command_execution',
        callId: 'c1',
        input: { command: 'pnpm --filter heirchive-web test' },
      },
    },
  ])
  assert.match(html, /cmd-sigil/)
  assert.doesNotMatch(html, /command_execution/, 'the runtime\'s word for "shell" is not content')
})

/** Everything that is not a command keeps the verb, because the argument does not say it. */
test('a file tool keeps its name and drops the sandbox mount', () => {
  const html = timeline([
    {
      type: 'tool.started',
      payload: {
        name: 'Read',
        callId: 'c1',
        input: { file_path: '/workspace/apps/web/src/pages/RunDetail.tsx', offset: 120, limit: 60 },
      },
    },
  ])
  assert.match(html, /tool-name">Read/, 'reading a file and rewriting it have to look different')
  assert.match(html, /apps\/web\/src\/pages\/RunDetail\.tsx/)
  assert.doesNotMatch(html, /\/workspace\//, 'the mount is the same on every row')
  assert.match(html, /from line 120/, 'which is why the same file appears four times')
})

/**
 * An agent's message is markdown and always was. Rendered as preformatted text the
 * timeline showed the source — `## What I built`, stray backticks, `**` around words —
 * and the longest message on the page is the one that says what the run did.
 */
test("an agent's message renders as the markdown it was written as", () => {
  const html = timeline([
    {
      type: 'agent.message',
      payload: {
        text: [
          'Done — one commit, clean tree.',
          '',
          '## What I built',
          '',
          '- Label `Exit` → **Sign out**, which the app already settles.',
          '',
          '```',
          'pnpm --filter heirchive-web test   53 passed',
          '```',
        ].join('\n'),
      },
    },
  ])

  assert.match(html, /class="md"/, 'the skill page\'s renderer, not a second one')
  assert.match(html, /md-h2/)
  assert.match(html, /md-list/)
  assert.match(html, /md-code/)
  assert.match(html, /<strong>Sign out<\/strong>/)
  assert.match(html, /md-inline-code/)
  assert.doesNotMatch(html, /## What I built/, 'the source is not the rendering')
  assert.doesNotMatch(html, /\*\*Sign out\*\*/)
})

/**
 * A runner note is a sentence the runner wrote and a copy of the same thing in fields.
 * The default branch rendered the whole payload, so the note appeared twice on one row —
 * once as prose and once inside a JSON dump of itself.
 */
test('a runner note reads as its sentence rather than as its payload', () => {
  const html = timeline([
    {
      type: 'runner.note',
      payload: {
        note: 'patch extracted: 2 file(s) over 1 commit(s), 9352 bytes',
        bytes: 9352,
        round: 1,
        commits: 1,
        filesChanged: 2,
      },
    },
  ])
  assert.match(html, /patch extracted: 2 file\(s\) over 1 commit\(s\), 9352 bytes/)
  assert.doesNotMatch(html, /&quot;filesChanged&quot;/, 'the fields are the same thing again')
})

/**
 * Claude's `tool.completed` carries no exit code at all — only codex does. The row read
 * `failed (exit ?)` on every failed claude call: a question mark where a reader looks for
 * the number, standing for a field that was never going to be there.
 */
test('a failed tool call does not invent an exit code it was never sent', () => {
  const html = timeline([
    { type: 'tool.completed', payload: { name: 'Bash', callId: 'c1', isError: true, output: 'no' } },
  ])
  assert.match(html, />failed</)
  assert.doesNotMatch(html, /exit \?/)
})

/**
 * A rate-limit row is the provider's object as it arrived, and as JSON it was the widest
 * line on the page — `overageDisabledReason`, an epoch integer, two lines of wrap — for a
 * row whose entire content is "the five-hour window let this through".
 */
test('a rate-limit row says which window and whether it allowed the call', () => {
  const html = timeline([
    {
      type: 'rate_limit',
      payload: {
        info: {
          status: 'allowed',
          resetsAt: 1794939600,
          overageStatus: 'rejected',
          rateLimitType: 'five_hour',
          isUsingOverage: false,
          overageDisabledReason: 'org_level_disabled',
        },
      },
    },
  ])
  assert.match(html, /five_hour · allowed/)
  assert.doesNotMatch(html, /org_level_disabled/)
})

/**
 * How an agent writes a numbered list: a blank line between the items. Each item used to
 * end its own `<ol>`, so a run page carried a list of two points numbered `1.` and `1.`
 * — markup that was correct in every assertion and wrong in the only place it is read.
 */
test('a list with blank lines between its items is one list', () => {
  const html = renderToString(
    <Markdown
      source={[
        '1. **The gateway** — well defended.',
        '',
        '2. **The patch path** — where the finding is.',
        '',
        'Written up as a single finding.',
        '',
        '- a bulleted list under it',
        '',
        '- is still its own list',
      ].join('\n')}
    />,
  )
  assert.equal(html.match(/<ol/g)?.length, 1, 'one ordered list, not one per item')
  assert.equal(html.match(/<li>/g)?.length, 4, 'two items in each list')
  assert.equal(html.match(/<ul/g)?.length, 1, 'the bullets are not absorbed into the numbering')
  assert.match(html, /Written up as a single finding/, 'the paragraph still ends the list')
})

/**
 * The timeline shows wall-clock time, not an offset from the run's start.
 *
 * `+265s` answers "how far into the run", which is not the question a timeline gets
 * asked. "When did this happen" is, because that is what you take to a log, a deploy, or
 * somebody saying it broke around ten past — and converting back meant adding seconds to
 * a start time two hundred rows up the page.
 */
test('timeline rows are stamped with a clock time', () => {
  const ts = '2026-10-16T12:04:25.000Z'
  const html = renderScoped(
    <Routes>
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>,
    'all',
    (qc) =>
      qc.setQueryData(['run', 'r1'], {
        ...runRow(),
        produced: { findings: [], suppressed: [], promoted: [], changes: [] },
        events: [{ id: 'e1', seq: 1, ts, type: 'agent.message', payload: { text: 'hello' } }],
        artifacts: [],
      }),
    '/runs/r1',
  )
  // The locale's own convention, so the assertion is against what `toLocaleTimeString`
  // produces here rather than against a format this code does not choose.
  const expected = new Date(ts).toLocaleTimeString(undefined, { timeStyle: 'medium' })
  assert.ok(html.includes(expected), `expected "${expected}" in the timeline`)
  assert.ok(!/\+\d+s<\/span>/.test(html), 'and no offset column')
})
