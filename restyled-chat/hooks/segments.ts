import { cellsOf } from './table'

/**
 * A stretch of a reply: prose for the markdown renderer, the inside of a fenced block, or a quote or a
 * table as the reply wrote it.
 */
export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; source: string; language?: string }
  | { kind: 'quote'; source: string }
  | { kind: 'table'; source: string }

// A fence, a quote or a table that starts its line. One indented under a list item belongs to that
// item, and splitting the list around it would break the list, so it stays with the prose.
const FENCE = /^(`{3,})([^`]*)$/
const QUOTE = /^>/
// The row under a table's header that sets its columns, such as `| :--- | ---: |`.
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// The marker of a quoted line, and the one space after it that belongs to the marker.
const QUOTE_MARKER = /^> ?/

// Markdown and Code take tabs and line breaks and no other control character.
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

const startsTable = (header: string, delimiter: string | undefined) =>
  !/^\s/.test(header) &&
  header.includes('|') &&
  delimiter !== undefined &&
  delimiter.includes('|') &&
  DELIMITER_ROW.test(delimiter) &&
  cellsOf(header).length === cellsOf(delimiter).length

// A table runs to the first blank line, a line with no cell break, or a quote.
const isTableRow = (line: string) => line.trim() !== '' && line.includes('|') && !QUOTE.test(line)

/** Splits prose at the quotes and the tables that start their lines. */
function proseSegmentsOf(lines: string[]): Segment[] {
  const segments: Segment[] = []
  let prose: string[] = []
  const closeProse = () => {
    const text = printable(prose.join('\n')).trim()
    if (text !== '') segments.push({ kind: 'prose', text })
    prose = []
  }
  // The line at `start` and the run of lines after it that `belongs` takes, as one segment. Returns the index past them.
  const take = (kind: 'quote' | 'table', start: number, belongs: (line: string) => boolean) => {
    let end = start + 1
    while (end < lines.length && belongs(lines[end] ?? '')) end++
    closeProse()
    segments.push({ kind, source: printable(lines.slice(start, end).join('\n')) })
    return end
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (QUOTE.test(line)) index = take('quote', index, next => QUOTE.test(next))
    else if (startsTable(line, lines[index + 1])) index = take('table', index, isTableRow)
    else {
      prose.push(line)
      index++
    }
  }
  closeProse()
  return segments
}

/** A quote's text with the marker of each line taken off, one level of quoting at a time. */
export function unquoted(source: string): string {
  return source
    .split('\n')
    .map(line => line.replace(QUOTE_MARKER, ''))
    .join('\n')
}

/** Splits a reply at its fenced blocks, quotes and tables. A fence still open at the end, as while a reply streams, runs to the end. */
export function segmentsOf(markdown: string): Segment[] {
  const segments: Segment[] = []
  let prose: string[] = []
  let code: string[] | undefined
  let opening = ''
  let language: string | undefined

  const closeProse = () => {
    segments.push(...proseSegmentsOf(prose))
    prose = []
  }
  const closeCode = (lines: string[]) => {
    const source = printable(lines.join('\n'))
    if (source.trim() !== '') segments.push(language === undefined ? { kind: 'code', source } : { kind: 'code', source, language })
  }

  for (const line of markdown.split('\n')) {
    const fence = FENCE.exec(line)
    if (code === undefined) {
      if (fence === null) prose.push(line)
      else {
        closeProse()
        code = []
        opening = fence[1] ?? ''
        language = (fence[2] ?? '').trim().split(/\s+/)[0] || undefined
      }
    } else if (fence !== null && (fence[1] ?? '').length >= opening.length && (fence[2] ?? '').trim() === '') {
      closeCode(code)
      code = undefined
    } else code.push(line)
  }
  if (code === undefined) closeProse()
  else closeCode(code)
  return segments
}
