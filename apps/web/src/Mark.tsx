/**
 * The anvil from the favicon, inline.
 *
 * The same drawing rather than an <img src="/favicon.svg">: inline it inherits the page's
 * colours, so the mark shifts with the theme instead of carrying its own dark plate into
 * a light sidebar. The plate is dropped here — at 22px next to a word there is nothing to
 * separate it from.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Ogun"
      style={{ flexShrink: 0 }}
    >
      <g fill="var(--accent)" opacity="0.85">
        <circle cx="7.5" cy="6.5" r="1.15" />
        <circle cx="11.5" cy="4.6" r="0.85" />
        <circle cx="4.6" cy="9.4" r="0.7" />
      </g>
      <path
        fill="var(--accent)"
        d="M3.2 13.6
           C5.4 12.2 7.6 11.6 9.6 11.5
           L26.4 11.5
           A1.4 1.4 0 0 1 27.8 12.9
           L27.8 14.6
           A1.4 1.4 0 0 1 26.4 16
           L20.6 16
           C20.2 18.6 19.4 20.1 18.2 21.2
           L18.2 23.4
           L23.6 23.4
           A1.5 1.5 0 0 1 25.1 24.9
           L25.1 26.3
           A1.4 1.4 0 0 1 23.7 27.7
           L8.3 27.7
           A1.4 1.4 0 0 1 6.9 26.3
           L6.9 24.9
           A1.5 1.5 0 0 1 8.4 23.4
           L13.8 23.4
           L13.8 21.2
           C12.6 20.1 11.8 18.6 11.4 16
           L9.6 16
           C7.6 15.9 5.4 15.2 3.2 13.9
           Z"
      />
    </svg>
  )
}
