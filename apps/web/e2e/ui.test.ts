import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import type { Page } from 'playwright'
import { open, settle, type Harness } from './harness.ts'
import { ALL_CLEAR, RUN_WITH_EVENTS, RUNS } from './fixtures.ts'

/**
 * The tray is a toggle, and these tests share one browser for speed — so a test that
 * inherits an open panel closes it instead of opening it, and fails on a timeout that
 * looks like the panel is broken. Each test states the condition it needs.
 */
const ensureClosed = async (page: Page): Promise<void> => {
  if ((await page.locator('.tray-panel').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForSelector('.tray-panel', { state: 'detached' })
  }
}

/**
 * The three things the server-rendered tests cannot reach.
 *
 * `render.test.tsx` calls `renderToString`, so it only ever sees a first paint: a panel
 * that has not been opened, a handle nobody dragged, a link nobody clicked. Every bug in
 * this file's subject matter lives *after* one of those interactions — which is why the
 * notification-scope bug shipped with tests passing.
 */

describe('the notifications tray', () => {
  let h: Harness
  before(async () => (h = await open()))
  after(async () => h.stop())

  test('opens to show the detail the collapsed line withholds', async () => {
    const { page } = h
    await assert.doesNotReject(page.waitForSelector('.tray-trigger.lit'))
    assert.equal(await page.locator('.tray-panel').count(), 0, 'closed to begin with')

    // The sentence is the thing the sidebar could not hold; it must be in the panel.
    await page.click('.tray-trigger')
    await page.waitForSelector('.tray-panel')
    const panel = await page.textContent('.tray-panel')
    assert.match(panel ?? '', /consecutive failures/)
    assert.match(panel ?? '', /config\.yaml has changed/)

    // Two problems, two tones: one stops work, one means it is running the old definition.
    assert.equal(await page.locator('.tray-item.stopped').count(), 1)
    assert.equal(await page.locator('.tray-item.stale').count(), 1)
  })

  /**
   * The collapsed line has to *fit*. It read "2 proble…" before the severity count moved
   * onto the dot, which is the one failure a server-rendered test can never see: the
   * markup was correct and the pixels were not.
   */
  test('the collapsed line is not truncated at the default width', async () => {
    const { page } = h
    await ensureClosed(page)
    const label = await page.waitForSelector('.tray-label')
    const { clipped, text } = await label.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth + 1,
      text: el.textContent ?? '',
    }))
    assert.equal(text, '2 problems')
    assert.ok(!clipped, `"${text}" is being cut off`)
    // Severity is on the dot instead, so it costs no width.
    assert.equal(await page.locator('.tray-trigger.stopped').count(), 1)
  })

  test('closes on escape, and on a click outside it', async () => {
    const { page } = h
    await ensureClosed(page)

    await page.click('.tray-trigger')
    await page.waitForSelector('.tray-panel')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.tray-panel', { state: 'detached' })

    await page.click('.tray-trigger')
    await page.waitForSelector('.tray-panel')
    await page.mouse.click(900, 400)
    await page.waitForSelector('.tray-panel', { state: 'detached' })
  })

  test('the panel is wider than the sidebar it used to be crammed into', async () => {
    const { page } = h
    await ensureClosed(page)
    await page.click('.tray-trigger')
    const panel = await page.waitForSelector('.tray-panel')
    const sidebar = await page.waitForSelector('.sidebar')
    const p = (await panel.boundingBox())!
    const s = (await sidebar.boundingBox())!
    // The whole reason this stopped being a rail: an explanatory sentence does not belong
    // in the narrowest column on screen.
    assert.ok(p.width > s.width, `panel ${p.width} should exceed sidebar ${s.width}`)
  })
})

describe('a tray with nothing to report', () => {
  let h: Harness
  before(async () => (h = await open('/', { '/api/system/status': ALL_CLEAR })))
  after(async () => h.stop())

  test('is present but unlit, and does not open', async () => {
    const { page } = h
    assert.match((await page.textContent('.tray-trigger')) ?? '', /All clear/)
    assert.equal(await page.locator('.tray-trigger.lit').count(), 0)
    assert.ok(await page.isDisabled('.tray-trigger'), 'nothing to open')
  })
})

/**
 * The bug that shipped green. A notification about a project you are not scoped to sent
 * you to a page that then filtered out the very thing you clicked.
 */
describe('following a notification about another project', () => {
  let h: Harness
  before(async () => (h = await open()))
  after(async () => h.stop())

  test('takes the scope with it, and puts the worker in front of you', async () => {
    const { page } = h

    // Standing in `ogun`; the halted worker is in `heirchive-api`.
    await page.selectOption('.scope select', 'ogun')
    await ensureClosed(page)
    await page.click('.tray-trigger')
    await page.click('.tray-item.stopped')

    await page.waitForURL(/\/workers\?focus=security-review/)
    assert.equal(await page.inputValue('.scope select'), 'heirchive-api', 'the scope moved')

    /**
     * Scoped to the worker list, and waited for.
     *
     * This was `waitForSelector('text=security-review')`, which passed against the tray
     * panel's own entry — the page could have rendered nothing at all and the assertion
     * would still have held. A screenshot is what caught it.
     */
    await page.waitForFunction(
      () => document.querySelector('.filter-count')?.textContent?.includes('1 of'),
    )
    const listed = await page.locator('.main .card strong').allTextContents()
    assert.deepEqual(listed, ['security-review'], 'the worker asked for, and only it')
    assert.equal(await page.locator('.chip').count(), 1, 'the focus is shown as a chip')
    assert.equal(
      await page.locator('.search input').count(),
      0,
      'the controls it overrides are hidden rather than left looking usable',
    )
  })

  test('clearing the chip returns the rest of that project', async () => {
    const { page } = h
    await page.click('.chip button')
    await page.waitForSelector('.search input')
    await page.waitForSelector('text=plan-a-ticket')
    assert.ok(!page.url().includes('focus='), 'and the url no longer carries it')
  })
})

describe('the project scope', () => {
  let h: Harness
  before(async () => (h = await open('/skills')))
  after(async () => h.stop())

  test('collapses a built-in listed once per project', async () => {
    const { page } = h
    await page.selectOption('.scope select', 'all')
    await page.waitForFunction(() => document.querySelectorAll('a[href^="/skills/"]').length === 2)

    await page.selectOption('.scope select', 'ogun')
    await page.waitForFunction(() => document.querySelectorAll('a[href^="/skills/"]').length === 1)
    // Asked of the content region, not the page: the scope selector lists every project
    // by name, so `body` contains "heirchive-api" whatever is being shown.
    assert.ok(!(await page.textContent('.main'))?.includes('heirchive-api'))
  })

  test('survives a reload, because it is a scope and not a page filter', async () => {
    const { page } = h
    await page.selectOption('.scope select', 'heirchive-api')
    await page.reload()
    await page.waitForSelector('.scope select')
    assert.equal(await page.inputValue('.scope select'), 'heirchive-api')
  })
})

describe('the sidebar', () => {
  let h: Harness
  before(async () => (h = await open()))
  after(async () => h.stop())

  const width = async (): Promise<number> =>
    (await (await h.page.waitForSelector('.sidebar')).boundingBox())!.width

  test('drags to a new width and keeps it across a reload', async () => {
    const { page } = h
    const before = await width()

    const handle = (await (await page.waitForSelector('.resizer')).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, 400)
    await page.mouse.down()
    await page.mouse.move(360, 400, { steps: 12 })
    await page.mouse.up()

    const after = await width()
    assert.ok(after > before + 100, `expected a wider sidebar, got ${before} → ${after}`)

    await page.reload()
    await page.waitForSelector('.scope select')
    assert.ok(Math.abs((await width()) - after) < 2, 'the width is remembered')
  })

  test('refuses to drag past its limits', async () => {
    const { page } = h
    const handle = (await (await page.waitForSelector('.resizer')).boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, 400)
    await page.mouse.down()
    // Far past the maximum, then far past the minimum: a sidebar that can be dragged to
    // nothing is one you cannot get back.
    await page.mouse.move(1200, 400, { steps: 10 })
    assert.ok((await width()) <= 480)
    await page.mouse.move(10, 400, { steps: 10 })
    assert.ok((await width()) >= 170)
    await page.mouse.up()
  })

  test('double-clicking the handle restores the default', async () => {
    const { page } = h
    await page.dblclick('.resizer')
    assert.ok(Math.abs((await width()) - 200) < 2, 'back to 200')
  })
})

/**
 * The Runs list, which is almost entirely interaction.
 *
 * Every item here is a thing `renderToString` cannot reach: a row that navigates, a row
 * that opens in place, a disclosure that is reachable from the keyboard, and the two ways
 * a row-wide click handler breaks a table that was working — swallowing a nested link and
 * eating a text selection. The markup for all of it is correct in the server-rendered
 * tests and none of those four is asserted by them.
 */
describe('the runs list', () => {
  let h: Harness
  before(async () => (h = await open('/runs', { '/api/runs': RUNS })))
  after(async () => h.stop())

  /** Back to the list between tests, since half of these navigate away from it. */
  const onList = async (page: Page): Promise<void> => {
    if (!page.url().endsWith('/runs')) {
      await page.goto(`${h.url}/runs`)
      await page.waitForSelector('table')
      await settle(page)
    }
  }

  /**
   * The complaint: "if you click the timestamp 3h ago you get to the details page. that's
   * not good ui." So a click on the worker's name — the middle of the row, nowhere near
   * the link — has to arrive at the same place.
   */
  test('a click anywhere in a run row opens that run', async () => {
    const { page } = h
    await onList(page)
    await page.click('tr:has(a[href="/runs/run-approved"]) td:nth-child(3)')
    await page.waitForURL(/\/runs\/run-approved$/)
    // And the page it reached is a real one, not a row id handed to a route that 404s.
    // `settle` first: the url changes before React has swapped the page, so asserting on
    // the heading immediately reads the list's own `<h1>` and passes for the wrong reason.
    await settle(page)
    assert.match((await page.textContent('h1')) ?? '', /adversarial-review/)
  })

  /**
   * The affordance, which is the other half of the complaint — "or we should add some
   * icon that makes it clear there is something to click". A hover tint is invisible
   * until the cursor is already on the row, so the chevron is what has to be there before
   * anybody moves the mouse.
   */
  test('every run row shows that it goes somewhere before it is hovered', async () => {
    const { page } = h
    await onList(page)
    const rows = await page.locator('tbody tr.rowlink').count()
    assert.equal(await page.locator('tbody .chev').count(), rows, 'one chevron per row')
    assert.ok(rows >= 4, `expected the fixture's rows, got ${rows}`)
  })

  /**
   * The guard that makes a row-wide click handler safe to add to a table people read.
   *
   * Dragging across a cell to copy a commit sha ends in a `click` on the row. Without the
   * selection check in `useRowNav` that click navigates, the page unmounts and the
   * selection goes with it — so the one thing a dense table of shas and branch names is
   * for stops working the moment the rows become clickable.
   */
  test('selecting text in a row copies it rather than navigating away', async () => {
    const { page } = h
    await onList(page)
    // The finished table specifically, by the link only its rows carry — `tr.rowlink`
    // also matches the waiting rows above it, whose third cell holds a different name.
    const cell = (await page
      .locator('tr:has(a[href^="/runs/"]) td:nth-child(3)')
      .first()
      .boundingBox())!
    // `cell.y + 10` rather than the middle of the cell: cells are top-aligned and a row
    // whose result column wrapped is twice as tall as its text, so a drag through the
    // vertical centre selects nothing and the test passes without testing anything.
    await page.mouse.move(cell.x + 2, cell.y + 10)
    await page.mouse.down()
    await page.mouse.move(cell.x + cell.width - 2, cell.y + 10, { steps: 8 })
    await page.mouse.up()

    assert.ok(page.url().endsWith('/runs'), `navigated away to ${page.url()}`)
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    assert.match(selected, /adversarial/, 'the selection survived the click that ended it')
  })

  /**
   * The gesture the selection guard cannot catch, and the reason the `.mono` cells are
   * not part of the click target.
   *
   * A double-click's first click arrives before the browser has selected the word under
   * it, so it is indistinguishable from a plain click — the row would navigate out from
   * under somebody copying a commit sha, which is what the sha column is for.
   */
  test('double-clicking a value meant for copying selects it rather than navigating', async () => {
    const { page } = h
    await onList(page)
    // Positioned near the top of the cell for the same reason the drag above is: cells
    // are top-aligned, so the element's centre can be below its own text.
    /**
     * The ticket identifier, which is what this column holds now.
     *
     * It was the base sha until that column was removed — it showed the commit the
     * workspace was *checked out at*, so every run of a day carried the same value and
     * the column said nothing. The guard under test is unchanged: a `.mono` cell exists
     * to be copied, so a double-click on one must select rather than navigate. Picking
     * the row that *has* a ticket, because the one without renders a dash and selecting
     * a dash would pass this test while proving nothing.
     */
    await page
      .locator('tr:has(a[href^="/runs/"]) td.mono:has(a.extlink)')
      .first()
      .dblclick({ position: { x: 12, y: 8 } })

    assert.ok(page.url().endsWith('/runs'), `navigated away to ${page.url()}`)
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    /**
     * `HEI` rather than `HEI-167`: a double-click selects a *word*, and a hyphen is a word
     * boundary in every browser. What is under test is that something was selected and
     * the page did not navigate — asserting the whole identifier would be asserting a
     * text-segmentation rule this code does not own.
     */
    assert.match(selected, /^HEI/, `expected part of a ticket identifier, selected "${selected}"`)
  })

  /**
   * The other guard. The pull request is an `<a>` inside a row that is itself a click
   * target, and without the `closest('a')` check the row handler wins — so the one link
   * on the page that leaves the app navigates to the run page instead, which looks like a
   * broken link rather than like a bug in a row handler.
   */
  test('the pull request link in a row is not swallowed by the row', async () => {
    const { page } = h
    await onList(page)
    const pr = page.locator('a[href^="https://github.com"]')
    assert.equal(await pr.count(), 1)
    assert.equal(await pr.textContent(), '#412', 'the number, not a url filling the column')
    assert.equal(await pr.getAttribute('target'), '_blank')

    // Clicked with the new tab suppressed, so what is asserted is that *this* page did
    // not move — which is exactly what the row handler would have done.
    await pr.evaluate((el) => el.removeAttribute('target'))
    await page.evaluate(() => {
      document.addEventListener('click', (e) => e.preventDefault(), { capture: true, once: true })
    })
    await pr.click()
    assert.ok(page.url().endsWith('/runs'), `the row handler hijacked the link: ${page.url()}`)
  })

  /**
   * A pending job has no run, so there is no `/runs/:id` for it and inventing one would
   * be worse than the bare pill it replaces. It opens in place instead, and the panel has
   * to carry the things the row cannot: the cycle, the dependency, and its state.
   */
  test('a waiting row opens in place instead of navigating to a run that does not exist', async () => {
    const { page } = h
    await onList(page)
    const row = page.locator('tr:has(.chev-button)')
    await row.locator('td:nth-child(3)').click()

    await page.waitForSelector('.panel-row')
    const panel = (await page.textContent('.panel-row')) ?? ''
    assert.match(panel, /ticket/, 'the cycle it is a node of')
    assert.match(panel, /plan/, 'the dependency, by node key')
    assert.match(panel, /skipped/, 'and what became of it')
    assert.ok(page.url().endsWith('/runs'), 'nothing navigated')

    // And it closes again, so the row is a disclosure rather than a one-way door.
    await row.locator('td:nth-child(3)').click()
    await page.waitForSelector('.panel-row', { state: 'detached' })
  })

  /** The disclosure is a real button, so it works without a mouse. */
  test('the waiting row disclosure is reachable from the keyboard', async () => {
    const { page } = h
    await onList(page)
    await page.locator('.chev-button').focus()
    assert.equal(await page.locator('.chev-button').getAttribute('aria-expanded'), 'false')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.panel-row')
    assert.equal(await page.locator('.chev-button').getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.panel-row', { state: 'detached' })
  })

  /**
   * The key. Closed by default — twelve definitions above the table is in the way on
   * every visit after the first — and the definitions in it are the ones `outcomes.ts`
   * documents, including the distinction that file exists for.
   */
  test('the status key explains the words in the rows, on request', async () => {
    const { page } = h
    await onList(page)
    assert.equal(await page.locator('.key-list').count(), 0, 'closed to begin with')

    await page.click('.key button')
    await page.waitForSelector('.key-list')
    const key = (await page.textContent('.key-list')) ?? ''
    // The four that are deliberately not interchangeable, each in its own words.
    assert.match(key, /its answer was no/, 'declined is a result, not a failure')
    assert.match(key, /harness or the agent failed/, 'error is somebody going to fix it')
    assert.match(key, /verify gate rejected its output/, 'changes-requested is the gate')
    assert.match(key, /A modifier ran and left a patch/, 'dispatched produced something')

    // Only the words on the page. A key listing outcomes no row has is padding between a
    // reader and the one definition they came for — and `skipped` is the clearest case,
    // since admission refuses before a run exists, so no row here can carry it.
    assert.ok(!key.includes('Admission refused the job'), 'nothing on this page was skipped')
  })

  /** An active run has to read as active in a list of fifty finished ones. */
  test('a run in flight is the row that is moving', async () => {
    const { page } = h
    await onList(page)
    const live = page.locator('tbody tr:has(.live)')
    assert.equal(await live.count(), 1)
    assert.match((await live.textContent()) ?? '', /nothing recorded yet/)
    // The pulse is a real animation rather than a static dot, which is the entire point.
    const name = await page.locator('tbody .live').first().evaluate(
      (el) => getComputedStyle(el, '::before').animationName,
    )
    assert.equal(name, 'pulse')
  })
})

/**
 * The timeline on the run page, which is two facts a rendered string cannot hold: a
 * command's output is collapsed until somebody asks for it, and a ninety-line heredoc
 * is kept whole without owning the page.
 */
describe('the run timeline', () => {
  let h: Harness
  before(
    async () =>
      (h = await open('/runs/run-events', { '/api/runs/run-events': RUN_WITH_EVENTS })),
  )
  after(async () => h.stop())

  /** The flow this change was not allowed to disturb: command, then its output, hidden. */
  test('a command is followed by its output, collapsed until it is asked for', async () => {
    const { page } = h
    await page.waitForSelector('.timeline .cmd')
    assert.equal(await page.locator('.tool-output').count(), 0, 'nothing is expanded on arrival')

    await page.locator('.output-toggle').first().click()
    await page.waitForSelector('.tool-output')
    assert.match((await page.textContent('.tool-output')) ?? '', /name: make-a-change/)

    await page.locator('.output-toggle').first().click()
    await page.waitForSelector('.tool-output', { state: 'detached' })
  })

  /**
   * The row used to slice the command at 160 characters, so a heredoc ended mid-token —
   * `open(p, 'w').write(s)` then a bare `E` where `EOF` had been cut in half. The whole
   * command is in the DOM now; the block is what is bounded, not the text.
   */
  test('a multi-line command is kept whole and bounded by its block', async () => {
    const { page } = h
    const block = page.locator('.cmd').nth(1)
    const text = (await block.textContent()) ?? ''
    assert.match(text, /python3 - <<'EOF'/, 'the first line')
    assert.match(text, /grep -n 'Sign out'/, 'and the last one, past where the slice fell')

    const { height, scrollHeight } = await block.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrollHeight: el.scrollHeight,
    }))
    assert.ok(height <= 180, `a command block may not exceed its cap, got ${height}`)
    assert.ok(scrollHeight >= height, 'and it scrolls rather than clipping to nothing')
  })

  /** The prompt is decoration: the command beside it is what a reader is being told. */
  test('the prompt is hidden from a screen reader', async () => {
    const { page } = h
    assert.equal(await page.locator('.cmd-sigil').first().getAttribute('aria-hidden'), 'true')
  })
})

/**
 * A modifier cannot switch off the services its own gate needs.
 *
 * The schema refuses it, and a form that let somebody tick the box and then showed them a
 * validation error would be teaching the rule the expensive way. The box is forced on and
 * disabled, and the sentence under it says why — a modifier's patch is judged by
 * `tests.command` in this same sandbox, so switching services off would point its own
 * gate at a database that is not running.
 */
describe('the services checkbox follows the permission profile', () => {
  let h: Harness
  before(async () => {
    h = await open('/workers', {})
    await settle(h.page)
  })
  after(() => h.stop())

  const openEditor = async (page: Page, worker: string): Promise<void> => {
    await page
      .locator('.card')
      .filter({ hasText: worker })
      .getByRole('button', { name: 'Edit' })
      .first()
      .click()
    await page.locator('label.inline').filter({ hasText: 'services' }).first().waitFor()
  }

  test('a reviewer may turn services off; a modifier may not', async () => {
    const { page } = h
    await openEditor(page, 'scope-a-ticket')
    const box = page.locator('label.inline').filter({ hasText: 'services' }).locator('input')
    assert.equal(await box.isDisabled(), false, 'a reviewer owns the choice')
    assert.equal(await box.isChecked(), false, 'and this fixture opted out')

    // Changing the profile to modifier takes the choice away in place, rather than on save.
    await page
      .locator('label')
      .filter({ hasText: 'Permissions' })
      .locator('select')
      .selectOption('modifier')
    assert.equal(await box.isDisabled(), true, 'a modifier does not get the choice')
    assert.equal(await box.isChecked(), true, 'and is shown as having services')

    const help = await page
      .locator('.checkbox-field small')
      .first()
      .textContent()
    assert.match(help ?? '', /judged by/, 'the reason is on screen, not in a later error')
  })
})
