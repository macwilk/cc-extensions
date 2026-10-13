import { expect, test } from 'claude-code/testing'

import { EMPTY, KEPT_TURNS, ageOf, apply, carriedTo, forkPoint, goalOpened, isDropped, layoutOf, marksOf, opened, progressOf, rebased, replay, rewoundTo, sectionsOf } from '../hooks/ledger'
import type { Event, Ledger } from '../types'

const FINDING = { kind: 'issue' as const, title: 'Demo scripts live only in a temp folder', from: 'Claude', why: 'They are lost when it is cleaned.', close: 'Move them into the repo.' }
const TURN: Event = { type: 'turn' }

/** Applies events in order, each made from the ledger as it then stands, and keeps the log. */
function run(steps: ((ledger: Ledger) => Event)[], from = EMPTY) {
  const log: Event[] = []
  const ledger = steps.reduce((now, step) => {
    const event = step(now)
    log.push(event)

    return apply(now, event)
  }, from)

  return { ledger, log }
}

test('a conversation comes back from its log as the same inbox', async () => {
  const { ledger, log } = run([
    () => TURN,
    now => goalOpened(now, 'Publish the mods'),
    now => opened(now, 10, 'audit', { kind: 'ask', title: 'Push to GitHub', from: 'You', why: '', close: '', goal: 'g1' }),
    now => opened(now, 20, 'claude', FINDING),
    () => ({ type: 'close', id: 'i2', how: 'done', by: 'audit', reason: 'The reply pushed main.' }),
    () => ({ type: 'note', what: 'reply audit', detail: { ms: 900 } }),
    () => ({ type: 'later', id: 'i3', reason: 'You set it aside.' }),
  ])

  expect(replay(log)).toEqual(ledger)
  expect(ledger.items.map(item => [item.id, item.status])).toEqual([
    ['i2', 'done'],
    ['i3', 'later'],
  ])
  expect(ledger.nextId).toBe(4)
})

test('a closed item leaves the inbox a few prompts after it closed, and an open one never does', async () => {
  const start = run([now => opened(now, 0, 'audit', FINDING), now => opened(now, 0, 'audit', { ...FINDING, title: 'Another' }), () => ({ type: 'close', id: 'i1', how: 'done', by: 'you', reason: 'Done.' })])
  const before = run(
    Array.from({ length: KEPT_TURNS - 1 }, () => () => TURN),
    start.ledger,
  )
  const after = run([() => TURN], before.ledger)

  expect(before.ledger.items.map(item => item.id)).toEqual(['i1', 'i2'])
  expect(after.ledger.items.map(item => item.id)).toEqual(['i2'])
})

test('an ask stays while its goal has work open, and a finished goal leaves with its asks', async () => {
  const ask = (title: string) => (now: Ledger) => opened(now, 0, 'audit', { kind: 'ask', title, from: 'You', why: '', close: '', goal: 'g1' })
  const start = run([now => goalOpened(now, 'Publish the mods'), ask('Push'), ask('License'), () => ({ type: 'close', id: 'i2', how: 'done', by: 'audit', reason: 'Pushed.' })])
  const waited = run(
    Array.from({ length: KEPT_TURNS + 2 }, () => () => TURN),
    start.ledger,
  )
  const [goal] = waited.ledger.goals

  expect(waited.ledger.items.map(item => item.id)).toEqual(['i2', 'i3'])
  expect(goal && progressOf(waited.ledger, goal)).toEqual({ done: 1, of: 2, isComplete: false })

  const finished = run(
    [() => ({ type: 'close', id: 'i3', how: 'dropped', by: 'you', reason: 'Not wanted.' }), ...Array.from({ length: KEPT_TURNS }, () => () => TURN)],
    waited.ledger,
  )

  expect(finished.ledger.goals).toEqual([])
  expect(finished.ledger.items).toEqual([])
})

test('nothing open leaves by its age, and what is brought back keeps the prompt it came from', async () => {
  const turns = (count: number) => Array.from({ length: count }, () => () => TURN)
  const start = run([
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Rename the branch', from: 'You', why: '', close: '' }),
    now => opened(now, 0, 'claude', FINDING),
    () => ({ type: 'later', id: 'i2', reason: 'You set it aside.' }),
  ])
  const after = run(turns(40), start.ledger)

  expect(after.ledger.items.map(item => item.status)).toEqual(['open', 'later'])

  const back = run([() => ({ type: 'reopen', id: 'i2' }), ...turns(40)], after.ledger)

  expect(back.ledger.items[1]).toMatchObject({ status: 'open', turn: 0 })
})

test('what the person dropped is known under another spelling, until they reopen it', async () => {
  const { ledger } = run([now => opened(now, 0, 'claude', FINDING), () => ({ type: 'close', id: 'i1', how: 'dropped', by: 'you', reason: 'You dropped it.' })])

  expect(isDropped(ledger, 'The demo scripts only live in a temp folder')).toBe(true)
  expect(isDropped(ledger, 'Run shade relies on an undocumented color')).toBe(false)
  expect(isDropped(apply(ledger, { type: 'reopen', id: 'i1' }), FINDING.title)).toBe(false)
})

test('a drop by Claude or the audit is not held against the same thing coming up again', async () => {
  const { ledger } = run([now => opened(now, 0, 'claude', FINDING), () => ({ type: 'close', id: 'i1', how: 'dropped', by: 'audit', reason: 'No longer applies.' })])

  expect(isDropped(ledger, FINDING.title)).toBe(false)
})

test('closing an item clears what was waiting on a reply', async () => {
  const { ledger } = run([
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'question', options: ['Yes', 'No'] }),
    () => ({ type: 'patch', id: 'i1', patch: { sent: 'Answer: Yes', isUnsettled: true } }),
    () => ({ type: 'close', id: 'i1', how: 'done', by: 'audit', reason: 'Your message answered it.' }),
  ])

  expect(ledger.items[0]).toMatchObject({ status: 'done', closedBy: 'audit', reason: 'Your message answered it.' })
  expect(ledger.items[0]?.sent).toBe(undefined)
  expect(ledger.items[0]?.isUnsettled).toBe(undefined)
})

test('the panel lays questions left in a dialog apart from the others, and asks under a goal once two share it', async () => {
  const { ledger } = run([
    now => goalOpened(now, 'Publish the mods'),
    now => opened(now, 0, 'audit', { kind: 'ask', title: 'Push', from: 'You', why: '', close: '', goal: 'g1' }),
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'question', title: 'Which license?' }),
    now => opened(now, 0, 'engine', { ...FINDING, kind: 'question', title: 'Which model?', dialog: 'toolu_1' }),
  ])
  const groupsOf = (now: typeof ledger) => Object.fromEntries(sectionsOf(now).flatMap(section => section.groups.map(group => [group.key, group.rows.map(row => row.title)])))
  const groups = groupsOf(ledger)

  expect(groups.questions).toEqual(['Which license?'])
  expect(groups.dialog).toEqual(['Which model?'])
  // A goal with one ask is not a heading of its own: the ask is listed with the others.
  expect(groups.g1).toBeUndefined()
  expect(groups.asks).toEqual(['Push'])

  const two = groupsOf(apply(ledger, opened(ledger, 0, 'audit', { kind: 'ask', title: 'Tag the release', from: 'You', why: '', close: '', goal: 'g1' })))

  expect(two.g1).toEqual(['Push', 'Tag the release'])
  expect(two.asks).toEqual([])
})

test('the panel puts a goal first with everything that belongs to it, and the rest by what it is', async () => {
  const ask = (title: string, goal: string) => ({ kind: 'ask' as const, title, from: 'You', why: '', close: '', goal })
  const { ledger } = run([
    now => goalOpened(now, 'Ten more themes'),
    now => opened(now, 0, 'audit', ask('Add ten themes', 'g1')),
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'unverified', title: 'Light themes never seen', goal: 'g1' }),
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'question', title: 'Which base?', goal: 'g1' }),
    now => goalOpened(now, 'A handoff brief'),
    now => opened(now, 0, 'audit', ask('Mock the brief', 'g5')),
    now => opened(now, 0, 'audit', { ...FINDING, kind: 'task', title: 'Log in to GitHub' }),
    now => opened(now, 0, 'claude', FINDING),
  ])
  const layout = layoutOf(ledger)

  // Inside a goal, what waits on the person is first. A goal of one item is not a block: its ask is a single goal.
  expect(layout.goals.map(block => [block.goal.title, block.open.map(item => item.title), block.waiting])).toEqual([['Ten more themes', ['Which base?', 'Light themes never seen', 'Add ten themes'], 1]])
  expect(layout.single.map(item => item.title)).toEqual(['Mock the brief'])
  expect(layout.oneOffs.map(group => [group.key, group.rows.map(item => item.title)])).toEqual([
    ['needs', ['Log in to GitHub']],
    ['findings', [FINDING.title]],
    ['running', []],
  ])

  const held = layoutOf(
    run(
      [
        () => ({ type: 'close', id: 'i2', how: 'done', by: 'audit', reason: 'Ten themes were added.' }),
        () => ({ type: 'close', id: 'i4', how: 'done', by: 'you', reason: 'You answered it.' }),
        () => ({ type: 'later', id: 'i3', reason: 'You set it aside.' }),
      ],
      ledger,
    ).ledger,
  )

  // What is set aside keeps its goal's name, and a goal with something set aside is not finished.
  expect(held.goals).toEqual([])
  expect(held.later.held.map(one => [one.goal.title, one.rows.map(item => item.title)])).toEqual([['Ten more themes', ['Light themes never seen']]])
  expect(held.closed.goals).toEqual([])
  expect(held.closed.rows.map(item => item.title)).toEqual(['Add ten themes', 'Which base?'])

  const finished = layoutOf(
    run(
      [
        () => ({ type: 'close', id: 'i2', how: 'done', by: 'audit', reason: 'Ten themes were added.' }),
        () => ({ type: 'close', id: 'i3', how: 'done', by: 'you', reason: 'You looked.' }),
        () => ({ type: 'close', id: 'i4', how: 'dropped', by: 'you', reason: 'You dropped it.' }),
      ],
      ledger,
    ).ledger,
  )

  expect(finished.closed.goals.map(block => [block.goal.title, block.done.length])).toEqual([['Ten more themes', 3]])
})

// A fork is made at the end of some turn of the first conversation, which may have gone on since.
test('a fork carries a log up to the end of the prompt it was made after, and nothing later', async () => {
  const { log } = run([() => TURN, now => opened(now, 0, 'claude', FINDING), () => TURN, now => opened(now, 0, 'claude', { ...FINDING, title: 'Run shade relies on an undocumented color' }), () => TURN])

  expect(replay(carriedTo(log, 1)).items.map(item => item.id)).toEqual(['i1'])
  expect(replay(carriedTo(log, 2)).items.map(item => item.id)).toEqual(['i1', 'i2'])
  expect(carriedTo(log, 9)).toEqual(log)
})

test('a prompt that was taken back does not count toward where a fork was made', async () => {
  const taken = run([() => TURN, now => opened(now, 0, 'claude', FINDING)])
  // Prompt 2 was sent and taken back, then sent again and kept: the fork after it carries what it opened.
  const { log } = run([() => TURN, () => ({ type: 'retract', to: taken.ledger }), () => TURN, now => opened(now, 0, 'claude', { ...FINDING, title: 'Run shade relies on an undocumented color' }), () => TURN], taken.ledger)
  const whole = [...taken.log, ...log]

  expect(replay(carriedTo(whole, 2)).items.map(item => item.title)).toEqual([FINDING.title, 'Run shade relies on an undocumented color'])
  expect(replay(carriedTo(whole, 2)).turn).toBe(2)
})

test('marks are read one to a line, and a line that is not a mark is skipped', async () => {
  expect(marksOf('toolu_a 1 2\ntoolu_b 2\n\nbroken\ntoolu_c x 9\n')).toEqual([
    { call: 'toolu_a', turn: 1, turns: 2 },
    { call: 'toolu_b', turn: 2, turns: -1 },
  ])
})

// A compaction raises Claude Code's count of turns, and a conversation that is quit and resumed is
// counted afresh from what it still holds: the count drops with nothing rewound.
test('the marks of a conversation started again are moved to the count it has now, so that the drop is no rewind', async () => {
  // Three prompts, a compaction and a fourth prompt, which left the count at 7. Resumed, the conversation counts 4.
  const marks = marksOf('toolu_a 1 1\ntoolu_b 2 2\ntoolu_c 3 3\ntoolu_d 4 7\n')
  const moved = rebased(marks, 4, 4)

  expect(rewoundTo(marks, 4)).toMatchObject({ turn: 3 })
  expect(moved.map(mark => mark.turns)).toEqual([-2, -1, 0, 4])
  expect(rewoundTo(moved, 4)).toBe(null)
  // A rewind of the last prompt, made after the resume, is still one.
  expect(rewoundTo(moved, 3)).toMatchObject({ turn: 3 })
  // A prompt whose turn never ended has no mark, and is in the count all the same.
  expect(rebased(marks, 5, 5).map(mark => mark.turns)).toEqual([-2, -1, 0, 4])
  // A count that did not drop moves nothing.
  expect(rebased(marks.slice(0, 3), 3, 3)).toEqual(marks.slice(0, 3))
  expect(rebased([], 0, 0)).toEqual([])
})

// After a rewind Claude Code counts fewer turns than the newest marks were written at.
test('a rewind is read off the marks, and flags what was opened after the point rewound to', async () => {
  const marks = marksOf('toolu_a 1 1\ntoolu_b 2 2\n- 3 3\n')

  expect(rewoundTo(marks, 3)).toBe(null)
  // A compaction raises the count, which is no rewind.
  expect(rewoundTo(marks, 9)).toBe(null)
  expect(rewoundTo(marks, 1)).toMatchObject({ turn: 1, kept: [{ call: 'toolu_a', turn: 1, turns: 1 }] })
  expect(rewoundTo(marks, 0)).toMatchObject({ turn: 0, kept: [] })

  const { ledger } = run([() => TURN, now => opened(now, 0, 'claude', FINDING), () => TURN, now => opened(now, 0, 'claude', { ...FINDING, title: 'Run shade relies on an undocumented color' }), () => ({ type: 'rewind', turn: 1 })])
  expect(ledger.items.map(item => [item.status, item.isRewound ?? false])).toEqual([
    ['open', false],
    ['open', true],
  ])
})

// Two turns can end on the same tool call, when the second made none. Claude Code's own count of turns tells them apart.
test('a fork is placed at the mark for its own count of turns, and without one at the newest mark it shares a tool call with', async () => {
  const marks = marksOf('toolu_a 1 2\ntoolu_a 2 4\ntoolu_b 3 6\n')

  expect(forkPoint(marks, ['toolu_a'], 2)).toMatchObject({ turn: 1, isExact: true })
  expect(forkPoint(marks, ['toolu_a'], 4)).toMatchObject({ turn: 2, isExact: true })
  expect(forkPoint(marks, ['toolu_a'], 99)).toMatchObject({ turn: 2, isExact: false })
  expect(forkPoint(marks, ['toolu_a', 'toolu_b'], 99)).toMatchObject({ turn: 3, isExact: false })
  expect(forkPoint(marks, ['toolu_z'], 4)).toBe(null)
})

test('an age is written in the one unit that fits', async () => {
  const minute = 60_000

  expect([0, 5 * minute, 125 * minute, 50 * 60 * minute].map(ago => ageOf(0, ago))).toEqual(['now', '5m', '2h', '2d'])
})
