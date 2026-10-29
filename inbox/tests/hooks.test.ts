import { expect, mock, test, type TestBody } from 'claude-code/testing'

import type { Ledger, Pending, Running } from '../types'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
/** What the models answer. `failures` is how many audits of a reply fail before one answers. */
type Said = { prompt?: string; reply?: string; fork?: string; failures?: number }

const LOG = '/home/me/.claude/inbox/conv-1.jsonl'
const NO_TOKENS = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const FINDING = { action: 'record', kind: 'issue', title: 'Demo scripts live only in a temp folder', why: 'They are lost when it is cleaned.' }
/** The panel as the engine hands it to be drawn: docked at the right, 48 columns wide. */
const PANE = { title: 'Inbox', isFocused: false, bodyColumns: 48, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

/**
 * Stands for what is beneath the mod: a clock, a home folder, the conversation's files, its id, and
 * models that answer what the test scripted. `said` may change while the test runs.
 */
function world(on: On, said: Said = {}, files: Record<string, string> = {}, pending: Pending[] | Pending | null = null, running: Running | null = null) {
  const clock = mock.clock(on, { now: 1000 })
  const forked: string[] = []
  const kept = { ledger: undefined as Ledger | undefined, filled: '', audits: [] as string[], logs: [] as string[], turns: 0, pending, rows: [] as { role: string; text: string; toolUses: { tool_use_id: string; tool: string; input: object }[] }[] }
  mock.env(on, { HOME: '/home/me' })
  on('session.turns', async () => ({ value: kept.turns }))
  // A test can start with an audit left in the session's state, as a reload of the mod leaves one:
  // until the mod writes that value itself, a read of it gives what the test put there.
  const seeded = { isRead: pending !== null, isRunning: running !== null }
  on('state.get', async ($, e, next) => {
    const read = await next(e)
    // The same for a turn that a reload of the mod finds running.
    if (seeded.isRunning && e.plugin === 'inbox' && e.key === 'running' && read.value) return { value: { ...read.value, value: running } }

    return seeded.isRead && e.plugin === 'inbox' && e.key === 'pending' && read.value ? { value: { ...read.value, value: kept.pending } } : read
  })
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'inbox' && e.key === 'ledger') kept.ledger = e.value as Ledger
    if (e.plugin === 'inbox' && e.key === 'running') seeded.isRunning = false
    if (e.plugin === 'inbox' && e.key === 'pending') {
      kept.pending = e.value as Pending[] | Pending | null
      seeded.isRead = false
    }

    return next(e)
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async ($, e) => {
    kept.filled = e.text

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.id', async () => ({ value: 'conv-1' }))
  on('session.messages', async () => ({ value: kept.rows as never }))
  on('fs.exists', async ($, e) => ({ value: e.path in files || Object.keys(files).some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.list', async ($, e) => ({
    value: Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: (files[path] ?? '').length, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', async ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', async ($, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__inbox__${e.name}` } }))
  on('command.register', async () => ({ value: undefined as never }))
  on('ui.log', async ($, e) => {
    kept.logs.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('model.complete', async ($, e) => {
    // Both passes ask the same model, so the rules each is given tell them apart.
    const isPromptPass = (e.system ?? '').startsWith('You read one message')
    if (!isPromptPass) kept.audits.push(e.prompt)
    if (!isPromptPass && (said.failures ?? 0) > 0) {
      said.failures = (said.failures ?? 0) - 1

      return { value: { isAnswered: false as const, reason: 'timeout', usage: NO_TOKENS } as never }
    }

    return { value: { isAnswered: true as const, text: (isPromptPass ? said.prompt : said.reply) ?? '{}', usage: NO_TOKENS } }
  })
  on('model.fork', async ($, e) => {
    forked.push(e.prompt)

    return { value: { isAnswered: true as const, text: said.fork ?? '{}', usage: NO_TOKENS } }
  })

  return { clock, files, forked, kept, book: () => kept.ledger ?? { items: [], goals: [], nextId: 1, turn: 0, dropped: [] } }
}

function start($: Engine) {
  return $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

/** A prompt of the person's, then the reply to it, with the model passes each of them starts run to their end. */
async function exchange($: Engine, clock: ReturnType<typeof mock.clock>, text: string, answer: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(5)
}

test('a turn that dies on an error opens an item, and the next turn that ends with a reply closes it', async ($, on) => {
  const { book, clock } = world(on)
  await start($)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'error' })
  await clock.settle()

  expect(book().items.map(item => [item.kind, item.status, item.by])).toEqual([['stopped', 'open', 'engine']])

  await $.turn.complete({ answer: 'Back.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'engine', reason: 'The next turn ended with a reply.' })
})

// A look in the background is taken by an agent of the mod's own. What it hands back has to end
// in the item and never in the conversation, where it would arrive as a message for Claude to
// answer. The test kit starts no agents, so two looks are already running when the test begins.
test('what an agent of the mod hands back lands in its item and goes no further, and a check that passed closes with the turn', async ($, on) => {
  const unrun = (id: string, title: string, agent?: string) => [
    { type: 'open', item: { kind: 'unverified', title, from: 'Claude', why: 'Untested.', close: 'Run it.', id, turn: 1, at: 900, by: 'audit', status: 'open' } },
    ...(agent ? [{ type: 'patch', id, patch: { check: { state: 'running', at: 950, agent } } }] : []),
  ]
  const log = [{ type: 'turn' }, ...unrun('i1', 'The copy button was never clicked', 'a1'), ...unrun('i2', 'The light themes were never looked at', 'a2'), ...unrun('i3', 'The handle was never seen in green'), ...unrun('i4', 'The drawer was never opened', 'a4')]
  const { book, clock } = world(on, {}, { [LOG]: `${log.map(line => JSON.stringify({ at: 900, turn: 1, ...line })).join('\n')}\n` })
  const beneath = { asked: [] as string[], handed: 0 }
  on('ui.toast', async () => ({ value: undefined }))
  on('agent.register', async () => ({ value: { agent: 'inbox:checker' } }))
  on('agent.spawn', async ($, e) => {
    beneath.asked.push(e.prompt)

    return { model: 'sonnet' }
  })
  // Beneath the mod a hand-back reaches the conversation: the count says whether one got through.
  on('tool.call', async () => {
    beneath.handed += 1

    return { result: {}, text: '' } as never
  })
  const handBack = (agentId: string, message: string) => $.tool.call({ tool: 'SubagentHandback', tool_use_id: `h-${agentId}`, agentId, message } as never)
  await start($)
  await clock.advance(5)
  const panel = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })

  await handBack('a1', 'VERDICT: failed\nTITLE: Copy leaves the clipboard empty\nREPORT: Clicked Copy twice and the clipboard stayed empty.')
  expect(beneath.handed).toBe(0)
  expect(book().items[0]).toMatchObject({ kind: 'issue', title: 'Copy leaves the clipboard empty', check: { state: 'back', verdict: 'failed' } })

  // Thrown away from its card, the result is gone and the item is what it was.
  await panel.press({ key: 'row-i1' })
  await panel.press({ key: 'dismiss-i1' })
  expect(book().items[0]).toMatchObject({ kind: 'unverified', title: 'The copy button was never clicked' })
  expect(book().items[0]?.check).toBeUndefined()

  // The agent of a look that is over is refused whatever else it calls, and what it hands back again is dropped.
  expect(await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u9', agentId: 'a1' } as never)).toMatchObject({ deny: expect.any(String) })
  await handBack('a1', 'VERDICT: passed\nREPORT: Late.')
  expect(beneath.handed).toBe(0)
  expect(book().items[0]?.check).toBeUndefined()

  // A check that passed and was not closed by hand is closed when the turn ends.
  await handBack('a2', 'VERDICT: passed\nREPORT: Drew both light themes and read them.')
  expect(book().items[1]).toMatchObject({ status: 'open', check: { verdict: 'passed' } })
  await $.turn.complete({ answer: 'Noted.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)
  expect(book().items[1]).toMatchObject({ status: 'done', closedBy: 'engine', reason: 'A check in the background passed: Drew both light themes and read them.' })

  // An agent that ends its turn without handing anything back said what it found in its last words.
  // However long it took, its look is still its own: nothing ends a look but its agent or the person.
  await clock.advance(60 * 60_000)
  expect(book().items[3]?.check).toMatchObject({ state: 'running', agent: 'a4' })

  // Its card counts every step it takes, though it keeps only the newest twelve to show.
  for (const step of Array.from({ length: 20 }, (_, at) => at + 1)) await $.tool.call({ tool: 'Bash', command: `echo ${step}`, tool_use_id: `s${step}`, agentId: 'a4' } as never)
  await clock.advance(5)
  await panel.press({ key: 'row-i4' })
  expect(book().items[3]?.check).toMatchObject({ steps: 20 })
  expect(book().items[3]?.check?.ran).toHaveLength(12)
  expect(JSON.stringify(await panel.drawn())).toContain('20 steps so far')
  await $.turn.complete({ answer: 'VERDICT: unclear\nREPORT: It needs a click that an agent cannot make.', durationMs: 10, isAborted: false, turnId: 't4', reason: 'answer', agentId: 'a4' })
  expect(book().items[3]?.check).toMatchObject({ state: 'back', verdict: 'unclear', text: 'It needs a click that an agent cannot make.' })

  // The button on a row asks for a look through the hook on the press, with what was never run.
  await panel.press({ key: 'check-i3' })
  expect(beneath.asked[0]).toContain('What was never run: The handle was never seen in green')
})

test('the checker is kept out of the agents Claude is offered, and every other agent is left alone', async ($, on) => {
  world(on)
  on('agent.offer', async () => ({ isOffered: true }))
  await start($)

  expect(await $.agent.offer({ agent: 'inbox:checker', description: '', source: 'plugin' } as never)).toEqual({ isOffered: false })
  expect(await $.agent.offer({ agent: 'Explore', description: '', source: 'built-in' } as never)).toEqual({ isOffered: true })
})

// A compaction in the middle of a turn takes the turn's earlier tool calls out of the conversation.
// The reply is still read against them, since the mod keeps each call as it is made.
test('a reply is read against every tool call of its turn, the ones a compaction took out of the conversation too', async ($, on) => {
  const { clock, kept } = world(on)
  on('tool.call', async () => ({ result: {}, text: '7 passed' }) as never)
  await start($)
  await $.prompt.submit({ text: 'fix the count', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.start({ text: 'fix the count', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/count.ts', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u2' })
  await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'u3' })
  // What the conversation holds after the compaction: its summary, and the one call made since.
  kept.rows = [
    { role: 'user', text: 'A summary of the conversation so far.', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u3', tool: 'Bash', input: { command: 'git status' } }] },
  ]
  await $.turn.complete({ answer: 'Fixed, and the tests pass.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)

  // A file in the project is named from the project's folder, as the person knows it.
  expect(kept.audits[0]).toContain('WHAT CLAUDE DID\nEdit: count.ts\nBash: npm test => 7 passed\nBash: git status => 7 passed\n')

  // A reload of the mod starts its own list over, and the conversation then holds more of the turn than it does.
  await $.turn.start({ text: '', turnId: 't2' })
  kept.rows = [
    { role: 'user', text: 'and the docs', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u4', tool: 'Write', input: { file_path: '/work/README.md' } }] },
  ]
  await $.turn.complete({ answer: 'Written.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)

  expect(kept.audits[1]).toContain('WHAT CLAUDE DID\nWrite: README.md\n')
})

// The engine hands a mod no conversation for an agent of a workflow, so its calls are known only as they are made.
test("a workflow agent's calls and report reach the reply's read, though the engine hands over no conversation for it", async ($, on) => {
  const { book, clock, kept } = world(on)
  on('tool.call', async () => ({ result: {}, text: 'alpha-marker' }) as never)
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'a1' }))
  await start($)
  await $.prompt.submit({ text: 'run the workflow', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.start({ text: 'run the workflow', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Run echo alpha-marker.', description: 'alpha', subagentType: 'workflow-subagent', parentModel: 'opus', background: true, fork: false, workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
  await $.tool.call({ tool: 'Bash', command: 'echo alpha-marker', tool_use_id: 'u2', agentId: 'a1' } as never)
  await $.turn.complete({ answer: 'alpha printed its marker.', durationMs: 5, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer' })
  await $.turn.complete({ answer: 'The workflow is done.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)

  expect(kept.audits[0]).toContain('WHAT ITS SUBAGENTS DID\n"alpha" (workflow-subagent, in a workflow, in the background, ended)\n  Bash: echo alpha-marker => alpha-marker\n  Its report: alpha printed its marker.')
  // A workflow's agents are listed as one task, the workflow, and never one by one.
  expect(book().items.filter(item => item.kind === 'running')).toEqual([])
})

test('a check that fails opens one item, and the same check passing closes it', async ($, on) => {
  const { book, clock } = world(on)
  const run = { hasFailed: true }
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: run.hasFailed ? 'Exit code 1\n2 failed, 5 passed' : '7 passed', ...(run.hasFailed ? { isError: true } : {}) }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u2' })
  await clock.settle()

  expect(book().items.map(item => [item.kind, item.status, item.key, item.why])).toEqual([['check', 'open', 'npm test', 'Exit code 1 2 failed, 5 passed']])

  run.hasFailed = false
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u3' })
  await clock.settle()

  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'engine', reason: 'The same check ran again and passed.' })
})

test('a command left running in the background is an item until the task is stopped', async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Running in the background.' }))
  on('tool.call', { tool: 'TaskStop' }, async () => ({ result: 'stopped', text: 'Stopped b1.' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, tool_use_id: 'u1' })
  await clock.settle()

  expect(book().items.map(item => [item.kind, item.title, item.key, item.status])).toEqual([['running', 'Start the dev server', 'b1', 'open']])

  await $.tool.call({ tool: 'TaskStop', task_id: 'b1', tool_use_id: 'u2' })
  await clock.settle()

  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'engine', reason: 'The task was stopped.' })
})

test("a subagent's command left running in the background is no item, as its end never reaches the conversation", async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Running in the background.' }))
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'a1' }))
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Serve it.', description: 'server', subagentType: 'general-purpose', parentModel: 'opus', background: false, fork: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, tool_use_id: 'u2', agentId: 'a1' } as never)
  await $.turn.complete({ answer: 'Started.', durationMs: 5, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer' })
  await clock.settle()

  expect(book().items.filter(item => item.key === 'b1')).toEqual([])
})

test("a workflow agent's command left running in the background is no item either", async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Running in the background.' }))
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Sweep it.', description: 'alpha', subagentType: 'workflow-subagent', parentModel: 'opus', background: true, fork: false, workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', run_in_background: true, tool_use_id: 'u2', agentId: 'a1' } as never)
  await clock.settle()

  expect(book().items.filter(item => item.key === 'b1')).toEqual([])
})

test("a subagent's failed check is no item, as the conversation never reruns it", async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'Exit code 1\n1 failed', isError: true }))
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Break each line and run the tests.', description: 'mutation sweep', subagentType: 'general-purpose', parentModel: 'opus', background: false, fork: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u2', agentId: 'a1' } as never)
  await clock.settle()

  expect(book().items.filter(item => item.kind === 'check')).toEqual([])
})

test('a dialog left with questions unanswered leaves each as an item with its answers', async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'AskUserQuestion' }, async () => ({
    result: 'Error',
    text: 'The user wants to clarify these questions.\n\n    Questions asked:\n- "Which fruit?"\n  (No answer provided)\n- "Which toppings?"\n  (No answer provided)',
    isError: true,
  }))
  await start($)
  await $.tool.call({
    tool: 'AskUserQuestion',
    tool_use_id: 'd1',
    questions: [
      { question: 'Which fruit?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: 'Crisp.' }, { label: 'Banana', description: 'Soft.' }] },
      { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Honey', description: '' }, { label: 'Granola', description: '' }] },
    ],
  })
  await clock.settle()

  expect(book().items.map(item => [item.title, item.options, item.isMulti ?? false, item.dialog])).toEqual([
    ['Which fruit?', ['Apple', 'Banana'], false, 'd1'],
    ['Which toppings?', ['Honey', 'Granola'], true, 'd1'],
  ])
})

test('an ask the audit cannot judge from one exchange goes to a fork, which closes it with its evidence', async ($, on) => {
  const said: Said = {
    prompt: '{"asks": [{"title": "Finish the rollout", "quote": "finish it", "done": "The reply shows it.", "goal": null}]}',
    reply: '{"unsure": [{"id": "i1", "question": "Was the rollout finished earlier in this conversation?"}]}',
    fork: '{"done": true, "reason": "Turn 3 deployed it to all three regions."}',
  }
  const { book, clock, forked, files } = world(on, said)
  await start($)
  await exchange($, clock, 'finish it', 'All of it is done.')

  expect(forked).toHaveLength(1)
  expect(forked[0]).toContain('Was the rollout finished earlier in this conversation?')
  expect(book().items[0]).toMatchObject({ title: 'Finish the rollout', status: 'done', closedBy: 'audit', reason: 'The reply closed it: Turn 3 deployed it to all three regions.' })
  expect((files[LOG] ?? '').split('\n').filter(line => line.includes('"type":"note"')).map(line => (JSON.parse(line) as { what: string }).what)).toEqual(['prompt pass', 'reply audit', 'fork'])
})

test('a fork that finds the work not done leaves the item open', async ($, on) => {
  const { book, clock } = world(on, {
    prompt: '{"asks": [{"title": "Finish the rollout", "quote": "finish it", "done": "The reply shows it.", "goal": null}]}',
    reply: '{"unsure": [{"id": "i1", "question": "Was it finished?"}]}',
    fork: '{"done": false, "reason": "One region is still on the old build."}',
  })
  await start($)
  await exchange($, clock, 'finish it', 'Working on it.')

  expect(book().items[0]).toMatchObject({ status: 'open' })
})

test('a message typed while Claude is still working is audited with its own reply, not the one before it', async ($, on) => {
  const said: Said = { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' }
  const { clock, kept } = world(on, said)
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await clock.advance(5)
  said.prompt = '{"asks": [{"title": "Write the changelog", "quote": "write the changelog", "done": "The reply shows it.", "goal": null}]}'
  await $.prompt.submit({ text: 'write the changelog', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.complete({ answer: 'Renamed.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)
  await $.turn.start({ text: 'write the changelog', turnId: 't2' })
  await $.turn.complete({ answer: 'Written.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)
  const [first = '', second = ''] = kept.audits

  expect(kept.audits).toHaveLength(2)
  expect(first).toContain('i1 [Open ask] [asked now] Rename the branch')
  expect(first).toContain('i2 [Open ask] Write the changelog')
  expect(first).toContain("THE USER'S MESSAGE\nrename the branch\n")
  expect(second).toContain('i2 [Open ask] [asked now] Write the changelog')
  expect(second).toContain("THE USER'S MESSAGE\nwrite the changelog\n")
})

test('a message typed while Claude is still working that reaches it in the same turn is audited with that turn, and not again with the next', async ($, on) => {
  const said: Said = { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' }
  const { clock, kept } = world(on, said)
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await clock.advance(5)
  said.prompt = '{"asks": [{"title": "Write the changelog", "quote": "write the changelog", "done": "The reply shows it.", "goal": null}]}'
  await $.prompt.submit({ text: 'write the changelog', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await clock.advance(5)
  const told = '<system-reminder>\nThe user sent a new message while you were working:\nwrite the changelog\n</system-reminder>'
  await $.session.append({ door: 'delivery', origin: { kind: 'composer' }, uuid: 'row-1', message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: told }] } })
  await $.turn.complete({ answer: 'Renamed, and the changelog is written.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)
  said.prompt = '{}'
  await $.prompt.submit({ text: 'push it', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'push it', turnId: 't2' })
  await $.turn.complete({ answer: 'Pushed.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)
  const [first = '', second = ''] = kept.audits

  expect(kept.audits).toHaveLength(2)
  expect(first).toContain('i2 [Open ask] [asked now] Write the changelog')
  expect(first).toContain('[1] rename the branch\n\n[2] write the changelog\n')
  expect(second).toContain("THE USER'S MESSAGE\npush it\n")
})

/** A prompt typed mid-turn as the engine hands it to Claude inside the running turn. */
function delivered($: Engine, text: string) {
  const told = `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n</system-reminder>`

  return $.session.append({ door: 'delivery', origin: { kind: 'composer' }, uuid: `row-${text}`, message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text: told }] } })
}

test('what Claude closed before a message typed in the same turn is still given to the audit of that turn', async ($, on) => {
  const said: Said = { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' }
  const { clock, kept } = world(on, said)
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await clock.advance(5)
  await $.tool.call({ tool: 'mcp__inbox__inbox', action: 'close', id: 'i1', reason: 'git branch shows release.', tool_use_id: 'u1' } as never)
  said.prompt = '{}'
  await $.prompt.submit({ text: 'thanks', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await clock.advance(5)
  await delivered($, 'thanks')
  await $.turn.complete({ answer: 'Renamed.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
  expect(kept.audits[0]).toContain('CLOSED BY CLAUDE THIS TURN\ni1 Rename the branch. To close: The reply shows it. Claude closed it: git branch shows release. Closed after message 1 of 2.')
  expect(kept.audits[0]).toContain("THE USER'S MESSAGES, numbered in the order they reached Claude\n[1] rename the branch\n\n[2] thanks\n\nWHAT CLAUDE DID")
})

test('a turn that a notice starts is not given what Claude closed in the turn before', async ($, on) => {
  const said: Said = { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' }
  const { clock, kept } = world(on, said)
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await clock.advance(5)
  await $.tool.call({ tool: 'mcp__inbox__inbox', action: 'close', id: 'i1', reason: 'git branch shows release.', tool_use_id: 'u1' } as never)
  await $.turn.complete({ answer: 'Renamed.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)
  // A notice is no prompt of the person's, so the count of prompts stands where the turn before left it.
  await $.prompt.submit({ text: 'The build finished.', wait: false, origin: { kind: 'task-notification' } } as never)
  await $.turn.start({ text: 'The build finished.', turnId: 't2' })
  await $.turn.complete({ answer: 'Noted.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)
  const [first = '', second = ''] = kept.audits

  expect(kept.audits).toHaveLength(2)
  expect(first).toContain('CLOSED BY CLAUDE THIS TURN\ni1 Rename the branch.')
  expect(second).toContain('CLOSED BY CLAUDE THIS TURN\nnone')
})

test('of two messages alike that wait, the one that reaches Claude joins the turn and the other waits for its own', async ($, on) => {
  const { clock, kept } = world(on, { prompt: '{}' })
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await $.prompt.submit({ text: 'yes', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'yes', wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await clock.advance(5)
  await delivered($, 'yes')
  await $.turn.complete({ answer: 'Renamed.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)
  await $.turn.start({ text: 'yes', turnId: 't2' })
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)
  const [first = '', second = ''] = kept.audits

  expect(kept.audits).toHaveLength(2)
  expect(first).toContain('[1] rename the branch\n\n[2] yes\n\nWHAT CLAUDE DID')
  expect(second).toContain("THE USER'S MESSAGE\nyes\n\nWHAT CLAUDE DID")
})

// A fork starts under a new id with the first conversation's history, and Claude Code names no
// parent. Each finished turn leaves a mark beside the log: the last tool call the conversation held.
test('the end of a turn leaves a mark with the last tool call of the conversation and the count of prompts', async ($, on) => {
  const { clock, files, kept } = world(on, { reply: '{}' })
  kept.rows = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_9', tool: 'Bash', input: {} }] }]
  await start($)
  kept.turns = 3
  await exchange($, clock, 'create notes.txt', 'Created.')

  // The call, the inbox's count of prompts, and Claude Code's own count of turns.
  expect(files['/home/me/.claude/inbox/conv-1.marks']).toBe('toolu_9 1 3\n')
})

test('a fork of a conversation starts with the inbox that conversation had where the fork was made', async ($, on) => {
  const first = [
    { type: 'turn' },
    { type: 'open', item: { id: 'i1', kind: 'issue', title: 'Demo scripts live only in a temp folder', from: 'Claude', why: 'Lost when cleaned.', close: 'Move them.', turn: 1, at: 0, by: 'claude', status: 'open' } },
    { type: 'turn' },
    { type: 'open', item: { id: 'i2', kind: 'issue', title: 'Run shade relies on an undocumented color', from: 'Claude', why: 'It may change.', close: 'Ask.', turn: 2, at: 0, by: 'claude', status: 'open' } },
  ]
  const files = {
    '/home/me/.claude/inbox/first.jsonl': first.map(event => `${JSON.stringify(event)}\n`).join(''),
    '/home/me/.claude/inbox/first.marks': 'toolu_1 1 2\ntoolu_1 2 4\n',
    '/home/me/.claude/inbox/other.marks': 'toolu_77 5 10\n',
  }
  const { book, clock, kept } = world(on, {}, files)
  // The fork was made after the first conversation's first prompt. Its second prompt called no tool,
  // so both turns ended on the same call: the fork's count of turns says which of them it was.
  kept.rows = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: {} }] }]
  kept.turns = 2
  await start($)
  await clock.settle()

  expect(book().items.map(item => [item.id, item.status])).toEqual([['i1', 'open']])
  expect(book().turn).toBe(1)
  // The fork has a log and marks of its own from here on, so a fork of it finds them.
  expect((files as Record<string, string>)[LOG]).toContain('"type":"open"')
  expect((files as Record<string, string>)[LOG]).toContain('"what":"carried"')
  expect((files as Record<string, string>)['/home/me/.claude/inbox/conv-1.marks']).toBe('toolu_1 1 2\n')
})

test('a conversation with a history and no log that shares no tool call with any other starts empty', async ($, on) => {
  const { book, kept } = world(on, {}, { '/home/me/.claude/inbox/other.marks': 'toolu_77 5 10\n' })
  kept.rows = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: {} }] }]
  await start($)

  expect(book().items).toEqual([])
})

// A rewind takes prompts out of the conversation and leaves the inbox whole, as the person wants:
// what those prompts opened stays, marked as coming from a part that is gone.
test('an item from a prompt the person rewound past is kept and marked, and the one before it is not', async ($, on) => {
  const said: Said = { reply: '{"open": [{"kind": "issue", "title": "Demo scripts live only in a temp folder", "why": "Lost when cleaned.", "close": "Move them."}]}' }
  const { book, clock, files, kept } = world(on, said)
  await start($)
  kept.turns = 1
  await exchange($, clock, 'tidy the demo', 'Tidied.')
  said.reply = '{"open": [{"kind": "issue", "title": "Run shade relies on an undocumented color", "why": "It may change.", "close": "Ask."}]}'
  kept.turns = 2
  await exchange($, clock, 'restyle the run', 'Restyled.')
  expect(files['/home/me/.claude/inbox/conv-1.marks']).toBe('- 1 1\n- 2 2\n')

  // Rewound to before the second prompt: Claude Code counts one turn again.
  kept.turns = 1
  said.reply = '{}'
  await $.prompt.submit({ text: 'try the run another way', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)

  expect(book().items.map(item => [item.title, item.status, item.isRewound ?? false])).toEqual([
    ['Demo scripts live only in a temp folder', 'open', false],
    ['Run shade relies on an undocumented color', 'open', true],
  ])
  expect(files['/home/me/.claude/inbox/conv-1.marks']).toBe('- 1 1\n')

  const panel = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  expect(JSON.stringify(await panel.drawn())).toContain('↶')
})

// A reload of the mod cancels the timer an audit waits on. What a turn's end asked for is kept in the
// session's state, which a reload leaves alone, so the mod finds it there when it is loaded again.
// A compaction raises Claude Code's count of turns. Quit and resumed, the conversation is counted
// afresh and lower, which read as a rewind to its start and flagged every open item.
test('a conversation that was compacted, quit and resumed is not taken for one that was rewound', async ($, on) => {
  const item = { kind: 'issue', from: 'Claude', why: '', close: '', at: 5, by: 'audit', status: 'open' }
  const log = [{ type: 'turn' }, { type: 'open', item: { ...item, id: 'i1', turn: 1, title: 'Demo scripts live only in a temp folder' } }, { type: 'turn' }, { type: 'open', item: { ...item, id: 'i2', turn: 2, title: 'Run shade relies on an undocumented color' } }]
  const { book, clock, files, kept } = world(on, {}, { [LOG]: `${log.map(line => JSON.stringify({ at: 5, turn: 1, ...line })).join('\n')}\n`, '/home/me/.claude/inbox/conv-1.marks': 'toolu_a 1 1\ntoolu_b 2 6\n' })
  // The resumed conversation holds two turns, where the last mark was written at a count of six.
  kept.turns = 2
  await start($)
  await clock.settle()
  await $.prompt.submit({ text: 'and the docs', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)

  expect(book().items.map(one => [one.id, one.isRewound ?? false])).toEqual([
    ['i1', false],
    ['i2', false],
  ])
  expect(files['/home/me/.claude/inbox/conv-1.marks']).toBe('toolu_a 1 -3\ntoolu_b 2 2\n')
})

test('the audits that a reload of the mod cut off run when the mod is loaded again, each once', async ($, on) => {
  const left = (id: string, text: string) => ({ id, answer: 'Created it.', turn: [{ text, isNotice: false, asked: [] }] })
  const { clock, kept } = world(on, { reply: '{}' }, {}, [left('t8', 'create notes.txt'), left('t9', 'create todo.txt')])
  await start($)
  await clock.advance(5)

  expect(kept.audits).toHaveLength(2)
  expect(kept.audits[0]).toContain("THE USER'S MESSAGE\ncreate notes.txt\n")
  expect(kept.audits[1]).toContain("THE USER'S MESSAGE\ncreate todo.txt\n")
  expect(kept.pending).toEqual([])

  await start($)
  await clock.advance(5)
  expect(kept.audits).toHaveLength(2)
})

test('an audit that a build before this one left in the state, alone and not in a list, still runs', async ($, on) => {
  const left = { id: 't9', answer: 'Created notes.txt.', turn: [{ text: 'create notes.txt', isNotice: false, asked: [] }] }
  const { clock, kept } = world(on, { reply: '{}' }, {}, left)
  await start($)
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
  expect(kept.pending).toEqual([])
})

test('the end of a turn asks for one audit, however often the mod is started before it runs', async ($, on) => {
  const { clock, kept } = world(on, { reply: '{}' })
  await start($)
  await $.prompt.submit({ text: 'create notes.txt', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.complete({ answer: 'Created.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await start($)
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
})

// A reload of the mod drops the passes waiting in it, so every audit not yet finished is kept in the session's state.
test('two audits that wait at once are both kept for a reload of the mod, and each runs once', async ($, on) => {
  const { clock, kept } = world(on, { reply: '{}' })
  const waiting = () => [kept.pending].flat().map(job => job?.id)
  await start($)
  await $.prompt.submit({ text: 'create notes.txt', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'create notes.txt', turnId: 't1' })
  await $.turn.complete({ answer: 'Created notes.txt.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.prompt.submit({ text: 'and todo.txt', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'and todo.txt', turnId: 't2' })
  await $.turn.complete({ answer: 'Created todo.txt.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })

  expect(waiting()).toEqual(['t1', 't2'])

  await clock.advance(5)

  expect(kept.audits).toHaveLength(2)
  expect(waiting()).toEqual([])
})

// A prompt cancelled before Claude writes anything goes back in the prompt box, and Claude Code takes
// it out of the conversation: its count of turns stays what it was when the prompt was sent.
test('a prompt cancelled and taken back takes with it what the inbox made of it', async ($, on) => {
  const said: Said = { prompt: '{"asks": [{"title": "Create notes.txt", "quote": "create notes.txt", "done": "The reply shows it.", "goal": null}]}', reply: '{}' }
  const { book, clock, files, kept } = world(on, said)
  await start($)
  await exchange($, clock, 'create notes.txt', 'On it.')
  kept.turns = 1
  const before = book()

  said.prompt = '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}'
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't2' })
  await clock.advance(5)
  expect(book().items.map(item => item.title)).toEqual(['Create notes.txt', 'Rename the branch'])
  expect(book().turn).toBe(before.turn + 1)

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't2', reason: 'aborted' })
  await clock.advance(5)

  expect(book().items.map(item => item.title)).toEqual(['Create notes.txt'])
  expect(book().turn).toBe(before.turn)
  // The log keeps what happened: the ask that was opened, then the line that took it back.
  expect((files[LOG] ?? '').split('\n').filter(line => line.includes('"type":"retract"'))).toHaveLength(1)

  said.prompt = '{"asks": [{"title": "Rename the trunk", "quote": "rename the trunk", "done": "The reply shows it.", "goal": null}]}'
  await exchange($, clock, 'rename the trunk', 'On it.')
  expect(book().items.map(item => item.id)).toEqual(['i1', 'i3'])
})

test('a prompt taken back before it was read leaves nothing behind when the read comes in', async ($, on) => {
  const { book, clock } = world(on, { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' })
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.advance(5)

  expect(book().items).toEqual([])
  expect(book().turn).toBe(0)
})

test('a turn stopped after Claude began stays in the conversation, and so does what the inbox made of its prompt', async ($, on) => {
  const { book, clock, kept } = world(on, { prompt: '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}]}' })
  await start($)
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  await clock.advance(5)
  kept.turns = 2
  await $.turn.complete({ answer: 'Renaming', durationMs: 10, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.advance(5)

  expect(book().items.map(item => [item.title, item.status])).toEqual([['Rename the branch', 'open']])
  expect(book().turn).toBe(1)
})

test('what the person set aside comes back when they ask to wrap up', async ($, on) => {
  const said: Said = {}
  const { book, clock } = world(on, said)
  await start($)
  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  await ui.press({ key: 'row-i1' })
  await ui.press({ key: 'later-i1' })

  expect(book().items[0]).toMatchObject({ status: 'later', closedBy: 'you' })

  said.prompt = '{"asks": [], "answers": [], "wrap": true}'
  await exchange($, clock, 'ok commit and push it', 'Pushed.')

  expect(book().items[0]?.status).toBe('open')
})

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** The handle as drawn: the color it stands on, and the count it shows. */
async function handleOf(ui: { drawn: () => Promise<unknown> }) {
  const texts = (node: unknown): Drawn[] => {
    const element = node as Drawn
    if (typeof node !== 'object' || node === null) return []

    return [...(element.type === 'Text' ? [element] : []), ...(element.children ?? []).flatMap(texts)]
  }
  const said = (node: unknown): string => (typeof node === 'string' ? node : ((node as Drawn | null)?.children ?? []).map(said).join(''))
  const [box] = texts(await ui.drawn()).filter(text => text.props?.backgroundColor !== undefined)

  return { color: box?.props?.backgroundColor, count: Number(said(box).replace(/\D/g, '')) }
}

// The handle says where to look first: it wears the color of the first section, in the panel's
// order, that waits on the person, and counts every open item as the panel's title does.
test('the handle takes the color of the first section that waits on the person, and lets go of an item once it is sent', async ($, on) => {
  const { book, clock, kept } = world(on, { reply: '{}' })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'Exit code 1\n2 failed, 5 passed', isError: true }))
  // The handle is drawn after what is already there, so something has to be there: the engine's mode labels, here none.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => $.ui.resolve(e).Box({}))
  await start($)
  const handle = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, viewport: { columns: 150, rows: 50 } })
  expect(await handleOf(handle)).toEqual({ color: 'selectionBg', count: 0 })

  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  expect(await handleOf(handle)).toEqual({ color: 'suggestion', count: 1 })

  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u2' })
  await clock.settle()
  expect(book().items.map(item => item.kind)).toEqual(['issue', 'check'])
  expect(await handleOf(handle)).toEqual({ color: 'warning', count: 2 })

  // The failing check goes out with a prompt. It is still open, and the reply is now what it waits on.
  const panel = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  await panel.press({ key: 'row-i2' })
  await panel.press({ key: 'add-i2' })
  await $.prompt.submit({ text: kept.filled, wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)

  expect(book().items[1]).toMatchObject({ status: 'open', sent: 'Sent with no note.' })
  expect(await handleOf(handle)).toEqual({ color: 'suggestion', count: 2 })
})

test('an item sent from the panel is marked as sent with what was said, until the reply to it is read', async ($, on) => {
  const { book, clock, files, kept } = world(on, { reply: '{"closed": [{"id": "i1", "how": "done", "reason": "The reply moved the scripts into tools/."}]}' })
  await start($)
  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  await ui.press({ key: 'row-i1' })
  await ui.press({ key: 'intent-i1-0' })

  expect(kept.filled).toContain('> Inbox i1: Demo scripts live only in a\n>   temp folder')
  expect(kept.filled).toContain('Fix this now, then tell me what you changed.')

  await $.prompt.submit({ text: `one more thing first\n\n---\n\n${kept.filled}`, wait: false, origin: { kind: 'composer' } })
  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ status: 'open', sent: 'Fix this now, then tell me what you changed.' })

  await $.turn.complete({ answer: 'Moved them into tools/.', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'audit', reason: 'The reply closed it: The reply moved the scripts into tools/.' })
  expect(book().items[0]?.sent).toBe(undefined)
  expect(files[LOG]).toContain('"type":"turn"')
})

// A reload starts the mod's memory over while the turn goes on, and the session's state is what is left of it.
test('a turn that a reload of the mod finds running is taken up from the state, with its id, its messages and what waits', async ($, on) => {
  const told = (text: string) => ({ text, isNotice: false, asked: [], answered: [] })
  const { book, clock, kept } = world(on, {}, {}, null, { id: 't1', heard: [told('rename the branch')], waiting: [told('then tag it')] })
  await start($)
  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  await $.tool.call({ tool: 'mcp__inbox__inbox', action: 'close', id: 'i1', reason: 'The scripts are in tools/ now.', tool_use_id: 'u2' } as never)
  await delivered($, 'then tag it')
  await $.turn.complete({ answer: 'Renamed and tagged.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ closedIn: 't1', closedHeard: 1 })
  expect(kept.audits).toHaveLength(1)
  expect(kept.audits[0]).toContain('[1] rename the branch\n\n[2] then tag it\n\nWHAT CLAUDE DID')
  expect(kept.audits[0]).toContain('CLOSED BY CLAUDE THIS TURN\ni1 Demo scripts live only in a temp folder.')
})

const TWO_ASKS =
  '{"asks": [{"title": "Rename the branch", "quote": "rename the branch", "done": "The reply shows it.", "goal": null}, {"title": "Write the changelog", "quote": "write the changelog", "done": "The reply shows it.", "goal": null}]}'

// No reply came, so nothing can be judged done. A close Claude made on its own word is still unread.
test('a turn stopped after Claude closed something is audited for that close alone, and one that closed nothing is not audited', async ($, on) => {
  const reply = '{"closed": [{"id": "i2", "how": "done", "reason": "The changelog entry is in the last commit."}], "reopened": [{"id": "i1", "why": "No command renamed the branch before the turn was stopped."}]}'
  const { book, clock, kept } = world(on, { prompt: TWO_ASKS, reply })
  await start($)
  await $.prompt.submit({ text: 'rename the branch and write the changelog', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch and write the changelog', turnId: 't1' })
  kept.turns = 1
  await clock.advance(5)
  await $.tool.call({ tool: 'mcp__inbox__inbox', action: 'close', id: 'i1', reason: 'git branch shows release.', tool_use_id: 'u1' } as never)
  await $.turn.complete({ answer: 'Renaming', durationMs: 10, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
  expect(kept.audits[0]).toContain('CLOSED BY CLAUDE THIS TURN\ni1 Rename the branch.')
  expect(kept.audits[0]).toContain("CLAUDE'S REPLY\nRenaming\n\n[The turn was stopped here, before Claude finished.]")
  expect(book().items.map(item => [item.id, item.status])).toEqual([
    ['i1', 'open'],
    ['i2', 'open'],
  ])
  expect(book().items[0]?.why).toBe('No command renamed the branch before the turn was stopped.')

  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'go on', turnId: 't2' })
  kept.turns = 2
  await $.turn.complete({ answer: 'Writing', durationMs: 10, isAborted: true, turnId: 't2', reason: 'aborted' })
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
})

test('an audit whose model call fails is asked once more, and no more than that', async ($, on) => {
  const said: Said = { prompt: TWO_ASKS, reply: '{"closed": [{"id": "i1", "how": "done", "reason": "git branch shows release."}]}', failures: 1 }
  const { book, clock, kept } = world(on, said)
  await start($)
  await exchange($, clock, 'rename the branch and write the changelog', 'Renamed.')

  expect(kept.audits).toHaveLength(2)
  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'audit' })

  said.failures = 5
  await exchange($, clock, 'now the changelog', 'Written.')

  expect(kept.audits).toHaveLength(4)
  expect(book().items[1]).toMatchObject({ status: 'open' })
})

test('an answer sent while Claude works that does not reach it before the turn ends is kept for the turn that hears it', async ($, on) => {
  const { book, clock, kept } = world(on, { reply: '{"closed": [{"id": "i1", "how": "done", "reason": "The reply moved the scripts into tools/."}]}' })
  await start($)
  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  await $.prompt.submit({ text: 'rename the branch', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'rename the branch', turnId: 't1' })
  // Sent from the panel while that turn runs: a prompt takes with it what was waiting in the prompt box.
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  await ui.press({ key: 'row-i1' })
  await ui.press({ key: 'intent-i1-0' })
  const answer = kept.filled
  await $.prompt.submit({ text: answer, wait: false, turnId: 't1', origin: { kind: 'composer' } })
  await clock.advance(5)
  await $.turn.complete({ answer: 'Renamed.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(5)

  expect(kept.audits).toHaveLength(1)
  expect(book().items[0]).toMatchObject({ status: 'open', sent: 'Fix this now, then tell me what you changed.' })

  await $.turn.start({ text: answer, turnId: 't2' })
  await $.turn.complete({ answer: 'Moved them into tools/.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ status: 'done', closedBy: 'audit' })
})

// An audit can wait behind the passes before it, and what the person does in the panel meanwhile came after the turn it reads.
test("an item the person reopens after a turn ends stays open, though that turn's audit had not started", async ($, on) => {
  const { book, clock } = world(on, { reply: '{"closed": [{"id": "i1", "how": "done", "reason": "The reply moved the scripts into tools/."}]}' })
  await start($)
  await $.prompt.submit({ text: 'move the scripts', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'move the scripts', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__inbox__inbox', tool_use_id: 'u1', ...FINDING })
  await $.tool.call({ tool: 'mcp__inbox__inbox', action: 'close', id: 'i1', reason: 'The scripts are in tools/ now.', tool_use_id: 'u2' } as never)
  await $.turn.complete({ answer: 'Moved them into tools/.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE, viewport: { columns: 150, rows: 50 } })
  await ui.press({ key: 'fold-closed' })
  await ui.press({ key: 'row-i1' })
  await ui.press({ key: 'later-i1' })

  expect(book().items[0]).toMatchObject({ status: 'open' })

  await clock.advance(5)

  expect(book().items[0]).toMatchObject({ status: 'open' })
})

test('a reload of the plugins closes the task that waited on it, and leaves the one that waits on a restart', async ($, on) => {
  const task = (title: string, closesOn: string) => ({ kind: 'task', title, why: 'The change is on disk.', closesOn })
  const { book, clock } = world(on, { reply: JSON.stringify({ open: [task('Run /reload-plugins to load the fix', 'reload'), task('Restart Claude Code for the new base theme', 'restart')] }) })
  await start($)
  await exchange($, clock, 'fix the hover', 'Fixed. Run /reload-plugins, and restart for the theme.')

  expect(book().items.map(item => [item.closesOn, item.status])).toEqual([
    ['reload', 'open'],
    ['restart', 'open'],
  ])

  await start($)
  await clock.settle()

  expect(book().items.map(item => [item.closesOn, item.status, item.reason])).toEqual([
    ['reload', 'done', 'The plugins were reloaded.'],
    ['restart', 'open', undefined],
  ])
})

test('a resumed conversation gets its inbox back from the log, and what waited on a restart is closed', async ($, on) => {
  const item = { kind: 'task', from: 'Claude', why: '', close: '', turn: 1, at: 5, by: 'audit', status: 'open' }
  const log = [
    { type: 'turn' },
    { type: 'open', item: { ...item, id: 'i1', title: 'Restart Claude Code to load the mods', closesOn: 'restart' } },
    { type: 'open', item: { ...item, id: 'i2', title: 'Ask GitHub Support to purge the old commits' } },
    { type: 'note', what: 'reply audit', detail: {} },
  ]
  const { book, clock } = world(on, {}, { [LOG]: `${log.map(line => JSON.stringify({ at: 5, turn: 1, ...line })).join('\n')}\n{"cut short` })
  await start($)
  await clock.settle()

  expect(book().items.map(one => [one.id, one.status])).toEqual([
    ['i1', 'done'],
    ['i2', 'open'],
  ])
  expect(book().items[0]?.reason).toBe('Claude Code was started again.')
  expect([book().turn, book().nextId]).toEqual([1, 3])
})

test("a workflow's agent is not audited on its own, as its report goes to the workflow and not to the conversation", { options: { depth: 'Exhaustive' } }, async ($, on) => {
  const step = JSON.stringify({ open: [{ kind: 'issue', title: 'The agent that ran step 3 hid a failed lint run', from: 'A subagent I started reported: "lint clean"', why: 'The lint call exited 1.', close: 'Rerun lint.' }] })
  const { book, clock } = world(on, { reply: step })
  on('agent.spawn', async () => ({ model: 'sonnet', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ tool_use_id: 'u1', prompt: 'Lint step 3.', description: 'step 3', subagentType: 'workflow-subagent', parentModel: 'opus', background: true, fork: false, workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
  await $.turn.complete({ answer: 'lint clean', durationMs: 5, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer' })
  await clock.advance(5)

  expect(book().items.filter(item => item.by === 'audit')).toEqual([])
})

test('a resumed conversation closes what ran in the background, as its tasks went with the old process', async ($, on) => {
  const running = { kind: 'running', from: 'Claude started it in the background.', why: '', close: 'It ends by itself, or you ask Claude to stop it.', selfCloses: 'When the task ends.', turn: 1, at: 5, by: 'engine', status: 'open' }
  const log = [
    { type: 'turn' },
    { type: 'open', item: { ...running, id: 'i1', title: 'Start the dev server', key: 'b1' } },
    { type: 'open', item: { ...running, id: 'i2', title: 'Workflow: survey', key: 'w1' } },
    { type: 'open', item: { ...running, id: 'i3', title: 'scout', key: 'a1' } },
    { type: 'open', item: { kind: 'issue', title: 'Demo scripts live only in a temp folder', from: 'Claude', why: '', close: '', turn: 1, at: 5, by: 'claude', status: 'open', id: 'i4' } },
  ]
  const { book, clock } = world(on, {}, { [LOG]: `${log.map(line => JSON.stringify({ at: 5, turn: 1, ...line })).join('\n')}\n` })
  await start($)
  await clock.settle()

  expect(book().items.map(one => [one.id, one.status, one.reason])).toEqual([
    ['i1', 'done', 'Claude Code was started again.'],
    ['i2', 'done', 'Claude Code was started again.'],
    ['i3', 'done', 'Claude Code was started again.'],
    ['i4', 'open', undefined],
  ])
})

test('a reload of the plugins leaves what runs in the background open, as its task is still running', async ($, on) => {
  const { book, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Running in the background.' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, tool_use_id: 'u1' })
  await clock.settle()
  await start($)
  await clock.settle()

  expect(book().items.map(one => [one.key, one.status])).toEqual([['b1', 'open']])
})
