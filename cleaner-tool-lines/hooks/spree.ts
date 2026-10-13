import type { SessionMessage } from 'claude-code'

import { type Call, type Subject, cut, noteOf, subjectOf } from './line'

// As much of a subject as the widest row shows.
const SUBJECT_CELLS = 400

/** The tool calls Claude makes between two pieces of its reply, in the order it made them. */
export type Spree = { calls: string[]; isLive: boolean }

/** What the one line of a spree says of a call that another row draws. */
export type Mark = { tool: string; subject: Subject; state: 'running' | 'done' | 'failed'; note: string | undefined }

/** Every spree of the conversation by the calls in it, how each call stands, and the spree still under way. */
export type Book = { spreeOf: Map<string, Spree>; markOf: Map<string, Mark>; current?: Spree }

export function emptyBook(): Book {
  return { spreeOf: new Map(), markOf: new Map() }
}

/** Adds a new call to the spree under way, starting one where none is. Returns the first call of the spree it changed. */
export function join(book: Book, id: string): string | undefined {
  if (book.spreeOf.has(id)) return undefined
  book.current ??= { calls: [], isLive: true }
  book.current.calls.push(id)
  book.current.isLive = true
  book.spreeOf.set(id, book.current)
  return book.current.calls[0]
}

/** Ends the spree under way, so the next call starts another. Returns the first call of the spree it ended. */
export function end(book: Book): string | undefined {
  const ended = book.current
  if (ended === undefined) return undefined
  ended.isLive = false
  book.current = undefined
  return ended.calls[0]
}

function markOf(call: Call): Mark {
  const subject = subjectOf(call.input)
  return {
    tool: call.tool,
    subject: { text: cut(subject, SUBJECT_CELLS), isPath: subject.isPath },
    // A call waiting on its turn or on approval is not running yet, so only a stored result marks it done.
    state: call.isErrored || call.isInterrupted ? 'failed' : call.isRunning || call.output === undefined ? 'running' : 'done',
    note: noteOf(call),
  }
}

/** Records how a call stands, as its row was last handed it or as the call itself reported. */
export function note(book: Book, id: string, call: Call): void {
  const mark = markOf(call)
  const was = book.markOf.get(id)
  // A row can be drawn once more as running after its call has ended.
  const hasEnded = was !== undefined && was.state !== 'running' && mark.state === 'running'
  book.markOf.set(id, hasEnded ? { ...mark, state: was.state, note: was.note } : mark)
}

type RequestMessage = { content: readonly { type: string; [field: string]: unknown }[] }

/**
 * The calls that open a spree because Claude Code draws a note of Claude's thinking before them, as
 * it draws any thinking that comes with text. Only the request form of the conversation holds the
 * thinking, and only for the part since its last compaction.
 */
export function thoughtSplits(messages: readonly RequestMessage[]): string[] {
  const splits: string[] = []
  let isAfterThought = false
  for (const block of messages.flatMap(message => message.content)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') isAfterThought = true
    if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
    if (isAfterThought) splits.push(block.id)
    isAfterThought = false
  }
  return splits
}

/**
 * Reads the sprees of a conversation off its messages, for the calls made before the mod was loaded.
 * Text ends a spree, Claude's or the person's, and so does a note of thinking, which the messages do
 * not show: `splits` names the calls that follow one. No spree is live: a call that follows the last
 * one joins it and makes it so.
 */
export function restore(book: Book, messages: readonly SessionMessage[], splits: ReadonlySet<string>): void {
  book.spreeOf.clear()
  book.markOf.clear()
  book.current = undefined
  for (const message of messages) {
    if (message.text.trim() !== '') end(book)
    for (const use of message.toolUses) {
      if (splits.has(use.tool_use_id)) end(book)
      join(book, use.tool_use_id)
      const call = { tool: use.tool, input: use.input, output: use.result ?? use.text, isRunning: false, isErrored: use.isError === true, isInterrupted: false }
      book.markOf.set(use.tool_use_id, markOf(call))
    }
  }
  for (const spree of book.spreeOf.values()) spree.isLive = false
}

/** `3 Bash, 2 Edit`: how many calls each tool took, the tools in the order Claude first called them. */
export function tallyOf(marks: readonly Mark[]): string {
  const counts = new Map<string, number>()
  for (const { tool } of marks) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].map(([tool, count]) => `${count} ${tool}`).join(', ')
}
