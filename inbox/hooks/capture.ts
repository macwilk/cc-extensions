// How an item is written into the prompt box, and read back out of the prompt that was sent.
// Nothing here touches the engine.
import type { Item, Kind, Ledger } from '../types'
import { progressOf, sectionsOf } from './ledger'

/** What stands between two items in the prompt box. */
export const RULE = '\n\n---\n\n'
export const SECTION_NAME = { needs: 'Needs you', findings: 'Findings', goals: 'Goals', running: 'Running' }
const LABEL: Record<Kind, string> = {
  stopped: 'Stopped',
  check: 'Failing check',
  question: 'Question',
  task: 'Your task',
  issue: 'Issue',
  opportunity: 'Opportunity',
  unverified: 'Unverified',
  ask: 'Open ask',
  running: 'Running',
}
/** How an item's line starts in the prompt box. The id in it is what Claude fetches the item by. */
const leadOf = (id: string) => `Inbox ${id}:`
const TITLE_LEAD = /^> Inbox \w+: /

export type Decoration = { start: number; end: number; bold?: boolean; dimColor?: boolean }

export function labelOf(item: Item) {
  return item.kind === 'ask' && item.isMissed ? 'Missed ask' : LABEL[item.kind]
}

/**
 * What the panel calls an item of each kind, in a word. The labels above are what Claude and the
 * models read, where an ask has to be told apart from the goal it belongs to. To the person, what
 * they asked for is a goal whether it is one item or a thread of them.
 */
export function nameOf(item: Item) {
  // A claim that a check ran and bore out is no longer one that nobody verified.
  if (item.kind === 'unverified' && item.status === 'done' && item.check?.verdict === 'passed') return 'Verified'

  return item.kind === 'ask' ? (item.isMissed ? 'Missed goal' : 'Goal') : item.kind === 'task' ? 'Task' : LABEL[item.kind]
}

export function clip(text: string, room: number) {
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

export function wrapped(line: string, room: number) {
  const lines = ['']
  for (const word of line.split(' ')) {
    const last = lines[lines.length - 1] ?? ''
    if (last !== '' && last.length + 1 + word.length > room) lines.push(word)
    else lines[lines.length - 1] = last === '' ? word : `${last} ${word}`
  }

  return lines.map(one => clip(one, room))
}

/** At most `most` lines of `text` wrapped to `room`, the last cut with an ellipsis when more follow. */
export function linesOf(text: string, room: number, most: number) {
  const lines = wrapped(text, room)

  return lines.length <= most ? lines : [...lines.slice(0, most - 1), clip(`${lines[most - 1]} ${lines[most]}`, room)]
}

/** Where an item sits in the panel: its section's name, then its group's with a goal's progress. */
export function placeOf(ledger: Ledger, item: Item) {
  for (const section of sectionsOf(ledger)) {
    const group = section.groups.find(one => one.rows.some(row => row.id === item.id))
    if (!group) continue
    const progress = group.goal ? progressOf(ledger, group.goal) : null

    return [SECTION_NAME[section.key], group.heading && `${group.heading}${progress ? ` (${progress.done} of ${progress.of} done)` : ''}`].filter(Boolean).join(' / ')
  }

  return ''
}

/**
 * One item as the lines put in the prompt box: its id and its title, quoted. Everything else the
 * inbox knows about it stays out of the box, where the person would have to read past it: Claude
 * fetches it by the id, with the tool's `get`.
 */
export function captureOf(item: Item, room: number) {
  return wrapped(`${leadOf(item.id)} ${item.title}`, room).map((line, at) => `> ${at === 0 ? '' : '  '}${line}`)
}

/** An item in full, as the tool's `get` hands it to Claude: what its line in the prompt box leaves out. */
export function fullOf(ledger: Ledger, item: Item) {
  const doneSoFar = item.goal === undefined ? [] : ledger.items.filter(one => one.goal === item.goal && one.status === 'done').map(one => one.title)

  return {
    id: item.id,
    kind: labelOf(item),
    title: item.title,
    status: item.status,
    where: placeOf(ledger, item),
    from: item.from,
    why: item.why,
    toClose: item.close,
    ...(item.options ? { answers: item.options } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.link ? { link: item.link } : {}),
    ...(item.file ? { file: item.file } : {}),
    ...(item.check?.text ? { check: { verdict: item.check.verdict ?? 'running', found: item.check.text } } : {}),
    ...(doneSoFar.length > 0 ? { doneSoFar } : {}),
  }
}

/** What the prompt box holds, less the item that carries `mark`: an item added again takes the place of its earlier capture. */
export function without(held: string, mark: string | undefined) {
  return mark === undefined
    ? held
    : held
        .split(RULE)
        .filter(block => !block.includes(mark))
        .join(RULE)
}

/**
 * An item as a quoted capture after what the prompt box already holds, then `say`: the answer picked
 * for it or what Claude is asked to do with it. A `say` that ends in a colon is left for the person
 * to finish, with the cursor right after it. `mark` is how the capture starts, id included, by which
 * the item is later found in the box.
 */
export function draftOf(held: string, item: Item, room: number, say?: string) {
  const capture = captureOf(item, room)
  const before = held.trim() === '' ? '' : `${held.replace(/\n+$/, '')}${RULE}`
  const after = say === undefined ? '' : say.endsWith(': ') ? say : `${say}\n\n`
  const text = `${before}${capture.join('\n')}\n\n${after}`
  const titles = new Set(capture)
  const decorations: Decoration[] = []
  let at = 0
  for (const line of text.split('\n')) {
    if (titles.has(line) || TITLE_LEAD.test(line)) decorations.push({ start: at, end: at + line.length, bold: true })
    else if (line.startsWith('>') || line === '---') decorations.push({ start: at, end: at + line.length, dimColor: true })
    at += line.length + 1
  }

  return { text, decorations, mark: `> ${leadOf(item.id)}` }
}

/**
 * What a card's Send adds under the capture, empty while nothing is ticked or typed. On a question,
 * text typed beside ticked answers goes on a line of its own, so that a comma in it is not read as
 * two answers. Elsewhere the typed value follows `lead`.
 */
export function sayOf(item: Item, picks: number[], typed: string, lead: string) {
  const own = typed.trim()
  if (!item.options) return own === '' ? '' : `${lead}${own}`
  const ticked = picks
    .map(at => item.options?.[at] ?? '')
    .filter(Boolean)
    .join(', ')
  if (ticked === '') return own === '' ? '' : `Answer: ${own}`

  return own === '' ? `Answer: ${ticked}` : `Answer: ${ticked}\nCustom: ${own}`
}

/**
 * A sent prompt taken apart: for each item whose capture went out with it, what the person said
 * under the capture, and `rest`, the text that belongs to no capture. `added` holds each waiting
 * item's mark.
 */
export function sentOf(text: string, added: Record<string, string>) {
  const blocks = text.split(RULE)
  const sent = Object.entries(added).flatMap(([id, mark]) => {
    const block = blocks.find(one => one.includes(mark))
    if (block === undefined) return []
    const said = block
      .split('\n')
      .filter(line => !line.startsWith('>'))
      .join('\n')
      .trim()

    return [{ id, said }]
  })
  const marks = Object.values(added)
  const rest = blocks
    .filter(block => !marks.some(mark => block.includes(mark)))
    .join('\n\n')
    .trim()

  return { sent, rest }
}
