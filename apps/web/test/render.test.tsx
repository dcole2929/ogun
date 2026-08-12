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

/**
 * A smoke test, not a snapshot. It renders every page with no data and no server, which
 * is exactly the state a page is in for its first paint — and the state that catches the
 * mistakes worth catching here: a bad hook order, a missing provider, a `.map` on
 * something undefined before the query resolves.
 *
 * Bundled through esbuild by `pnpm --filter @ogun/web test`, since node cannot strip JSX.
 */
const render = (el: ReactElement): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  ] as const) {
    const html = render(el)
    assert.ok(html.length > 0, `${name} rendered nothing`)
  }
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
