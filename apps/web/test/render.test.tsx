import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'
import { Markdown } from '../src/Markdown.tsx'
import { SkillsPage } from '../src/pages/Skills.tsx'
import { WorkersPage } from '../src/pages/Workers.tsx'
import { FindingsPage } from '../src/pages/Findings.tsx'
import { RunsPage } from '../src/pages/Runs.tsx'
import { CoveragePage } from '../src/pages/Coverage.tsx'
import { RunnersPage } from '../src/pages/Runners.tsx'
import { SettingsPage } from '../src/pages/Settings.tsx'
import type { LinearOauth, SystemInfo } from '../src/api.ts'

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

test('every page renders with no data', () => {
  for (const [name, el] of [
    ['skills', <SkillsPage />],
    ['workers', <WorkersPage />],
    ['findings', <FindingsPage />],
    ['runs', <RunsPage />],
    ['coverage', <CoveragePage />],
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
