// The one tool Claude has on the inbox: get the items the user sent, list what is open, close an item, record a finding.
// Nothing here touches the engine: a call is answered with the events it causes and the text Claude reads.
import type { Event, Item, Ledger } from '../types'
import { fullOf, labelOf } from './capture'
import { isDropped, isListed, opened, wordsOf } from './ledger'

/** How many items Claude may record between two prompts of the person, so that one reply cannot fill the panel. */
export const RECORDS_PER_TURN = 3

export const TOOL_NAME = 'inbox'
export const TOOL_DESCRIPTION = [
  "The user's inbox: a side panel that lists what this conversation has left open. It holds questions for the user, tasks only the user can do, findings, and what the user asked for that is not finished. The inbox reads every message and every reply itself, so never call this tool to find out what to do.",
  '`get`: the user can send you an item from the panel. It arrives in their message as a quoted line with the item\'s id, as in "> Inbox i12: ...", and what they wrote under the quote is their answer to it or what they want done with it. The quote holds only the title, so before anything else call `get` with every id quoted in the message. It returns each item in full: where it came from, why it matters and what closing it takes. Act on that, and never on the title alone.',
  '`close`: when you finish something the user asked for in this turn, close it then and not at the end, so that the user sees it settle while you work. Name it with `about`, a few of the user\'s own words for it, or with `id` when you have one. `reason` says what now shows it done, in one sentence the user can check. Close only what is fully done and shown: never what is partly done, planned or not yet run. `how: dropped` is for what no longer applies. Always send a close in the same message as your next tool call, never as a call on its own: when no other tool call is left to make, leave the close out, since the inbox closes what your reply shows done.',
  '`list` returns the open items with their ids. Use it only when the user refers to the inbox or to its items, as in "resolve the findings in our inbox": list them, work through the ones meant, and close each one as it is resolved.',
  '`record` adds a finding the user would want to see later and that this turn does not resolve: something wrong or risky you noticed (`issue`), something that could be better (`opportunity`), or a claim you could not check by running (`unverified`). Record sparingly. Do not record what you fix in this turn, what your reply already asks the user, or anything already listed. When the user tells you to keep something for later ("put a pin in that"), record nothing: the inbox sets it aside itself.',
].join(' ')
export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'list', 'close', 'record'] },
    ids: { type: 'array', items: { type: 'string' }, description: "get: the ids quoted in the user's message." },
    id: { type: 'string', description: 'close: the id of the item, as `list` or an earlier close gave it.' },
    about: { type: 'string', description: 'close: a few words naming what the user asked for, when you have no id.' },
    how: { type: 'string', enum: ['done', 'dropped'], description: 'close: `done` when it was resolved, `dropped` when it no longer applies. Default `done`.' },
    reason: { type: 'string', description: 'close: what happened, in one sentence the user can check.' },
    kind: { type: 'string', enum: ['issue', 'opportunity', 'unverified'], description: 'record: what the finding is.' },
    title: { type: 'string', description: 'record: the finding as one plain sentence the user gets at a glance with the conversation gone from their mind: whole words, no compressed headline, up to about 16 words. The details go in `why`.' },
    why: { type: 'string', description: 'record: why it matters, with the names and paths that make it checkable.' },
    close: { type: 'string', description: 'record: what resolving it would take.' },
    file: { type: 'string', description: 'record: the absolute path of the file it is about, if one.' },
  },
  required: ['action'],
}

type Call = { action?: unknown; ids?: unknown; id?: unknown; about?: unknown; how?: unknown; reason?: unknown; kind?: unknown; title?: unknown; why?: unknown; close?: unknown; file?: unknown }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * The open item a few words point at: the one whose title and done-criterion hold the most of
 * them, when that is at least half and more than any other item holds. Words that fit two items
 * alike point at neither, since closing the wrong one is worse than asking for the id.
 */
function meant(ledger: Ledger, about: string) {
  const wanted = [...new Set(wordsOf(about))]
  const ranked = ledger.items
    .filter(item => item.status === 'open')
    .map(item => ({ item, near: wanted.filter(word => wordsOf(`${item.title} ${item.close}`).includes(word)).length / Math.max(1, wanted.length) }))
    .sort((one, other) => other.near - one.near)
  const [best, next] = ranked

  return best && best.near >= 0.5 && (next === undefined || best.near > next.near) ? best.item : undefined
}

/** What the user asked for that is still open, with ids, for Claude to close by id from here on. */
function stillAsked(ledger: Ledger, but = '') {
  const asks = ledger.items.filter(item => item.status === 'open' && item.kind === 'ask' && item.id !== but)

  return asks.length === 0 ? '' : ` Still open from the user: ${asks.map(item => `${item.id} "${item.title}" (done when: ${item.close})`).join('; ')}.`
}

function listed(item: Item) {
  const answers = item.options ? ` Answers: ${item.options.join(' | ')}.` : ''

  return `${item.id} [${labelOf(item)}] ${item.title}\n  Why: ${item.why}\n  To close: ${item.close}${answers}`
}

/** What a call of the tool causes and what Claude reads back. `recorded` is how many items Claude has recorded since the person's last prompt. */
export function answerTool(ledger: Ledger, call: Call, at: number, recorded: number): { events: Event[]; text: string } {
  if (call.action === 'get') {
    const ids = (Array.isArray(call.ids) ? call.ids : [call.id]).map(text).filter(Boolean)
    if (ids.length === 0) return { events: [], text: 'A get needs `ids`: the ids quoted in the user\'s message, as in "> Inbox i12: ...".' }
    const found = ids.flatMap(id => ledger.items.find(one => one.id === id) ?? [])
    const unknown = ids.filter(id => !found.some(item => item.id === id))

    return { events: [], text: [JSON.stringify(found.map(item => fullOf(ledger, item)), null, 1), ...(unknown.length > 0 ? [`No item has the id ${unknown.join(', ')}.`] : [])].join('\n\n') }
  }
  if (call.action === 'list') {
    const open = ledger.items.filter(item => item.status === 'open')
    const later = ledger.items.filter(item => item.status === 'later').length
    const aside = later > 0 ? `\n\n${later} more ${later === 1 ? 'is' : 'are'} set aside and not listed.` : ''

    return { events: [], text: open.length === 0 ? `The inbox has no open items.${aside}` : `${open.map(listed).join('\n')}${aside}` }
  }
  if (call.action === 'close') {
    const id = text(call.id)
    const item = id === '' ? meant(ledger, text(call.about)) : ledger.items.find(one => one.id === id)
    if (!item && id !== '') return { events: [], text: `No item has the id "${id}".${stillAsked(ledger) || ' Call list for the ids.'}` }
    if (!item) return { events: [], text: `No open item clearly matches "${text(call.about)}", so nothing was closed.${stillAsked(ledger) || ' Nothing the user asked for is open.'}` }
    if (item.status !== 'open') return { events: [], text: `${item.id} is not open: it is ${item.status === 'later' ? 'set aside' : item.status}.` }
    if (text(call.reason) === '') return { events: [], text: 'A close needs a reason: what happened, in one sentence the user can check.' }

    return {
      events: [{ type: 'close', id: item.id, how: call.how === 'dropped' ? 'dropped' : 'done', by: 'claude', reason: `Claude closed it: ${text(call.reason)}` }],
      text: `Closed ${item.id}: ${item.title}.${stillAsked(ledger, item.id)}`,
    }
  }
  if (call.action === 'record') {
    const kind = call.kind === 'opportunity' || call.kind === 'unverified' ? call.kind : 'issue'
    const title = text(call.title)
    if (title === '' || text(call.why) === '') return { events: [], text: 'A record needs a title and a why.' }
    if (isDropped(ledger, title)) return { events: [], text: 'Not recorded: the user dropped this before. Do not record it again.' }
    // What the person asked for in this turn can be the record itself, and that ask is not a listing of it.
    const others = { ...ledger, items: ledger.items.filter(item => item.kind !== 'ask' || item.turn !== ledger.turn) }
    if (isListed(others, title)) return { events: [], text: 'Not recorded: the inbox already lists this.' }
    if (recorded >= RECORDS_PER_TURN) return { events: [], text: `Not recorded: ${RECORDS_PER_TURN} items were recorded since the user's last message. Tell the user about it in your reply.` }
    const event = opened(ledger, at, 'claude', {
      kind,
      title,
      from: 'Claude recorded it while working.',
      why: text(call.why),
      close: text(call.close) || 'Say whether to act on it, or drop it.',
      ...(text(call.file) ? { file: text(call.file) } : {}),
    })

    return { events: [event], text: `Recorded as ${event.item.id}.` }
  }

  return { events: [], text: 'The action is one of get, list, close or record.' }
}
