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
import type { SystemInfo } from '../src/api.ts'

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
  assert.match(html, /ogun project secret set/, 'the refusal has to name the path that works')
  assert.match(html, /plain HTTP/, "the server's reason should be shown, not paraphrased")
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
