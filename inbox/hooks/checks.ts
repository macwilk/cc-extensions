// A look at an item in the background: what the agent that takes it is, what it is asked, and how
// what it hands back is read. Nothing here touches the engine.
import type { Check, Event, Item } from '../types'

/** The agent type the mod registers, as the engine names it: the plugin's name, then the type's. */
export const AGENT = 'checker'
export const AGENT_TYPE = `inbox:${AGENT}`
/** How long after a result came back asking again is offered: sooner, the answer would be the same. */
export const ASK_AGAIN_AFTER = 3 * 60_000
export const CHECKS_AT_ONCE = 3
/** How many of the agent's commands a check keeps to show. */
const RAN_KEPT = 12

/**
 * The agent looks and reports, and changes nothing: fixing what a check finds is work for the
 * conversation, where the person sees it and can stop it.
 */
export const AGENT_SPEC = {
  name: AGENT,
  description: 'Looks into one thing for the inbox by reading and running, and reports what it saw. Started by the inbox, not by Claude.',
  prompt: [
    'You look into one thing and report what you saw. You work beside a conversation between a user and Claude, and neither of them sees you work.',
    'You may read files and run commands that change nothing. Never edit, write, move or delete a file, never commit or push, never install anything, and never stop or restart a process you did not start. If settling it would take any of those, say so in your report instead.',
    'Run the least that settles it, and do not ask anyone anything. When you have your answer, hand back your report once, in the form you were asked for, and end your turn.',
  ].join(' '),
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
}

/** The engine's tool that an agent hands its report back with. */
export const HAND_BACK = 'SubagentHandback'
/** What the engine's hand-back tool is told once the mod has the report, so that the agent stops there. */
export const RECEIVED = 'Delivered. Your work is finished: end your turn now with one word and do not call this tool again.'
export const STOPPED = 'This look was stopped by the user. End your turn now with one word and call no more tools.'
/** What closes an issue that a failed check made. What the claim before it was waiting on is not what settles the problem found. */
export const ISSUE_CLOSE = 'Fix the problem that the check found, and show by running that it is gone.'

/**
 * How a report is to be written: it is read in a narrow side panel, which draws it as Markdown, by
 * a person who wants the answer and not how it was reached.
 */
const FOR_THE_PANEL =
  'It is read in a narrow side panel, so each bullet is one short fact on a line of its own that starts with "- ". Put every command, path, file name, id and value in backticks. Leave out process ids, temporary paths and how you went about it, unless the user needs them to act.'

/** True for an item a look in the background can be taken at: a finding that was never run, or something still running. */
export function canCheck(item: Item) {
  return item.status === 'open' && (item.kind === 'unverified' || item.kind === 'running' || item.check?.was !== undefined)
}

/** What the agent is asked: to check a finding by running it, or to say where a running task stands. */
export function checkAsk(item: Item) {
  if (item.kind === 'running') {
    return [
      'Find out where this background task stands right now. Do not stop it, restart it or wait for it to end.',
      `The task: ${item.title}`,
      item.why,
      ...(item.key ? [`Its task id: ${item.key}`] : []),
      'Look at what it has written so far: its output, the files it writes, and whether its process is alive.',
      'Report in this form and nothing else:',
      `REPORT: where it stands, in one short sentence. Then at most four bullets: how far along it is, whether anything has gone wrong, and when it looks like ending. ${FOR_THE_PANEL}`,
    ].join('\n')
  }

  return [
    'Check whether this holds by running it. Reading the code alone does not settle it.',
    `What was never run: ${item.check?.was?.title ?? item.title}`,
    `What is known: ${item.why}`,
    `What would settle it: ${item.check?.was?.close ?? item.close}`,
    ...(item.file ? [`The file it is about: ${item.file}`] : []),
    'Report in this form and nothing else:',
    'VERDICT: passed, failed or unclear',
    'TITLE: only when it failed, the problem you found, as one plain sentence of at most 14 words, with no backticks',
    `REPORT: what you found, in one short sentence. Then at most four bullets: what you ran and what you saw. ${FOR_THE_PANEL}`,
    '"passed" means you ran it and it holds. "failed" means you ran it and it does not hold. "unclear" means you could not run it, or what you saw does not settle it: then the report says why.',
  ].join('\n')
}

/** One field of a report: the text after its name, up to the next field. */
function fieldOf(message: string, name: string) {
  return new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?=^(?:VERDICT|TITLE|REPORT):|$(?![\\s\\S]))`, 'm').exec(message)?.[1]?.trim() ?? ''
}

/**
 * What the agent handed back, as the events it causes. A report that does not follow the form is
 * one that settled nothing, with its words kept. A check that failed makes an issue of the item,
 * under the problem the agent named and closed by that problem's fix, and remembers what the item was.
 */
export function checkBack(item: Item, message: string, at: number): Event[] {
  const text = fieldOf(message, 'REPORT') || message.trim()
  const kept = { state: 'back' as const, at, text, ...tracesOf(item.check) }
  if (item.kind === 'running') return [{ type: 'patch', id: item.id, patch: { check: kept } }]
  // What the item was before an earlier look made an issue of it: a second look starts from that again.
  const was = item.check?.was ?? { kind: item.kind, title: item.title, close: item.close }
  const said = fieldOf(message, 'VERDICT').toLowerCase()
  const verdict = said.startsWith('passed') ? 'passed' : said.startsWith('failed') ? 'failed' : 'unclear'
  if (verdict !== 'failed') return [{ type: 'patch', id: item.id, patch: { ...was, check: { ...kept, verdict } } }]
  // A title is drawn as plain text, where a backtick would show as one.
  const title = (fieldOf(message, 'TITLE').split('\n')[0] ?? '').replaceAll('`', '')

  return [{ type: 'patch', id: item.id, patch: { kind: 'issue', title: title || was.title, close: ISSUE_CLOSE, check: { ...kept, verdict, was } } }]
}

/**
 * A look whose agent ended with no report, as one that settled nothing. A look is never ended
 * for taking long: the agent of one that timed out came back a minute later, and its report was
 * thrown away. It runs until its agent ends or the person stops it.
 */
export function checkLost(item: Item, at: number, why: string): Event[] {
  const lost: Check = { state: 'back', at, text: why, ...(item.kind === 'running' ? {} : { verdict: 'unclear' as const }), ...tracesOf(item.check) }

  return [{ type: 'patch', id: item.id, patch: { ...(item.check?.was ?? {}), check: lost } }]
}

/** Throwing a result away: the item is what it was before the look, an issue made by a failed check included. */
export function checkDismissed(item: Item): Event[] {
  return [{ type: 'patch', id: item.id, patch: item.check?.was ?? {}, drop: ['check'] }]
}

/** One command of the agent's, kept with how it ended, for the person who wants to see how the answer was found. */
export function ranLine(tool: string, input: Record<string, unknown>, output: string) {
  const last = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)
  if (tool === 'Bash') return `$ ${String(input.command ?? '').split('\n').join(' ').slice(0, 160)}${last ? ` => ${last.slice(0, 120)}` : ''}`

  return `${tool} ${String(input.file_path ?? input.pattern ?? input.path ?? '').slice(0, 160)}`
}

/**
 * The check with one more step: counted, and its command put on the list, the oldest dropped once
 * the list is full. The count is kept apart from the list, which would stop at its own length.
 */
export function withRan(check: Check, line: string): Check {
  return { ...check, steps: stepsOf(check) + 1, ran: [...(check.ran ?? []), line].slice(-RAN_KEPT) }
}

/** How many steps a check has taken. */
export function stepsOf(check: Check) {
  return check.steps ?? check.ran?.length ?? 0
}

/** What a look that has ended keeps of how it was taken. */
function tracesOf(check: Check | undefined) {
  return check?.ran ? { steps: stepsOf(check), ran: check.ran } : {}
}

/** What goes with an item into the prompt box when a look found something for the conversation to act on. */
export function sayOfCheck(check: Check) {
  if (check.verdict === 'failed') return `A check in the background found this: ${check.text ?? ''} Fix it, then show me that it holds.`

  return `A check in the background could not settle this: ${check.text ?? ''}`
}
