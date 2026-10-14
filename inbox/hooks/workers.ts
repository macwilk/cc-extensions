// What the model passes are asked, and how their answers are read. One pass reads each prompt of
// the person's for what it asks and what it answers. The other reads each exchange for what got
// done, what was skipped and what it leaves open. Nothing here touches the engine.
import type { Event, Item, Ledger } from '../types'
import { labelOf } from './capture'
import { apply, goalOpened, isDropped, isListed, opened, progressOf } from './ledger'

/**
 * The model of both passes, and the lighter one a person can choose in its place. In a replay of 66
 * real exchanges, the lighter model missed asks put as a question or a complaint, found half as many
 * answers to open questions, and took longer.
 */
export const READ_MODEL = 'sonnet'
export const LIGHT_MODEL = 'haiku'
/** The most new items one reply may open, and the most entries of Claude's todo list one read is given. */
export const OPENS_PER_REPLY = 3
export const TODOS_PER_READ = 20

/**
 * How much of a turn the passes are given, which is what a read costs. Counts are of tool calls,
 * lines and subagents, and the rest are characters.
 */
export type Depth = {
  model: string
  /** The most tool calls of a turn, and of how each ended: its last lines after its first, and the characters of that. */
  calls: number
  tail: number
  ending: number
  /** Of an exchange: the reply, the message it answers, and what Claude wrote before the reply. */
  reply: number
  message: number
  said: number
  /** Of a prompt as it is read for what it asks: the prompt, and the reply it answers. */
  prompt: number
  lastReply: number
  /** The most subagents, and of each: its tool calls, its report, the task it was given, and what it wrote along the way. */
  agents: number
  agentCalls: number
  report: number
  task: number
  agentSaid: number
  /** The most items one reply may put to a fork of the conversation, which reads all of it. */
  forks: number
  /** Whether a read is also told which files were read and searched, what each edit changed, and how every other tool ended. */
  isFull: boolean
  /** Whether every subagent's report is audited against its own tool calls, with a model call of its own. */
  isAuditingAgents: boolean
}
const BALANCED: Depth = { model: READ_MODEL, calls: 80, tail: 3, ending: 500, reply: 9000, message: 4000, said: 6000, prompt: 6000, lastReply: 5000, agents: 12, agentCalls: 10, report: 2000, task: 0, agentSaid: 0, forks: 2, isFull: false, isAuditingAgents: false }
const THOROUGH: Depth = { model: READ_MODEL, calls: 400, tail: 12, ending: 2000, reply: 40000, message: 20000, said: 30000, prompt: 30000, lastReply: 20000, agents: 60, agentCalls: 60, report: 12000, task: 2000, agentSaid: 4000, forks: 6, isFull: true, isAuditingAgents: false }
/**
 * The depths a person can choose. `Light` reads what `Balanced` reads, with the lighter model, and
 * `Exhaustive` reads what `Thorough` reads and audits each subagent as the main conversation is audited.
 */
export const DEPTHS: Record<string, Depth> = {
  Light: { ...BALANCED, model: LIGHT_MODEL },
  Balanced: BALANCED,
  Thorough: THOROUGH,
  Exhaustive: { ...THOROUGH, isAuditingAgents: true },
}
/** The most items the audit of one subagent may open, and the most that all of them may open between two prompts of the person's. */
export const OPENS_PER_AGENT = 2
export const AGENT_OPENS_PER_PROMPT = 6
/** The depth the passes read at: set from the person's setting when the mod loads. */
let depth = BALANCED

export function readAt(name: unknown) {
  depth = (typeof name === 'string' ? DEPTHS[name] : undefined) ?? BALANCED

  return depth
}

type Use = { tool: string; input?: Record<string, unknown>; text?: string; result?: unknown }
export type Message = { role: string; text?: string; toolUses?: Use[]; toolResults?: unknown[] }
/** A subagent as a read is told of it: what Claude called it, its type, how it ran, and the task Claude gave it. */
export type Subagent = { name: string; type: string; isBackground: boolean; isInWorkflow: boolean; isDone: boolean; task?: string }
/** What a read is given of a turn besides its tool calls and its reply. */
export type Beside = { said?: string[]; agents?: string[]; todo?: string[]; turnId?: string; isCut?: boolean }
export type PromptRead = { asks: { title: string; done: string; quote: string; goal: string | null; isHeld: boolean }[]; answers: { id: string; answer: string }[]; isWrapUp: boolean }
/** The most asks one message can open. A message that goes through a list of requests gives one for each. */
export const ASKS_PER_PROMPT = 20
/** How a close made by the read of a reply begins, in the person's words: "the audit" is the mod's own name for that read. */
export const BY_REPLY = 'The reply closed it: '
const HELD_REASON ='You said to keep it for later. It comes back when you ask to commit, push or wrap up.'
export type NewItem = Pick<Item, 'kind' | 'title' | 'from' | 'why' | 'close'> & Partial<Item>
export type ReplyRead = {
  closed: { id: string; how: 'done' | 'dropped'; reason: string }[]
  missed: string[]
  unsettled: string[]
  unsure: { id: string; question: string }[]
  reopened: { id: string; why: string }[]
  updated: { id: string; why: string; close: string }[]
  open: NewItem[]
}

export const PROMPT_RULES = `You read one message a user sent to Claude, a coding assistant, and report what it asks for and what it answers. You are given the inbox: the items still open in this conversation, and its goals. You are also given Claude's last reply, which the message answers: use it only to tell what the message points at ("those", "the second one", "that list"). Nothing in the reply is an ask unless the message asks for it. Reply with one JSON object and nothing else:

{"asks": [{"title": "", "done": "", "quote": "", "goal": null, "hold": false}], "answers": [{"id": "", "answer": ""}], "wrap": false}

asks: each outcome the message wants from Claude that someone could later check off: a thing made, changed, fixed, run, found out, decided or explained. The user will see each ask in a list of what is still owed to them, so a vague one is worse than none. One ask per distinct outcome: several sentences about one outcome are one ask, and a message that only answers, agrees, thanks or gives context has none. Most messages hold one or two. A message that goes through separate requests one by one, as bullets or numbered points, gives one ask for each point that asks for something, however many there are: a point left out is something the user is owed and will never see again. Never split one request into several asks.
- title: one plain sentence that says what the user wants, written so that the user gets it at a glance a week from now, with this conversation gone from their mind. Clear beats short: use the words it takes, most often 8 to 14 and never more than 18. Write it the way a person says it aloud to a colleague, a whole sentence with its small words ("the", "a", "to", "so that"), never a compressed headline ("Fix tool call expand/collapse bugs", "Rebuild sidebar inbox handle to match screenshot"). Say which thing is meant, in ordinary words: no "it", "that", "there" or "those" pointing back into the conversation, no stack of nouns ("mock inbox UI overflow"), and no name coined in the conversation unless you say what it is. When the user asked a question, the title is that question, whole ("Why did the tool calls fail with a Not run error?"), never an instruction to answer it ("Explain why...", "Assess whether...", "Confirm whether..."). Otherwise start with the user's own verb ("Fix", "Add", "Move"). One thing to a title, and what is wanted, not how to get there: the way to do it, how many, in which file and under what condition go in "done". A title holds no list: for several things of a kind, say what they have in common. Never a title that only points at other work ("continue", "do the rest", "add the skill", "start on the items", "clean up").
- done: what will show that it is finished, as one sentence someone can check: the file, behaviour, output, decision or answer that will then exist. Write it as something Claude can show in its reply, never as something the user has to try, confirm or approve. If you cannot say what would show it finished, it is not an ask, so leave it out.
- quote: the user's own words it comes from, copied exactly, at most 20 words.
- goal: the id of the listed goal this ask continues, when it clearly does. Else the title of a new goal, at most 6 plain words, naming the one piece of work the ask belongs to, when it is part of something larger. A goal is a piece of work that gets finished ("Shiki colors in diffs", "A license on the repo"), never a theme that every later ask would fit ("A better inbox", "Good UX"). Else null, for a one-off: an ask that stands alone has no goal, and a goal is never one ask said again in fewer words. Asks from one message that serve one outcome share one goal. Prefer a listed goal to a new one.
- hold: true when the user says to keep it for later and not to do it now ("put a pin in that", "that can sit in the backlog", "not now"). It is then listed as set aside, and the reply is not expected to do it. When what the user holds is a list from Claude's last reply ("put a pin in those for now", said of a section of the reply), copy the list: every entry of it, sub-entries too, becomes an ask of its own, with a title and a "done" taken from the reply, hold true, and one shared goal named for the list ("Before commit and push"). Never fold such a list into one ask about the list.
Not asks: how the reply should read (its length, format, tone, or what it should ask back), limits on the work ("do not run the tests", "nothing else"), and a step given only as the way to carry out another ask.
Not asks either: words the user quotes from an earlier message, a document or a tool's output, which are what they are talking about and not what they ask now; a go-ahead for work Claude proposed or already has listed ("yes", "go on", "start on those"), which adds no outcome of its own; and an open-ended direction with no end to check ("polish it", "keep iterating", "make it better").
Do not list as an ask anything already open in the inbox: an ask repeated from an earlier message, or a reference to an open item.

answers: each open item this message clearly answers, decides, or reports as done or not wanted, whether or not it names the item. A question is answered by a message that states the choice in passing, and a task by a message that shows the user did it. id is the item's id, answer is what the user said about it, in their words. Leave out anything you are not sure the message settles.

wrap: true when the message asks to commit, push, open a pull request, or wrap up the work.`

/** How the audit is told that Claude closed an item as not wanted any more, and not as done. */
const AS_DROPPED = '[dropped as no longer wanted]'

export const REPLY_RULES = `You audit one exchange between a user and Claude, a coding assistant: the user's message, what Claude did with its tools, and Claude's reply. Some turns start from a notice of the system's instead, such as a background task ending: then the notice is what the reply answers, and what it reports is known, not a claim to verify. You keep the user's inbox, which lists what the conversation has left open. Reply with one JSON object and nothing else:

{"closed": [{"id": "", "how": "done", "reason": ""}], "missed": [], "unsettled": [], "unsure": [{"id": "", "question": ""}], "reopened": [{"id": "", "why": ""}], "updated": [{"id": "", "why": "", "close": ""}], "open": [{"kind": "", "title": "", "from": "", "why": "", "close": "", "goal": null}]}

What you are given of the turn: WHAT CLAUDE DID lists its tool calls, each with how it ended. A line there that starts "Question dialog" holds what the user chose in a dialog Claude put up: those choices are the user's own, as a message of theirs is, and can answer an open question. WHAT CLAUDE SAID WHILE WORKING, when present, is what Claude wrote to the user earlier in the same turn, before its reply: the user read it, so what it reports, asks or leaves open counts as the reply's own does. WHAT ITS SUBAGENTS DID, when present, lists the helpers Claude handed work to, each with its tool calls and, once it has ended, its report: that work is Claude's, so it shows what was run and changed, and a problem a report names is a problem whether or not the reply repeats it. CLAUDE'S OWN TODO LIST, when present, is its working list as the turn ended: an entry not finished there is a sign that the ask it belongs to is not done, unless the tool calls or the reply show that work done. Never open an item for a todo entry alone. When more than one message of the user's reached Claude in the turn, they are numbered in the order they arrived, and where a later one takes back or changes what an earlier one said, the later one stands.

An inbox that only grows is useless, so closing what this exchange settled matters as much as opening what it leaves. Go through every open item, not only the marked ones.

closed: each open item this exchange settled.
- how "done": the work was carried out, the question was answered, or the user's message shows they did the task, and the tool results, the reply or the message show it. Saying it will be done, planning it, or mentioning it does not count. Part of it done does not count. An ask is done once Claude has carried it out and the exchange shows that: it does not wait for the user to try it, reload, look at it or approve it. When that is all that is left, close the ask as done, and put what the user has not yet seen under open or updated as an unverified item.
- how "dropped": it no longer applies. The user said it is not wanted. The user or the reply chose another way, so the item is moot. A newer question or item in this reply replaces it. The reply declines an ask and says why, which the user has now read.
- reason: the evidence in one sentence the user can check, with the commit, file, command or words that show it. For a declined ask, start it with "Claude declined:".

missed: ids of asks marked [asked now] that the reply shows no sign of: it did not do them, did not start them, and said nothing about them. Not finished is not missed. An ask the reply did part of, is still working on, is waiting on something for, explains, or asks the user about stays open and is not listed here.

unsettled: ids of items marked [sent] that the reply did not act on. A [sent] item the reply acted on goes under closed.

unsure: an open item you cannot judge from this exchange because it turns on earlier parts of the conversation, with the one yes-or-no question whose answer would settle it. Use it rarely.

reopened: Claude may close an item itself while it works, on its own word. Those are listed under CLOSED BY CLAUDE THIS TURN, each with what was to show it done and the reason Claude gave. List here each one that the tool results and the reply do not bear out: the work is not there, it failed, or it was only planned. Where the user's messages are numbered, a close says after which of them it was made: list it too when a message that came after it takes it back, by saying to keep the item open, by changing the answer the close rests on, or by asking for something else in its place. A message that came before the close takes nothing back. One marked ${AS_DROPPED} was closed by Claude as not wanted any more and not as done: list it when nothing the user wrote, and nothing the reply shows, makes it unwanted or moot. "why" says what is missing or what the user said, written for the user. Leave out every close the exchange supports, which is most of them.

updated: each open item this exchange says more about without settling it. Give "why", the whole account of it as it now stands, written for the user as an item's "why" is (it replaces the old one, so keep what still holds), and for an item that is not an ask "close", what would settle it now. An ask keeps the "To close" it has, which is what the user asked for. An ask the reply worked on and did not finish belongs here, with what was found and what of the work itself is still missing. So does an open issue or unverified item that the reply repeats, narrows or adds to. Decide this before you open anything: whatever is about the same work as an open item goes here, whatever its kind, and is never opened as a second item. An ask the reply declines, or shows cannot be done as asked, is not updated: close it as dropped. Neither is an ask whose "To close" the exchange now meets: close it as done.

open: what the reply newly leaves that the user would be worse off not seeing again: something they must answer, something they must do, or something that is wrong. At most ${OPENS_PER_REPLY}. Each has a kind:
- "question": a decision the reply asks the user to make and that work waits on. Give "options", the answers the reply offered or the plain ones (2 to 4, at most 6 words each, each saying what choosing it does: "Yes, forks keep the inbox", never a bare "Yes"), "recommended", the places in options of the ones the reply recommended, and "multi": true when several can be chosen. A go-ahead ("Shall I commit?") is a question with options like "Yes, commit it" and "Not yet". One question holds one decision: two decisions are two questions, never one question whose answers are combinations of both. When it replaces an open question on the same matter, close that one as dropped.
- "task": something only the user can do: run a command in their own shell, act on a web page, give a value only they have, or judge something by eye. Give what applies: "command", the exact command; "link", the page's URL; "draft", text written for them to send; "value", the name of the value to type, like "Ticket"; "look": true when their eyes must judge it. A reply that tells the user to reload plugins or to restart Claude Code leaves one task, with "closesOn": "reload" or "closesOn": "restart", whatever else it says to look at afterward.
- "issue": a defect or a risk that remains after this reply and that someone could act on. A limit of the platform that the reply explains and works within is not an issue.
- "opportunity": an improvement the reply raises and does not make, where the user showed interest.
- "unverified": something the reply presents as working or fixed without having run it, where the user is likely to rely on it. At most one for a reply: when the reply lists several things it did not run, name them in one item. When an unverified item about the same work is already open, add to that one under updated and open none.
Write every item for the user, who directs this work and will read the item several messages from now, when the details of this exchange have left their mind. They must be able to decide or act from the item alone. So say the thing itself, in plain words, and never describe the conversation ("the reply asks whether...", "work waits on the answer"). A name the reply coined ("the log marker", "item 4", "the carry-over") means nothing later: say what it is.
For each:
- "title": one plain sentence that the user gets at a glance a week from now, with this exchange gone from their mind. Clear beats short: use the words it takes, most often 8 to 14 and never more than 18. Write it the way you would say it aloud to the user, a whole sentence with its small words ("the", "a", "to", "so that"), never a compressed headline ("Click-shading fix relies on undocumented colorless background value"). Say which thing is meant, in ordinary words: no "it" or "that" pointing back into the conversation, no stack of nouns, no hyphenated coinage ("mid-turn closing"), and no name coined in the conversation unless you say what it is. A question is the question itself, asked of the user and ending in "?" ("Should the ten new themes switch to the dark base, so that their diff colors show?"). A task says what the user has to do and what for ("Restart Claude Code so that the new theme colors load"). An issue says what is wrong and where ("Old commits on GitHub still show your work email"). An unverified item says what was not tried ("The copy button was never clicked, so copying is untested"). An opportunity says what could be done. One thing to a title, and no list in it: when an item covers several things, the title says what they have in common or names the one that matters most, and "why" lists them. Counts, paths, causes and what Claude tried go in "why".
- "from": where it comes from, written as Claude in the first person with a short quote, like: My reply after the force push: "GitHub still serves the old commits".
- "why": three to five sentences. What this is about and how it came up. What is at stake: for a question, what each answer leads to and what it costs; for a task, what it unblocks and what happens if it waits; for a finding, what goes wrong and when. What Claude recommends, if the reply says. Give the exact names, paths and numbers.
- "close": what the user has to do or say, concretely.
- "goal": the id of the listed goal it belongs to (as in "g12"), when it is plainly about that piece of work: a question on how to do it, a task that unblocks it, a finding about what was built for it. Else null. Never a goal's title, and never a goal that is not listed.
- "file": the absolute path it is about, if one.
Do not open: what this exchange already resolved; what the reply says it will do next; a closing pleasantry or an open-ended offer of more help; anything an open item is already about, even in other words or as another kind, which goes under updated; anything under DROPPED BY THE USER; anything under SET ASIDE BY THE USER, which the user is keeping for later and does not want raised again, one by one or as a list.`

const cut = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.floor(room * 0.6))}\n[...]\n${text.slice(-Math.floor(room * 0.4))}`)
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const flat = (lines: string) => lines.split(/\s*\n\s*/).filter(Boolean).join(' ')
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** The open items as lines a model reads, each with its id, and with what marks it for this exchange. */
export function inboxLines(ledger: Ledger, asked: string[] = []) {
  const open = ledger.items.filter(item => item.status === 'open')
  const lines = open.map(item => {
    const marks = [asked.includes(item.id) ? ' [asked now]' : '', item.sent ? ` [sent: ${item.sent.split('\n').join(' ')}]` : ''].join('')
    const answers = item.options ? ` Answers: ${item.options.join(' | ')}.` : ''

    return `${item.id} [${labelOf(item)}]${marks} ${item.title}. To close: ${item.close}${answers}`
  })
  const goals = ledger.goals.map(goal => {
    const { done, of } = progressOf(ledger, goal)

    return `${goal.id} ${goal.title} (${done} of ${of} asks done)`
  })

  return [`OPEN ITEMS\n${lines.join('\n') || 'none'}`, `GOALS\n${goals.join('\n') || 'none'}`].join('\n\n')
}

/** The last thing Claude wrote to the person, which their next message answers. */
export function lastReplyOf(messages: Message[]) {
  return text(messages.findLast(message => message.role === 'assistant' && text(message.text) !== '')?.text)
}

/** `lastReply` is what the message answers, given so that "those" and "the second one" can be told. */
export function promptAsk(ledger: Ledger, message: string, lastReply = '') {
  return `${inboxLines(ledger)}\n\nCLAUDE'S LAST REPLY\n${cut(lastReply, depth.lastReply) || 'None.'}\n\nMESSAGE\n${cut(message, depth.prompt)}`
}

/** How a tool call ended: its first line and its last few, since a run's verdict is at the end of what it prints. */
function endOf(output: string) {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const kept = lines.length <= depth.tail + 1 ? lines : [lines[0] ?? '', '[...]', ...lines.slice(-depth.tail)]

  return kept.join(' ').slice(0, depth.ending)
}

/** What an edit changed or a new file starts with, for a read that is told as much. */
function changeOf(input: Record<string, unknown>) {
  if (typeof input.old_string === 'string') return ` (replaced ${JSON.stringify(flat(text(input.old_string)).slice(0, 300))} with ${JSON.stringify(flat(text(input.new_string)).slice(0, 300))})`

  return typeof input.content === 'string' ? ` (${input.content.split('\n').length} lines, starting ${JSON.stringify(flat(input.content).slice(0, 300))})` : ''
}

/** A file's path from the project's folder when the file is in it: what an item says of a file is read by the person, who knows it by that path. */
function fromProject(path: string, cwd: string) {
  return cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

/**
 * One tool call as a line: what was run or changed, and how it ended. Reading and searching are
 * left out, and so is the inbox tool but for a finding it was given to record, which can be the
 * very thing the person asked for. A read at full depth is told more: which files were read and
 * searched, what each edit changed, a plan whole, and how every other tool ended.
 */
export function toolLine(use: Use, cwd = '') {
  const input = use.input ?? {}
  const ended = endOf(text(use.text))
  if (use.tool === 'Bash') return `Bash: ${text(input.command).split('\n').join(' ').slice(0, depth.isFull ? 2000 : 600)} => ${ended || 'no output'}`
  if (use.tool === 'Edit' || use.tool === 'Write' || use.tool === 'NotebookEdit') return `${use.tool}: ${fromProject(text(input.file_path) || text(input.notebook_path), cwd)}${depth.isFull ? changeOf(input) : ''}`
  if (depth.isFull && ['Read', 'Grep', 'Glob'].includes(use.tool)) return `${use.tool}: ${[text(input.pattern), fromProject(text(input.file_path) || text(input.path), cwd)].filter(Boolean).join(' in ')}`
  if (depth.isFull && use.tool === 'ExitPlanMode') return `Plan: ${cut(text(input.plan), 4000)}`
  // One started in the background answers with the engine's notes to Claude, which say nothing of the work.
  if (use.tool === 'Agent' || use.tool === 'Task') return `Agent: ${text(input.description)} => ${ended.startsWith('Async agent launched') ? 'started in the background' : ended}`
  // What the person chose in a dialog is theirs, and is told whole.
  if (use.tool === 'AskUserQuestion') return `Question dialog: ${flat(text(use.text)).slice(0, 700)}`
  if (use.tool === 'Workflow') return `Workflow: ${text(input.name) || /name:\s*['"]([^'"]+)['"]/.exec(text(input.script))?.[1] || text(input.scriptPath) || 'a script'} => ${ended.startsWith('Workflow launched') ? 'started in the background' : ended}`
  if (use.tool.startsWith('mcp__inbox__')) return input.action === 'record' ? `Inbox record: ${text(input.title)} => ${ended}` : null
  // A subagent's report is told as its report, and Claude's todo list as the list.
  if (['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'SubagentHandback'].includes(use.tool)) return null

  return depth.isFull ? `${use.tool}: ${JSON.stringify(input).slice(0, 400)} => ${ended || 'no output'}` : `${use.tool}: ${JSON.stringify(input).slice(0, 160)}`
}

/**
 * What Claude wrote to the person in this turn before its reply, in order: each message of its own
 * that has text, since the person's last message, but for the reply itself.
 */
export function saidOf(messages: Message[], reply: string) {
  const from = messages.findLastIndex(message => message.role === 'user' && text(message.text) !== '' && list(message.toolResults).length === 0)
  const said = messages
    .slice(from + 1)
    .filter(message => message.role === 'assistant' && text(message.text) !== '')
    .map(message => text(message.text))

  return said.at(-1) === reply.trim() ? said.slice(0, -1) : said
}

/**
 * Claude's own todo list as the conversation last left it, one line an entry, and nothing when all
 * of it is finished. One tool writes the list whole each time, and another keeps it entry by entry.
 */
export function todoOf(messages: Message[]) {
  const uses = messages.flatMap(message => message.toolUses ?? [])
  const entries = new Map<string, { title: string; status: string }>()
  list(uses.findLast(use => use.tool === 'TodoWrite')?.input?.todos).forEach((todo, at) => {
    const { content, status } = todo as { content?: unknown; status?: unknown }
    entries.set(`w${at}`, { title: text(content), status: text(status) })
  })
  for (const use of uses) {
    const input = use.input ?? {}
    if (use.tool === 'TaskCreate') {
      const id = text((use.result as { task?: { id?: unknown } } | undefined)?.task?.id)
      if (id !== '') entries.set(id, { title: text(input.subject), status: 'pending' })
    }
    const entry = use.tool === 'TaskUpdate' ? entries.get(text(input.taskId)) : undefined
    if (entry && input.status === 'deleted') entries.delete(text(input.taskId))
    else if (entry) Object.assign(entry, { title: text(input.subject) || entry.title, status: text(input.status) || entry.status })
  }
  const kept = [...entries.values()].filter(entry => entry.title !== '')
  if (kept.every(entry => entry.status === 'completed')) return []

  return kept.slice(-TODOS_PER_READ).map(entry => `[${entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'in progress' : 'not started'}] ${entry.title}`)
}

/**
 * A subagent as lines of a read: who it is, the latest of its tool calls, and its report once it has
 * ended. A deeper read is also told the task it was given and what it wrote along the way.
 */
export function agentPart(agent: Subagent, lines: string[], report: string, said: string[] = []) {
  const how = [agent.type, agent.isInWorkflow ? 'in a workflow' : '', agent.isBackground ? 'in the background' : '', agent.isDone ? 'ended' : 'still running'].filter(Boolean).join(', ')

  return [
    `"${agent.name}" (${how})`,
    ...(depth.task > 0 && text(agent.task) !== '' ? [`  Its task: ${cut(flat(text(agent.task)), depth.task)}`] : []),
    ...newest(lines, depth.agentCalls).map(line => `  ${line}`),
    ...(depth.agentSaid > 0 && said.length > 0 ? [`  It wrote along the way: ${cut(said.map(flat).join(' / '), depth.agentSaid)}`] : []),
    ...(report.trim() !== '' ? [`  Its report: ${cut(report.trim(), depth.report)}`] : []),
  ].join('\n')
}

export const AGENT_RULES = `You audit the work of one helper: a subagent that Claude, a coding assistant, handed a task to. You are given the task, the helper's tool calls with how each ended, what it wrote along the way, and its report. Claude relies on that report, and the user who directs the work never reads it. You also keep the user's inbox, which lists what the conversation has left open. Reply with one JSON object and nothing else:

{"open": [{"kind": "", "title": "", "from": "", "why": "", "close": "", "file": ""}]}

open: what the user would be worse off not knowing about this helper's work, at most ${OPENS_PER_AGENT}, and most often none. A helper that did its task and reported it truly leaves nothing. Each has a kind:
- "unverified": the report presents something as working, fixed, passing or true, and the tool calls do not show that it was run or checked. Name what was claimed and what was not run. At most one: several such claims go in one item.
- "issue": something the tool calls show that the report hides or gets wrong, and that someone could act on: a check that failed while the report says it passed or leaves it out, an error it worked around without saying so, a change it made that its task did not ask for and its report does not mention, or a part of its task that it skipped while its report reads as if all of it was done.
Do not open: what the tool calls bear out; a problem the report states plainly, which Claude has read; a limit the helper explains and works within; anything an open item is already about, even in other words; a judgement of how well the report is written.
Write every item for the user, who will read it several messages from now with none of this in mind, and who must be able to act from the item alone. Say the thing itself in plain words, and name the helper by what it was doing ("the subagent that ran the tests"), never by an id.
- "title": one plain sentence that the user gets at a glance, most often 8 to 14 words and never more than 18: a whole sentence with its small words, never a compressed headline. An issue says what is wrong and where. An unverified item says what was not tried.
- "from": where it comes from, written as Claude in the first person with a short quote, like: A subagent I started to run the tests reported: "all tests pass".
- "why": three to five sentences. What this is about, what is at stake, and the exact names, paths, commands and numbers.
- "close": what would settle it, concretely.
- "file": the absolute path it is about, if one.`

/** What the audit of one subagent is asked: the inbox, then the subagent's task, its tool calls, what it wrote and its report. */
export function agentAsk(ledger: Ledger, agent: Subagent, lines: string[], said: string[], report: string) {
  return [
    inboxLines(ledger),
    `THE HELPER\n"${agent.name}" (${[agent.type, agent.isInWorkflow ? 'in a workflow' : ''].filter(Boolean).join(', ')})`,
    `THE TASK CLAUDE GAVE IT\n${cut(text(agent.task), depth.message) || 'Not kept.'}`,
    `WHAT IT DID\n${newest(lines).join('\n') || 'It called no tools that change anything.'}`,
    ...(said.length > 0 ? [`WHAT IT WROTE ALONG THE WAY\n${cut(said.join('\n\n'), depth.said)}`] : []),
    `ITS REPORT\n${cut(report, depth.reply) || 'It gave none.'}`,
  ].join('\n\n')
}

/** A tool call as a hook on it is handed it, with how it ended: the call's own fields, without the ones the engine adds to every call. */
export function useOf(call: Record<string, unknown>, output: string): Use {
  const input = Object.fromEntries(Object.entries(call).filter(([field]) => !['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'].includes(field)))

  return { tool: text(call.tool), input, text: output }
}

/** The latest of a turn's tool calls when there are many, under a line that says how many were left out. */
export function newest(lines: string[], most = depth.calls) {
  return lines.length <= most ? lines : [`[${lines.length - most} earlier tool calls left out]`, ...lines.slice(-most)]
}

/**
 * What Claude did since the person's last message, as the conversation holds it: one line a tool
 * call. A compaction in the middle of a turn leaves only the calls made after it.
 */
export function toolLines(messages: Message[], cwd = '') {
  const from = messages.findLastIndex(message => message.role === 'user' && text(message.text) !== '' && list(message.toolResults).length === 0)

  return messages
    .slice(from + 1)
    .flatMap(message => message.toolUses ?? [])
    .flatMap(use => toolLine(use, cwd) ?? [])
}

export function didLines(messages: Message[], most = depth.calls, cwd = '') {
  return newest(toolLines(messages, cwd), most)
}

/** `isNotice` is true for a turn that a notice of the system's started, such as a background task ending, and not a message of the user's. */
/**
 * The items Claude closed itself in the turn being audited, as done or as dropped: the audit is the
 * check on those. A close keeps the id of the engine's turn it was made in. One that kept none, from
 * a build before this one or from a reload of the mod in the middle of a turn, is told by the count
 * of prompts as it stands.
 */
export function closedByClaude(ledger: Ledger, turnId?: string) {
  const isClosed = (item: Item) => item.status === 'done' || item.status === 'dropped'

  return ledger.items.filter(item => isClosed(item) && item.closedBy === 'claude' && (item.closedIn === undefined ? item.closedTurn === ledger.turn : item.closedIn === turnId))
}

/**
 * `message` is what the turn answers: one text, or each message in the order it reached Claude.
 * Several are told by number, and a close of Claude's then says after which of them it was made:
 * the person may take back in a later message what an earlier one said.
 */
export function replyAsk(ledger: Ledger, asked: string[], message: string | string[], isNotice: boolean, did: string[], reply: string, beside: Beside = {}) {
  const messages = typeof message === 'string' ? [message] : message
  const isSeveral = messages.length > 1
  const told = isSeveral ? messages.map((one, at) => `[${at + 1}] ${one}`).join('\n\n') : (messages[0] ?? '')
  const heading = isNotice ? 'THE NOTICE THAT STARTED THIS TURN (from the system, not the user)' : isSeveral ? "THE USER'S MESSAGES, numbered in the order they reached Claude" : "THE USER'S MESSAGE"
  const after = (item: Item) => (isSeveral && item.closedHeard !== undefined ? ` Closed ${item.closedHeard < 1 ? 'before message 1' : `after message ${item.closedHeard}`} of ${messages.length}.` : '')
  const closed = closedByClaude(ledger, beside.turnId).map(item => `${item.id} ${item.title}. To close: ${item.close} ${item.reason ?? ''}${item.status === 'dropped' ? ` ${AS_DROPPED}` : ''}${after(item)}`)
  const agents = beside.agents ?? []
  const shown = agents.length <= depth.agents ? agents : [`[${agents.length - depth.agents} earlier subagents left out]`, ...agents.slice(-depth.agents)]
  const said = (beside.said ?? []).join('\n\n')

  return [
    inboxLines(ledger, asked),
    `CLOSED BY CLAUDE THIS TURN\n${closed.join('\n') || 'none'}`,
    `DROPPED BY THE USER\n${ledger.dropped.join('\n') || 'none'}`,
    `SET ASIDE BY THE USER\n${
      ledger.items
        .filter(item => item.status === 'later')
        .map(item => item.title)
        .join('\n') || 'none'
    }`,
    `${heading}\n${cut(told, depth.message) || 'None: the turn went on without a new message.'}`,
    `WHAT CLAUDE DID\n${did.join('\n') || 'It called no tools that change anything.'}`,
    ...(shown.length > 0 ? [`WHAT ITS SUBAGENTS DID\n${shown.join('\n')}`] : []),
    ...(beside.todo && beside.todo.length > 0 ? [`CLAUDE'S OWN TODO LIST\n${beside.todo.join('\n')}`] : []),
    ...(said !== '' ? [`WHAT CLAUDE SAID WHILE WORKING\n${cut(said, depth.said)}`] : []),
    `CLAUDE'S REPLY\n${cut(reply, depth.reply)}`,
  ].join('\n\n')
}

export function forkAsk(item: Item, question: string) {
  return `Do not continue the work. Answer one question about this conversation so far, with one JSON object and nothing else: {"done": true, "reason": ""}. "done" is true only if it was carried out or settled, and "reason" is the evidence in one sentence the user can check.\n\nThe item: ${item.title}\nClosing it takes: ${item.close}\nThe question: ${question}`
}

/** The JSON object in a model's reply, or null when it holds none: models wrap it in prose or a code fence at times. */
export function jsonOf(reply: string): Record<string, unknown> | null {
  const from = reply.indexOf('{')
  const to = reply.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  try {
    const value: unknown = JSON.parse(reply.slice(from, to + 1))

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What the prompt pass said, kept to what the ledger can hold: asks with a title, answers to items that are open. */
export function readPrompt(ledger: Ledger, reply: string): PromptRead | null {
  const said = jsonOf(reply)
  if (!said) return null
  const open = new Set(ledger.items.filter(item => item.status === 'open').map(item => item.id))
  const asks = list(said.asks).flatMap(one => {
    const ask = one as Record<string, unknown>

    // An ask that does not say what would show it finished could never be closed, so it is not listed.
    return text(ask.title) === '' || text(ask.done) === '' ? [] : [{ title: text(ask.title), done: text(ask.done), quote: text(ask.quote), goal: text(ask.goal) || null, isHeld: ask.hold === true }]
  })
  const answers = list(said.answers).flatMap(one => {
    const answer = one as Record<string, unknown>

    return open.has(text(answer.id)) && text(answer.answer) !== '' ? [{ id: text(answer.id), answer: text(answer.answer) }] : []
  })

  return { asks: asks.slice(0, ASKS_PER_PROMPT), answers, isWrapUp: said.wrap === true }
}

const KINDS = ['question', 'task', 'issue', 'opportunity', 'unverified'] as const

function newItem(raw: unknown): NewItem | null {
  const one = raw as Record<string, unknown>
  const kind = KINDS.find(known => known === one.kind)
  if (!kind || text(one.title) === '') return null
  const options = list(one.options).map(text).filter(Boolean).slice(0, 4)
  const recommended = list(one.recommended).filter((at): at is number => typeof at === 'number' && at >= 0 && at < options.length)

  return {
    kind,
    title: text(one.title),
    from: text(one.from) || "Claude's reply.",
    why: text(one.why),
    close: text(one.close) || (kind === 'question' ? 'Pick one of the answers.' : 'Say whether to act on it, or drop it.'),
    ...(/^g\d+$/.test(text(one.goal)) ? { goal: text(one.goal) } : {}),
    ...(kind === 'question' && options.length > 1 ? { options, ...(one.multi === true ? { isMulti: true as const } : {}), ...(recommended.length > 0 ? { recommended } : {}) } : {}),
    ...(text(one.command) ? { command: text(one.command) } : {}),
    ...(/^https?:\/\//.test(text(one.link)) ? { link: text(one.link) } : {}),
    ...(text(one.file).startsWith('/') ? { file: text(one.file) } : {}),
    ...(text(one.draft) ? { draft: text(one.draft) } : {}),
    ...(kind === 'task' && text(one.value) ? { ask: `${text(one.value).replace(/:\s*$/, '')}: ` } : {}),
    ...(kind === 'task' && one.look === true ? { isLook: true as const } : {}),
    ...(kind === 'task' && one.closesOn === 'restart' ? { closesOn: 'restart' as const, selfCloses: 'When Claude Code is started again.' } : {}),
    ...(kind === 'task' && one.closesOn === 'reload' ? { closesOn: 'reload' as const, selfCloses: 'When the plugins are reloaded, or Claude Code is started again.' } : {}),
  }
}

/** True for a close's reason that says what happened: models at times leave a stub where the evidence should be. */
function isEvidence(reason: string) {
  return reason.length >= 12 && !/^(placeholder|n\/a|none|tbd|done)\.?$/i.test(reason)
}

/** What the reply audit said, kept to what the ledger can hold: closes of items that are open, and new items within the cap. */
export function readReply(ledger: Ledger, reply: string, turnId?: string): ReplyRead | null {
  const said = jsonOf(reply)
  if (!said) return null
  const open = new Set(ledger.items.filter(item => item.status === 'open').map(item => item.id))
  const ids = (value: unknown) => list(value).map(text).filter(id => open.has(id))
  const closed = list(said.closed).flatMap(one => {
    const close = one as Record<string, unknown>

    return open.has(text(close.id)) && isEvidence(text(close.reason)) ? [{ id: text(close.id), how: close.how === 'dropped' ? ('dropped' as const) : ('done' as const), reason: text(close.reason) }] : []
  })
  const fresh = list(said.open).flatMap(one => newItem(one) ?? [])
  // One reply leaves at most one thing unverified: its other caveats belong in that one item.
  const kept = fresh.filter((item, at) => item.kind !== 'unverified' || fresh.findIndex(other => other.kind === 'unverified') === at)
  const settled = new Set(closed.map(close => close.id))
  const unsure = list(said.unsure).flatMap(one => {
    const doubt = one as Record<string, unknown>

    return open.has(text(doubt.id)) && !settled.has(text(doubt.id)) && text(doubt.question) !== '' ? [{ id: text(doubt.id), question: text(doubt.question) }] : []
  })
  const selfClosed = new Set(closedByClaude(ledger, turnId).map(item => item.id))
  const reopened = list(said.reopened).flatMap(one => {
    const back = one as Record<string, unknown>

    return selfClosed.has(text(back.id)) && text(back.why) !== '' ? [{ id: text(back.id), why: text(back.why) }] : []
  })
  const updated = list(said.updated).flatMap(one => {
    const more = one as Record<string, unknown>
    const isSaying = text(more.why) !== '' || text(more.close) !== ''

    return open.has(text(more.id)) && !settled.has(text(more.id)) && isSaying ? [{ id: text(more.id), why: text(more.why), close: text(more.close) }] : []
  })

  return {
    closed,
    missed: ids(said.missed).filter(id => !settled.has(id)),
    unsettled: ids(said.unsettled).filter(id => !settled.has(id)),
    unsure: unsure.slice(0, depth.forks),
    reopened,
    updated,
    open: kept.slice(0, OPENS_PER_REPLY),
  }
}

/** Events made one after another, each from the ledger as the ones before it left it. */
function builder(ledger: Ledger) {
  const made = { events: [] as Event[], now: ledger }

  return {
    made,
    push: <E extends Event>(event: E) => {
      made.events.push(event)
      made.now = apply(made.now, event)

      return event
    },
  }
}

/**
 * What the prompt pass found, as events: each new ask under its goal, each answer marked on its
 * item for the reply's audit to judge, and what was set aside brought back when the person wraps up.
 * `asked` names the asks opened, which the reply's audit checks for ones the reply skipped.
 */
export function promptEvents(ledger: Ledger, said: PromptRead, at: number) {
  const { made, push } = builder(ledger)
  const asked: string[] = []
  for (const ask of said.asks) {
    if (isListed(made.now, ask.title)) continue
    // What the person dropped and now asks for again is theirs to bring back: the ask opens, and the drop is lifted.
    const isRenewed = isDropped(made.now, ask.title)
    // A goal named by an id the ledger does not hold is a slip of the model's, not a new goal's title.
    const wanted = ask.goal !== null && /^g\d+$/.test(ask.goal) && !made.now.goals.some(goal => goal.id === ask.goal) ? null : ask.goal
    const named = made.now.goals.find(goal => goal.id === wanted || goal.title.toLowerCase() === wanted?.toLowerCase())
    const goal = wanted === null ? undefined : (named?.id ?? push(goalOpened(made.now, wanted)).goal.id)
    const event = push({
      ...opened(made.now, at, 'audit', {
        kind: 'ask',
        title: ask.title,
        from: ask.quote ? `You: "${ask.quote}"` : 'Your message.',
        why: '',
        close: ask.done,
        ...(goal ? { goal } : {}),
      }),
      ...(isRenewed ? { isRenewed } : {}),
    })
    // What the person said to keep for later is set aside as it is listed, and the reply is not held to it.
    if (ask.isHeld) push({ type: 'later', id: event.item.id, reason: HELD_REASON })
    else asked.push(event.item.id)
  }
  for (const answer of said.answers) push({ type: 'patch', id: answer.id, patch: { sent: answer.answer }, drop: ['isUnsettled'] })
  // Wrapping up brings back what the person set aside.
  if (said.isWrapUp) for (const item of made.now.items.filter(one => one.status === 'later' && one.closedBy === 'you')) push({ type: 'reopen', id: item.id })

  return { events: made.events, asked }
}

/**
 * What an audit was asked about: the ledger it was given, and the items that the messages of its
 * turn answered. `heard` is left out by a job that a build before this one kept. `isCut` is true for
 * a turn that ended without a reply, which settles nothing: its audit can only reopen what Claude closed.
 */
export type Since = { book: Ledger; heard?: string[]; isCut?: boolean }

/**
 * The items an audit leaves alone. It takes seconds and may run after the next message, so the
 * ledger it writes to is not the one it read. An item that was closed, reopened or answered while it
 * was out has moved on, and an answer that came in a message its turn never heard is for the audit
 * of the turn that does hear it.
 */
function beyond(since: Since, now: Ledger) {
  const read = new Map(since.book.items.map(item => [item.id, item]))
  const isBeyond = (item: Item) => {
    const was = read.get(item.id)
    if (!was || was.status !== item.status || was.closedBy !== item.closedBy || was.sent !== item.sent) return true

    return since.heard !== undefined && item.sent !== undefined && !since.heard.includes(item.id)
  }

  return new Set(now.items.filter(isBeyond).map(item => item.id))
}

/**
 * What the reply's audit found, as events: closes with their evidence, asks the reply skipped, what
 * was sent and not acted on, and the new items the reply leaves, less any the person dropped before
 * or the inbox already lists. With `since`, nothing is written to an item the audit must leave alone.
 */
export function replyEvents(ledger: Ledger, found: ReplyRead, at: number, since?: Since) {
  const { made, push } = builder(ledger)
  const off = since ? beyond(since, ledger) : new Set<string>()
  const within = <T extends { id: string }>(ones: T[]) => ones.filter(one => !off.has(one.id))
  if (since?.isCut) {
    for (const back of within(found.reopened)) {
      push({ type: 'reopen', id: back.id })
      push({ type: 'patch', id: back.id, patch: { why: back.why } })
    }

    return made.events
  }
  const said = { ...found, closed: within(found.closed), reopened: within(found.reopened), updated: within(found.updated), missed: found.missed.filter(id => !off.has(id)), unsettled: found.unsettled.filter(id => !off.has(id)) }
  for (const close of said.closed) push({ type: 'close', id: close.id, how: close.how, by: 'audit', reason: `${BY_REPLY}${close.reason}` })
  // While something Claude started still runs in the background, the work is not over: an ask not yet done is not one that was skipped.
  const isBusy = made.now.items.some(item => item.kind === 'running' && item.status === 'open')
  for (const id of said.missed) if (!isBusy && made.now.items.some(item => item.id === id && item.kind === 'ask')) push({ type: 'patch', id, patch: { isMissed: true } })
  for (const id of said.unsettled) push({ type: 'patch', id, patch: { isUnsettled: true }, drop: ['sent'] })
  // What was sent has now been read. An item the audit neither closed nor called unsettled is open as before.
  for (const item of made.now.items.filter(one => one.status === 'open' && one.sent !== undefined && !off.has(one.id))) push({ type: 'patch', id: item.id, patch: {}, drop: ['sent'] })
  // A close Claude made on its own word, which the exchange does not bear out, is open again with what is missing.
  for (const back of said.reopened) {
    push({ type: 'reopen', id: back.id })
    push({ type: 'patch', id: back.id, patch: { why: back.why } })
  }
  // An item a reply says more about takes the newer account of it.
  for (const more of said.updated) {
    const isAsk = made.now.items.some(item => item.id === more.id && item.kind === 'ask')
    // What closes an ask is what the person asked for, in the words read off their message. No reply rewrites that.
    push({ type: 'patch', id: more.id, patch: { ...(more.why === '' ? {} : { why: more.why }), ...(more.close === '' || isAsk ? {} : { close: more.close }) }, drop: ['isMissed'] })
  }
  for (const { goal: named, ...rest } of said.open) {
    // A goal the ledger does not hold is a slip of the model's: the item is then one of no goal.
    const fields = made.now.goals.some(goal => goal.id === named) ? { ...rest, goal: named } : rest
    // A reload or a restart is one task however many replies ask for it: the open one takes the newest wording.
    const same = fields.closesOn && made.now.items.find(item => item.status === 'open' && item.closesOn === fields.closesOn)
    if (same) push({ type: 'patch', id: same.id, patch: { title: fields.title, from: fields.from, why: fields.why, close: fields.close } })
    else if (!isDropped(made.now, fields.title) && !isListed(made.now, fields.title)) push(opened(made.now, at, 'audit', fields))
  }

  return made.events
}

/** What the fork said about one item: whether it is done, and the evidence. */
/** What the audit of a subagent said, kept to what it may open: issues and untested claims, within its cap. */
export function readAgent(reply: string): NewItem[] {
  const fresh = list(jsonOf(reply)?.open)
    .flatMap(one => newItem(one) ?? [])
    .filter(item => item.kind === 'issue' || item.kind === 'unverified')

  return fresh.filter((item, at) => item.kind !== 'unverified' || fresh.findIndex(other => other.kind === 'unverified') === at).slice(0, OPENS_PER_AGENT)
}

/**
 * What the audit of a subagent found, as events: its new items, less any the person dropped before
 * or the inbox already lists, and no more of them than `room`.
 */
export function agentEvents(ledger: Ledger, found: NewItem[], at: number, room: number) {
  const { made, push } = builder(ledger)
  for (const fields of found) if (made.events.length < room && !isDropped(made.now, fields.title) && !isListed(made.now, fields.title)) push(opened(made.now, at, 'audit', fields))

  return made.events
}

export function readFork(reply: string) {
  const said = jsonOf(reply)

  return said && typeof said.done === 'boolean' ? { isDone: said.done, reason: text(said.reason) } : null
}
