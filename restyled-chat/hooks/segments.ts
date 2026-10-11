/** A stretch of a reply: prose for the markdown renderer, or the inside of a fenced block. */
export type Segment = { kind: 'prose'; text: string } | { kind: 'code'; source: string; language?: string }

// A fence that starts its line. One indented under a list item belongs to that item, and splitting
// the list around it would break the list, so it stays with the prose.
const FENCE = /^(`{3,})([^`]*)$/

// Markdown and Code take tabs and line breaks and no other control character.
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** Splits a reply at its fenced blocks. A fence still open at the end, as while a reply streams, runs to the end. */
export function segmentsOf(markdown: string): Segment[] {
  const segments: Segment[] = []
  let prose: string[] = []
  let code: string[] | undefined
  let opening = ''
  let language: string | undefined

  const closeProse = () => {
    const text = printable(prose.join('\n')).trim()
    if (text !== '') segments.push({ kind: 'prose', text })
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
