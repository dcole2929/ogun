import { strict as assert } from 'node:assert'
import { after, before, describe, test } from 'node:test'
import type { Page } from 'playwright'
import { open, type Harness } from './harness.ts'
import { ALL_CLEAR } from './fixtures.ts'

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
