// The inbox: a side panel that keeps what a conversation leaves open, a small handle that opens it,
// one tool for Claude, and the signals that open and close items without anyone saying so. Every
// change is an event. Events are applied to the ledger held in the session's state and written to
// the conversation's log, from which the inbox comes back when the conversation is resumed.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { Check, Event, Item, Kind, Ledger, Pending, Running, View } from '../types'
import { SECTION_NAME, clip, draftOf, linesOf, nameOf, sayOf, sentOf, without, wrapped, type Decoration } from './capture'
import { AGENT_SPEC, AGENT_TYPE, ASK_AGAIN_AFTER, CHECKS_AT_ONCE, HAND_BACK, RECEIVED, STOPPED, canCheck, checkAsk, checkBack, checkDismissed, checkLost, ranLine, sayOfCheck, stepsOf, withRan } from './checks'
import { EMPTY, ageOf, apply, carriedTo, forkPoint, layoutOf, marksOf, needsYou, opened, progressOf, rebased, replay, rewoundTo, sectionsOf, type GoalBlock, type Section } from './ledger'
import { checkOf, failedCheck, leftQuestions } from './signals'
import { TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA, answerTool } from './tool'
import { AGENT_OPENS_PER_PROMPT, AGENT_RULES, BY_REPLY, PROMPT_RULES, REPLY_RULES, agentAsk, agentEvents, agentPart, closedByClaude, didLines, forkAsk, lastReplyOf, newest, promptAsk, promptEvents, readAgent, readAt, readFork, readPrompt, readReply, replyAsk, replyEvents, saidOf, todoOf, toolLine, toolLines, useOf, type Beside, type Message, type Subagent } from './workers'

const PANE = 'inbox'
/** Raised whenever the fields of View change, so a value an earlier build stored is told apart from this build's. */
const SHAPE = 2
const OFF: View = { shape: SHAPE, isPanelOpen: false, folded: ['later', 'closed'], open: [], detailed: [], added: {}, typed: {}, picks: {}, shownGoals: [], agents: [], tick: 0 }
const viewAtom = atom({ plugin: 'inbox', key: 'view' } as const, OFF)
const ledgerAtom = atom({ plugin: 'inbox', key: 'ledger' } as const, EMPTY)
// The audit a turn's end asked for, until it has finished. It is kept in the session's state because
// a reload of the mod cancels the timer that audit waits on, and the audit with it.
const pendingAtom = atom({ plugin: 'inbox', key: 'pending' } as const, null as Pending | null)
const runningAtom = atom({ plugin: 'inbox', key: 'running' } as const, null as Running | null)

type Color = ThemeKey
/** Each section its own accent, so its bar and count are told apart at a glance. */
const ACCENT: Record<Section['key'] | 'later' | 'closed', Color> = { needs: 'warning', findings: 'suggestion', goals: 'success', running: 'planMode', later: 'merged', closed: 'inactive' }
/** Each kind of item has one mark and one color wherever it is listed, so that no heading has to say what a row is. */
const LOOK: Record<Kind, { mark: string; color: Color }> = {
  stopped: { mark: '!', color: 'error' },
  check: { mark: '!', color: 'error' },
  question: { mark: '?', color: 'warning' },
  task: { mark: '→', color: 'warning' },
  issue: { mark: '!', color: 'error' },
  opportunity: { mark: '+', color: 'suggestion' },
  unverified: { mark: '~', color: 'suggestion' },
  ask: { mark: '○', color: 'success' },
  running: { mark: '◌', color: 'planMode' },
}
/** How a check of a finding came out, as a row and a card show it. */
const VERDICT: Record<NonNullable<Check['verdict']>, { head: string; tag: string; color: Color; mark: string }> = {
  passed: { head: '✓ Passed at', tag: 'passed', color: 'success', mark: '✓' },
  failed: { head: '✗ Failed at', tag: 'failed', color: 'error', mark: '!' },
  unclear: { head: '? Unclear at', tag: 'unclear', color: 'warning', mark: '~' },
}
/** The words of a look in the background: a check of a finding, and where a running task stands. */
const CHECK_WORDS = {
  verify: { ask: 'Verify', again: 'Verify again', back: '✓ Checked at' },
  status: { ask: "What's going on?", again: 'Ask again', back: '✓ Where it stands as of' },
}
const wordsOf = (item: Item) => (item.kind === 'running' ? CHECK_WORDS.status : CHECK_WORDS.verify)
/** The time of day as the person reads it off a clock. */
const clockOf = (at: number) => {
  const time = new Date(at)

  return `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`
}
const SHORT: Record<Section['key'], string> = { needs: 'Needs', findings: 'Finds', goals: 'Goals', running: 'Runs' }
/** What Claude can be asked to do with an item of each kind: a button, and the line it adds to the prompt. */
const INTENTS: Record<Kind, { label: string; say: string }[]> = {
  stopped: [],
  check: [{ label: 'Fix it', say: 'Fix this failing check, run it again, and show me how it ended.' }],
  question: [{ label: 'Explain it', say: 'Explain this question and what each answer leads to before I pick.' }],
  running: [{ label: 'Stop it', say: 'Stop this now.' }],
  task: [{ label: 'Walk me through it', say: 'Walk me through this step by step.' }],
  issue: [
    { label: 'Fix it now', say: 'Fix this now, then tell me what you changed.' },
    { label: 'Explain it', say: 'Explain this in plain words before changing anything.' },
  ],
  opportunity: [
    { label: 'Build it', say: 'Build this.' },
    { label: 'Weigh it up', say: 'Tell me what this would cost and what it would buy before building anything.' },
  ],
  unverified: [],
  ask: [{ label: 'Do it now', say: 'Do this now.' }],
}
const BY_YOU = { done: 'You marked it done in the panel.', dropped: 'You dropped it in the panel.' }
const LATER_REASON = 'You set it aside. It comes back when you ask to commit, push or wrap up.'
/** Told to the audit of a turn that ended without a reply, under whatever Claude had written by then. */
const CUT_SHORT = '[The turn was stopped here, before Claude finished.]'
/** Under this many columns the panel has no room for an item's title, and draws its narrow shape. */
const MIN_COLUMNS = 34
/** Past this many characters a part of the log is full, and the next events start a new part. The engine writes no file over 4 MiB. */
const PART_SIZE = 2_000_000

/**
 * What a press handler has no other way to learn: the terminal as last drawn, whether any item may
 * be waiting in the prompt box, so that typing with none waiting costs nothing, and how many items
 * Claude has recorded, and the audits of its subagents have opened, since the person's last prompt.
 */
const seen = { terminal: 0, isFullscreen: true, bodyColumns: 0, placement: '', hasStaged: true, recorded: 0, agentOpened: 0, cwd: '' }
/** The conversation's log as this session holds it: where its parts are, the part being written and its text, and the writes still to finish. */
const log = { base: '', part: 0, text: '', marks: '', queue: Promise.resolve() }
/** What a turn answers: a message of the person's or a notice of the system's, with the asks the message opened. */
/**
 * A prompt on its way to a reply. `before` is how things stood when the person sent it, kept so that
 * a prompt they cancel and get back in the prompt box leaves nothing behind.
 */
type Sent = { text: string; isNotice: boolean; asked: string[]; answered: string[]; before?: { ledger: Ledger; turns: number; added: View['added'] }; isTakenBack?: boolean }
/**
 * The model passes, run one after another, since a reply's audit needs the asks its prompt's pass
 * found. A person may type ahead while Claude works, so each reply is audited against what it was
 * a reply to: `waiting` holds what was submitted and has not reached Claude yet, and `turn` what
 * the running turn answers. `turnId` is the engine's id of that turn, which each close Claude makes
 * in it keeps. `did` holds the running turn's tool calls, each kept as it is made: a
 * compaction in the middle of a turn takes the earlier ones out of the conversation. `agents` holds
 * the subagents Claude started, each until a read has been told how it ended: `told` is how many of
 * its tool calls a read has been given, and `report` what it handed back.
 */
const passes = {
  queue: Promise.resolve(),
  waiting: [] as Sent[],
  turn: null as Sent[] | null,
  turnId: undefined as string | undefined,
  did: [] as string[],
  audits: new Set<string>(),
  depth: readAt(undefined),
  agents: new Map<string, Subagent & { told: number; report?: string; calls: string[] }>(),
}
const isClosed = (item: Item) => item.status === 'done' || item.status === 'dropped'

/**
 * Keeps the running turn in the session's state, which a reload of the mod leaves as it is, while
 * the mod's own memory starts over. What a prompt took with it for a take-back is not kept.
 */
function keepTurn($: EngineInterface) {
  const told = ({ text, isNotice, asked, answered }: Sent) => ({ text, isNotice, asked, answered })
  const running: Running = { ...(passes.turnId === undefined ? {} : { id: passes.turnId }), heard: passes.turn?.map(told) ?? null, waiting: passes.waiting.map(told) }

  return update($, runningAtom, () => running)
}

/** Takes the running turn up from the session's state, when this load of the mod knows of none. */
async function takeUpTurn($: EngineInterface) {
  const running = await read($, runningAtom)
  if (!running || passes.turn !== null || passes.turnId !== undefined || passes.waiting.length > 0) return
  const sent = (told: Pending['turn'][number]): Sent => ({ ...told, answered: told.answered ?? [] })
  passes.turn = running.heard?.map(sent) ?? null
  passes.turnId = running.id
  passes.waiting = running.waiting.map(sent)
}

/**
 * The stored view as this build understands it. A session keeps its state across a reload, so the
 * value may come from an earlier build with other fields: that one starts over, keeping only
 * whether the panel is open.
 */
function current(stored: View | undefined): View {
  return stored?.shape === SHAPE ? { ...OFF, ...stored } : { ...OFF, isPanelOpen: stored?.isPanelOpen === true }
}

async function viewOf($: EngineInterface) {
  return current(await read($, viewAtom))
}

function change($: EngineInterface, next: (was: View) => View) {
  return update($, viewAtom, was => next(current(was)))
}

/**
 * The stored ledger, or an empty one when what is stored is not this build's: a session keeps its
 * state across a reload, and another build, or another mod of the same name, may have left its own.
 */
function sound(stored: Ledger | undefined): Ledger {
  return stored && Array.isArray(stored.items) && Array.isArray(stored.goals) && Array.isArray(stored.dropped) && typeof stored.turn === 'number' ? stored : EMPTY
}

async function ledgerOf($: EngineInterface) {
  return sound(await read($, ledgerAtom))
}

function partPath(part: number) {
  return `${log.base}${part === 0 ? '' : `.${part}`}.jsonl`
}

/**
 * Writes events to the conversation's log, after the ones before them. The engine writes whole
 * files, so the text of the part being written is held here and written out again with each batch.
 */
function logged($: EngineInterface, events: Event[], turn: number) {
  if (events.length === 0 || log.base === '') return
  log.queue = log.queue
    .then(async () => {
      const at = await $.clock.now()
      if (log.text.length > PART_SIZE) Object.assign(log, { part: log.part + 1, text: '' })
      log.text += events.map(event => `${JSON.stringify({ at, turn, ...event })}\n`).join('')
      await $.fs.write(partPath(log.part), log.text)
    })
    .catch((error: unknown) => {
      $.ui.log(`inbox: the log was not written: ${String(error).slice(0, 120)}`)
    })
}

/** Applies the events `make` gives for the ledger as it stands, and logs them. */
async function record($: EngineInterface, make: (now: Ledger) => Event[]) {
  let events: Event[] = []
  await update($, ledgerAtom, was => {
    events = make(sound(was))

    return events.reduce(apply, sound(was))
  })
  logged($, events, (await ledgerOf($)).turn)

  return events
}

/** Logs something that changes no item: a tool call, a model call, a signal. */
async function note($: EngineInterface, what: string, detail: unknown) {
  logged($, [{ type: 'note', what, detail }], (await ledgerOf($)).turn)
}

/** The events of a log's lines. A line cut short by a crash is skipped: the events around it still apply. */
function eventsOf(text: string) {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Event]
      } catch {
        return []
      }
    })
}

/**
 * Leaves a mark for the turn that just ended, beside the log: the last tool call the conversation
 * holds, and the count of prompts. A fork of this conversation starts under a new id with the same
 * history, and Claude Code names no parent, so the fork finds its way back by a call both hold.
 */
async function mark($: EngineInterface) {
  if (log.base === '') return
  // A conversation that has called no tool yet is marked all the same, with a dash for the call: the counts are what a rewind is read from.
  const last = (await $.session.messages()).flatMap(row => row.toolUses.map(use => use.tool_use_id)).at(-1) ?? '-'
  log.marks += `${last} ${(await ledgerOf($)).turn} ${await $.session.turns()}\n`
  await $.fs.write(`${log.base}.marks`, log.marks)
}

/**
 * Notices a rewind: Claude Code then counts fewer turns than the newest marks were written at. The
 * items opened after the point rewound to are kept and flagged, and the marks of the turns that are
 * gone are taken out, so that neither a fork nor a later rewind is placed by them.
 */
async function followRewind($: EngineInterface) {
  const back = rewoundTo(marksOf(log.marks), await $.session.turns())
  if (back === null || log.base === '') return
  log.marks = back.kept.map(one => `${one.call} ${one.turn} ${one.turns}\n`).join('')
  await $.fs.write(`${log.base}.marks`, log.marks)
  await record($, () => [{ type: 'rewind', turn: back.turn }])
}

/**
 * For a conversation that has a history and no log, which a fork is: the events of the conversation
 * it was forked from, up to where the fork was made. That is the newest mark of any log whose tool
 * call this conversation also holds.
 */
async function forkedFrom($: EngineInterface, folder: string) {
  const calls = (await $.session.messages()).flatMap(row => row.toolUses.map(use => use.tool_use_id))
  if (calls.length === 0 || !(await $.fs.exists(folder))) return null
  const turns = await $.session.turns()
  let found: { name: string; marks: string; turn: number; at: number; isExact: boolean } | null = null
  for (const entry of await $.fs.list(folder)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.marks')) continue
    const marks = await $.fs.read(`${folder}/${entry.name}`)
    const point = forkPoint(marksOf(marks), calls, turns)
    // A log that marks this very count of turns beats one that only shares a tool call. Between two alike, the one sharing the later call.
    const isBetter = point !== null && (found === null || (point.isExact && !found.isExact) || (point.isExact === found.isExact && point.at > found.at))
    if (point !== null && isBetter) found = { name: entry.name.slice(0, -'.marks'.length), marks, turn: point.turn, at: point.at, isExact: point.isExact }
  }
  if (found === null) return null
  const { name, turn } = found
  const events: Event[] = []
  for (let part = 0; await $.fs.exists(`${folder}/${name}${part === 0 ? '' : `.${part}`}.jsonl`); part += 1) {
    events.push(...eventsOf(await $.fs.read(`${folder}/${name}${part === 0 ? '' : `.${part}`}.jsonl`)))
  }
  const marks = marksOf(found.marks)
    .filter(one => one.turn <= turn)
    .map(one => `${one.call} ${one.turn} ${one.turns}\n`)
    .join('')

  return { from: name, turn, events: carriedTo(events, turn), marks }
}

/**
 * Brings the inbox back from the conversation's log. A session that starts with nothing in its
 * state and events in its log is a conversation started again, which closes what waited on a
 * restart. A fork of a conversation has no log yet, and starts from the inbox it was forked with.
 */
async function restore($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const folder = `${home}/.claude/inbox`
  log.base = `${folder}/${await $.session.id()}`
  const events: Event[] = []
  let part = 0
  while (await $.fs.exists(partPath(part))) {
    log.text = await $.fs.read(partPath(part))
    events.push(...eventsOf(log.text))
    part += 1
  }
  log.part = Math.max(0, part - 1)
  log.marks = (await $.fs.exists(`${log.base}.marks`)) ? await $.fs.read(`${log.base}.marks`) : ''
  const fork = part === 0 ? await forkedFrom($, folder) : null
  if (fork) {
    events.push(...fork.events)
    Object.assign(log, { marks: fork.marks, text: fork.events.map(event => `${JSON.stringify(event)}\n`).join('') })
    await $.fs.write(`${log.base}.marks`, log.marks)
    await $.fs.write(partPath(0), log.text)
    void note($, 'carried', { from: fork.from, turn: fork.turn })
  }
  const held = await ledgerOf($)
  await update($, ledgerAtom, () => replay(events))
  // State that outlived the start means the plugins were reloaded in a running session. A restart reloads them too.
  const isRestart = held.turn === 0 && held.items.length === 0
  // Started again, the conversation is counted afresh, and lower than before where it was compacted:
  // the marks are moved to that count, or the next prompt would read the drop as a rewind.
  const marks = marksOf(log.marks)
  const moved = isRestart ? rebased(marks, (await ledgerOf($)).turn, await $.session.turns()) : marks
  if (moved !== marks) {
    log.marks = moved.map(one => `${one.call} ${one.turn} ${one.turns}\n`).join('')
    await $.fs.write(`${log.base}.marks`, log.marks)
  }
  await record($, now =>
    now.items
      .filter(item => item.status === 'open' && (item.closesOn === 'reload' || (isRestart && item.closesOn === 'restart')))
      .map(item => ({ type: 'close', id: item.id, how: 'done', by: 'engine', reason: isRestart ? 'Claude Code was started again.' : 'The plugins were reloaded.' })),
  )
}

/**
 * Keeps the terminal's width as a drawing hook reports it. Beside a docked panel a hook is told the
 * transcript's width, so the panel's own is added back.
 */
function noteViewport(viewport: { columns: number; isFullscreen?: boolean } | undefined, now: View) {
  if (!viewport) return
  seen.terminal = viewport.columns + (now.isPanelOpen && seen.placement === 'dock' ? seen.bodyColumns + 2 : 0)
  seen.isFullscreen = viewport.isFullscreen ?? seen.isFullscreen
}

/** True where the engine docks a panel at the right of the transcript, false where it lands above the prompt. */
function docks() {
  return seen.isFullscreen && seen.terminal >= 110
}

async function openPanel($: EngineInterface) {
  await change($, now => ({ ...now, isPanelOpen: true }))
  await $.ui.open(docks() ? { id: PANE, title: 'Inbox' } : { id: PANE, title: 'Inbox', rows: 18 })
}

function togglePanel($: EngineInterface) {
  return async () => {
    // Opening the panel is when a rewind made since the last prompt is first looked at.
    if (!(await viewOf($)).isPanelOpen) return followRewind($).then(() => openPanel($))
    await $.ui.close({ id: PANE })
    // The close hook below hears a person's close, not this one of the mod's own.
    await change($, now => ({ ...now, isPanelOpen: false }))
  }
}

/** The handle: an arrow toward where the panel lands and the number of open items, on the color of what waits on the person. */
function handleOf($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, now: View, book: Ledger, arrow: string) {
  const { Button, Text } = ui
  const sections = sectionsOf(book)
  // The same rows the panel counts under its title: open ones, less those of a goal whose asks are all done.
  const openIn = (section: Section) => section.groups.filter(group => group.goal === undefined || !progressOf(book, group.goal).isComplete).flatMap(group => group.rows.filter(row => row.status === 'open'))
  const total = sections.reduce((sum, section) => sum + openIn(section).length, 0)
  // The handle wears the color of the first section, in the panel's order, that still waits on
  // something. An item whose capture was sent waits on Claude's reply and no longer on the person,
  // so it stops coloring the handle while it still counts as open.
  const waiting = sections.find(section => openIn(section).some(row => row.sent === undefined))
  const color = waiting ? ACCENT[waiting.key] : undefined

  return (
    <Button key="handle" label={now.isPanelOpen ? 'Hide the inbox' : 'Show the inbox'} plain onPress={togglePanel($)}>
      <Text backgroundColor={color ?? 'selectionBg'} {...(color ? { color: 'inverseText' } : {})} bold>
        {' '}
        {arrow} {total}{' '}
      </Text>
    </Button>
  )
}

/**
 * Opens an item's card in place, or shuts it. Other cards stay as they are, so nothing above the
 * clicked row changes height and the row stays under the pointer. The mod scrolls the panel in one
 * case only: part of the opened card is off screen, and then by the least that shows it. When the
 * list gets shorter than where the panel is scrolled to, the engine brings it back to the list's end.
 */
function toggleOpen($: EngineInterface, id: string) {
  return async () => {
    const isOpening = !(await viewOf($)).open.includes(id)
    await change($, now => ({ ...now, open: isOpening ? [...now.open, id] : now.open.filter(one => one !== id) }))
    // The card is drawn after this handler returns, so it is asked for a moment later.
    if (isOpening) {
      $.clock.after(150, () => $.ui.scroll({ in: PANE, to: { key: `item-${id}` }, block: 'nearest' }))
    }
  }
}

function toggleGoal($: EngineInterface, key: string) {
  return () => change($, now => ({ ...now, shownGoals: now.shownGoals.includes(key) ? now.shownGoals.filter(one => one !== key) : [...now.shownGoals, key] }))
}

function toggleFold($: EngineInterface, key: string) {
  return () => change($, now => ({ ...now, folded: now.folded.includes(key) ? now.folded.filter(one => one !== key) : [...now.folded, key] }))
}

function toggleDetails($: EngineInterface, id: string) {
  return () => change($, now => ({ ...now, detailed: now.detailed.includes(id) ? now.detailed.filter(one => one !== id) : [...now.detailed, id] }))
}

/** Draws the panel again after a while, when all that will have changed is the time: a result is then old enough to ask about again. */
function redrawLater($: EngineInterface, after: number) {
  $.clock.after(after, () => {
    void change($, now => ({ ...now, tick: now.tick + 1 }))
  })
}

/**
 * Ends a look at an item with what its agent said: what it handed back, or the answer its turn
 * ended on. An agent that ended with nothing to say leaves `lost`, the reason, in its place. A look
 * that was stopped, or that has ended already, is left as it is.
 */
async function endCheck($: EngineInterface, id: string, agent: string, message: string, lost = 'The check ended without a report.') {
  const at = await $.clock.now()
  const events = await record($, now => {
    const item = now.items.find(one => one.id === id && one.check?.state === 'running' && one.check.agent === agent)

    return item ? (message.trim() === '' ? checkLost(item, at, lost) : checkBack(item, message, at)) : []
  })
  await ours($, agent)
  if (events.length > 0) redrawLater($, ASK_AGAIN_AFTER + 1000)
}

/** Remembers an agent as the mod's, so that what it still calls or hands back after its look is over is never taken for the conversation's. */
function ours($: EngineInterface, agent: string) {
  return change($, now => (now.agents.includes(agent) ? now : { ...now, agents: [...now.agents, agent].slice(-40) }))
}

/**
 * Starts a look at an item in the background: an agent of the mod's own type, which reads and runs
 * and changes nothing. What it hands back is taken by a hook of the mod's, so none of it enters the
 * conversation and Claude takes no turn over it. It is called from the hook on a press and never
 * from a button's own handler, for the reason given at that hook.
 */
async function startCheck($: EngineInterface, id: string) {
  const book = await ledgerOf($)
  const item = book.items.find(one => one.id === id)
  if (!item || !canCheck(item) || item.check?.state === 'running') return
  if (book.items.filter(one => one.check?.state === 'running').length >= CHECKS_AT_ONCE) {
    $.ui.toast(`${CHECKS_AT_ONCE} checks are running. Try again when one is back.`)

    return
  }
  try {
    await $.agent.register(AGENT_SPEC)
    const started = await $.agent.spawn({ prompt: checkAsk(item), description: clip(`Inbox: ${item.title}`, 60), subagentType: AGENT_TYPE })
    const agent = started.deny === undefined ? started.agentId : undefined
    if (agent === undefined) throw new Error(started.deny ?? `no agent started: ${JSON.stringify(started)}`)
    const at = await $.clock.now()
    await ours($, agent)
    // The item stays as it was, open or shut: a look asked for from a row goes on behind the row,
    // whose tag says it is running. Opening its card there would push the rest of the list away.
    await change($, now => ({ ...now, detailed: now.detailed.filter(one => one !== id) }))
    await record($, () => [{ type: 'patch', id, patch: { check: { state: 'running', at, agent, ...(item.check?.was ? { was: item.check.was } : {}) } } }])
    void note($, 'check', { id, agent, model: started.model })
  } catch (error) {
    $.ui.toast('The check could not start.')
    $.ui.log(`inbox: a check did not start: ${String(error).slice(0, 160)}`)
  }
}

/** The handler of a button whose press a hook takes: the work is the hook's. */
const ignore = () => undefined

/**
 * Stops a look: the item is as it was before, and whatever the agent still does or says is
 * dropped. `thenAdd` hands the item to the conversation in its place, through the prompt box.
 */
function stopCheck($: EngineInterface, id: string, thenAdd = false) {
  return async () => {
    const agent = (await ledgerOf($)).items.find(one => one.id === id)?.check?.agent
    if (agent !== undefined) await ours($, agent)
    await record($, now => now.items.filter(one => one.id === id && one.check?.state === 'running').flatMap(checkDismissed))
    if (thenAdd) await addAll($, [{ id }])
  }
}

/** Throws a result away: the item is what it was before the look. */
function dismissCheck($: EngineInterface, id: string) {
  return async () => {
    await record($, now => now.items.filter(one => one.id === id && one.check?.state === 'back').flatMap(checkDismissed))
    await change($, now => ({ ...now, detailed: now.detailed.filter(one => one !== id) }))
  }
}

/** Closes an item on a check that passed, with what the check saw as the evidence. */
function closeChecked($: EngineInterface, id: string) {
  return async () => {
    await record($, now => passedOf(now, 'you').filter(event => event.id === id))
    await change($, was => ({ ...was, open: was.open.filter(one => one !== id) }))
  }
}

/** A close for every open item whose check passed: the person's click on one, or the end of a turn for all that are left. */
function passedOf(ledger: Ledger, by: 'you' | 'engine') {
  return ledger.items
    .filter(item => item.status === 'open' && item.check?.state === 'back' && item.check.verdict === 'passed')
    .map(item => ({ type: 'close' as const, id: item.id, how: 'done' as const, by, reason: `A check in the background passed: ${item.check?.text ?? ''}` }))
}

/**
 * Adds items to the prompt box together, each with what is said about it: the answer picked for
 * it, or what Claude is asked to do with it. An item already in the box takes the place of its
 * earlier capture, so a second answer replaces the first.
 */
async function addAll($: EngineInterface, entries: { id: string; say?: string }[]) {
  const [now, book] = await Promise.all([viewOf($), ledgerOf($)])
  const room = Math.max(40, Math.min(96, seen.terminal - 10))
  let draft: { text: string; decorations: Decoration[] } = { text: (await $.prompt.read()).text, decorations: [] }
  const marks: Record<string, string> = {}
  for (const { id, say } of entries) {
    const item = book.items.find(one => one.id === id)
    if (!item) continue
    const { mark, ...next } = draftOf(without(draft.text, now.added[id]), item, room, say)
    draft = next
    marks[id] = mark
  }
  if (Object.keys(marks).length === 0) return
  await $.prompt.fill({ ...draft, mode: 'replace' })
  seen.hasStaged = true
  await change($, was => ({ ...was, added: { ...was.added, ...marks }, open: was.open.filter(one => !(one in marks)) }))
  if (seen.placement !== 'dock') await $.ui.close({ id: PANE })
}

function addToPrompt($: EngineInterface, id: string, say?: string) {
  return () => addAll($, [{ id, say }])
}

/**
 * Follows the prompt box: an item whose capture was deleted from it is open again, as if it had
 * never been added.
 */
async function followPrompt($: EngineInterface, text: string) {
  const waiting = Object.entries((await viewOf($)).added)
  const gone = waiting.filter(([, mark]) => !text.includes(mark)).map(([id]) => id)
  seen.hasStaged = waiting.length > gone.length
  if (gone.length > 0) await change($, was => ({ ...was, added: Object.fromEntries(Object.entries(was.added).filter(([id]) => !gone.includes(id))) }))
}

/** Keeps what the person types into an item's text box, so its Send button knows when there is something to send. */
function setTyped($: EngineInterface, id: string) {
  return (value: string) => {
    void change($, now => ({ ...now, typed: { ...now.typed, [id]: value } }))
  }
}

/** Ticks or unticks one answer of a question that takes several. */
function togglePick($: EngineInterface, id: string, at: number) {
  return () =>
    change($, now => {
      const picks = now.picks[id] ?? []

      return { ...now, picks: { ...now.picks, [id]: picks.includes(at) ? picks.filter(one => one !== at) : [...picks, at].sort() } }
    })
}

/** Adds an item to the prompt box with what its card holds to send. Nothing ticked or typed, nothing added. */
function sendSaid($: EngineInterface, item: Item, lead: string) {
  return async () => {
    const now = await viewOf($)
    const say = sayOf(item, now.picks[item.id] ?? [], now.typed[item.id] ?? '', lead)
    if (say !== '') await addAll($, [{ id: item.id, say }])
  }
}

/** Adds every one of these open questions to the prompt box, each with its recommended answer. */
function takeRecommended($: EngineInterface, questions: Item[]) {
  return async () => {
    const now = await viewOf($)
    const rows = questions.filter(row => row.status === 'open' && !now.added[row.id] && row.options)
    await addAll(
      $,
      rows.map(row => ({ id: row.id, say: `Answer: ${(row.recommended ?? [0]).map(at => row.options?.[at]).join(', ')}` })),
    )
  }
}

/** Adds every open ask of a goal to the prompt box, and asks Claude to work through them. */
function doTheRest($: EngineInterface, block: GoalBlock) {
  return () => {
    const rows = block.open.filter(row => row.kind === 'ask')

    return addAll(
      $,
      rows.map((row, at) => ({ id: row.id, say: at === rows.length - 1 ? `Do the rest of this goal: ${block.goal.title}.` : undefined })),
    )
  }
}

/**
 * Closes an item as done or dropped, sets it aside for later, or brings it back, as the person's
 * own doing. A closed item keeps its row under Closed for a few prompts, and one set aside keeps
 * it under Later.
 */
function setStatus($: EngineInterface, id: string, how: 'done' | 'dropped' | 'later' | 'open') {
  return async () => {
    await record($, () => [how === 'open' ? { type: 'reopen', id } : how === 'later' ? { type: 'later', id, reason: LATER_REASON } : { type: 'close', id, how, by: 'you', reason: BY_YOU[how] }])
    await change($, was => ({
      ...was,
      added: Object.fromEntries(Object.entries(was.added).filter(([one]) => one !== id)),
      open: was.open.filter(one => one !== id),
    }))
  }
}

function copyText($: EngineInterface, text: string, what: string) {
  return async () => {
    const { isCopied } = await $.ui.copy({ text })
    $.ui.toast(isCopied ? `${what} copied` : 'Could not copy')
  }
}

/** A check that ran: a failure opens an item unless one is open for the same command, and a pass closes the ones that are. */
async function followCheck($: EngineInterface, command: string, hasFailed: boolean, output: string) {
  const at = await $.clock.now()
  await record($, now => {
    const open = now.items.filter(item => item.kind === 'check' && item.key === command && item.status === 'open')
    if (hasFailed) return open.length > 0 ? [] : [opened(now, at, 'engine', failedCheck(command, output))]

    return open.map(item => ({ type: 'close', id: item.id, how: 'done', by: 'engine', reason: 'The same check ran again and passed.' }))
  })
}

/**
 * What Claude left running in the background becomes an item: a command, a subagent or a workflow.
 * `task` is what its end is known by, which the notice of that end names.
 */
async function followTask($: EngineInterface, task: string, title: string, why: string) {
  const at = await $.clock.now()
  await record($, now => [
    opened(now, at, 'engine', {
      kind: 'running',
      title: clip(title, 80),
      from: 'Claude started it in the background.',
      why,
      close: 'It ends by itself, or you ask Claude to stop it.',
      key: task,
      selfCloses: 'When the task ends.',
    }),
  ])
}

/**
 * What Claude's subagents did since a read was last told: for each, its tool calls since then and,
 * once it has ended, its report. A report that came back as the notice this turn answers is in the
 * read already and is not told twice. A subagent that has ended is told of once and then forgotten.
 */
async function subagentsDid($: EngineInterface, turn: Sent[]) {
  const notice = turn.map(sent => sent.text).join('\n')
  const parts: string[] = []
  for (const [id, agent] of passes.agents) {
    const { lines, said } = await workOf($, id, agent.calls, agent.report)
    if (lines.length > agent.told || agent.isDone) parts.push(agentPart(agent, lines.slice(agent.told), agent.isDone && !notice.includes(id) ? (agent.report ?? '') : '', said))
    agent.told = lines.length
    if (agent.isDone) passes.agents.delete(id)
  }

  return parts
}

/**
 * A subagent's work: its tool calls as lines, and what it wrote before its report. The calls are
 * in two places, as the main conversation's are: the subagent's own conversation and `calls`, the
 * list this mod kept as they were made. The engine hands over no conversation for a workflow's
 * agent, so the longer of the two is the whole, and what such an agent wrote along the way is not known.
 */
async function workOf($: EngineInterface, id: string, calls: string[], report = '') {
  const rows = await $.session.messages({ agentId: id }).catch(() => [])
  const messages = Array.isArray(rows) ? (rows as Message[]) : []
  // A call still under way has no outcome yet: it and the calls after it are told once it has one.
  const uses = messages.flatMap(message => message.toolUses ?? [])
  const under = uses.findIndex(use => use.text === undefined && use.result === undefined)
  const held = (under < 0 ? uses : uses.slice(0, under)).flatMap(use => toolLine(use, seen.cwd) ?? [])
  const said = messages.flatMap(message => (message.role === 'assistant' && (message.text ?? '').trim() !== '' ? [(message.text ?? '').trim()] : []))

  return { lines: held.length >= calls.length ? held : calls, said: said.at(-1) === report.trim() ? said.slice(0, -1) : said }
}

/**
 * Audits one subagent that has ended: its report against its own tool calls. It opens only what is
 * wrong or was never run, never an ask, and all such audits together open no more than a few items
 * between two prompts of the person's, however many subagents a workflow starts.
 */
async function agentPass($: EngineInterface, id: string, agent: Subagent, calls: string[], report: string) {
  const { lines, said } = await workOf($, id, calls, report)
  if (lines.length === 0 && report.trim() === '') return
  const reply = await ask($, 'agent audit', { model: passes.depth.model, system: AGENT_RULES, prompt: agentAsk(await ledgerOf($), agent, lines, said, report), maxTokens: 1500, effort: 'medium' })
  const found = reply === null ? [] : readAgent(reply)
  if (found.length === 0) return
  const at = await $.clock.now()
  const events = await record($, now => agentEvents(now, found, at, AGENT_OPENS_PER_PROMPT - seen.agentOpened))
  seen.agentOpened += events.length
}

/** A question dialog that ended: the questions it was left with become items, each with its own answers. */
async function followDialog($: EngineInterface, asked: Parameters<typeof leftQuestions>[0], reply: string, isRefused: boolean, dialog: string) {
  const at = await $.clock.now()
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const left = leftQuestions(asked, reply, isRefused, dialog, time)
  await record($, now => {
    const events: Event[] = []
    left.reduce((book, fields) => {
      const event = opened(book, at, 'engine', fields)
      events.push(event)

      return apply(book, event)
    }, now)

    return events
  })
}

/** The end of a turn of the main conversation: one that died on an error opens an item, and the next that ends with a reply closes it. */
async function followTurn($: EngineInterface, reason: string) {
  const at = await $.clock.now()
  await record($, now => {
    const open = now.items.filter(item => item.kind === 'stopped' && item.status === 'open')
    if (reason === 'answer') return open.map(item => ({ type: 'close', id: item.id, how: 'done', by: 'engine', reason: 'The next turn ended with a reply.' }))
    if (reason !== 'error' || open.length > 0) return []

    return [
      opened(now, at, 'engine', {
        kind: 'stopped',
        title: 'The last turn stopped on an error',
        from: 'Claude Code itself: the turn ended on an API error after its retries.',
        why: 'The work halted outside the conversation. Nothing more happens until a prompt goes through.',
        close: 'Send any message to pick the work back up. If it stops again, check your sign-in and usage with /status.',
        selfCloses: 'When the next turn ends with a reply.',
      }),
    ]
  })
}

/**
 * Starts a model pass after the ones before it, on a timer of its own: a call made inside a hook
 * is cut when that hook's work is over, and a pass outlives the hook that asked for it.
 */
function queued($: EngineInterface, pass: () => Promise<void>) {
  $.clock.after(1, () => {
    passes.queue = passes.queue.then(pass).catch((error: unknown) => {
      $.ui.log(`inbox: a pass did not finish: ${String(error).slice(0, 120)}`)
    })
  })
}

/** One call of a model, logged whole: what it was asked, what it said, what it cost and how long it took. */
async function ask($: EngineInterface, pass: string, request: { model: string; system: string; prompt: string; maxTokens: number; effort: 'low' | 'medium' }) {
  const started = await $.clock.now()
  const reply = await $.model.complete({ ...request, timeoutMs: 90_000 })
  void note($, pass, {
    model: request.model,
    prompt: request.prompt,
    reply: reply.isAnswered ? reply.text : null,
    ...(reply.isAnswered ? {} : { failed: reply.reason }),
    usage: reply.usage,
    ms: (await $.clock.now()) - started,
  })

  return reply.isAnswered ? reply.text : null
}

/** Reads the person's message for what it asks and what it answers. It runs while Claude works on the same message. */
async function promptPass($: EngineInterface, message: string, sent: Sent, lastReply: string) {
  if (message.trim() === '') return
  const reply = await ask($, 'prompt pass', { model: passes.depth.model, system: PROMPT_RULES, prompt: promptAsk(await ledgerOf($), message, lastReply), maxTokens: 3000, effort: 'low' })
  const said = reply === null ? null : readPrompt(await ledgerOf($), reply)
  // The read of a prompt can come back after the person has taken the prompt back.
  if (!said || sent.isTakenBack) return
  const at = await $.clock.now()
  await record($, now => {
    const made = promptEvents(now, said, at)
    sent.asked = made.asked

    return made.events
  })
  // Added to the list the turn's audit job already holds, so that a read that ends after the turn does still counts.
  sent.answered.push(...said.answers.map(answer => answer.id))
  await keepTurn($)
}

/**
 * Audits the exchange that just ended: what got done, what the reply skipped, and what it leaves
 * open. An item the audit cannot judge from one exchange is put to a fork of the main conversation,
 * which reads all of it from the prompt cache while that is still warm.
 */
async function replyPass($: EngineInterface, answer: string, turn: Pending['turn'], did: string[], beside: Beside) {
  const book = await ledgerOf($)
  if (answer.trim() === '') return
  const asked = turn.flatMap(sent => sent.asked)
  const message = turn.map(sent => sent.text)
  const isNotice = turn.length > 0 && turn.every(sent => sent.isNotice)
  const request = { model: passes.depth.model, system: REPLY_RULES, prompt: replyAsk(book, asked, message, isNotice, did, answer, beside), maxTokens: 3000, effort: 'medium' as const }
  // Asked once more when the call fails: an audit that never answers leaves what Claude closed in the turn unread for good.
  const reply = (await ask($, 'reply audit', request)) ?? (await ask($, 'reply audit', request))
  const said = reply === null ? null : readReply(book, reply, beside.turnId)
  if (!said) return
  const at = await $.clock.now()
  // Read when the audit is back: the read of a message that reached the turn late may have ended meanwhile.
  const heard = turn.every(sent => sent.answered !== undefined) ? turn.flatMap(sent => sent.answered ?? []) : undefined
  await record($, now => replyEvents(now, said, at, { book, heard, isCut: beside.isCut }))
  // A turn that was cut short is read for what Claude closed in it, and for nothing else.
  if (beside.isCut) return
  for (const doubt of said.unsure) {
    const item = book.items.find(one => one.id === doubt.id)
    if (!item) continue
    const forked = await $.model.fork({ prompt: forkAsk(item, doubt.question) })
    const found = forked.isAnswered ? readFork(forked.text) : null
    void note($, 'fork', { id: item.id, question: doubt.question, reply: forked.isAnswered ? forked.text : null, ...(forked.isAnswered ? {} : { failed: forked.reason }), usage: 'usage' in forked ? forked.usage : null })
    if (found?.isDone) await record($, now => (now.items.some(one => one.id === item.id && one.status === 'open') ? [{ type: 'close', id: item.id, how: 'done', by: 'audit', reason: `${BY_REPLY}${found.reason}` }] : []))
  }
}

/** Starts the audit of a reply. It stays in the session's state until it has run, whether or not the model answered. */
function audit($: EngineInterface, job: Pending) {
  passes.audits.add(job.id)
  queued($, async () => {
    try {
      // An audit that a build before this one left in the state has no list of its own.
      await replyPass($, job.answer, job.turn, job.did ?? didLines((await $.session.messages()) as Message[], undefined, seen.cwd), { said: job.said, agents: job.agents, todo: job.todo, turnId: job.id, isCut: job.isCut })
    } finally {
      passes.audits.delete(job.id)
      await update($, pendingAtom, left => (left?.id === job.id ? null : left))
    }
  })
}

export const register: Register = (on, options) => {
  passes.depth = readAt(options.depth)

  on('session.start', async ($, e, next) => {
    seen.cwd = e.cwd
    await restore($)
    await takeUpTurn($)
    // An audit still in the state was cut off by a reload of the mod, unless this load of it is the one running it.
    const left = await read($, pendingAtom)
    if (left && !passes.audits.has(left.id)) audit($, left)
    await $.command.register({ name: 'inbox', description: 'Show or hide the inbox panel' })
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    // A new session's prompt box is empty, whatever the last one held.
    await change($, now => ({ ...now, added: {} }))
    // A look whose agent is gone can never come back: Claude Code was closed while it ran. A reload
    // of the mod alone leaves the agent running, and its look with it.
    // Where the agents cannot be listed, every look is left running: ending a live one is worse than leaving a dead one.
    const listed = await $.agent.list().catch(() => null)
    const alive = new Set((listed ?? []).map(agent => agent.id))
    for (const item of listed ? (await ledgerOf($)).items : []) {
      const agent = item.check?.state === 'running' ? item.check.agent : undefined
      if (agent !== undefined && !alive.has(agent)) await endCheck($, item.id, agent, '', 'Claude Code was closed while the check was running.')
    }

    return next(e)
  })

  on('command.run', { command: 'inbox' }, async ($, e) => {
    seen.terminal = e.presentation.columns
    seen.isFullscreen = e.presentation.isFullscreen
    const wasOpen = (await viewOf($)).isPanelOpen
    await togglePanel($)()

    return { text: wasOpen ? 'Inbox hidden.' : 'Inbox opened.' }
  })

  // Sending a prompt closes nothing. An item whose capture went out with it is marked as sent, with
  // what was said under it, and stays open until the reply is read.
  on('prompt.submit', async ($, e, next) => {
    // A background task's notice of its end names the task, which closes the item that followed it.
    if (e.origin.kind === 'task-notification') {
      await record($, now => now.items.filter(item => item.kind === 'running' && item.status === 'open' && item.key !== undefined && e.text.includes(item.key)).map(item => ({ type: 'close', id: item.id, how: 'done', by: 'engine', reason: 'The task ended.' })))
    }
    if (e.origin.kind !== 'composer') {
      // A notice that starts a turn of its own is what that turn's reply answers.
      if (e.turnId === undefined) {
        passes.waiting.push({ text: e.text, isNotice: true, asked: [], answered: [] })
        await keepTurn($)
      }

      return next(e)
    }
    await followRewind($)
    const added = (await viewOf($)).added
    const before = { ledger: await ledgerOf($), turns: await $.session.turns(), added }
    const { sent, rest } = sentOf(e.text, added)
    await record($, () => [{ type: 'turn' }, ...sent.map(one => ({ type: 'patch' as const, id: one.id, patch: { sent: one.said || 'Sent with no note.' }, drop: ['isUnsettled' as const] }))])
    await change($, now => ({ ...now, added: {} }))
    Object.assign(seen, { hasStaged: false, recorded: 0, agentOpened: 0 })
    const submitted: Sent = { text: e.text, isNotice: false, asked: [], answered: sent.map(one => one.id), before }
    passes.waiting.push(submitted)
    await keepTurn($)
    // Read now, before Claude starts on this message: what the message answers is the reply before it.
    const lastReply = lastReplyOf((await $.session.messages()) as Message[])
    queued($, () => promptPass($, rest, submitted, lastReply))

    return next(e)
  })

  // Each edit of the prompt box is checked against the items waiting in it, without holding the key up.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (seen.hasStaged && box.text !== e.text) void followPrompt($, box.text)

    return box
  })

  // What an agent of the mod's hands back is taken here and goes no further. Left alone it would
  // land in the conversation as a message, and Claude would take a turn to answer it.
  // The tool an agent hands its report back with is the engine's own and not among the typed ones,
  // so one hook sees every tool call of the mod's agents and tells that tool apart by name.
  on('tool.call', async ($, e, next) => {
    const agent = (e as { agentId?: string }).agentId
    if (agent === undefined) {
      // A call of Claude's own: kept for the reply's read, with how it ended. The inbox tool is
      // answered by a hook of this mod, whose answer has no `text` and is its `result`.
      const answer = await next(e)
      const said = answer as { text?: unknown; deny?: unknown; result?: unknown }
      const line = toolLine(useOf(e as unknown as Record<string, unknown>, String(said.text ?? said.deny ?? (typeof said.result === 'string' ? said.result : ''))), seen.cwd)
      if (line !== null) passes.did.push(line)

      return answer
    }
    const item = (await ledgerOf($)).items.find(one => one.check?.state === 'running' && one.check.agent === agent)
    // An agent is the mod's while a look of its is running, and stays so once the look has ended or was stopped.
    if (!item && !(await viewOf($)).agents.includes(agent)) {
      // A call of a subagent of Claude's: kept for the reply's read, as Claude's own are. The engine
      // hands over no conversation for a workflow's agent, so this list is all there is of its calls.
      const answer = await next(e)
      const said = answer as { text?: unknown; deny?: unknown }
      const line = toolLine(useOf(e as unknown as Record<string, unknown>, String(said.text ?? said.deny ?? '')), seen.cwd)
      if (line !== null) passes.agents.get(agent)?.calls.push(line)

      return answer
    }
    if ((e.tool as string) === HAND_BACK) {
      if (item) await endCheck($, item.id, agent, String((e as { message?: unknown }).message ?? ''))
      const told = item ? RECEIVED : STOPPED

      return { result: { success: true, message: told }, text: told } as unknown as Awaited<ReturnType<typeof next>>
    }
    // Every other tool: an agent whose look was stopped is refused, so that it ends, and what a
    // running one does is kept for the person who asks how the answer was found.
    if (!item) return { deny: STOPPED }
    const answer = await next(e)
    const line = ranLine(e.tool, e as unknown as Record<string, unknown>, String((answer as { text?: unknown }).text ?? ''))
    void record($, now => now.items.filter(one => one.id === item.id && one.check?.state === 'running').map(one => ({ type: 'patch' as const, id: one.id, patch: { check: withRan(one.check as Check, line) } })))

    return answer
  })

  // The checker is the mod's to start and never Claude's. Kept out of what Claude is offered, it
  // adds no agent to Claude's list and no notice of a new agent type to the conversation.
  on('agent.offer', { agent: AGENT_TYPE }, async () => ({ isOffered: false }))

  // A look is started here, from a hook on the press, and not from the button's own handler. An
  // agent started from a handler is the mod's own doing with no hook above it, and the engine then
  // runs none of the mod's hooks on what that agent does: its report would pass the hook above and
  // land in the conversation. Started inside this hook, what the agent does reaches that hook.
  on('ui.press', { plugin: 'inbox' }, async ($, e, next) => {
    const id = /^(?:check|look|again)-(i\d+)$/.exec(e.element)?.[1]
    if (e.requestId !== PANE || id === undefined) return next(e)
    await startCheck($, id)

    return { element: e.element }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const answer = await next(e)
    // A command an agent of the mod's runs to check something is not the conversation's: its failing test is no item.
    const agent = (e as { agentId?: string }).agentId
    if (agent !== undefined && (await viewOf($)).agents.includes(agent)) return answer
    const check = checkOf(e.command)
    const said = answer as { isError?: boolean; text?: string; deny?: string; result?: { interrupted?: boolean; backgroundTaskId?: string } }
    const task = said.result?.backgroundTaskId
    if (task) void followTask($, task, e.description || e.command, `It runs: ${clip(e.command, 300)}`)
    else if (check && said.deny === undefined && !said.result?.interrupted) void followCheck($, check, said.isError === true, said.text ?? '')

    return answer
  })

  // A subagent of Claude's is kept by its id, so that a read can be told what it did, and one left
  // running in the background is listed as running until it ends. The mod's own checker is not Claude's.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined || e.subagentType === AGENT_TYPE) return started
    const name = e.description || e.subagentType
    passes.agents.set(started.agentId, { name, type: e.subagentType, isBackground: e.background, isInWorkflow: e.workflow !== undefined, isDone: false, task: e.prompt, told: 0, calls: [] })
    // A workflow's agents are listed as one task, the workflow, and a teammate idles and never ends.
    if (e.background && e.workflow === undefined && e.parentAgentId === undefined && e.isTeammate !== true) void followTask($, started.agentId, name, `A subagent that was told: ${clip(e.prompt, 300)}`)

    return started
  })

  // A workflow runs in the background from the start, and the notice of its end names its task.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const answer = await next(e)
    const run = (answer as { result?: { taskId?: string; workflowName?: string; summary?: string; error?: string } }).result
    if ((e as { agentId?: string }).agentId === undefined && run?.taskId && !run.error) void followTask($, run.taskId, `Workflow: ${run.workflowName ?? 'a script'}`, run.summary || 'A script of Claude\'s that hands the work to several subagents.')

    return answer
  })

  // A background task stopped by hand sends no notice of its end, so the stop closes the item that followed it.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const answer = await next(e)
    const task = e.task_id ?? e.shell_id
    if (task !== undefined) {
      void record($, now => now.items.filter(item => item.kind === 'running' && item.status === 'open' && item.key === task).map(item => ({ type: 'close', id: item.id, how: 'done', by: 'engine', reason: 'The task was stopped.' })))
    }

    return answer
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const answer = await next(e)
    const said = answer as { isError?: boolean; text?: string; deny?: string }
    void followDialog($, e.questions, said.text ?? said.deny ?? '', said.isError === true || said.deny !== undefined, e.tool_use_id ?? 'dialog')

    return answer
  })

  on('tool.call', { tool: 'mcp__inbox__inbox' }, async ($, e) => {
    const at = await $.clock.now()
    let text = ''
    const events = await record($, now => {
      const answer = answerTool(now, e as Parameters<typeof answerTool>[1], at, seen.recorded, passes.turnId === undefined ? undefined : { id: passes.turnId, heard: passes.turn?.length ?? 0, unheard: passes.waiting.flatMap(sent => sent.answered) })
      text = answer.text

      return answer.events
    })
    if (events.some(event => event.type === 'open')) seen.recorded += 1
    void note($, 'tool', { call: e, text })

    return { result: text }
  })

  // A turn answers what was submitted up to the message it starts with. What the person typed after
  // that, while Claude was still working, waits: for the running turn to take it in, or for a turn of its own.
  on('turn.start', async ($, e, next) => {
    // An agent's turn is not the conversation's, and answers nothing the person sent.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    passes.did = []
    passes.turnId = e.turnId
    const at = passes.waiting.findIndex(sent => sent.text === e.text)
    passes.turn = passes.waiting.splice(0, at >= 0 ? at + 1 : e.text === '' ? 0 : passes.waiting.length)
    await keepTurn($)

    return next(e)
  })

  // A message typed while Claude works is handed to it inside the running turn, when that turn is
  // still calling tools. The turn then answers that message too, and no turn starts for it. One row
  // hands over one message, and they are handed over in the order they were typed: the row is the
  // first waiting message whose words it holds, so of two alike only one leaves.
  on('session.append', { door: 'delivery' }, async ($, e, next) => {
    const turn = passes.turn
    if (e.agentId !== undefined || e.message.name !== 'queued_command' || !turn) return next(e)
    const told = e.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
    const at = passes.waiting.findIndex(sent => !sent.isNotice && sent.text !== '' && told.includes(sent.text))
    if (at >= 0) {
      turn.push(...passes.waiting.splice(at, 1))
      await keepTurn($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // The end of an agent's turn is the end of its look, when it has one still running: an agent
      // that never handed anything back said what it found in its last words.
      const agent = e.agentId
      const item = (await ledgerOf($)).items.find(one => one.check?.state === 'running' && one.check.agent === agent)
      if (item) await endCheck($, item.id, agent, e.answer)
      // A subagent of Claude's that ended: its last words are its report, and the item that listed it as running closes.
      const helper = passes.agents.get(agent)
      if (helper) {
        // Audited once, at the end of its first run: a subagent sent a further message runs again.
        if (passes.depth.isAuditingAgents && !helper.isDone) queued($, () => agentPass($, agent, { ...helper }, [...helper.calls], e.answer))
        Object.assign(helper, { isDone: true, report: e.answer })
        await record($, now => now.items.filter(one => one.kind === 'running' && one.status === 'open' && one.key === agent).map(one => ({ type: 'close', id: one.id, how: 'done', by: 'engine', reason: 'The subagent ended.' })))
      }

      return next(e)
    }
    const turn = passes.turn ?? passes.waiting.splice(0)
    passes.turn = null
    passes.turnId = undefined
    await keepTurn($)
    // A prompt cancelled before Claude wrote anything goes back in the prompt box, and Claude Code
    // takes it out of the conversation: its count of turns is what it was when the prompt was sent.
    // Then the inbox is put back too. A turn stopped later stays in the conversation, and so does
    // what the inbox made of it.
    const [only] = turn
    const taken = turn.length === 1 && e.isAborted ? only?.before : undefined
    if (only !== undefined && taken !== undefined && (await $.session.turns()) === taken.turns) {
      only.isTakenBack = true
      await record($, () => [{ type: 'retract', to: taken.ledger }])
      await change($, now => ({ ...now, added: taken.added }))
      seen.hasStaged = Object.keys(taken.added).length > 0

      return next(e)
    }
    void followTurn($, e.reason)
    // A check that passed and that the person did not close is closed with the turn.
    await record($, now => passedOf(now, 'engine'))
    // A turn that ended without a reply settles nothing, so it is audited only when Claude closed
    // something in it on its own word: that close has had no other read.
    const isCut = e.reason !== 'answer'
    if (!isCut || closedByClaude(await ledgerOf($), e.turnId).length > 0) {
      // The turn's tool calls are in two places, and either can have lost some: the conversation to
      // a compaction, the mod's own list to a reload of the mod. Neither gains any, so the longer is
      // the whole. Read here and not when the audit runs, by when a new prompt may have been sent.
      const messages = (await $.session.messages()) as Message[]
      const told = toolLines(messages, seen.cwd)
      const did = newest(passes.did.length >= told.length ? passes.did : told)
      const answer = isCut ? `${e.answer}\n\n${CUT_SHORT}`.trim() : e.answer
      const job = { id: e.turnId, answer, turn: turn.map(({ text, isNotice, asked, answered }) => ({ text, isNotice, asked, answered })), did, said: saidOf(messages, e.answer), agents: await subagentsDid($, turn), todo: todoOf(messages), ...(isCut ? { isCut } : {}) }
      await update($, pendingAtom, () => job)
      audit($, job)
    }
    // Last, and never in the way of the audit: a mark that is not written only costs a fork its inbox.
    try {
      await mark($)
    } catch (error) {
      $.ui.log(`inbox: the turn's mark was not written: ${String(error).slice(0, 120)}`)
    }

    return next(e)
  })

  // Made for the mouse: a click presses, and the keyboard's focus ring lands only in a text box.
  on('ui.focus', { plugin: 'inbox' }, async ($, e, next) => (e.requestId === PANE && e.origin.kind === 'person' && !e.element?.startsWith('input-') ? {} : next(e)))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await change($, now => ({ ...now, isPanelOpen: false }))

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    noteViewport(e.viewport, await viewOf($))

    return next(e)
  })

  // The handle is the one way in and out: a small box that is always there, at the right end of the
  // status row, with the number of open items and an arrow toward where the panel lands: sideways
  // where it docks at the right, upward where it lands above the prompt.
  // The handle goes after whatever is drawn there already, the mode labels and what another mod adds.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [now, book, beneath] = await Promise.all([viewOf($), ledgerOf($), next(e)])
    noteViewport(e.viewport, now)
    const { Box, Text } = $.ui.resolve(e)
    const arrow = docks() ? (now.isPanelOpen ? '▸' : '◂') : now.isPanelOpen ? '▾' : '▴'

    return (
      <Box>
        {beneath}
        {e.props.modes.length > 0 && <Text> </Text>}
        {handleOf($, $.ui.resolve(e), now, book, arrow)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Link, Text } = ui
    // A surface with no text box of its own gets the answer buttons alone.
    const Input = 'Input' in ui ? ui.Input : undefined
    const [now, book, clock] = await Promise.all([viewOf($), ledgerOf($), $.clock.now()])
    const isDock = e.props.placement === 'dock'
    const height = e.props.scroll.bodyRows
    Object.assign(seen, { bodyColumns: e.props.bodyColumns, placement: e.props.placement })
    const width = e.props.bodyColumns
    const sections = sectionsOf(book)
    const openIn = (section: Section) => section.groups.flatMap(group => group.rows.filter(row => row.status === 'open'))
    const layout = layoutOf(book)
    const opened = book.items.filter(item => item.status === 'open')
    const isFolded = (key: string) => now.folded.includes(key)

    const pillOf = (text: string, color: Color) => (
      <Text backgroundColor={color} color="inverseText" bold>
        {' '}
        {text}{' '}
      </Text>
    )

    // Too narrow for a title: the counts alone, each on its section's color, and how to get more.
    if (width < MIN_COLUMNS) {
      return (
        <Box flexDirection="column" width={width} minHeight={isDock ? height : undefined}>
          <Text bold color="suggestion">
            {clip('Inbox', width)}
          </Text>
          {sections.map(section => (
            <Box flexDirection="row" marginTop={1}>
              {pillOf(String(openIn(section).length), ACCENT[section.key])}
              {width >= 14 && <Text> {clip(width >= 18 ? SECTION_NAME[section.key] : SHORT[section.key], width - 5)}</Text>}
            </Box>
          ))}
          <Box flexGrow={1} minHeight={1} />
          {wrapped(width >= 14 ? 'Drag this edge left for the items' : 'Drag left', width).map(line => (
            <Text color="inactive" italic>
              {line}
            </Text>
          ))}
        </Box>
      )
    }

    /** A button that says what it does: filled for the main action of a card, quiet for the rest. */
    const buttonOf = (key: string, label: string, onPress: () => unknown, isMain = false) => (
      <Button key={key} label={label} plain onPress={onPress}>
        <Text backgroundColor={isMain ? 'suggestion' : 'selectionBg'} {...(isMain ? { color: 'inverseText', bold: true } : {})}>
          {' '}
          {label}{' '}
        </Text>
      </Button>
    )

    // What a model wrote is drawn as Markdown, so that its lists read as lists and its commands and
    // paths as code. A surface without Markdown gets the same words as plain lines.
    const Markdown = 'Markdown' in ui ? ui.Markdown : undefined
    const proseOf = (text: string, room: number) =>
      Markdown ? (
        <Box width={room}>
          <Markdown text={text} />
        </Box>
      ) : (
        <Box flexDirection="column">
          {text.split('\n').flatMap(line => wrapped(line, room).map(part => <Text>{part}</Text>))}
        </Box>
      )

    const fieldOf = (label: string, text: string, color: Color, indent = 0) => (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color}>{label}</Text>
        {proseOf(text, width - 5 - indent)}
      </Box>
    )

    // One answer to a question: a button of its own, numbered as Claude's question dialog numbers
    // them, the recommended one marked. A click adds the item and the answer to the prompt. On a
    // question that takes several, a click ticks the answer, and Send carries the ticked ones.
    const answerOf = (row: Item, at: number, label: string) => {
      const isTicked = (now.picks[row.id] ?? []).includes(at)
      const isRecommended = (row.recommended ?? [0]).includes(at)
      const shown = row.isMulti ? `${isTicked ? '[✓]' : '[ ]'} ${label}` : `${at + 1}. ${label}`
      // "Recommended" stands beside a short answer. Beside a long one it would be squeezed into a
      // column a few cells wide, so there it goes on a row of its own under the answer.
      const isBeside = shown.length + ' Recommended'.length + 2 <= width - 5

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {row.isMulti ? buttonOf(`answer-${row.id}-${at}`, shown, togglePick($, row.id, at), isTicked) : buttonOf(`answer-${row.id}-${at}`, shown, addToPrompt($, row.id, `Answer: ${label}`), isRecommended)}
            {isRecommended && isBeside && <Text color="inactive"> Recommended</Text>}
          </Box>
          {isRecommended && !isBeside && <Text color="inactive">    Recommended</Text>}
        </Box>
      )
    }

    // A text box for what only the person can say, with a Send button that works once something is
    // typed or ticked.
    const typedOf = (row: Item, hint: string, lead: string) => {
      const typed = (now.typed[row.id] ?? '').trim()
      const isReady = sayOf(row, now.picks[row.id] ?? [], typed, lead) !== ''
      // Claude Code's text box is one line and cuts a longer answer short, so an answer that does
      // not fit is also shown whole under the box, where it can be read before it is sent. The box
      // names no key for sending: that hint wraps to a second row once the text is long.
      const whole = typed.length > width - 10 ? wrapped(typed, width - 5) : []

      return (
        <Box flexDirection="column">
          {Input && (
            <Box borderStyle="round" borderColor={typed === '' ? 'subtle' : 'suggestion'} paddingX={1}>
              <Input key={`input-${row.id}`} placeholder={hint} value={now.typed[row.id] ?? ''} submitLabel=" " onInput={setTyped($, row.id)} onSubmit={sendSaid($, row, lead)} />
            </Box>
          )}
          {whole.map(line => (
            <Text color="inactive"> {line}</Text>
          ))}
          <Box flexDirection="row">
            {isReady ? buttonOf(`send-${row.id}`, 'Send', sendSaid($, row, lead), true) : <Text color="subtle"> Send </Text>}
            <Text> </Text>
            {buttonOf(`done-${row.id}`, 'Done', setStatus($, row.id, 'done'))}
            <Text> </Text>
            {buttonOf(`drop-${row.id}`, 'Drop', setStatus($, row.id, 'dropped'))}
            <Text> </Text>
            {buttonOf(`later-${row.id}`, 'Later', setStatus($, row.id, 'later'))}
          </Box>
        </Box>
      )
    }

    // An item opened in place: everything known about it, then what can be done with it, each named.
    // One that is closed or set aside shows the same, led by how that came about, with a way back.
    const cardOf = (row: Item, indent = 0) => {
      const color = LOOK[row.kind].color
      const how = row.status === 'open' ? undefined : row.status
      const isTyped = Boolean(row.options) || Boolean(row.ask)
      const check = how ? undefined : row.check
      // A check that came back with a verdict has its own button to the prompt box, which takes the place of the usual ones.
      const intents = INTENTS[row.kind].filter(() => !row.command && !row.draft && !row.isLook && !check?.verdict)
      const outcome = check?.state === 'back' && check.verdict ? VERDICT[check.verdict] : undefined
      const isStale = check?.state === 'back' && clock - check.at >= ASK_AGAIN_AFTER
      const ran = check?.ran ?? []
      // The steps are counted apart from the list of them, which keeps only the newest.
      const steps = check ? stepsOf(check) : 0
      const hasMain = isTyped || intents.length > 0 || Boolean(row.command) || Boolean(row.draft) || Boolean(row.isLook) || Boolean(check) || canCheck(row)
      const field = (label: string, text: string) => fieldOf(label, text, color, indent)
      const goal = book.goals.find(one => one.id === row.goal)

      return (
        <Box flexDirection="column" paddingLeft={3 + indent} paddingRight={1} paddingBottom={1}>
          <Text color={how === 'done' ? 'success' : how === 'later' ? ACCENT.later : how === 'dropped' ? 'inactive' : color}>{clip(`${nameOf(row)}${goal ? ` · ${goal.title}` : ''}`, width - 5 - indent)}</Text>
          {how && field(how === 'done' ? 'Done' : how === 'dropped' ? 'Dropped' : 'Later', row.reason ?? '')}
          {!how && now.added[row.id] && field('In your prompt', `It waits in the prompt box. Delete it there and it is open again.${row.options ? ' Pick another answer and it takes the place of this one.' : ''}`)}
          {!how && row.isRewound && field('From a part you rewound', 'You rewound the conversation to before the prompt this came from, so Claude no longer has that exchange. The item is kept as it was. Drop it if the rewind made it moot.')}
          {!how && row.isUnsettled && field('Not settled', 'You sent this, and the reply did not act on it.')}
          {!how && row.sent && !row.isUnsettled && field('Sent', `It went out with your last message: ${row.sent.split('\n').join(' ')} It stays open until the reply is read.`)}
          {row.why !== '' && field('Why', row.why)}
          {field('From', row.from)}
          {field('To close', row.close)}
          {!how && row.selfCloses && field('Closes by itself', row.selfCloses)}
          {!how && row.file && (
            <Box marginTop={1}>
              <Link href={`file://${row.file}`}>{clip(`Open ${row.file.split('/').slice(-2).join('/')}`, width - 6)}</Link>
            </Box>
          )}
          {!how && row.link && (
            <Box marginTop={1}>
              <Link href={row.link}>{clip(row.link, width - 6)}</Link>
            </Box>
          )}
          {!how && row.command && (
            <Box flexDirection="column" marginTop={1}>
              <Text backgroundColor="composerSidebarBackground"> {clip(row.command, width - 8)} </Text>
              <Box flexDirection="row" marginTop={1}>
                {buttonOf(`copy-${row.id}`, 'Copy command', copyText($, row.command, 'Command'))}
                <Text> </Text>
                {row.kind !== 'stopped' && buttonOf(`run-${row.id}`, 'Run it for me', addToPrompt($, row.id, `Run this for me and tell me what it printed: ${row.command}`), true)}
              </Box>
            </Box>
          )}
          {!how && row.draft && <Box marginTop={1}>{buttonOf(`draft-${row.id}`, 'Copy the request I drafted', copyText($, row.draft, 'Draft'), true)}</Box>}
          {!how && row.isLook && (
            <Box flexDirection="row" marginTop={1}>
              {buttonOf(`right-${row.id}`, 'Looks right', setStatus($, row.id, 'done'), true)}
              <Text> </Text>
              {buttonOf(`wrong-${row.id}`, 'Looks wrong', addToPrompt($, row.id, 'What looks wrong: '))}
            </Box>
          )}
          {!how && row.options && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={color}>{row.isMulti ? 'Answer, tick any' : 'Answer'}</Text>
              {row.options.map((option, at) => answerOf(row, at, option))}
              <Text> {row.isMulti ? 'Something else' : `${row.options.length + 1}. Something else`}</Text>
              {typedOf(row, row.isMulti ? 'Add your own' : 'Type your own answer', 'Answer: ')}
            </Box>
          )}
          {!how && !row.options && row.ask && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={color}>{row.ask.replace(/: $/, '')}</Text>
              {typedOf(row, 'Type it here', row.ask)}
            </Box>
          )}
          {!how && intents.length > 0 && (
            <Box flexDirection="row" marginTop={1}>
              {intents.map((intent, at) => (
                <Box marginRight={1}>{buttonOf(`intent-${row.id}-${at}`, intent.label, addToPrompt($, row.id, intent.say), at === 0 && !isTyped)}</Box>
              ))}
            </Box>
          )}
          {/* A look in the background: asked for, running, or back with what it found and when. */}
          {!how && !check && canCheck(row) && <Box marginTop={1}>{buttonOf(`look-${row.id}`, wordsOf(row).ask, ignore, true)}</Box>}
          {check?.state === 'running' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="suggestion">
                ◌ Checking since {clockOf(check.at)}
                {steps > 0 ? ` · ${steps} ${steps === 1 ? 'step' : 'steps'} so far` : ''}
              </Text>
              {/* What the agent did last, so that a long look is seen to be moving. It runs until its agent ends or the person stops it. */}
              {ran.length > 0 && <Text color="inactive">{clip(ran.at(-1) ?? '', width - 5 - indent)}</Text>}
              <Box flexDirection="row" marginTop={1}>
                {buttonOf(`stop-${row.id}`, 'Stop', stopCheck($, row.id))}
                <Text> </Text>
                {buttonOf(`take-${row.id}`, 'Add to prompt', stopCheck($, row.id, true))}
              </Box>
            </Box>
          )}
          {check?.state === 'back' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={outcome ? outcome.color : 'success'}>
                {outcome ? outcome.head : wordsOf(row).back} {clockOf(check.at)}
              </Text>
              {proseOf(check.text ?? '', width - 5 - indent)}
              <Box flexDirection="row" marginTop={1}>
                {check.verdict === 'passed' && buttonOf(`close-${row.id}`, 'Close', closeChecked($, row.id), true)}
                {check.verdict === 'failed' && buttonOf(`fix-${row.id}`, 'Fix it', addToPrompt($, row.id, sayOfCheck(check)), true)}
                {check.verdict === 'unclear' && buttonOf(`mine-${row.id}`, 'Add to prompt', addToPrompt($, row.id, sayOfCheck(check)), true)}
                {check.verdict && <Text> </Text>}
                {isStale && buttonOf(`again-${row.id}`, wordsOf(row).again, ignore, !check.verdict)}
                {isStale && <Text> </Text>}
                {buttonOf(`dismiss-${row.id}`, 'Dismiss', dismissCheck($, row.id))}
                {ran.length > 0 && <Text> </Text>}
                {ran.length > 0 && buttonOf(`details-${row.id}`, 'Details', toggleDetails($, row.id))}
              </Box>
              {now.detailed.includes(row.id) && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="inactive">{steps > ran.length ? `${steps} steps, the last ${ran.length} shown` : `${steps} ${steps === 1 ? 'step' : 'steps'}`}</Text>
                  {ran.map(line => (
                    <Text color="inactive">{clip(line, width - 5 - indent)}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {how && (
            <Box flexDirection="row" marginTop={1}>
              {buttonOf(`later-${row.id}`, 'Reopen', setStatus($, row.id, 'open'), true)}
              <Text> </Text>
              {buttonOf(`add-${row.id}`, 'Add to prompt', addToPrompt($, row.id))}
            </Box>
          )}
          {!how && !isTyped && (
            <Box flexDirection="row" marginTop={1}>
              {buttonOf(`add-${row.id}`, 'Add to prompt', addToPrompt($, row.id), !hasMain)}
              <Text> </Text>
              {buttonOf(`done-${row.id}`, 'Done', setStatus($, row.id, 'done'))}
              <Text> </Text>
              {buttonOf(`drop-${row.id}`, 'Drop', setStatus($, row.id, 'dropped'))}
              <Text> </Text>
              {buttonOf(`later-${row.id}`, 'Later', setStatus($, row.id, 'later'))}
            </Box>
          )}
        </Box>
      )
    }

    // A button that shows over the end of a row while the pointer is on it, for the one thing most often done to it.
    const quickOf = (row: Item, label: string, onPress: () => unknown) => (
      <Box position="absolute" right={0} top={0} display="none" hover={{ display: 'flex', scope: row.id }} backgroundColor="userMessageBackgroundHover">
        <Text> </Text>
        {buttonOf(`quick-${row.id}`, label, onPress)}
      </Box>
    )

    // An item's row, open or closed: a click opens its card in place, and a second click shuts it.
    // Its mark and its color say what kind of item it is, so that no heading has to. The tag at its
    // end says only what its place does not: where an answer or a look stands, or how long it has
    // waited on the person. `indent` sets a finished goal's items in under the goal.
    const rowOf = (row: Item, indent = 0) => {
      const look = LOOK[row.kind]
      const isOpen = now.open.includes(row.id)
      const how = row.status === 'open' ? undefined : row.status
      const isAdded = !how && Boolean(now.added[row.id])
      const isSent = !how && !isAdded && Boolean(row.sent) && !row.isUnsettled
      const isMissed = !how && !isAdded && !isSent && (row.isUnsettled === true || row.isMissed === true)
      const check = how ? undefined : row.check
      const outcome = check?.state === 'back' && check.verdict ? VERDICT[check.verdict] : undefined
      // The button for a look stands at the row's end until one is asked for, and again once what came back is old.
      const isAsking = !how && !isAdded && !isSent && !isOpen && canCheck(row)
      const quick = !isAsking ? '' : !check ? wordsOf(row).ask : check.state === 'back' && clock - check.at >= ASK_AGAIN_AFTER ? wordsOf(row).again : ''
      const tag =
        how ??
        (isAdded
          ? 'in prompt'
          : isSent
            ? 'sent'
            : row.isUnsettled
              ? 'not settled'
              : row.isMissed
                ? 'missed'
                : check?.state === 'running'
                  ? 'checking'
                  : outcome
                    ? outcome.tag
                    : check
                      ? `as of ${clockOf(check.at)}`
                      : needsYou(row) || row.kind === 'running'
                        ? ageOf(row.at, clock)
                        : '')
      // A closed or set-aside row has a dimmed title, so its tag takes a color of its own and never reads as more of the title.
      const tagColor: Color = isMissed ? 'error' : isAdded || how === 'done' ? 'success' : isSent ? 'suggestion' : how === 'dropped' ? 'error' : how === 'later' ? ACCENT.later : check?.state === 'running' ? 'suggestion' : outcome ? outcome.color : check ? 'success' : 'inactive'
      // An item from a prompt the person rewound past keeps its place and takes the mark of a step back.
      const mark = how === 'done' ? '✓' : how === 'dropped' ? '✕' : how === 'later' ? '◷' : isAdded ? '●' : isSent ? '◐' : row.isRewound ? '↶' : outcome ? outcome.mark : look.mark
      const markColor: Color = isAdded || how === 'done' ? 'success' : isSent ? 'suggestion' : how === 'later' ? ACCENT.later : how === 'dropped' || row.isRewound ? 'inactive' : outcome ? outcome.color : look.color
      const taken = quick !== '' ? quick.length + 4 : tag !== '' ? tag.length + 2 : 0
      const lines = linesOf(row.title, Math.max(8, width - indent - 3 - taken), isOpen ? 4 : 3)

      return (
        <Box key={`item-${row.id}`} flexDirection="column" {...(isOpen ? { backgroundColor: 'userMessageBackground' } : {})}>
          <Box key={`head-${row.id}`} flexDirection="row" hover={{ backgroundColor: 'userMessageBackgroundHover', scope: row.id }}>
            <Text color={look.color}>
              {' '.repeat(indent)}
              {isOpen ? '▍' : ' '}
            </Text>
            <Text color={markColor}>{mark} </Text>
            <Button key={`row-${row.id}`} label={row.title} plain dimColor={(Boolean(how) || row.isRewound === true) && !isOpen} onPress={toggleOpen($, row.id)}>
              <Text bold={isOpen}>{lines.join('\n')}</Text>
            </Button>
            <Box flexGrow={1} />
            {quick !== '' && buttonOf(`check-${row.id}`, quick, ignore)}
            {quick === '' && tag !== '' && <Text color={tagColor}>  {tag}</Text>}
            {/* A row with a look running or back keeps its tag in sight: the button would cover where the look stands. */}
            {quick === '' && !isOpen && !isAdded && !isSent && !how && !row.options && !check && quickOf(row, 'Add to prompt', addToPrompt($, row.id))}
            {!isOpen && how && quickOf(row, 'Reopen', setStatus($, row.id, 'open'))}
          </Box>
          {isOpen && cardOf(row, indent)}
        </Box>
      )
    }

    // A section's name minimizes it, and so does the arrow at its row's end, which says which way it is.
    const headOf = (key: string, name: string, color: Color, count: number, extra: ReturnType<typeof buttonOf> | null = null) => (
      <Box flexDirection="row">
        <Button key={`fold-${key}`} label={name} plain onPress={toggleFold($, key)}>
          <Text color={color}>▍</Text>
          <Text bold>{name}</Text>
          <Text color="inactive"> {count}</Text>
        </Button>
        <Box flexGrow={1} />
        {extra}
        <Button key={`fold-mark-${key}`} label={isFolded(key) ? `Show ${name}` : `Hide ${name}`} plain dimColor onPress={toggleFold($, key)}>
          {isFolded(key) ? ' ▸' : ' ▾'}
        </Button>
      </Box>
    )

    // A goal has three states: minimized to its name and progress, open with what is done behind one
    // line, and open with every item listed. Minimized, it still says how much in it waits on the
    // person. A finished goal, under Closed, is one row until it is clicked.
    const goalOf = (block: GoalBlock, at: number, isFinished = false) => {
      const key = `goal-${block.goal.id}`
      const { done, of } = progressOf(book, block.goal)
      const isAll = now.shownGoals.includes(block.goal.id)
      const isMin = isFinished ? !isAll : isFolded(key)
      const toggle = isFinished ? toggleGoal($, block.goal.id) : toggleFold($, key)
      const hasBar = width >= 40 && of <= 12
      const waits = isMin && !isFinished && block.waiting > 0 ? `  ? ${block.waiting}` : ''
      const room = width - (hasBar ? of : 0) - `${done} of ${of}`.length - waits.length - (isFinished ? 8 : 6)

      return (
        <Box flexDirection="column" marginTop={isFinished || at === 0 ? 0 : 1}>
          <Box flexDirection="row">
            <Button key={key} label={block.goal.title} plain dimColor={isFinished && isMin} onPress={toggle}>
              <Text color={isFinished ? 'inactive' : ACCENT.goals}>{isFinished ? ' ✓ ' : '▍'}</Text>
              <Text bold={!isFinished || !isMin}>{clip(block.goal.title, Math.max(8, room))}</Text>
            </Button>
            {waits !== '' && <Text color="warning">{waits}</Text>}
            <Box flexGrow={1} />
            {hasBar && <Text color="success">{'▰'.repeat(Math.max(0, done))}</Text>}
            {hasBar && <Text color="subtle">{'▱'.repeat(Math.max(0, of - done))}</Text>}
            <Text color="inactive">
              {' '}
              {done} of {of}
            </Text>
            <Button key={`${key}-mark`} label={isMin ? `Show ${block.goal.title}` : `Hide ${block.goal.title}`} plain dimColor onPress={toggle}>
              {isMin ? ' ▸' : ' ▾'}
            </Button>
          </Box>
          {!isMin && block.open.map(row => rowOf(row))}
          {!isMin && !isFinished && block.done.length > 0 && (
            <Box flexDirection="row">
              <Button key={`done-${block.goal.id}`} label={isAll ? 'Hide what is done' : 'Show what is done'} plain onPress={toggleGoal($, block.goal.id)}>
                <Text color="success"> ✓ </Text>
                <Text bold={isAll}>Done</Text>
                <Text color="inactive">
                  {' '}
                  {block.done.length} {isAll ? '▾' : '▸'}
                </Text>
              </Button>
              <Box flexGrow={1} />
              {isAll && block.open.some(row => row.kind === 'ask') && buttonOf(`rest-${block.goal.id}`, 'Have Claude do the rest', doTheRest($, block))}
            </Box>
          )}
          {!isMin && (isFinished || isAll) && block.done.map(row => rowOf(row, isFinished ? 2 : 0))}
        </Box>
      )
    }

    const zoneOf = (name: string) => (
      <Box flexDirection="row" marginTop={1}>
        <Text color="inactive">{name}</Text>
      </Box>
    )

    const waiting = opened.filter(needsYou).length
    const oneOffs = layout.oneOffs.filter(group => group.rows.length > 0)
    const hasGoals = layout.goals.length > 0 || layout.single.length > 0
    // The two zones are named only where both hold something: one of them alone needs no name.
    const isZoned = hasGoals && oneOffs.length > 0
    const top = isZoned ? 0 : 1
    // Questions left behind in one dialog can be answered together, each with what Claude recommended.
    const dialog = opened.filter(row => row.dialog !== undefined && row.options && !now.added[row.id])
    const laterCount = layout.later.rows.length + layout.later.held.reduce((sum, one) => sum + one.rows.length, 0)
    const closedCount = layout.closed.goals.length + layout.closed.rows.length

    return (
      <Box flexDirection="column" width={width} minHeight={isDock ? height : undefined}>
        <Box flexDirection="row">
          <Text bold color="suggestion">
            Inbox
          </Text>
          <Text color="inactive">
            {waiting > 0 ? ` · ${waiting} need you` : ''} · {opened.length} open
          </Text>
        </Box>

        {isZoned && zoneOf('Goals')}
        {layout.goals.map((block, at) => (at === 0 && !isZoned ? <Box marginTop={1}>{goalOf(block, at)}</Box> : goalOf(block, at)))}
        {layout.single.length > 0 && (
          <Box flexDirection="column" marginTop={layout.goals.length > 0 ? 1 : top}>
            {headOf('single', 'Single goals', ACCENT.goals, layout.single.length)}
            {!isFolded('single') && layout.single.map(row => rowOf(row))}
          </Box>
        )}

        {isZoned && zoneOf('One-offs')}
        {oneOffs.map((group, at) => (
          <Box flexDirection="column" marginTop={at === 0 ? top : 1}>
            {headOf(group.key, SECTION_NAME[group.key], ACCENT[group.key], group.rows.length, group.key === 'needs' && dialog.length > 1 ? buttonOf('batch-dialog', 'Take the recommended', takeRecommended($, dialog)) : null)}
            {!isFolded(group.key) && group.rows.map(row => rowOf(row))}
          </Box>
        ))}

        {opened.length === 0 && (
          <Box marginTop={1}>
            <Text color="inactive">Nothing is open.</Text>
          </Box>
        )}

        {laterCount > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {headOf('later', 'Later', ACCENT.later, laterCount)}
            {/* What was set aside together keeps the name of the goal it belongs to. */}
            {!isFolded('later') &&
              layout.later.held.map(one => (
                <Box flexDirection="column">
                  <Text bold> {clip(one.goal.title, width - 1)}</Text>
                  {one.rows.map(row => rowOf(row))}
                </Box>
              ))}
            {!isFolded('later') && layout.later.rows.map(row => rowOf(row))}
          </Box>
        )}

        {closedCount > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {headOf('closed', 'Closed', ACCENT.closed, closedCount)}
            {!isFolded('closed') && layout.closed.goals.map((block, at) => goalOf(block, at, true))}
            {!isFolded('closed') && layout.closed.rows.map(row => rowOf(row))}
          </Box>
        )}
      </Box>
    )
  })
}
