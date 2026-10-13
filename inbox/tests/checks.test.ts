import { expect, test } from 'claude-code/testing'

import { nameOf } from '../hooks/capture'
import { ISSUE_CLOSE, canCheck, checkAsk, checkBack, checkDismissed, checkLost, ranLine, stepsOf, withRan } from '../hooks/checks'
import { EMPTY, apply, opened } from '../hooks/ledger'
import type { Event, Item, Ledger } from '../types'

const UNRUN = { kind: 'unverified' as const, title: 'The copy button was never clicked', from: 'Claude', why: 'Its handler is tested, the click is not.', close: 'Click it and read the clipboard.' }

function ledgerOf(...steps: ((now: Ledger) => Event)[]) {
  return steps.reduce((now, step) => apply(now, step(now)), EMPTY)
}

const first = (ledger: Ledger) => ledger.items[0] as Item
const after = (ledger: Ledger, events: Event[]) => events.reduce(apply, ledger)

test('a check that passes leaves the item as it is, with what was seen and when', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', UNRUN))
  const back = after(ledger, checkBack(first(ledger), 'VERDICT: passed\nREPORT: Clicked Copy on two blocks.\nBoth were on the clipboard.', 500))

  expect(first(back)).toMatchObject({ kind: 'unverified', title: UNRUN.title, check: { state: 'back', at: 500, verdict: 'passed', text: 'Clicked Copy on two blocks.\nBoth were on the clipboard.' } })
})

// A check that fails has found a problem, and the item is then that problem: an issue under the
// title the agent gave it. What the item was is kept, so that throwing the result away undoes it.
test('a check that fails makes an issue of the item under the problem found, and dismissing the result undoes that', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', UNRUN))
  // The report is drawn as Markdown and keeps its list and its backticks. The title is plain text, and loses them.
  const report = 'The clipboard stays empty.\n- Clicked `Copy` twice\n- `pbpaste` printed nothing'
  const failed = after(ledger, checkBack(first(ledger), `VERDICT: failed\nTITLE: \`Copy\` leaves the clipboard empty\nREPORT: ${report}`, 500))

  expect(first(failed)).toMatchObject({ kind: 'issue', title: 'Copy leaves the clipboard empty', check: { verdict: 'failed', text: report, was: { kind: 'unverified', title: UNRUN.title } } })
  // A second look is asked about what was never run, not about the problem the first one named.
  expect(canCheck(first(failed))).toBe(true)
  expect(checkAsk(first(failed))).toContain(`What was never run: ${UNRUN.title}`)
  expect(checkAsk(first(failed))).toContain(`What would settle it: ${UNRUN.close}`)
  // The issue closes on its own problem being fixed. Held to what the claim was waiting on, a fix
  // that was made and shown stayed open for want of something the problem never needed.
  expect(first(failed).close).toBe(ISSUE_CLOSE)

  const passedLater = after(failed, checkBack(first(failed), 'VERDICT: passed\nREPORT: It copies now.', 900))

  expect(first(passedLater)).toMatchObject({ kind: 'unverified', title: UNRUN.title, close: UNRUN.close, check: { verdict: 'passed' } })
  expect(first(passedLater).check?.was).toBeUndefined()

  const dismissed = after(failed, checkDismissed(first(failed)))

  expect(first(dismissed)).toMatchObject({ kind: 'unverified', title: UNRUN.title, close: UNRUN.close })
  expect(first(dismissed).check).toBeUndefined()
})

test('a claim that a check bore out is named Verified once it has closed, and Unverified until then', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', UNRUN))
  const passed = after(ledger, checkBack(first(ledger), 'VERDICT: passed\nREPORT: Clicked Copy on two blocks.', 500))

  expect(nameOf(first(passed))).toBe('Unverified')

  const closed = after(passed, [{ type: 'close', id: first(passed).id, how: 'done', by: 'engine', reason: 'A check in the background passed: Clicked Copy on two blocks.' }])

  expect(nameOf(first(closed))).toBe('Verified')
})

test('a report that does not follow the form, or an agent that ends with no report, settles nothing and says so', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'audit', UNRUN))

  expect(first(after(ledger, checkBack(first(ledger), 'I could not find a clipboard tool on this machine.', 500))).check).toMatchObject({ verdict: 'unclear', text: 'I could not find a clipboard tool on this machine.' })
  expect(first(after(ledger, checkLost(first(ledger), 500, 'The check ended without a report.'))).check).toMatchObject({ state: 'back', verdict: 'unclear', text: 'The check ended without a report.' })
})

test('a look at something still running has no verdict, only where it stands', async () => {
  const ledger = ledgerOf(now => opened(now, 0, 'engine', { kind: 'running', title: 'Replay 66 exchanges', from: 'Claude', why: 'It runs: python replay.py', close: '', key: 'b1' }))
  const item = first(ledger)

  expect(canCheck(item)).toBe(true)
  expect(checkAsk(item)).toContain('Its task id: b1')

  const back = first(after(ledger, checkBack(item, 'REPORT: 41 of 66 are through and none has failed.', 500)))

  expect(back.check).toEqual({ state: 'back', at: 500, text: '41 of 66 are through and none has failed.' })
})

test('what the agent ran is kept as short lines, the newest twelve', async () => {
  const line = ranLine('Bash', { command: 'wc -w notes.txt' }, 'counting\n       3 notes.txt\n')

  expect(line).toBe('$ wc -w notes.txt => 3 notes.txt')
  expect(ranLine('Read', { file_path: '/work/notes.txt' }, 'alpha')).toBe('Read /work/notes.txt')
  // The count goes on past the list: a card that counted the list would say 12 steps from the twelfth on.
  const long = Array.from({ length: 51 }, (_, at) => `$ step ${at + 1}`).reduce(withRan, { state: 'running' as const, at: 0 })

  expect(long.ran).toHaveLength(12)
  expect(long.ran?.at(-1)).toBe('$ step 51')
  expect(long.steps).toBe(51)
  expect(stepsOf(long)).toBe(51)
  // A check an earlier build left, with a list and no count, counts what it has.
  expect(stepsOf({ state: 'running', at: 0, ran: ['$ ls', '$ pwd'] })).toBe(2)

  const ledger = ledgerOf(now => opened(now, 0, 'audit', UNRUN))
  const running = after(ledger, [{ type: 'patch', id: 'i1', patch: { check: long } }])

  expect(first(after(running, checkBack(first(running), 'VERDICT: passed\nREPORT: Ran it.', 900))).check).toMatchObject({ state: 'back', steps: 51 })
})
