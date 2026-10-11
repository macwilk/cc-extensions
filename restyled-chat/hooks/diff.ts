export type DiffLine = { kind: 'added' | 'removed' | 'about' | 'context'; text: string }

// A hunk's range, and the lines git writes before the first hunk of a file.
const ABOUT = /^(@@|diff |index )/

/** The lines of a unified diff, each as what it is: added, removed, about the diff, or context. */
export function diffLinesOf(source: string): DiffLine[] {
  const lines = source.split('\n')
  return lines.map((text, index) => {
    // The pair that names the two files reads like a removed and an added line, so it is told by its partner.
    const namesOldFile = text.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ') === true
    const namesNewFile = text.startsWith('+++ ') && lines[index - 1]?.startsWith('--- ') === true
    if (ABOUT.test(text) || namesOldFile || namesNewFile) return { kind: 'about', text }
    if (text.startsWith('+')) return { kind: 'added', text }
    if (text.startsWith('-')) return { kind: 'removed', text }
    return { kind: 'context', text }
  })
}
