import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * One suggestion. `hint` is the second line a person reads to tell two similar entries
 * apart — a team's name beside its key, a state's type beside its name — and `group` is
 * the heading it sits under.
 */
export type Suggestion = { value: string; hint?: string; group?: string }

/**
 * A list of values with a dropdown of what the workspace actually calls them, and a text
 * box for when it is wrong.
 *
 * ### Why both halves are required
 *
 * The dropdown exists because these fields are matched against a remote system's own
 * vocabulary and a typo is invisible: `status: [To Do]` against a column named `Todo`
 * parses, stores, polls, reads forty tickets and admits none of them, forever. Nothing
 * fails. The poll's `detail` line was written to make that case legible after the fact;
 * a picker makes it not happen.
 *
 * The text box exists because the suggestions can be missing for reasons that have
 * nothing to do with the value being wrong. That is not hypothetical and it is not rare:
 * of the two projects connected on the machine this was built on, one had a grant that
 * had expired 24 days earlier, and querying it returned `AUTHENTICATION_ERROR`. A strict
 * dropdown would have made that source — the one most in need of attention — impossible
 * to edit. A private team the app token cannot see has the same shape.
 *
 * So: the list is an aid, never an authority. Every value here can be typed.
 *
 * ### The unknown marker
 *
 * A chip whose value is not in a *reachable* list is marked. This is the typo catcher,
 * and it is deliberately a mark rather than a refusal — `Todo` renamed to `In Queue`
 * yesterday is the same signal as a misspelling, and only a person knows which. When the
 * list could not be fetched, nothing is marked: an unreachable list would otherwise paint
 * every value as suspect at the moment there is no way to check any of them.
 */
export function TokenPicker({
  label,
  values,
  onChange,
  suggestions,
  reachable,
  placeholder,
  hint,
  wide,
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  suggestions: Suggestion[]
  /** Whether `suggestions` is an answer. False means "we could not ask", not "none". */
  reachable: boolean
  placeholder?: string
  hint?: React.ReactNode
  wide?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  const known = useMemo(() => new Set(suggestions.map((s) => s.value)), [suggestions])

  /**
   * Case-insensitive on both sides. The config matches statuses ignoring case, so
   * `todo` and `Todo` are the same condition and offering the second as an addition to
   * the first would write a duplicate that changes nothing.
   */
  const taken = useMemo(() => new Set(values.map((v) => v.toLowerCase())), [values])
  const shown = useMemo(() => {
    const q = draft.trim().toLowerCase()
    return suggestions.filter(
      (s) =>
        !taken.has(s.value.toLowerCase()) &&
        (q === '' || s.value.toLowerCase().includes(q) || (s.hint ?? '').toLowerCase().includes(q)),
    )
  }, [suggestions, taken, draft])

  useEffect(() => setActive(0), [draft, open])

  // Clicking anywhere else closes the list. Pointerdown rather than click so that the
  // list is gone before a click on something underneath it is dispatched.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const add = (value: string) => {
    const trimmed = value.trim()
    if (trimmed === '' || taken.has(trimmed.toLowerCase())) {
      setDraft('')
      return
    }
    onChange([...values, trimmed])
    setDraft('')
  }

  const remove = (value: string) => onChange(values.filter((v) => v !== value))

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // The highlighted suggestion wins over the raw text, so that typing three letters
      // and pressing Enter adds the real value rather than the three letters.
      add(open && shown[active] ? shown[active].value : draft)
      return
    }
    // A comma is how these were written when they were one text field, and somebody who
    // learned that spelling should not have to unlearn it to use this.
    if (e.key === ',') {
      e.preventDefault()
      add(draft)
      return
    }
    if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      remove(values[values.length - 1]!)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, shown.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Escape') setOpen(false)
  }

  let lastGroup: string | undefined

  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <span className="field-label">{label}</span>
      <div className="picker" ref={box}>
        <div className="picker-values">
          {values.map((value) => {
            const unknown = reachable && !known.has(value)
            return (
              <span
                key={value}
                className={`chip${unknown ? ' chip-unknown' : ''}`}
                title={
                  unknown
                    ? `nothing in this workspace is called "${value}" — a rename, or a typo`
                    : undefined
                }
              >
                <strong>{value}</strong>
                <button type="button" title="remove" onClick={() => remove(value)}>
                  ×
                </button>
              </span>
            )
          })}
          <input
            type="text"
            value={draft}
            placeholder={values.length === 0 ? placeholder : ''}
            onChange={(e) => {
              setDraft(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="picker-toggle"
            title={reachable ? 'show what this workspace has' : 'nothing to suggest'}
            onClick={() => setOpen((o) => !o)}
          >
            ▾
          </button>
        </div>

        {open && (
          <div className="picker-list">
            {shown.length === 0 ? (
              <p className="picker-note">
                {!reachable
                  ? 'no suggestions — type the value and press Enter'
                  : draft.trim() === ''
                    ? 'everything here is already chosen'
                    : `nothing matches "${draft.trim()}" — Enter adds it anyway`}
              </p>
            ) : (
              shown.map((s, i) => {
                const heading = s.group !== lastGroup ? s.group : undefined
                lastGroup = s.group
                return (
                  <div key={`${s.group ?? ''}:${s.value}`}>
                    {heading && <p className="picker-group">{heading}</p>}
                    <button
                      type="button"
                      className={`picker-option${i === active ? ' active' : ''}`}
                      // Mousedown, not click: the input's blur would otherwise close the
                      // list before the click landed on anything.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        add(s.value)
                      }}
                      onMouseEnter={() => setActive(i)}
                    >
                      <span>{s.value}</span>
                      {s.hint && <span className="muted">{s.hint}</span>}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  )
}
