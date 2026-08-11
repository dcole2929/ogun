const ESC = String.fromCharCode(27)
const isTTY = process.stdout.isTTY === true
const paint = (code: string, s: string): string => (isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : s)

export const dim = (s: string) => paint('2', s)
export const bold = (s: string) => paint('1', s)
export const red = (s: string) => paint('31', s)
export const green = (s: string) => paint('32', s)
export const yellow = (s: string) => paint('33', s)
export const cyan = (s: string) => paint('36', s)

export const severityColor = (s: string): string =>
  s === 'critical' || s === 'high' ? red(s) : s === 'medium' ? yellow(s) : dim(s)

export const outcomeColor = (s: string): string =>
  s === 'approved' || s === 'dispatched'
    ? green(s)
    : s === 'error' || s === 'changes-requested'
      ? red(s)
      : yellow(s)

export function table(rows: string[][]): string {
  if (rows.length === 0) return ''
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? '').length)))
  return rows
    .map((r) =>
      r
        .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - stripAnsi(cell).length)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const stripAnsi = (s: string): string => s.replace(ANSI, '')

// The explicit annotation on the const is required for control-flow narrowing: without
// it, TS won't treat `if (!res) fail(...)` as proving res is non-null afterwards.
export const fail: (message: string) => never = (message) => {
  console.error(red(`error: ${message}`))
  process.exit(1)
}
