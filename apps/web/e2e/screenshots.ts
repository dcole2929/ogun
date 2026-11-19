import { mkdir, writeFile } from 'node:fs/promises'
import { open, settle } from './harness.ts'
import { ALL_CLEAR, LINEAR_OPTIONS_UNREACHABLE, RUN_WITH_EVENTS, RUNS } from './fixtures.ts'

/**
 * The UI, photographed — one file per state.
 *
 * Two bugs in this UI were found by looking at a picture and could not have been found
 * any other way. The tray's collapsed line rendered correct markup and read as
 * "2 proble…" at the default sidebar width; a test of my own passed against text in the
 * wrong element while the page under it was empty. Neither is visible to an assertion
 * about markup, and both are obvious in a screenshot.
 *
 * **[amended] They are not committed.** This comment used to say they were, on the
 * grounds that "a private repository cannot get an image diff by linking to an image
 * host". That was asserted and never tested, and it is false:
 * `blob/screenshots/<file>.png?raw=1` is not camo-proxied, so a reviewer's own session
 * authenticates the fetch and the image renders inline on a private repo. Committing them
 * cost more than it bought — git keeps every version of every blob a branch has pointed
 * at, so a screenshot per UI change grows `main` forever. `pnpm screenshots` publishes
 * this directory to the orphan `screenshots` branch, which has no parent and is
 * force-pushed, so only the current set is reachable. Links in merged pull requests go
 * stale; that is the accepted trade.
 *
 * ### They have to be stable
 *
 * A screenshot that differs run to run is a diff nobody reads, and the whole scheme dies
 * the first time it cries wolf. So: a fixed viewport, animations off, no caret, and
 * fixtures carrying no clock — nothing here renders a relative time, because "3 days ago"
 * is a pixel difference every day.
 *
 * The residual is font rendering, which is a property of the machine. Two people running
 * this on different distributions will produce different bytes for the same UI. That is
 * the honest limit of committing screenshots without a container, and it is why these are
 * a review aid rather than an assertion — nothing fails when they change.
 */

const DIR = new URL('../../../docs/screenshots/', import.meta.url).pathname

type Shot = {
  name: string
  path: string
  status?: unknown
  /** `unreachable` shows the editor with its Linear suggestions missing. */
  linearOptions?: 'unreachable'
  /**
   * An ISO instant to pin the browser's clock to before the page loads.
   *
   * The note above says no captured fixture may render a relative time, and for every
   * shot until now that was free — none of those pages shows one. The Runs page is built
   * out of them: "3h ago", "ran for 7m", a clock counting up on an in-flight row. Without
   * a fixed now, this file's own stability rule would forbid photographing the page this
   * whole change is about.
   *
   * Pinning the clock rather than rewriting the fixtures in absolute time, because the
   * relative rendering IS the thing under review — a shot of absolute timestamps would be
   * a picture of a page nobody uses.
   */
  now?: string
  /**
   * Extra route bodies for this shot. `ROUTES['/api/runs']` is deliberately empty so that
   * every other page's shot is unaffected by a list full of relative times; the three
   * shots that are *about* that list opt into the fixture here.
   */
  routes?: Record<string, unknown> 
  /**
   * Photograph the whole scrollable page rather than the viewport.
   *
   * Every other shot here is of something above the fold at 1280x800. The run page's
   * timeline is not: it sits under the metadata card and the Result section, so a
   * viewport screenshot of that page is a picture of everything except the part under
   * review.
   */
  fullPage?: boolean
  /** Anything to do before the shutter: open the panel, drag the handle. */
  act?: (page: Awaited<ReturnType<typeof open>>['page']) => Promise<void>
  clip?: { x: number; y: number; width: number; height: number }
}

const SHOTS: Shot[] = [
  {
    name: 'workers',
    path: '/workers',
    // The filter bar, the per-project sections, and the scope selector holding "all".
  },
  {
    name: 'tray-open',
    path: '/workers',
    act: async (page) => {
      await page.click('.tray-trigger')
      await page.waitForSelector('.tray-panel')
    },
  },
  {
    name: 'tray-all-clear',
    path: '/workers',
    status: ALL_CLEAR,
  },
  {
    name: 'worker-focused',
    path: '/workers?focus=security-review',
    act: async (page) => {
      await page.selectOption('.scope select', 'heirchive-api')
      await page.waitForFunction(() =>
        document.querySelector('.filter-count')?.textContent?.includes('1 of'),
      )
    },
  },
  {
    name: 'sources',
    path: '/sources',
    act: async (page) => {
      await page.selectOption('.scope select', 'ogun')
      await page.waitForSelector('.card')
    },
  },
  {
    name: 'source-editing',
    path: '/sources',
    act: async (page) => {
      await page.selectOption('.scope select', 'ogun')
      await page.click('text=Edit')
      await page.waitForSelector('.form')
    },
  },
  {
    /**
     * The reason the whole feature exists, in one picture: the status field offering what
     * the workspace actually calls its columns, grouped by whether they have been started.
     * A `status` typed by hand against a column named something else parses, polls, and
     * admits nothing, forever.
     */
    name: 'source-picking',
    path: '/sources',
    act: async (page) => {
      await page.selectOption('.scope select', 'ogun')
      await page.click('text=Edit')
      await page.waitForSelector('.form')
      // The statuses picker, which is the one narrowed by the teams above it.
      await page.click('.field:has(> .field-label:text-is("Statuses")) input')
      await page.waitForSelector('.picker-list')
    },
  },
  {
    /**
     * The same editor with no credential behind it. Every field still takes a typed
     * value — the state a strict dropdown would have made uneditable.
     */
    name: 'source-no-suggestions',
    path: '/sources',
    linearOptions: 'unreachable',
    act: async (page) => {
      await page.selectOption('.scope select', 'ogun')
      await page.click('text=Edit')
      await page.waitForSelector('.note')
    },
  },
  {
    /**
     * The list this change is about: a chevron per row saying the rows go somewhere, the
     * pull request a run produced readable without opening it, and a run still in flight
     * reading as in flight rather than as a blank outcome.
     */
    name: 'runs',
    path: '/runs',
    now: '2026-10-16T15:00:00.000Z',
    routes: { '/api/runs': RUNS },
  },
  {
    /** The status key open, which is the answer to "what does declined mean". */
    name: 'runs-status-key',
    path: '/runs',
    now: '2026-10-16T15:00:00.000Z',
    routes: { '/api/runs': RUNS },
    act: async (page) => {
      await page.click('.key button')
      await page.waitForSelector('.key-list')
    },
  },
  {
    /**
     * A waiting job, expanded. The old table said "waiting on a dependency" for every
     * row in it; this says which node, what state it is in, and what the job needs.
     */
    name: 'runs-waiting',
    path: '/runs',
    now: '2026-10-16T15:00:00.000Z',
    routes: { '/api/runs': RUNS },
    act: async (page) => {
      await page.click('.chev-button')
      await page.waitForSelector('.panel-row')
    },
  },
  {
    /**
     * The timeline, which is the page: a shell command set as a command rather than
     * labelled `Bash`, each one followed by its collapsed output, and an agent's closing
     * message rendered as the markdown it was written as.
     *
     * `now` because the header renders `when(startedAt)` — "3h ago" is a pixel difference
     * every hour, and this file's stability rule forbids it.
     */
    name: 'run-detail',
    path: '/runs/run-events',
    now: '2026-10-16T15:00:00.000Z',
    routes: { '/api/runs/run-events': RUN_WITH_EVENTS },
    fullPage: true,
  },
  {
    name: 'skills-scoped',
    path: '/skills',
    act: async (page) => {
      await page.selectOption('.scope select', 'ogun')
      await page.waitForFunction(
        () => document.querySelectorAll('a[href^="/skills/"]').length === 1,
      )
    },
  },
  {
    name: 'sidebar-wide',
    path: '/skills',
    act: async (page) => {
      const handle = (await (await page.waitForSelector('.resizer')).boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, 400)
      await page.mouse.down()
      await page.mouse.move(380, 400, { steps: 10 })
      await page.mouse.up()
    },
  },
]

export async function capture(): Promise<string[]> {
  await mkdir(DIR, { recursive: true })
  const written: string[] = []

  for (const shot of SHOTS) {
    const h = await open(shot.path, {
      ...(shot.status ? { '/api/system/status': shot.status } : {}),
      ...(shot.linearOptions === 'unreachable'
        ? { '/api/linear-options': LINEAR_OPTIONS_UNREACHABLE }
        : {}),
      ...(shot.routes ?? {}),
    }, shot.now)
    try {
      // No animation, no blinking caret: both are pixels that differ by when the shutter
      // happened to fall rather than by anything anyone changed.
      await h.page.emulateMedia({ reducedMotion: 'reduce' })
      await h.page.addStyleTag({
        content: '*,*::before,*::after{transition:none!important;animation:none!important}',
      })
      await shot.act?.(h.page)
      // Again after acting: selecting a project refetches, and the shutter must not fall
      // between the request and what it renders.
      await settle(h.page)
      const file = `${DIR}${shot.name}.png`
      await h.page.screenshot({
        path: file,
        ...(shot.fullPage ? { fullPage: true } : {}),
        ...(shot.clip ? { clip: shot.clip } : {}),
        caret: 'hide',
        animations: 'disabled',
      })
      written.push(file)
    } finally {
      await h.stop()
    }
  }

  await writeFile(
    `${DIR}README.md`,
    [
      '# Screenshots',
      '',
      'Regenerated by `pnpm test:e2e` — do not edit by hand.',
      '',
      'Not committed — `.gitignore` holds this directory. `pnpm screenshots` publishes',
      'them to the orphan `screenshots` branch and prints markdown to paste into a pull',
      'request; linking `blob/screenshots/<file>.png?raw=1` renders inline even on a',
      'private repo, because that form is not camo-proxied.',
      '',
      'Nothing fails when these change; they are a review aid, not an assertion. Font',
      'rendering is a property of the machine, so bytes produced on another distribution',
      'will differ for an identical UI.',
      '',
      ...SHOTS.map((s) => `- \`${s.name}.png\` — \`${s.path}\``),
      '',
    ].join('\n'),
  )

  return written
}

// `node e2e/screenshots.ts` regenerates them without running the assertions.
if (process.argv[1]?.endsWith('screenshots.ts')) {
  const files = await capture()
  console.log(`${files.length} screenshots written to docs/screenshots/`)
}
