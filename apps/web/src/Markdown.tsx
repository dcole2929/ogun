import { Fragment, type ReactNode } from 'react'

/**
 * A small markdown renderer for SKILL.md, covering exactly what those files use:
 * frontmatter, headings, paragraphs, fenced code, lists, tables, blockquotes, rules,
 * and inline code/bold/italic/links.
 *
 * It builds React elements rather than HTML — there is no dangerouslySetInnerHTML
 * anywhere in here. A skill is a file from a repository, which for a tool whose whole
 * job is running other people's repositories is not a trustworthy source of markup.
 */
export function Markdown({ source }: { source: string }) {
  const { frontmatter, body } = splitFrontmatter(source)
  return (
    <div className="md">
      {frontmatter && <pre className="md-frontmatter">{frontmatter}</pre>}
      {renderBlocks(body)}
    </div>
  )
}

function splitFrontmatter(src: string): { frontmatter: string | null; body: string } {
  if (!src.startsWith('---\n')) return { frontmatter: null, body: src }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: null, body: src }
  return { frontmatter: src.slice(4, end).trim(), body: src.slice(end + 4) }
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i++
      continue
    }

    // fenced code
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) buf.push(lines[i++] ?? '')
      i++
      out.push(
        <pre key={key++} className="md-code">
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1]!.length)
      const Tag = `h${level + 1 > 6 ? 6 : level + 1}` as 'h2'
      out.push(
        <Tag key={key++} className={`md-h${level}`}>
          {inline(heading[2] ?? '')}
        </Tag>,
      )
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} className="md-hr" />)
      i++
      continue
    }

    // table — needs a header row, a separator, then body rows
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|')) rows.push(splitRow(lines[i++]!))
      out.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, n) => (
                  <th key={n}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {r.map((cell, m) => (
                    <td key={m}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^>\s?/, ''))
        i++
      }
      out.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(buf.join('\n'))}
        </blockquote>,
      )
      continue
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+/.exec(line)
    if (bullet) {
      const ordered = /\d/.test(bullet[1] ?? '')
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
          items.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, ''))
          i++
        } else if (/^\s{2,}\S/.test(l) && items.length > 0) {
          // continuation of the previous item
          items[items.length - 1] += `\n${l.trim()}`
          i++
        } else break
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={key++} className="md-list">
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </List>,
      )
      continue
    }

    // paragraph: consume until a blank line or the start of another block
    const buf: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '' || /^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s)/.test(l)) break
      buf.push(l)
      i++
    }
    out.push(
      <p key={key++} className="md-p">
        {inline(buf.join(' '))}
      </p>,
    )
  }

  return out
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/**
 * Inline spans. Split on a single alternation so the pieces cannot nest wrongly —
 * code wins over emphasis, which is what stops `**` inside a code span from being
 * read as bold.
 */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  for (const part of text.split(INLINE)) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={key++} className="md-inline-code">
          {part.slice(1, -1)}
        </code>,
      )
    } else if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={key++}>{part.slice(2, -2)}</strong>)
    } else if (
      (part.startsWith('*') && part.endsWith('*')) ||
      (part.startsWith('_') && part.endsWith('_'))
    ) {
      out.push(<em key={key++}>{part.slice(1, -1)}</em>)
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
      // Only http(s) and relative targets become links. A `javascript:` href in a file
      // we did not write is not something to hand to the browser.
      if (link && /^(https?:\/\/|[./#])/.test(link[2] ?? '')) {
        out.push(
          <a key={key++} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        )
      } else {
        out.push(<Fragment key={key++}>{part}</Fragment>)
      }
    }
  }
  return out
}
