/** What an inbox item is, which decides the section it sits in. */
export type Kind = 'stopped' | 'check' | 'question' | 'task' | 'issue' | 'opportunity' | 'unverified' | 'ask' | 'running'

/** Who opened or closed an item: the person, the audit's model, Claude through the tool, or the mod's own signals. */
export type Actor = 'you' | 'audit' | 'claude' | 'engine'

/** One thing a conversation left open, with what is known about it and what closing it takes. */
export type Item = {
  id: string
  kind: Kind
  title: string
  /** Where it came from, in words: whose message, and what it said. */
  from: string
  why: string
  /** What closing it takes. */
  close: string
  /** The count of prompts sent when it opened, and the time. */
  turn: number
  at: number
  by: Actor
  status: 'open' | 'later' | 'done' | 'dropped'
  /** Once closed or set aside: who did it, how it came about, and the count of prompts then. */
  closedBy?: Actor
  reason?: string
  closedTurn?: number
  /**
   * The id of the engine's turn in which Claude closed it, which is the turn whose audit reviews the
   * close, and how many of that turn's messages had reached Claude by then.
   */
  closedIn?: string
  closedHeard?: number
  /** The goal it belongs to: an ask, or a question, a task or a finding about that piece of work. */
  goal?: string
  /** A look at it in the background, running or come back. */
  check?: Check
  /** True for an ask that a reply neither did nor mentioned. */
  isMissed?: true
  /** What the person last sent about it from the panel, kept until the reply to that is read. */
  sent?: string
  /** True when it was sent and the reply did not settle it. */
  isUnsettled?: true
  /** True when the prompt it came from is no longer in the conversation: the person rewound past it. */
  isRewound?: true
  /** A question's answers, each one click. */
  options?: string[]
  /** True for a question that takes several answers. */
  isMulti?: true
  /** The answers Claude recommended, by their place in `options`. */
  recommended?: number[]
  /** The question dialog a question was left in, by its tool call. */
  dialog?: string
  /** A task's command, a page it is done on, a file it is about, and text drafted for the person to send. */
  command?: string
  link?: string
  file?: string
  draft?: string
  /** A value only the person has: what to call it in the prompt, typed in the card. */
  ask?: string
  /** True for something only the person's eyes can judge. */
  isLook?: true
  /** What the mod watches for to close it without anyone saying so, in words. */
  selfCloses?: string
  /** The event that closes it by itself: a restart of Claude Code, or a reload of its plugins. */
  closesOn?: 'restart' | 'reload'
  /** What a failing check or a running task follows: the command, or the task's id. */
  key?: string
}

/**
 * A look at an item that an agent takes beside the conversation: a check of something that was
 * never run, or where a running task stands. Nothing of it enters the conversation.
 */
export type Check = {
  state: 'running' | 'back'
  /** When it started, and once it is back, when it came back. */
  at: number
  /** The agent taking it, while it runs. */
  agent?: string
  /** How a check of a finding came out. A look at a running task has none. */
  verdict?: 'passed' | 'failed' | 'unclear'
  /** What was found, in words. */
  text?: string
  /** How many steps the agent has taken. `ran` keeps only the newest of them, so its length is not the count. */
  steps?: number
  /** The newest of the commands that were run to find it, each with how it ended. */
  ran?: string[]
  /** What the item was before a failed check made an issue of it, for when the person throws the result away. */
  was?: { kind: Kind; title: string; close?: string }
}

/** A piece of work the person asked for, which its items sit under. */
export type Goal = { id: string; title: string; turn: number }

/** Everything the inbox holds for one conversation. It is rebuilt from the conversation's log of events. */
export type Ledger = {
  items: Item[]
  goals: Goal[]
  nextId: number
  /** How many prompts the person has sent. */
  turn: number
  /** Titles of items the person dropped, so that the same thing is not opened again. */
  dropped: string[]
}

/** One line of a conversation's inbox log. `note` lines change nothing: they record a model call, a tool call or a signal. */
export type Event =
  | { type: 'turn' }
  | { type: 'goal'; goal: Goal }
  | { type: 'open'; item: Item; isRenewed?: boolean }
  | { type: 'close'; id: string; how: 'done' | 'dropped'; by: Actor; reason: string; in?: string; heard?: number }
  | { type: 'later'; id: string; reason: string }
  | { type: 'reopen'; id: string }
  | { type: 'patch'; id: string; patch: Partial<Item>; drop?: (keyof Item)[] }
  | { type: 'retract'; to: Ledger }
  | { type: 'rewind'; turn: number }
  | { type: 'note'; what: string; detail: unknown }

/** What the panel shows and holds between presses. It lasts for the session and is not logged. */
export type View = {
  /** Which build's fields this value has. One stored by a build with other fields is not read. */
  shape: number
  isPanelOpen: boolean
  /** The sections and goals that are minimized, by key. */
  folded: string[]
  /** The items whose cards are open. Opening one leaves the others as they are. */
  open: string[]
  /** The items whose check shows the commands it ran. */
  detailed: string[]
  /** Items whose capture waits in the prompt box, each with the line that shows it is still there. */
  added: Record<string, string>
  /** What the person has typed into an item's text box, and the answers ticked on it. */
  typed: Record<string, string>
  picks: Record<string, number[]>
  /** The goals whose finished items are listed. */
  shownGoals: string[]
  /** The agents the mod started to look at items, whose reports must never reach the conversation. */
  agents: string[]
  /** Raised to draw the panel again when only the time has moved on. */
  tick: number
}

/**
 * The audit of a reply that the end of a turn asked for and that has not finished: the turn, its
 * reply, the prompts it answered, and the tool calls made in it. With them, when the turn had any:
 * what Claude wrote before the reply, what its subagents did, and its todo list as the turn ended.
 */
export type Pending = { id: string; answer: string; turn: { text: string; isNotice: boolean; asked: string[]; answered?: string[] }[]; did?: string[]; said?: string[]; agents?: string[]; todo?: string[]; isCut?: boolean }

/**
 * The turn that is running, kept where a reload of the mod leaves it: the engine's id of the turn,
 * the messages that have reached Claude in it, and the ones the person sent that have not yet.
 */
export type Running = { id?: string; heard: Pending['turn'] | null; waiting: Pending['turn'] }

declare module 'claude-code' {
  interface PluginState {
    inbox: { ledger: Ledger; view: View; pending: Pending | null; running: Running | null }
  }
}
