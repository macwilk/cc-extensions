// The inbox's items and how they change. Nothing here touches the engine. Every change is an event,
// a conversation's ledger is its events applied in order, and the log of those events is what
// brings the inbox back when the conversation is resumed.
import type { Actor, Event, Goal, Item, Ledger } from '../types'

/** How many prompts a closed item stays listed for before it leaves the panel. Its log lines stay. */
export const KEPT_TURNS = 4

export const EMPTY: Ledger = { items: [], goals: [], nextId: 1, turn: 0, dropped: [] }

export type Group = { key: string; heading?: string; goal?: Goal; isBatch?: true; rows: Item[] }
export type Section = { key: 'needs' | 'findings' | 'goals' | 'running'; groups: Group[] }
type Fields = Pick<Item, 'kind' | 'title' | 'from' | 'why' | 'close'> & Partial<Omit<Item, 'id' | 'turn' | 'at' | 'by' | 'status'>>

const isClosed = (item: Item) => item.status === 'done' || item.status === 'dropped'

/** Words that say nothing about what a title names. */
const FILLER = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'not', 'but', 'its', 'still', 'only', 'now'])

/** A title as its words of weight, so that two spellings of one thing compare alike. */
export function wordsOf(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(word => word.length > 2 && !FILLER.has(word))
}

/** True when two titles name the same thing: at least half of the words of the two are shared. */
export function isAlike(one: string, other: string) {
  const words = new Set(wordsOf(one))
  const others = new Set(wordsOf(other))
  const shared = [...words].filter(word => others.has(word)).length

  return shared > 0 && shared / (words.size + others.size - shared) >= 0.5
}

/** True when `title` names something the person already dropped. */
export function isDropped(ledger: Ledger, title: string) {
  return ledger.dropped.some(dropped => isAlike(dropped, title))
}

/** True when `title` names something the inbox already holds open or set aside. */
export function isListed(ledger: Ledger, title: string) {
  return ledger.items.some(item => (item.status === 'open' || item.status === 'later') && isAlike(item.title, title))
}

/** A new item as an event, numbered after the ledger's last and stamped with its count of prompts. */
export function opened(ledger: Ledger, at: number, by: Actor, fields: Fields): Extract<Event, { type: 'open' }> {
  return { type: 'open', item: { ...fields, id: `i${ledger.nextId}`, turn: ledger.turn, at, by, status: 'open' } }
}

export function goalOpened(ledger: Ledger, title: string): Extract<Event, { type: 'goal' }> {
  return { type: 'goal', goal: { id: `g${ledger.nextId}`, title, turn: ledger.turn } }
}

/**
 * How far along a goal is, counted in its asks: the questions and findings that belong to it are
 * not steps of it. It is complete once it has asks and every one of them is done or dropped.
 */
export function progressOf(ledger: Ledger, goal: Goal) {
  const asks = ledger.items.filter(item => item.goal === goal.id && item.kind === 'ask')

  return {
    done: asks.filter(item => item.status === 'done').length,
    of: asks.filter(item => item.status !== 'dropped').length,
    isComplete: asks.length > 0 && asks.every(isClosed),
  }
}

/**
 * The ledger after one more prompt. Closed items that have been listed for KEPT_TURNS prompts leave
 * it. An ask stays with its goal while the goal has work open, so that the goal's progress still
 * counts it, and a finished goal leaves with its asks. Nothing open leaves by its age: an open
 * item stays until someone closes it or the person sets it aside.
 */
function aged(ledger: Ledger): Ledger {
  const turn = ledger.turn + 1
  const isStale = (item: Item) => isClosed(item) && (item.closedTurn ?? 0) + KEPT_TURNS <= turn
  const gone = new Set(
    ledger.goals
      .filter(goal => progressOf(ledger, goal).isComplete && ledger.items.filter(item => item.goal === goal.id).every(isStale))
      .map(goal => goal.id),
  )
  const kept = ledger.items.filter(item => (item.goal === undefined ? !isStale(item) : !gone.has(item.goal)))

  return {
    ...ledger,
    turn,
    goals: ledger.goals.filter(goal => !gone.has(goal.id)),
    items: kept,
  }
}

function changed(ledger: Ledger, id: string, change: (item: Item) => Item): Ledger {
  return { ...ledger, items: ledger.items.map(item => (item.id === id ? change(item) : item)) }
}

const numberOf = (id: string) => Number(id.slice(1)) || 0

export function apply(ledger: Ledger, event: Event): Ledger {
  switch (event.type) {
    case 'turn':
      return aged(ledger)
    case 'goal':
      return { ...ledger, goals: [...ledger.goals, event.goal], nextId: Math.max(ledger.nextId, numberOf(event.goal.id) + 1) }
    case 'open': {
      const dropped = event.isRenewed ? ledger.dropped.filter(title => !isAlike(title, event.item.title)) : ledger.dropped

      return { ...ledger, items: [...ledger.items, event.item], nextId: Math.max(ledger.nextId, numberOf(event.item.id) + 1), dropped }
    }
    case 'close': {
      const item = ledger.items.find(one => one.id === event.id)
      const dropped = item && event.how === 'dropped' && event.by === 'you' ? [...ledger.dropped, item.title] : ledger.dropped
      const { sent: _sent, isUnsettled: _isUnsettled, isMissed: _isMissed, closedIn: _closedIn, closedHeard: _closedHeard, ...rest } = item ?? ({} as Item)
      const within = { ...(event.in === undefined ? {} : { closedIn: event.in }), ...(event.heard === undefined ? {} : { closedHeard: event.heard }) }
      const made = { status: event.how, closedBy: event.by, reason: event.reason, closedTurn: ledger.turn, ...within }

      return item ? { ...changed(ledger, event.id, () => ({ ...rest, ...made })), dropped } : ledger
    }
    case 'later':
      return changed(ledger, event.id, item => ({ ...item, status: 'later', closedBy: 'you', reason: event.reason, closedTurn: ledger.turn }))
    case 'reopen': {
      const title = ledger.items.find(item => item.id === event.id)?.title

      // An item brought back is as fresh as a new one: its age counts from now.
      return {
        ...changed(ledger, event.id, ({ closedBy: _closedBy, reason: _reason, closedTurn: _closedTurn, closedIn: _closedIn, closedHeard: _closedHeard, ...item }) => ({ ...item, status: 'open' })),
        dropped: ledger.dropped.filter(dropped => dropped !== title),
      }
    }
    case 'patch':
      return changed(ledger, event.id, item => {
        const gone = new Set<string>(event.drop ?? [])

        return Object.fromEntries(Object.entries({ ...item, ...event.patch, id: item.id }).filter(([key]) => !gone.has(key))) as Item
      })
    // The person cancelled a prompt and Claude Code took it out of the conversation: the inbox is as
    // it was before that prompt. Ids are not handed out twice, so a log line names one item only.
    case 'retract':
      return { ...event.to, nextId: ledger.nextId }
    // The person rewound the conversation to the end of this prompt. The inbox keeps everything, and
    // what was opened after that point says so: the exchange it came from is gone.
    case 'rewind':
      return { ...ledger, items: ledger.items.map(item => (item.turn > event.turn && item.status !== 'done' && item.status !== 'dropped' ? { ...item, isRewound: true } : item)) }
    case 'note':
      return ledger
  }
}

export function replay(events: Event[]) {
  return events.reduce(apply, EMPTY)
}

/**
 * The events of a log up to the end of its prompt number `turn`: all that came before the prompt
 * after it. A fork of a conversation carries the inbox as it stood where the fork was made, and
 * nothing the first conversation did afterwards.
 */
export function carriedTo(events: Event[], turn: number) {
  const kept: Event[] = []
  let now = EMPTY
  for (const event of events) {
    if (event.type === 'turn' && now.turn === turn) break
    now = apply(now, event)
    kept.push(event)
  }

  return kept
}

/**
 * The marks a conversation's log left, one for each finished turn: the last tool call the
 * conversation held then, the inbox's count of prompts, and Claude Code's own count of turns.
 */
export function marksOf(text: string) {
  return text
    .split('\n')
    .map(line => line.trim().split(' '))
    .flatMap(([call, turn, turns]) => (call && turn !== undefined && turn !== '' && Number.isInteger(Number(turn)) ? [{ call, turn: Number(turn), turns: Number(turns ?? -1) }] : []))
}

/**
 * What a rewind left behind. Claude Code counts fewer turns after one than the newest marks were
 * written at: those marks are of turns that are no longer in the conversation. Returns the last
 * prompt of the inbox that is still in it and the marks that still hold, or null when no mark is
 * ahead of the count, which is every case but a rewind (a compaction raises the count).
 */
export function rewoundTo(marks: { call: string; turn: number; turns: number }[], turns: number) {
  const kept = marks.filter(mark => mark.turns <= turns)
  if (kept.length === marks.length) return null

  return { turn: Math.max(0, ...kept.map(mark => mark.turn)), kept }
}

/**
 * The marks of a conversation that was started again, moved to the count of turns Claude Code gives
 * it now. A compaction raises that count, and a conversation that is quit and resumed is counted
 * afresh from what it still holds, so the count drops with nothing rewound. The newest mark is put
 * at the count as it stands, less the prompts sent since that mark, and the others keep their
 * distance from it. `prompts` is the inbox's own count of prompts. Marks the count is not behind stay.
 */
export function rebased(marks: { call: string; turn: number; turns: number }[], prompts: number, turns: number) {
  const last = marks.at(-1)
  const drop = last ? last.turns - (turns - Math.max(0, prompts - last.turn)) : 0

  return drop > 0 ? marks.map(mark => ({ ...mark, turns: mark.turns - drop })) : marks
}

/**
 * Where a fork was made, among the marks of one log: the mark for the same count of turns as the
 * fork holds, when one of its tool calls is there too. Two turns can end on the same tool call, so
 * without that count the newest mark for the newest call the fork holds is taken.
 */
export function forkPoint(marks: { call: string; turn: number; turns: number }[], calls: string[], turns: number) {
  const held = marks.map(mark => ({ ...mark, at: calls.lastIndexOf(mark.call) })).filter(mark => mark.at >= 0)
  const exact = held.filter(mark => mark.turns === turns).at(-1)
  const newest = held.reduce<(typeof held)[number] | undefined>((best, mark) => (best === undefined || mark.at >= best.at ? mark : best), undefined)

  return exact ? { ...exact, isExact: true } : newest ? { ...newest, isExact: false } : null
}

/** How long ago `at` was, in the one unit that fits: `now`, `5m`, `2h`, `3d`. */
export function ageOf(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  return minutes < 60 * 24 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (60 * 24))}d`
}

/**
 * The ledger's items as the panel lays them out: what waits on the person, findings, goals with
 * their asks, and what is running. Each group holds its items of every status, the panel choosing
 * which to show where.
 */
export function sectionsOf(ledger: Ledger): Section[] {
  const of = (key: string, heading: string, isIn: (item: Item) => boolean): Group => ({ key, heading, rows: ledger.items.filter(isIn) })
  // A goal is drawn as one once two asks share it. Until then its one ask is listed like any other.
  const shared = ledger.goals.filter(goal => ledger.items.filter(item => item.goal === goal.id).length > 1)

  return [
    {
      key: 'needs',
      groups: [
        of('stopped', 'Stopped', item => item.kind === 'stopped'),
        of('checks', 'Failing checks', item => item.kind === 'check'),
        of('questions', 'Questions', item => item.kind === 'question' && item.dialog === undefined),
        { ...of('dialog', 'Left in a dialog', item => item.kind === 'question' && item.dialog !== undefined), isBatch: true },
        of('tasks', 'Your tasks', item => item.kind === 'task'),
      ],
    },
    {
      key: 'findings',
      groups: [
        of('issues', 'Issues', item => item.kind === 'issue'),
        of('opportunities', 'Opportunities', item => item.kind === 'opportunity'),
        of('unverified', 'Unverified', item => item.kind === 'unverified'),
      ],
    },
    {
      key: 'goals',
      groups: [
        ...shared.map(goal => ({ key: goal.id, heading: goal.title, goal, rows: ledger.items.filter(item => item.kind === 'ask' && item.goal === goal.id) })),
        of('asks', 'Asks', item => item.kind === 'ask' && !shared.some(goal => goal.id === item.goal)),
      ],
    },
    { key: 'running', groups: [{ key: 'running', rows: ledger.items.filter(item => item.kind === 'running') }] },
  ]
}

const NEEDS: Item['kind'][] = ['stopped', 'check', 'question', 'task']
const FINDINGS: Item['kind'][] = ['issue', 'opportunity', 'unverified']
/** True for an item that waits on the person. */
export const needsYou = (item: Item) => NEEDS.includes(item.kind)
/** Inside a goal, what waits on the person comes first, then findings, then the goal's own asks. */
const rankOf = (item: Item) => (NEEDS.includes(item.kind) ? 0 : FINDINGS.includes(item.kind) ? 1 : item.kind === 'ask' ? 2 : 3)

/** A goal as the panel draws it: what is open in it, what is closed, and how much of it waits on the person. */
export type GoalBlock = { goal: Goal; open: Item[]; done: Item[]; waiting: number }
export type Layout = {
  goals: GoalBlock[]
  /** Open asks that share a goal with nothing else: each is a goal of one item. */
  single: Item[]
  oneOffs: { key: 'needs' | 'findings' | 'running'; rows: Item[] }[]
  later: { held: { goal: Goal; rows: Item[] }[]; rows: Item[] }
  closed: { goals: GoalBlock[]; rows: Item[] }
}

/**
 * The ledger's items as the panel lays them out: goals first, each with everything that belongs
 * to it, then what belongs to no goal by what it is. A goal is a block of its own once two items
 * share it. Until then its one item is listed like any other of its kind. A goal with nothing
 * open or set aside left in it is under Closed, and what was set aside keeps its goal's name.
 */
export function layoutOf(ledger: Ledger): Layout {
  const shared = ledger.goals.filter(goal => ledger.items.filter(item => item.goal === goal.id).length > 1)
  const blocks = shared.map(goal => {
    const own = ledger.items.filter(item => item.goal === goal.id)
    const open = own.filter(item => item.status === 'open').sort((one, other) => rankOf(one) - rankOf(other))

    return { goal, open, done: own.filter(isClosed), waiting: open.filter(needsYou).length, later: own.filter(item => item.status === 'later') }
  })
  const loose = ledger.items.filter(item => !shared.some(goal => goal.id === item.goal))
  const open = loose.filter(item => item.status === 'open')
  const block = ({ goal, open: rows, done, waiting }: (typeof blocks)[number]): GoalBlock => ({ goal, open: rows, done, waiting })

  return {
    goals: blocks.filter(one => one.open.length > 0).map(block),
    single: open.filter(item => item.kind === 'ask'),
    oneOffs: [
      { key: 'needs', rows: open.filter(needsYou) },
      { key: 'findings', rows: open.filter(item => FINDINGS.includes(item.kind)) },
      { key: 'running', rows: open.filter(item => item.kind === 'running') },
    ],
    later: { held: blocks.filter(one => one.later.length > 0).map(one => ({ goal: one.goal, rows: one.later })), rows: loose.filter(item => item.status === 'later') },
    closed: {
      goals: blocks.filter(one => one.open.length === 0 && one.later.length === 0 && one.done.length > 0).map(block),
      // What is closed in a goal whose other items are all set aside has no block to sit in.
      rows: [...loose.filter(isClosed), ...blocks.filter(one => one.open.length === 0 && one.later.length > 0).flatMap(one => one.done)],
    },
  }
}
