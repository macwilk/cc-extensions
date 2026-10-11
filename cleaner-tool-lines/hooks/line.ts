/** What a tool call's row carries, as `ui.render` hands it over. */
export type Call = {
  tool: string
  input: unknown
  output?: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
}

// The input fields that say what a call acts on, the most telling first. An Agent call has both a
// description and a prompt, and the description is the one written to be read at a glance.
const SUBJECT_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']
const PATH_FIELDS = new Set(['file_path', 'notebook_path'])
// The fields that run long. An open call shows one of these whole in place of its subject.
const WHOLE_FIELDS = ['command', 'prompt']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function onOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

type Subject = { text: string; isPath: boolean }

function subjectOf(input: unknown): Subject {
  if (!isRecord(input)) return { text: '', isPath: false }
  for (const field of SUBJECT_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value !== '') return { text: onOneLine(value), isPath: PATH_FIELDS.has(field) }
  }
  const raw = Object.keys(input).length === 0 ? '' : onOneLine(JSON.stringify(input))
  return { text: raw, isPath: false }
}

/** How the call ended, where the dot's color alone does not say. */
export function noteOf(call: Call): string | undefined {
  if (call.isInterrupted) return 'interrupted'
  if (call.isErrored) return 'error'
  // An errored call's output is the text the model read, so only a result object has these fields.
  if (!isRecord(call.output)) return undefined
  if (call.output.backgroundTaskId !== undefined) return 'background'
  // An Agent call resolves as soon as its agent is launched, while the agent itself goes on running.
  if (call.output.status === 'async_launched' || call.output.status === 'remote_launched') return 'background'
  if (call.output.timedOutAfterMs !== undefined) return 'timed out'
  return undefined
}

// The blocks a terminal draws two cells wide: East Asian wide and fullwidth characters, and emoji.
const TWO_CELLS = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u
// Marks, joiners and variation selectors change the character before them and take no cell of their own.
const NO_CELL = /[\p{M}\u200d\ufe00-\ufe0f]/u

function cellsOf(character: string): number {
  if (NO_CELL.test(character)) return 0
  return TWO_CELLS.test(character) ? 2 : 1
}

export function cellsIn(text: string): number {
  let cells = 0
  for (const character of text) cells += cellsOf(character)
  return cells
}

// A path says most at its end, where the file's name is. Anything else says most at its start.
function cut({ text, isPath }: Subject, room: number): string {
  if (cellsIn(text) <= room) return text
  const characters = isPath ? Array.from(text).reverse() : Array.from(text)
  let kept = ''
  // One cell is the ellipsis's.
  let cells = 1
  for (const character of characters) {
    cells += cellsOf(character)
    if (cells > room) break
    kept = isPath ? character + kept : kept + character
  }
  return isPath ? '…' + kept : kept + '…'
}

/** A closed call's subject, cut to `room` cells. */
export function closedSubject(input: unknown, room: number): string {
  return cut(subjectOf(input), room)
}

/** What an open call shows of its input, and the language to color it in when it is code. */
export type Detail = { text: string; language?: string }

// Text and Code take tabs and line breaks and no other control character.
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** An open call's command or prompt whole, else its subject whole, else all of its input. */
export function detailOf(input: unknown): Detail {
  if (!isRecord(input)) return { text: '' }
  for (const field of [...WHOLE_FIELDS, ...SUBJECT_FIELDS]) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    return field === 'command' ? { text: printable(value), language: 'bash' } : { text: printable(value) }
  }
  return Object.keys(input).length === 0 ? { text: '' } : { text: JSON.stringify(input, null, 2), language: 'json' }
}

export function dotColorOf(call: Call): 'warning' | 'success' | 'error' {
  if (call.isErrored || call.isInterrupted) return 'error'
  // A call waiting on its turn or on approval is not running yet, so only a stored result marks it done.
  return call.isRunning || call.output === undefined ? 'warning' : 'success'
}
