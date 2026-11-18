/** The cells of a markdown table row, trimmed. A pipe escaped with a backslash is a pipe inside a cell. */
export function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replaceAll('\\|', '|'))
}

// What a cell keeps of its markdown in a spreadsheet: code as written, and the text of bold, struck
// text and links without their marks.
function plain(cell: string): string {
  return cell
    .split(/(`[^`]+`)/)
    .map(part =>
      part.startsWith('`')
        ? part.slice(1, -1)
        : part
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/~~(.+?)~~/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
    )
    .join('')
}

/** The rows of a markdown table as plain cells, without the row under the header that sets the columns. */
function rowsOf(source: string): string[][] {
  return source
    .split('\n')
    .filter((_, index) => index !== 1)
    .map(row => cellsOf(row).map(plain))
}

/** A markdown table as tab-separated values, which a spreadsheet pastes as cells. */
export function tsvOf(source: string): string {
  return rowsOf(source)
    .map(row => row.map(cell => cell.replaceAll('\t', ' ')).join('\t'))
    .join('\n')
}

const csvCell = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)

/** A markdown table as comma-separated values. */
export function csvOf(source: string): string {
  return rowsOf(source)
    .map(row => row.map(csvCell).join(','))
    .join('\n')
}
