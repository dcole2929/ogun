import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * The sidebar, and the drag handle that sets its width.
 *
 * 200px was chosen when the rail held seven one-word links. It now also holds the project
 * scope and the status rail, whose entries are sentences — `heirchive-api: config not
 * published` — and a fixed narrow column turns those into two lines of ellipsis. The
 * width that works depends on how long your project slugs are, which is not something
 * this file can know.
 */

const MIN = 170
const MAX = 480
const DEFAULT = 200
const STORAGE_KEY = 'ogun.sidebar-width'

const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n))

const stored = (): number => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? DEFAULT : clamp(Number.parseInt(raw, 10) || DEFAULT)
  } catch {
    return DEFAULT
  }
}

export function Sidebar({ children }: { children: ReactNode }) {
  // Not read during render: there is no localStorage on the server, and reading it in the
  // initialiser would make the first client paint disagree with the markup.
  const [width, setWidth] = useState(DEFAULT)
  const [dragging, setDragging] = useState(false)
  const frame = useRef(0)

  useEffect(() => setWidth(stored()), [])

  useEffect(() => {
    if (!dragging) return

    /**
     * Coalesced to one update per frame. A mousemove handler that calls setState on every
     * event repaints the entire page — every table, every card — as fast as the mouse
     * reports, which on a trackpad is far more often than the screen refreshes.
     */
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => setWidth(clamp(e.clientX)))
    }
    const onUp = () => setDragging(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // While dragging, the pointer is regularly outside the handle and over text; without
    // this every drag past the first few pixels selects the page instead of resizing it.
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      cancelAnimationFrame(frame.current)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging])

  // Written on release rather than on every frame: this is a preference, and a drag is
  // one decision however many pixels it passes through.
  useEffect(() => {
    if (dragging) return
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width))
    } catch {
      // Losing the preference is not worth losing the drag over.
    }
  }, [dragging, width])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // A pointer drag is not the only way to set a width, and a separator that cannot be
    // reached from the keyboard is one a keyboard user cannot use at all.
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - 16))
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + 16))
    else return
    e.preventDefault()
  }, [])

  return (
    <>
      <aside className="sidebar" style={{ width }}>
        {children}
      </aside>
      <div
        className={`resizer${dragging ? ' dragging' : ''}`}
        style={{ left: width }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={width}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        tabIndex={0}
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        // Double-click restores the default, which is the cheapest way back from a width
        // that turned out to be a mistake.
        onDoubleClick={() => setWidth(DEFAULT)}
        onKeyDown={onKeyDown}
      />
    </>
  )
}
