import { expect, test } from 'claude-code/testing'

import { RULE, draftOf, sayOf, sentOf } from '../hooks/capture'
import { EMPTY, apply, goalOpened, opened } from '../hooks/ledger'
import { checkOf, leftQuestions } from '../hooks/signals'
import { RECORDS_PER_TURN, answerTool } from '../hooks/tool'
import { ASKS_PER_PROMPT, DEPTHS, agentAsk, agentEvents, agentPart, didLines, readAgent, readAt, jsonOf, lastReplyOf, promptAsk, promptEvents, readPrompt, readReply, replyAsk, replyEvents, saidOf, todoOf, toolLine, useOf } from '../hooks/workers'
import type { Event, Ledger } from '../types'

const QUESTION = { kind: 'question' as const, title: 'Which license should the mods use?', from: 'My reply.', why: 'The manifests need one.', close: 'Pick one of the answers.', options: ['GPL-3.0-or-later', 'MIT'] }
const FINDING = { kind: 'issue' as const, title: 'Demo scripts live only in a temp folder', from: 'Claude', why: 'They are lost when it is cleaned.', close: 'Move them into the repo.' }

function ledgerOf(...steps: ((ledger: Ledger) => Event)[]) {
  return steps.reduce((now, step) => apply(now, step(now)), EMPTY)
}

test('a command is a check only when its exit status is its own', async () => {
  expect(checkOf('npx -p typescript tsc -p inbox')).toBe('npx -p typescript tsc -p inbox')
  expect(checkOf('cd app && npm test')).toBe('cd app && npm test')
  expect(checkOf('cd app; python3 -m unittest -q')).toBe('cd app; python3 -m unittest -q')
  expect(checkOf('cd app && npm test; echo done')).toBe(null)
  expect(checkOf('npm test | tail -5')).toBe(null)
  expect(checkOf('pytest tests/unit 2>&1')).toBe('pytest tests/unit 2>&1')
  expect(checkOf('git status')).toBe(null)
})

test('a dialog left through Chat about this gives each unanswered question as an item with its answers', async () => {
  const asked = [
    { question: 'Which fruit?', options: [{ label: 'Apple (Recommended)', description: 'Crisp.' }, { label: 'Banana' }] },
    { question: 'Which toppings?', multiSelect: true, options: [{ label: 'Honey' }, { label: 'Granola' }] },
  ]
  const reply = 'The user wants to clarify these questions.\n\n    Questions asked:\n- "Which fruit?"\n  Answer: Apple\n- "Which toppings?"\n  (No answer provided)'
  const left = leftQuestions(asked, reply, true, 'toolu_1', '1:12 AM')

  expect(left.map(item => item.title)).toEqual(['Which toppings?'])
  expect(left[0]).toMatchObject({ kind: 'question', options: ['Honey', 'Granola'], isMulti: true, dialog: 'toolu_1' })
  expect(leftQuestions(asked, 'The user answered: ...', false, 'toolu_1', '1:12 AM')).toEqual([])
  expect(leftQuestions(asked, 'The user rejected the tool use.', true, 'toolu_1', '1:12 AM')[0]).toMatchObject({ title: 'Which fruit?', options: ['Apple', 'Banana'], recommended: [0] })
})

test('the tool lists what is open, closes with a reason, and records within its limits', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', QUESTION))

  expect(answerTool(ledger, { action: 'list' }, 0, 0).text).toContain('i1 [Question] Which license should the mods use?')
  expect(answerTool(ledger, { action: 'close', id: 'i1' }, 0, 0).events).toEqual([])
  expect(answerTool(ledger, { action: 'close', id: 'i1', reason: 'The user chose GPL.' }, 0, 0).events).toEqual([{ type: 'close', id: 'i1', how: 'done', by: 'claude', reason: 'Claude closed it: The user chose GPL.' }])

  const recorded = answerTool(ledger, { action: 'record', kind: 'issue', title: FINDING.title, why: FINDING.why }, 5, 0)
  expect(recorded.events[0]).toMatchObject({ type: 'open', item: { id: 'i2', kind: 'issue', by: 'claude' } })
  expect(answerTool(ledger, { action: 'record', title: FINDING.title, why: FINDING.why }, 5, RECORDS_PER_TURN).events).toEqual([])
})

test('an ask of this turn to record a finding does not stand in the way of recording it', async () => {
  const ask = { kind: 'ask' as const, title: `Record that ${FINDING.title}`, from: 'You', why: '', close: 'The finding is in the inbox.' }
  const asked = ledgerOf(() => ({ type: 'turn' }), now => opened(now, 0, 'audit', ask))
  const record = { action: 'record', kind: 'issue', title: FINDING.title, why: FINDING.why }

  expect(answerTool(asked, record, 5, 0).events[0]).toMatchObject({ type: 'open', item: { kind: 'issue', title: FINDING.title } })
  // An ask left open from an earlier turn still counts as the inbox listing it.
  expect(answerTool(apply(asked, { type: 'turn' }), record, 5, 0).text).toBe('Not recorded: the inbox already lists this.')
})

// The prompt box holds an item's id and title alone: the rest is what Claude gets by the id.
test('the tool hands over in full each item a message quotes, and names an id it does not know', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', QUESTION))
  const got = answerTool(ledger, { action: 'get', ids: ['i1', 'i9'] }, 0, 0)

  expect(JSON.parse(got.text.split('\n\n')[0] ?? '')).toEqual([
    { id: 'i1', kind: 'Question', title: QUESTION.title, status: 'open', where: 'Needs you / Questions', from: QUESTION.from, why: QUESTION.why, toClose: QUESTION.close, answers: QUESTION.options },
  ])
  expect(got.text).toContain('No item has the id i9.')
  expect(got.events).toEqual([])
  expect(answerTool(ledger, { action: 'get' }, 0, 0).text).toContain('A get needs `ids`')
})

// Claude closes what the person asked for as it finishes each thing, without first listing the inbox.
test('the tool closes an ask named by a few words, and says what the person asked for is still open', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the branch to release', from: 'You', why: '', close: 'git branch shows release.' }),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Write the changelog entry', from: 'You', why: '', close: 'CHANGELOG.md has an entry for this release.' }),
  )
  const closed = answerTool(ledger, { action: 'close', about: 'rename branch', reason: 'git branch now shows release.' }, 0, 0)

  expect(closed.events).toEqual([{ type: 'close', id: 'i1', how: 'done', by: 'claude', reason: 'Claude closed it: git branch now shows release.' }])
  expect(closed.text).toBe('Closed i1: Rename the branch to release. Still open from the user: i2 "Write the changelog entry" (done when: CHANGELOG.md has an entry for this release.).')
})

test('words that fit two items alike, or none, close nothing and bring back the ids to choose from', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the branch to release', from: 'You', why: '', close: 'git branch shows release.' }),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the tag to release', from: 'You', why: '', close: 'git tag shows release.' }),
  )
  const unclear = answerTool(ledger, { action: 'close', about: 'rename release', reason: 'Done.' }, 0, 0)
  const unknown = answerTool(ledger, { action: 'close', about: 'deploy the site', reason: 'Done.' }, 0, 0)

  expect(unclear.events).toEqual([])
  expect(unclear.text).toContain('No open item clearly matches "rename release", so nothing was closed. Still open from the user: i1 "Rename the branch to release"')
  expect(unknown.events).toEqual([])
  expect(answerTool(ledger, { action: 'close', about: 'rename the tag', reason: 'git tag shows release.' }, 0, 0).events).toMatchObject([{ type: 'close', id: 'i2' }])
})

// A close Claude makes while it works rests on its own word. The audit of the reply is the check on it.
test('the reply audit reopens what Claude closed itself when the exchange does not bear the close out', async () => {
  const ledger = ledgerOf(
    () => ({ type: 'turn' }),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the branch to release', from: 'You', why: '', close: 'git branch shows release.' }),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Write the changelog entry', from: 'You', why: '', close: 'CHANGELOG.md has an entry.' }),
    () => ({ type: 'close', id: 'i1', how: 'done', by: 'claude', reason: 'Claude closed it: git branch shows release.' }),
    () => ({ type: 'close', id: 'i2', how: 'done', by: 'claude', reason: 'Claude closed it: The entry is written.' }),
  )

  expect(replyAsk(ledger, [], 'rename and write', false, [], 'Renamed.')).toContain('CLOSED BY CLAUDE THIS TURN\ni1 Rename the branch to release. To close: git branch shows release. Claude closed it: git branch shows release.\ni2 ')

  const said = readReply(ledger, JSON.stringify({ reopened: [{ id: 'i2', why: 'No edit to CHANGELOG.md was made: the reply only says it will be written.' }, { id: 'i9', why: 'No such item.' }] }))
  const after = (said ? replyEvents(ledger, said, 9) : []).reduce(apply, ledger)

  expect(after.items.map(item => [item.id, item.status])).toEqual([
    ['i1', 'done'],
    ['i2', 'open'],
  ])
  expect(after.items[1]?.why).toBe('No edit to CHANGELOG.md was made: the reply only says it will be written.')
})

test('the tool refuses to record again what the person dropped or what is already listed', async () => {
  const listed = ledgerOf(now => opened(now, 0, 'claude', FINDING))
  const dropped = apply(listed, { type: 'close', id: 'i1', how: 'dropped', by: 'you', reason: 'You dropped it.' })
  const again = { action: 'record', title: 'The demo scripts only live in a temp folder', why: 'Still true.' }

  expect(answerTool(listed, again, 0, 0)).toEqual({ events: [], text: 'Not recorded: the inbox already lists this.' })
  expect(answerTool(dropped, again, 0, 0).text).toContain('the user dropped this before')
})

test('an answer picked in the panel is found again in the prompt that was sent, apart from what the person typed besides', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', QUESTION))
  const [item] = ledger.items
  const draft = item && draftOf('also bump the version', item, 80, 'Answer: GPL-3.0-or-later')
  const { sent, rest } = sentOf(draft?.text ?? '', { i1: draft?.mark ?? '' })

  expect(draft?.text).toBe(`also bump the version${RULE}> Inbox i1: Which license should the mods use?\n\nAnswer: GPL-3.0-or-later\n\n`)
  expect(sent).toEqual([{ id: 'i1', said: 'Answer: GPL-3.0-or-later' }])
  expect(rest).toBe('also bump the version')
})

test('text typed beside ticked answers goes on its own line', async () => {
  const [item] = ledgerOf(now => opened(now, 0, 'audit', { ...QUESTION, isMulti: true })).items

  expect(item && sayOf(item, [0, 1], 'nightly, on weekdays', 'Answer: ')).toBe('Answer: GPL-3.0-or-later, MIT\nCustom: nightly, on weekdays')
  expect(item && sayOf(item, [], 'ask me each time', 'Answer: ')).toBe('Answer: ask me each time')
  expect(item && sayOf(item, [], ' ', 'Answer: ')).toBe('')
})

test('the prompt pass opens each ask under its goal, and skips one the inbox already lists', async () => {
  const ledger = ledgerOf(
    now => goalOpened(now, 'Publish the mods'),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Push the mods to GitHub', from: 'You', why: '', close: '', goal: 'g1' }),
  )
  const said = readPrompt(
    ledger,
    'Here you go:\n```json\n{"asks": [{"title": "Push the mods to GitHub", "done": "The commits are on GitHub.", "quote": "push it", "goal": "g1"}, {"title": "License the mods under GPL", "done": "Each mod has a GPL LICENSE file.", "quote": "gpl pls", "goal": "g1"}, {"title": "Write a blog post", "done": "A draft post exists.", "quote": "a post", "goal": "Announce the mods"}, {"title": "Say what 2 plus 2 is", "done": "The reply gives the sum.", "quote": "2+2?", "goal": "g9"}, {"title": "Polish the panel", "done": "", "quote": "polish it", "goal": null}], "answers": [{"id": "i2", "answer": "yes"}, {"id": "i77", "answer": "no"}], "wrap": false}\n```',
  )
  const made = said && promptEvents(ledger, said, 0)
  const after = (made?.events ?? []).reduce(apply, ledger)

  // An ask that does not say what would show it finished is not listed: it could never be closed.
  expect(said?.asks.map(ask => ask.title)).not.toContain('Polish the panel')
  expect(after.items[1]).toMatchObject({ title: 'License the mods under GPL', close: 'Each mod has a GPL LICENSE file.' })
  expect(said?.answers).toEqual([{ id: 'i2', answer: 'yes' }])
  expect(after.goals.map(goal => goal.title)).toEqual(['Publish the mods', 'Announce the mods'])
  expect(after.items.map(item => [item.title, item.goal])).toEqual([
    ['Push the mods to GitHub', 'g1'],
    ['License the mods under GPL', 'g1'],
    ['Write a blog post', 'g4'],
    ['Say what 2 plus 2 is', undefined],
  ])
  expect(made?.asked).toEqual(['i3', 'i5', 'i6'])
})

test('the reply audit closes with evidence, marks a skipped ask, and opens what the reply leaves', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Create notes.txt', from: 'You', why: '', close: '' }),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the branch', from: 'You', why: '', close: '' }),
    now => opened(now, 0, 'claude', FINDING),
    () => ({ type: 'patch', id: 'i3', patch: { sent: 'Fix it now.' } }),
    () => ({ type: 'close', id: 'i3', how: 'dropped', by: 'you', reason: 'You dropped it.' }),
  )
  const said = readReply(
    ledger,
    JSON.stringify({
      closed: [
        { id: 'i1', how: 'done', reason: 'Write created notes.txt.' },
        { id: 'i9', how: 'done', reason: 'No such item.' },
      ],
      missed: ['i2'],
      open: [
        { kind: 'question', title: 'Commit the change?', from: 'My reply: "Shall I commit?"', why: 'One file is edited.', close: 'A yes or a not yet.', options: ['Yes, do it', 'Not yet'], recommended: [0] },
        { kind: 'issue', title: 'The demo scripts only live in a temp folder', why: 'Again.' },
        { kind: 'task', title: 'Give the ticket', value: 'Ticket', why: 'The branch name needs it.' },
      ],
    }),
  )
  const after = (said ? replyEvents(ledger, said, 9) : []).reduce(apply, ledger)

  expect(after.items.map(item => [item.id, item.status, item.isMissed ?? false])).toEqual([
    ['i1', 'done', false],
    ['i2', 'open', true],
    ['i3', 'dropped', false],
    ['i4', 'open', false],
    ['i5', 'open', false],
  ])
  expect(after.items[0]?.reason).toBe('The reply closed it: Write created notes.txt.')
  expect(after.items[3]).toMatchObject({ kind: 'question', options: ['Yes, do it', 'Not yet'], recommended: [0], by: 'audit' })
  expect(after.items[4]).toMatchObject({ kind: 'task', ask: 'Ticket: ' })
})

// A reply that works on an ask and does not finish it, or that repeats a caveat, says more about an
// item already open. Opening a second item about it is how an inbox fills with repeats.
test('the reply audit adds what a reply found to the open item it is about, and the item keeps the prompt it came from', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Fix the scroll snapping back', from: 'You', why: '', close: 'The view holds still when scrolled.' }),
    now => opened(now, 0, 'claude', FINDING),
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'unverified', title: 'The fold was not seen in a live session' }),
    () => ({ type: 'patch', id: 'i1', patch: { isMissed: true } }),
    () => ({ type: 'turn' }),
    () => ({ type: 'turn' }),
  )
  const said = readReply(
    ledger,
    JSON.stringify({
      closed: [{ id: 'i2', how: 'done', reason: 'The scripts were moved into the repo.' }],
      updated: [
        { id: 'i1', why: 'Not reproduced in 180 wheel ticks.', close: 'The user says when it snaps.' },
        { id: 'i2', why: 'Closed in this same reply.' },
        { id: 'i3', why: 'Still only run in scratch sessions.', close: 'Run a spree in a live session.' },
        { id: 'i9', why: 'No such item.' },
      ],
    }),
  )
  const after = (said ? replyEvents(ledger, said, 9) : []).reduce(apply, ledger)

  expect(said?.updated.map(more => more.id)).toEqual(['i1', 'i3'])
  expect(after.items).toHaveLength(3)
  // What closes an ask is what the person asked for: a reply adds what it found and rewrites no part of that.
  expect(after.items[0]).toMatchObject({ status: 'open', why: 'Not reproduced in 180 wheel ticks.', close: 'The view holds still when scrolled.', turn: 0 })
  expect(after.items[0]?.isMissed).toBeUndefined()
  expect(after.items[2]).toMatchObject({ status: 'open', why: 'Still only run in scratch sessions.', close: 'Run a spree in a live session.', turn: 0 })
})

test('what a reply leaves joins the goal it is about, when the audit names a goal the inbox holds', async () => {
  const ledger = ledgerOf(
    now => goalOpened(now, 'Ten more themes'),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Add ten common themes', from: 'You', why: '', close: 'Ten themes exist.', goal: 'g1' }),
  )
  const said = readReply(
    ledger,
    JSON.stringify({
      open: [
        { kind: 'question', title: 'Should the new themes switch to the dark base?', why: 'Diff colors.', close: 'Pick one.', options: ['Switch them', 'Leave them'], goal: 'g1' },
        { kind: 'issue', title: 'Old commits on GitHub still show your work email', why: 'By hash.', close: 'Ask Support.', goal: 'g9' },
        { kind: 'unverified', title: 'The copy button was never clicked', why: 'Untested.', close: 'Click it.', goal: 'Ten more themes' },
      ],
    }),
  )
  const after = (said ? replyEvents(ledger, said, 0) : []).reduce(apply, ledger)

  expect(after.items.slice(1).map(item => [item.kind, item.goal])).toEqual([
    ['question', 'g1'],
    ['issue', undefined],
    ['unverified', undefined],
  ])
})

test('an update that says nothing leaves the item as it was', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'claude', FINDING))
  const said = readReply(ledger, JSON.stringify({ updated: [{ id: 'i1', why: ' ', close: '' }] }))

  expect(said?.updated).toEqual([])
})

test('wrapping up brings back what the person set aside', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'claude', FINDING),
    () => ({ type: 'later', id: 'i1', reason: 'You set it aside.' }),
  )
  const said = readPrompt(ledger, '{"asks": [], "answers": [], "wrap": true}')
  const after = (said ? promptEvents(ledger, said, 0).events : []).reduce(apply, ledger)

  expect(after.items.map(item => item.status)).toEqual(['open'])
})

// "Put a pin in those" names work to keep, not work to do now: it has to be in the inbox, set aside,
// and the reply that follows must not be marked as having skipped it.
test('what the person says to keep for later is listed as set aside under one goal, and comes back on a wrap up', async () => {
  const held = (title: string) => ({ title, done: 'It is done and shown.', quote: 'put a pin in those', goal: 'Before commit and push', hold: true })
  const said = readPrompt(EMPTY, JSON.stringify({ asks: [held('Record the tool lines GIF again'), held('See a set-aside item come back on a commit'), { title: 'Fix the tag colors', done: 'The tag has its own color.', quote: '', goal: null }] }))
  const made = said ? promptEvents(EMPTY, said, 0) : { events: [], asked: [] }
  const after = made.events.reduce(apply, EMPTY)

  expect(after.goals.map(goal => goal.title)).toEqual(['Before commit and push'])
  expect(after.items.map(item => [item.status, item.closedBy, item.goal])).toEqual([
    ['later', 'you', after.goals[0]?.id],
    ['later', 'you', after.goals[0]?.id],
    ['open', undefined, undefined],
  ])
  expect(made.asked).toEqual([after.items[2]?.id])

  const wrap = readPrompt(after, '{"asks": [], "answers": [], "wrap": true}')

  expect((wrap ? promptEvents(after, wrap, 0).events : []).reduce(apply, after).items.map(item => item.status)).toEqual(['open', 'open', 'open'])
})

test('a message that lists many requests gives an ask for each, and the prompt read is shown the reply the message answers', async () => {
  const many = Array.from({ length: 20 }, (_, at) => ({ title: `Change setting number ${at} in the panel`, done: 'It is changed.', quote: '', goal: null }))
  const messages = [{ role: 'assistant', text: 'An older reply.' }, { role: 'user', text: 'ok' }, { role: 'assistant', text: 'Before commit: record the GIF again.' }, { role: 'assistant', text: ' ', toolUses: [] }]

  expect(readPrompt(EMPTY, JSON.stringify({ asks: many }))?.asks).toHaveLength(ASKS_PER_PROMPT)
  expect(lastReplyOf(messages)).toBe('Before commit: record the GIF again.')
  expect(promptAsk(EMPTY, 'put a pin in those', lastReplyOf(messages))).toContain("CLAUDE'S LAST REPLY\nBefore commit: record the GIF again.\n\nMESSAGE\nput a pin in those")
})

test('an ask is not marked as missed while something Claude started is still running', async () => {
  const asked = ledgerOf(now => opened(now, 0, 'audit', { kind: 'ask', title: 'Finish the remaining work', from: 'You', why: '', close: '' }))
  const busy = apply(asked, opened(asked, 0, 'engine', { kind: 'running', title: 'Replay 66 exchanges', from: 'Claude', why: '', close: '', key: 'b1' }))
  const said = readReply(busy, '{"missed": ["i1"]}')
  const idle = apply(busy, { type: 'close', id: 'i2', how: 'done', by: 'engine', reason: 'The task ended.' })

  expect((said ? replyEvents(busy, said, 0) : []).reduce(apply, busy).items[0]?.isMissed).toBe(undefined)
  expect((said ? replyEvents(idle, said, 0) : []).reduce(apply, idle).items[0]?.isMissed).toBe(true)
})

test('a reload asked for by two replies is one task, in the newest wording', async () => {
  const reload = (title: string) => JSON.stringify({ open: [{ kind: 'task', title, why: 'The fix is on disk.', closesOn: 'reload' }] })
  const first = readReply(EMPTY, reload('Reload plugins to load the hover fix'))
  const ledger = (first ? replyEvents(EMPTY, first, 0) : []).reduce(apply, EMPTY)
  const second = readReply(ledger, reload('Run /reload-plugins to pick up the theme colors'))
  const after = (second ? replyEvents(ledger, second, 5) : []).reduce(apply, ledger)

  expect(after.items.map(item => [item.id, item.title, item.closesOn])).toEqual([['i1', 'Run /reload-plugins to pick up the theme colors', 'reload']])
})

test('a close that gives no evidence is not applied', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', QUESTION),
    now => opened(now, 0, 'claude', FINDING),
  )
  const said = readReply(ledger, '{"closed": [{"id": "i1", "how": "done", "reason": "placeholder"}, {"id": "i2", "how": "done", "reason": "The reply moved the scripts into tools/."}]}')

  expect(said?.closed.map(close => close.id)).toEqual(['i2'])
})

test('one reply opens at most three items, and at most one of them unverified', async () => {
  const item = (kind: string, title: string) => ({ kind, title, why: 'It matters.' })
  const said = readReply(
    EMPTY,
    JSON.stringify({ open: [item('unverified', 'The dock width was not run'), item('unverified', 'The clipboard write was not run'), item('issue', 'Logs grow without bound'), item('task', 'Rotate the key'), item('opportunity', 'Cache the palette')] }),
  )

  expect(said?.open.map(one => one.title)).toEqual(['The dock width was not run', 'Logs grow without bound', 'Rotate the key'])
})

test('what was sent is read once: settled closes it, unsettled marks it, and the rest is open as before', async () => {
  const ledger = ledgerOf(
    now => opened(now, 0, 'audit', QUESTION),
    now => opened(now, 0, 'audit', { ...QUESTION, title: 'Which model runs the audit?' }),
    () => ({ type: 'patch', id: 'i1', patch: { sent: 'Answer: MIT' } }),
    () => ({ type: 'patch', id: 'i2', patch: { sent: 'Answer: Sonnet' } }),
  )
  const said = readReply(ledger, '{"closed": [], "unsettled": ["i1"]}')
  const after = (said ? replyEvents(ledger, said, 0) : []).reduce(apply, ledger)

  expect(after.items.map(item => [item.sent, item.isUnsettled])).toEqual([
    [undefined, true],
    [undefined, undefined],
  ])
})

test('what Claude did is told as the tool calls that change or run something, since the last message', async () => {
  const lines = didLines([
    { role: 'user', text: 'old' },
    { role: 'assistant', toolUses: [{ tool: 'Bash', input: { command: 'rm old' }, text: 'done' }] },
    { role: 'user', text: 'make notes' },
    { role: 'assistant', toolUses: [{ tool: 'Read', input: { file_path: '/a' } }, { tool: 'Write', input: { file_path: '/tmp/notes.txt' } }] },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', toolUses: [{ tool: 'Bash', input: { command: 'npm test' }, text: 'Exit code 1\n2 failed' }] },
  ])

  expect(lines).toEqual(['Write: /tmp/notes.txt', 'Bash: npm test => Exit code 1 2 failed'])
  // A call kept as it is made reads the same as one read back from the conversation.
  expect(toolLine(useOf({ tool: 'Bash', tool_use_id: 'u1', command: 'npm test' }, 'Exit code 1\n2 failed'))).toBe(lines[1])
  expect(toolLine(useOf({ tool: 'WebFetch', tool_use_id: 'u2', agentId: undefined, url: 'https://example.test' }, 'ok'))).toBe('WebFetch: {"url":"https://example.test"}')
})

test('a finding Claude records is told to the reply as something it did, and its other inbox calls are not', async () => {
  const record = { tool: 'mcp__inbox__inbox', tool_use_id: 'u1', action: 'record', kind: 'issue', title: FINDING.title, why: FINDING.why }

  expect(toolLine(useOf(record, 'Recorded as i5.'))).toBe(`Inbox record: ${FINDING.title} => Recorded as i5.`)
  expect(toolLine(useOf(record, 'Not recorded: the inbox already lists this.'))).toBe(`Inbox record: ${FINDING.title} => Not recorded: the inbox already lists this.`)
  for (const action of ['get', 'list', 'close']) expect(toolLine(useOf({ tool: 'mcp__inbox__inbox', tool_use_id: 'u2', action }, 'ok'))).toBe(null)
})

test('what the user chose in a dialog and a workflow by its name are each a line of what Claude did, and its todo tools are none', async () => {
  expect(toolLine(useOf({ tool: 'AskUserQuestion', tool_use_id: 'u1', questions: [] }, 'User has answered your questions:\n"Which fruit?"="Apple".'))).toBe('Question dialog: User has answered your questions: "Which fruit?"="Apple".')
  expect(toolLine(useOf({ tool: 'Workflow', tool_use_id: 'u2', script: "export const meta = {\n  name: 'review-changes',\n}" }, 'Launched.'))).toBe('Workflow: review-changes => Launched.')
  expect(toolLine(useOf({ tool: 'Agent', tool_use_id: 'u4', description: 'Run the tests' }, 'Async agent launched successfully.\nagentId: a1'))).toBe('Agent: Run the tests => started in the background')
  for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'SubagentHandback']) expect(toolLine(useOf({ tool, tool_use_id: 'u3' }, 'ok'))).toBe(null)
})

test('what Claude wrote before its reply is told to the read, apart from the reply', async () => {
  const messages = [
    { role: 'user', text: 'old' },
    { role: 'assistant', text: 'An old reply.' },
    { role: 'user', text: 'fix both' },
    { role: 'assistant', text: 'The first is fixed: the test passes.', toolUses: [{ tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }] },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', text: 'Both are fixed.' },
  ]
  const said = saidOf(messages, 'Both are fixed.')

  expect(said).toEqual(['The first is fixed: the test passes.'])
  expect(replyAsk(EMPTY, [], 'fix both', false, [], 'Both are fixed.', { said })).toContain("WHAT CLAUDE SAID WHILE WORKING\nThe first is fixed: the test passes.\n\nCLAUDE'S REPLY")
  expect(replyAsk(EMPTY, [], 'fix both', false, [], 'Both are fixed.')).not.toContain('WHAT CLAUDE SAID')
})

test("Claude's todo list is told while any of it is unfinished, from either tool that keeps it", async () => {
  const whole = [{ role: 'assistant', toolUses: [{ tool: 'TodoWrite', input: { todos: [{ content: 'Write the test', status: 'completed' }, { content: 'Update the README', status: 'in_progress' }, { content: 'Run the build', status: 'pending' }] } }] }]
  const byEntry = [
    {
      role: 'assistant',
      toolUses: [
        { tool: 'TaskCreate', input: { subject: 'Write the test' }, result: { task: { id: '1' } } },
        { tool: 'TaskCreate', input: { subject: 'Run the build' }, result: { task: { id: '2' } } },
        { tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ],
    },
  ]

  expect(todoOf(whole)).toEqual(['[done] Write the test', '[in progress] Update the README', '[not started] Run the build'])
  expect(todoOf(byEntry)).toEqual(['[done] Write the test', '[not started] Run the build'])
  expect(todoOf([...byEntry, { role: 'assistant', toolUses: [{ tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }] }])).toEqual([])
})

test('a subagent is told with its latest tool calls and its report, and only the latest subagents are told', async () => {
  const agent = { name: 'Run the tests', type: 'general-purpose', isBackground: true, isInWorkflow: false, isDone: true }
  const part = agentPart(
    agent,
    Array.from({ length: (DEPTHS.Balanced?.agentCalls ?? 0) + 2 }, (_, at) => `Bash: step ${at} => ok`),
    'One test fails.',
  )
  const asked = replyAsk(EMPTY, [], 'go', false, [], 'Done.', { agents: Array.from({ length: (DEPTHS.Balanced?.agents ?? 0) + 1 }, (_, at) => `"agent ${at}" (Explore, ended)`) })

  expect(part.split('\n')[0]).toBe('"Run the tests" (general-purpose, in the background, ended)')
  expect(part).toContain('  [2 earlier tool calls left out]')
  expect(part.split('\n').at(-1)).toBe('  Its report: One test fails.')
  expect(asked).toContain('WHAT ITS SUBAGENTS DID\n[1 earlier subagents left out]\n"agent 1"')
})

test('a thorough read is told what a balanced one leaves out, and an unknown depth is the balanced one', async () => {
  const read = useOf({ tool: 'Read', tool_use_id: 'u1', file_path: '/app/src/cart.py' }, 'class Cart')
  const edit = useOf({ tool: 'Edit', tool_use_id: 'u2', file_path: '/app/src/cart.py', old_string: 'total = 0', new_string: 'total = 0.0' }, 'ok')
  const fetched = useOf({ tool: 'WebFetch', tool_use_id: 'u3', url: 'https://example.test' }, 'The page says the limit is 10 MB.')
  const run = useOf({ tool: 'Bash', tool_use_id: 'u4', command: 'npm test' }, ['start', 'a', 'b', 'c', 'FAIL cart', 'x', 'y', '1 failed'].join('\n'))

  expect(readAt('Nonsense')).toBe(DEPTHS.Balanced)
  expect([read, edit, fetched].map(use => toolLine(use, '/app'))).toEqual([null, 'Edit: src/cart.py', 'WebFetch: {"url":"https://example.test"}'])
  expect(toolLine(run)).toBe('Bash: npm test => start [...] x y 1 failed')
  expect(readAt('Thorough')).toBe(DEPTHS.Thorough)
  expect([read, edit, fetched].map(use => toolLine(use, '/app'))).toEqual([
    'Read: src/cart.py',
    'Edit: src/cart.py (replaced "total = 0" with "total = 0.0")',
    'WebFetch: {"url":"https://example.test"} => The page says the limit is 10 MB.',
  ])
  expect(toolLine(run)).toContain('FAIL cart')
  expect(readAt('Light')?.model).toBe('haiku')
  readAt('Balanced')
})

test('a deeper read is told the task a subagent was given and what it wrote along the way', async () => {
  const agent = { name: 'Run the tests', type: 'general-purpose', isBackground: false, isInWorkflow: true, isDone: true, task: 'Run the tests\nand report.' }

  expect(agentPart(agent, [], 'All pass.', ['Starting.'])).toBe('"Run the tests" (general-purpose, in a workflow, ended)\n  Its report: All pass.')
  readAt('Thorough')
  expect(agentPart(agent, ['Bash: npm test => ok'], 'All pass.', ['Starting.', 'Half way.'])).toBe(
    ['"Run the tests" (general-purpose, in a workflow, ended)', '  Its task: Run the tests and report.', '  Bash: npm test => ok', '  It wrote along the way: Starting. / Half way.', '  Its report: All pass.'].join('\n'),
  )
  readAt('Balanced')
})

test('the audit of a subagent opens only issues and untested claims, within its cap and never twice', async () => {
  const more = { why: 'It only read files.', close: 'Run the tests.' }
  const found = readAgent(
    JSON.stringify({
      open: [
        { kind: 'ask', title: 'Do more work on the cart', ...more },
        { kind: 'unverified', title: 'The subagent said the tests pass and never ran them', ...more },
        { kind: 'unverified', title: 'A second untested claim about the build', ...more },
        { kind: 'issue', title: 'The cart total is wrong for an empty cart', ...more },
        { kind: 'issue', title: 'A third finding that is over the cap', ...more },
      ],
    }),
  )
  const events = agentEvents(EMPTY, found, 5, 6)

  expect(found.map(item => item.kind)).toEqual(['unverified', 'issue'])
  expect(events.map(event => event.type)).toEqual(['open', 'open'])
  expect(agentEvents(events.reduce(apply, EMPTY), found, 6, 6)).toEqual([])
  expect(agentEvents(EMPTY, found, 5, 1).length).toBe(1)
  expect([readAt('Exhaustive').isAuditingAgents, readAt('Thorough').isAuditingAgents]).toEqual([true, false])
  readAt('Balanced')
  expect(agentAsk(EMPTY, { name: 'Run the tests', type: 'Explore', isBackground: false, isInWorkflow: false, isDone: true, task: 'Run them.' }, ['Bash: npm test => ok'], [], 'All pass.')).toContain(
    'THE TASK CLAUDE GAVE IT\nRun them.\n\nWHAT IT DID\nBash: npm test => ok\n\nITS REPORT\nAll pass.',
  )
})

test('a reply that is not JSON is read as nothing', async () => {
  expect(jsonOf('I could not decide.')).toBe(null)
  expect(readReply(EMPTY, 'no json here')).toBe(null)
})
