import { expect, test, type TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const WIDE = { columns: 160, rows: 50 }
const NARROW = { columns: 60, rows: 40 }
const ENGINE_ROW = 'engine row'

const BASH = {
  tool_use_id: 'toolu_bash',
  tool: 'Bash',
  input: { command: 'cat a.txt b.txt', description: 'Print both files' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'alpha\nbeta', stderr: '', interrupted: false },
}

const READ = {
  tool_use_id: 'toolu_read',
  tool: 'Read',
  input: { file_path: '/repo/notes.md', limit: 20 },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { type: 'text' },
}

const FOLDED_RUN = {
  calls: [
    { tool_use_id: READ.tool_use_id, tool: 'Read', input: READ.input, isRunning: false, isErrored: false, isInterrupted: false },
  ],
  isActive: false,
  isExpanded: false,
}

type Row = Omit<typeof BASH, 'input' | 'output'> & { input: unknown; output?: unknown }
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function mountRow($: Engine, row: Row, viewport = WIDE, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'cleaner-tool-lines',
    surface,
    component: 'ToolUse',
    requestId: row.tool_use_id,
    props: row,
    viewport,
  })
}

function mountResult($: Engine, row: Row) {
  return $.ui.mount({
    plugin: 'cleaner-tool-lines',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: row.tool_use_id,
    props: { tool_use_id: row.tool_use_id, tool: row.tool, output: row.output, isErrored: row.isErrored },
    viewport: WIDE,
  })
}

function mountRun($: Engine, props: typeof FOLDED_RUN) {
  return $.ui.mount({ plugin: 'cleaner-tool-lines', surface: 'terminal', component: 'ToolGroup', props, viewport: WIDE })
}

function mountPrompt($: Engine, isExpanded: boolean) {
  return $.ui.mount({
    plugin: 'cleaner-tool-lines',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'find the costs', origin: { kind: 'composer' }, isExpanded },
    viewport: WIDE,
  })
}

// Stands for Claude Code's own drawing at every site the mod hands back.
function drawEngineRows(on: On) {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [ENGINE_ROW] })
  })
}

// Everything a tree shows, in the order written: its strings, and the source of a Code.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const { props, children } = node as Drawn
  const source = typeof props?.source === 'string' ? props.source : ''
  return source + (children ?? []).map(textOf).join('')
}

// Every element of a tree that the test picks, outermost first.
function elementsOf(node: unknown, isPicked: (element: Drawn) => boolean): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const element = node as Drawn
  const inner = (element.children ?? []).flatMap(child => elementsOf(child, isPicked))
  return isPicked(element) ? [element, ...inner] : inner
}

const isBox = (element: Drawn) => element.type === 'Box'

type Mounted = { drawn: () => Promise<unknown> }

// All of the pressable line, with the spaces that fill it out to the row's edge.
async function buttonOf(ui: Mounted): Promise<string> {
  return textOf(elementsOf(await ui.drawn(), element => element.type === 'Button')[0])
}

// What the pressable line says.
async function lineOf(ui: Mounted): Promise<string> {
  return (await buttonOf(ui)).trimEnd()
}

// A row's text without the spaces that fill its line out to the row's edge.
function unfilled(text: string): string {
  return text.replace(/ {2,}/g, '')
}

// The shaded panel an open call's input and result sit on, if the tree has one.
async function panelOf(ui: Mounted): Promise<Drawn | undefined> {
  return elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.backgroundColor !== undefined)[0]
}

// MARK: The closed line

test('draws a finished call as one closed line', async $ => {
  const ui = await mountRow($, BASH)
  expect(unfilled(textOf(await ui.drawn()))).toBe('● ▸ tool_call: Bash(cat a.txt b.txt)')
})

test('names a file tool by its path', async $ => {
  expect(await lineOf(await mountRow($, READ))).toBe('▸ tool_call: Read(/repo/notes.md)')
})

test('names an agent by its description, not its prompt', async $ => {
  const agent = { ...BASH, tool: 'Agent', input: { prompt: 'Read every file and report back.', description: 'Survey repo' } }
  expect(await lineOf(await mountRow($, agent))).toBe('▸ tool_call: Agent(Survey repo)')
})

test('shows the raw input of a tool it has no subject for', async $ => {
  const check = { ...BASH, tool: 'mcp__inbox__run_check', input: { checks: ['npm test'] } }
  expect(await lineOf(await mountRow($, check))).toBe('▸ tool_call: mcp__inbox__run_check({"checks":["npm test"]})')
})

test('draws a call with no input with empty brackets', async $ => {
  const bare = { ...BASH, tool: 'TaskList', input: {} }
  expect(await lineOf(await mountRow($, bare))).toBe('▸ tool_call: TaskList()')
})

test('joins a command written over several lines', async $ => {
  const script = { ...BASH, input: { command: 'cd /repo\n  && npm test' } }
  expect(await lineOf(await mountRow($, script))).toBe('▸ tool_call: Bash(cd /repo && npm test)')
})

test('sets the tool name apart in bold, inside one pressable line', async $ => {
  const ui = await mountRow($, BASH)
  const button = elementsOf(await ui.drawn(), element => element.type === 'Button')[0]
  const bold = elementsOf(button, element => element.props?.bold === true)
  expect(bold.map(textOf)).toEqual(['Bash'])
})

// MARK: Width

// At 60 columns the line has 56 cells: the indent takes 2 and the dot's column 2.
test('cuts a long subject so the line fills one row and no more', async $ => {
  const long = { ...BASH, input: { command: 'echo ' + 'x'.repeat(400) } }
  const line = await lineOf(await mountRow($, long, NARROW))
  expect(line.length).toBe(56)
  expect(line).toMatch(/^▸ tool_call: Bash\(echo x+…\)$/)
})

test('cuts the subject, never the note after it', async $ => {
  const failed = { ...BASH, input: { command: 'echo ' + 'x'.repeat(400) }, isErrored: true, output: 'Exit code 1' }
  const line = await lineOf(await mountRow($, failed, NARROW))
  expect(line.length).toBe(56)
  expect(line).toMatch(/…\) - error$/)
})

test('cuts a long path from the front so its file name stays', async $ => {
  const deep = { ...READ, input: { file_path: '/repo/' + 'deep/'.repeat(30) + 'notes.md' } }
  const line = await lineOf(await mountRow($, deep, NARROW))
  expect(line.length).toBe(56)
  expect(line).toMatch(/^▸ tool_call: Read\(…[a-z/]+\/deep\/notes\.md\)$/)
})

// The head "▸ tool_call: Bash(" takes 18 cells and the closing bracket 1, which leaves the subject 37.
test('counts a wide character as the two cells a terminal draws it in', async $ => {
  const wide = { ...BASH, input: { command: 'echo ' + '語'.repeat(80) } }
  // "echo " takes 5 cells and the ellipsis 1, so 15 wide characters fit and a 16th would not.
  expect(await lineOf(await mountRow($, wide, NARROW))).toBe('▸ tool_call: Bash(echo ' + '語'.repeat(15) + '…)')
})

test('cuts between emoji, never through one', async $ => {
  const party = { ...BASH, input: { command: 'echo ' + '🎉'.repeat(80) } }
  expect(await lineOf(await mountRow($, party, NARROW))).toBe('▸ tool_call: Bash(echo ' + '🎉'.repeat(15) + '…)')
})

test('keeps the file name of a long path of wide characters', async $ => {
  const deep = { ...READ, input: { file_path: '/repo/' + '語'.repeat(80) + '/notes.md' } }
  // The ellipsis takes 1 cell and "/notes.md" 9, so 13 wide characters fit before the file name.
  expect(await lineOf(await mountRow($, deep, NARROW))).toBe('▸ tool_call: Read(…' + '語'.repeat(13) + '/notes.md)')
})

test('gives a combining mark no cell of its own', async $ => {
  // Each "é" here is an "e" followed by a combining acute accent: two characters, one cell.
  const accented = { ...BASH, input: { command: 'echo ' + 'é'.repeat(80) } }
  expect(await lineOf(await mountRow($, accented, NARROW))).toBe('▸ tool_call: Bash(echo ' + 'é'.repeat(31) + '…)')
})

test('leaves a subject that fits the row whole', async $ => {
  expect(await lineOf(await mountRow($, BASH, NARROW))).toBe('▸ tool_call: Bash(cat a.txt b.txt)')
})

// A press lands on the button alone, so a line shorter than its row is filled out to the row's edge.
test('fills a closed line out to the edge of its row', async $ => {
  // The line takes 34 of the row's 56 cells.
  expect(await buttonOf(await mountRow($, BASH, NARROW))).toBe('▸ tool_call: Bash(cat a.txt b.txt)' + ' '.repeat(22))
})

test('fills by the cells a line takes, not by its characters', async $ => {
  const wide = { ...BASH, input: { command: 'echo 語語' } }
  // 26 characters in 28 cells.
  expect(await buttonOf(await mountRow($, wide, NARROW))).toBe('▸ tool_call: Bash(echo 語語)' + ' '.repeat(28))
})

test('fills the line of an open call out to the edge of its row, after its note', async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, { ...BASH, isErrored: true, output: 'Exit code 1' }, NARROW)
  await ui.press({ key: 'toggle' })
  // The line takes 25 of the row's 56 cells.
  expect(await buttonOf(ui)).toBe('▾ tool_call: Bash - error' + ' '.repeat(31))
})

// MARK: Status

// While the pointer is on a folded run, Claude Code draws every dim text in the run at full
// strength. A dim part would light up along with its neighbours, as if they were one target.
test('dims no part of the line, so a hovered run cannot light its other lines', async $ => {
  const ui = await mountRow($, { ...BASH, isErrored: true, output: 'Exit code 1' })
  expect(elementsOf(await ui.drawn(), element => element.props?.dimColor !== undefined)).toEqual([])
})

test('colors the dot by how the call stands', async $ => {
  const dotColorOf = async (row: Row) => {
    const ui = await mountRow($, row)
    const dot = elementsOf(await ui.drawn(), element => element.type === 'Text' && textOf(element).includes('●'))[0]
    await ui.unmount()
    return dot?.props?.color
  }
  expect(await dotColorOf({ ...BASH, isRunning: true, output: undefined })).toBe('warning')
  // Waiting on its turn or on approval: not running yet, no result yet.
  expect(await dotColorOf({ ...BASH, output: undefined })).toBe('warning')
  expect(await dotColorOf(BASH)).toBe('success')
  expect(await dotColorOf({ ...BASH, isErrored: true, output: 'Exit code 1' })).toBe('error')
  expect(await dotColorOf({ ...BASH, isInterrupted: true, output: 'Interrupted' })).toBe('error')
})

test('notes how a call ended when the dot alone does not say', async $ => {
  const noteOf = async (row: Row) => {
    const ui = await mountRow($, row)
    const note = (await lineOf(ui)).split(') - ')[1]
    await ui.unmount()
    return note
  }
  expect(await noteOf(BASH)).toBeUndefined()
  expect(await noteOf({ ...BASH, isErrored: true, output: 'Exit code 1' })).toBe('error')
  expect(await noteOf({ ...BASH, isErrored: true, isInterrupted: true, output: 'Interrupted' })).toBe('interrupted')
  expect(await noteOf({ ...BASH, output: { ...BASH.output, backgroundTaskId: 'b1' } })).toBe('background')
  expect(await noteOf({ ...BASH, output: { ...BASH.output, timedOutAfterMs: 120000 } })).toBe('timed out')
})

test('notes an agent that Claude Code left running in the background', async $ => {
  const agent = { ...BASH, tool: 'Agent', input: { description: 'Count to four', prompt: 'Reply with four.' } }
  const launched = {
    status: 'async_launched',
    isAsync: true,
    agentId: 'a1',
    description: 'Count to four',
    prompt: 'Reply with four.',
    outputFile: '/tmp/a1.output',
  }
  const running = await mountRow($, { ...agent, output: launched })
  expect(await lineOf(running)).toBe('▸ tool_call: Agent(Count to four) - background')
  await running.unmount()

  const finished = await mountRow($, { ...agent, output: { status: 'completed', prompt: 'Reply with four.' } })
  expect(await lineOf(finished)).toBe('▸ tool_call: Agent(Count to four)')
})

// MARK: Opening a call

test('opens and closes a call when its line is pressed', async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, BASH)
  expect(await lineOf(ui)).toBe('▸ tool_call: Bash(cat a.txt b.txt)')

  await ui.press({ key: 'toggle' })
  expect(await lineOf(ui)).toMatch(/^▾ /)

  await ui.press({ key: 'toggle' })
  expect(await lineOf(ui)).toBe('▸ tool_call: Bash(cat a.txt b.txt)')
})

// A press anywhere on a button toggles it and the pointer inverts all of it, so an open call keeps
// its button to the row of its head and leaves the input free to be read, selected and copied.
test('keeps only the head of an open call pressable', async ($, on) => {
  drawEngineRows(on)
  const failed = { ...BASH, isErrored: true, output: 'Exit code 1' }
  const ui = await mountRow($, failed)
  await ui.press({ key: 'toggle' })
  expect(await lineOf(ui)).toBe('▾ tool_call: Bash - error')
})

test('shows an open shell command as code, with its line breaks', async ($, on) => {
  drawEngineRows(on)
  const script = { ...BASH, input: { command: "python3 - <<'EOF'\nimport sys\nprint('one')\nEOF" } }
  const ui = await mountRow($, script)
  await ui.press({ key: 'toggle' })
  const code = elementsOf(await panelOf(ui), element => element.type === 'Code')[0]
  expect(code?.props).toEqual({ source: "python3 - <<'EOF'\nimport sys\nprint('one')\nEOF", language: 'bash' })
})

test('shows the whole prompt of an open agent call', async ($, on) => {
  drawEngineRows(on)
  const agent = { ...BASH, tool: 'Agent', input: { description: 'Survey repo', prompt: 'Read every file.\nReport back.' } }
  const ui = await mountRow($, agent)
  await ui.press({ key: 'toggle' })
  expect(textOf(await panelOf(ui))).toBe('Read every file.\nReport back.')
})

test('shows the whole subject of any other open call', async ($, on) => {
  drawEngineRows(on)
  const deep = { ...BASH, tool: 'Read', input: { file_path: '/repo/' + 'deep/'.repeat(30) + 'notes.md' } }
  const ui = await mountRow($, deep, NARROW)
  await ui.press({ key: 'toggle' })
  expect(textOf(await panelOf(ui))).toBe('/repo/' + 'deep/'.repeat(30) + 'notes.md')
})

test('shows all of the input of an open call it has no subject for', async ($, on) => {
  drawEngineRows(on)
  const check = { ...BASH, tool: 'mcp__inbox__run_check', input: { checks: ['npm test'] } }
  const ui = await mountRow($, check)
  await ui.press({ key: 'toggle' })
  const code = elementsOf(await panelOf(ui), element => element.type === 'Code')[0]
  expect(code?.props).toEqual({ source: '{\n  "checks": [\n    "npm test"\n  ]\n}', language: 'json' })
})

test('draws no panel for an open call with no input', async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, { ...BASH, tool: 'TaskList', input: {} })
  await ui.press({ key: 'toggle' })
  expect(await panelOf(ui)).toBeUndefined()
})

test('leaves the result of an open standalone call to the row beneath', async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, BASH)
  await ui.press({ key: 'toggle' })
  // The result row is a site of its own, so the line's row holds the head and the input alone.
  expect(unfilled(textOf(await ui.drawn()))).toBe('● ▾ tool_call: Bashcat a.txt b.txt')
})

test('hides the result of a closed standalone call and sets it on the panel once the call is open', async ($, on) => {
  drawEngineRows(on)
  const line = await mountRow($, BASH)
  const result = await mountResult($, BASH)
  expect(textOf(await result.drawn())).toBe('')

  await line.press({ key: 'toggle' })
  expect(textOf(await panelOf(result))).toBe(ENGINE_ROW)
})

test('opens a call of a folded run to its input and its result alone', async ($, on) => {
  let askedFor: string | undefined
  // Claude Code draws a call of an unfolded run with its result inline, under a header named by `tool`.
  on('ui.render', { component: 'ToolUse' }, async ($, e) => {
    askedFor = e.props.tool
    const { Text } = $.ui.resolve(e)
    return Text({ children: [ENGINE_ROW] })
  })
  drawEngineRows(on)
  await mountRun($, FOLDED_RUN)
  const ui = await mountRow($, READ)

  await ui.press({ key: 'toggle' })
  expect(unfilled(textOf(await ui.drawn()))).toBe('● ▾ tool_call: Read/repo/notes.md' + ENGINE_ROW)
  expect(textOf(await panelOf(ui))).toBe('/repo/notes.md' + ENGINE_ROW)
  // An empty name is how the row is asked for without its header, which the line already is.
  expect(askedFor).toBe('')
})

test('shows the input alone for an open call of a run that has no result yet', async ($, on) => {
  drawEngineRows(on)
  await mountRun($, FOLDED_RUN)
  const ui = await mountRow($, { ...READ, isRunning: true, output: undefined })
  await ui.press({ key: 'toggle' })
  expect(unfilled(textOf(await ui.drawn()))).toBe('● ▾ tool_call: Read/repo/notes.md')
})

test('opening one call leaves the next one closed', async ($, on) => {
  drawEngineRows(on)
  const first = await mountRow($, BASH)
  const second = await mountRow($, READ)

  await first.press({ key: 'toggle' })
  expect(await lineOf(first)).toBe('▾ tool_call: Bash')
  expect(await lineOf(second)).toBe('▸ tool_call: Read(/repo/notes.md)')
})

// MARK: Folded runs

test('asks Claude Code to unfold a folded run so each call gets its line', async ($, on) => {
  let asked: boolean | undefined
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    asked = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return Text({ children: [ENGINE_ROW] })
  })
  await mountRun($, FOLDED_RUN)
  expect(asked).toBe(true)
})

// A click on an open call's input or result is a click on the run to Claude Code, which then marks
// the whole run expanded. Handing the run back at that point would redraw every call in it natively.
test('keeps its own lines when Claude Code marks a run expanded', async ($, on) => {
  drawEngineRows(on)
  const run = await mountRun($, FOLDED_RUN)
  const inRun = await mountRow($, READ)
  expect(await lineOf(inRun)).toBe('▸ tool_call: Read(/repo/notes.md)')

  await run.redraw({ ...FOLDED_RUN, isExpanded: true })
  expect(await lineOf(inRun)).toBe('▸ tool_call: Read(/repo/notes.md)')
})

// Claude Code shades a run it marks expanded and adds a row beneath it.
test('covers the shade of a run Claude Code marks expanded, and takes back the row beneath it', async ($, on) => {
  drawEngineRows(on)
  const run = await mountRun($, FOLDED_RUN)
  expect(elementsOf(await run.drawn(), isBox)).toEqual([])

  await run.redraw({ ...FOLDED_RUN, isExpanded: true })
  const [cover, ...others] = elementsOf(await run.drawn(), isBox)
  expect(others).toEqual([])
  // A background Claude Code reads as no color, which live draws the terminal's own over the shade.
  expect(cover?.props?.backgroundColor).toBe('ansi256()')
  expect(cover?.props?.marginBottom).toBe(-1)
  expect(textOf(cover)).toBe(ENGINE_ROW)
})

test('covers nothing where every run is drawn expanded, which Claude Code neither shades nor pads', async ($, on) => {
  drawEngineRows(on)
  const prompt = await mountPrompt($, true)
  const run = await mountRun($, { ...FOLDED_RUN, isExpanded: true })
  expect(elementsOf(await run.drawn(), isBox)).toEqual([])
  expect(textOf(await run.drawn())).toBe(ENGINE_ROW)

  await prompt.redraw({ text: 'find the costs', origin: { kind: 'composer' }, isExpanded: false })
})

// MARK: Sprees

type RunCall = { tool_use_id: string; tool: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean }
type Chunk = { kind: 'tool'; index: number; id: string; name: string } | { kind: 'text' | 'thinking'; index: number; text: string }
type Made = { tool_use_id: string; tool: string; input: unknown; isErrored: boolean; output?: unknown }

const DONE = { isRunning: false, isErrored: false, isInterrupted: false }
const LS = { ...BASH, tool_use_id: 'toolu_spree_ls', input: { command: 'ls' } }
const TESTS = { ...BASH, tool_use_id: 'toolu_spree_tests', input: { command: 'npm test' }, isErrored: true, output: 'Exit code 1' }
const EDIT = { ...DONE, tool_use_id: 'toolu_spree_edit', tool: 'Edit', input: { file_path: '/repo/app.ts' }, output: { filePath: '/repo/app.ts' } }
const MCP = { ...DONE, tool_use_id: 'toolu_spree_mcp', tool: 'mcp__inbox__inbox', input: { action: 'list' }, output: { text: 'nothing open' } }
const NOTES = { ...READ, tool_use_id: 'toolu_spree_notes' }
const RUN_OF_THREE = {
  calls: [
    { ...DONE, tool_use_id: 'toolu_ls', tool: 'Bash', input: { command: 'ls' } },
    { ...DONE, tool_use_id: 'toolu_test', tool: 'Bash', input: { command: 'npm test' }, isErrored: true },
    { ...DONE, tool_use_id: READ.tool_use_id, tool: 'Read', input: READ.input },
  ] as RunCall[],
  isActive: false,
  isExpanded: false,
}

const begins = (row: { tool_use_id: string; tool: string }): Chunk => ({ kind: 'tool', index: 0, id: row.tool_use_id, name: row.tool })
const says = (text: string): Chunk => ({ kind: 'text', index: 0, text })
const thinks = (text: string): Chunk => ({ kind: 'thinking', index: 0, text })

function mountRunOf($: Engine, props: typeof RUN_OF_THREE) {
  return $.ui.mount({ plugin: 'cleaner-tool-lines', surface: 'terminal', component: 'ToolGroup', requestId: 'run', props, viewport: WIDE })
}

// Stands for the model and for the tools. Each request of a turn streams the next list of chunks.
// A call made with `holdOpen` runs until the test calls `settle`, and `started` resolves once it runs.
function claudeWorks(on: On, responses: Chunk[][]): { settle: () => void; started: Promise<void> } {
  const waiting = [...responses]
  const held = { settle: () => {}, start: () => {} }
  const started = new Promise<void>(resolve => (held.start = resolve))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    for (const chunk of waiting.shift() ?? []) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('tool.call', async ($, e) => {
    const asked = e as { failed?: boolean; holdOpen?: boolean }
    if (asked.holdOpen === true) {
      held.start()
      await new Promise<void>(resolve => (held.settle = resolve))
    }
    return asked.failed === true ? { result: 'Exit code 1', text: 'Exit code 1', isError: true } : { result: { ok: true }, text: 'ok' }
  })
  return { settle: () => held.settle(), started }
}

// One request of a turn, read to its end as Claude Code reads it.
async function request($: Engine, index: number, agentId?: string) {
  const step = { turnId: 'turn', index, model: 'claude', messageCount: 1 }
  for await (const chunk of $.turn.step(agentId === undefined ? step : { ...step, agentId })) void chunk
}

// Claude Code runs a call that the model made. `failed` and `holdOpen` are read by the stand-in above.
function runCall($: Engine, made: Made, more: { holdOpen?: boolean; agentId?: string } = {}) {
  const call = { tool: made.tool, tool_use_id: made.tool_use_id, ...(made.input as Record<string, unknown>), failed: made.isErrored, ...more }
  return $.tool.call(call as Parameters<Engine['tool']['call']>[0])
}

async function dotOf(ui: Mounted): Promise<unknown> {
  return elementsOf(await ui.drawn(), element => element.type === 'Text' && textOf(element) === '● ')[0]?.props?.color
}

// A prompt typed while Claude works is drawn between the calls made before it arrived and the calls
// made after. One line that counted them all would stand above the prompt and count what is below it.
test('a prompt typed while Claude works ends the spree under way, so the calls after it fold apart', { options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(LS)], [begins(EDIT)], [begins(TESTS)], [begins(NOTES)]])
  for (const index of [0, 1]) await request($, index)
  // Submitted while the turn runs, the prompt carries the turn's id and goes out with its next request.
  await $.prompt.submit({ text: 'also run the tests', wait: false, origin: { kind: 'composer' }, turnId: 'turn' } as never)
  for (const index of [2, 3]) await request($, index)
  const rows = [await mountRow($, LS), await mountRow($, EDIT), await mountRow($, TESTS), await mountRow($, NOTES)]
  for (const made of [LS, EDIT, TESTS, NOTES]) await runCall($, made)

  expect(await lineOf(rows[0] as Mounted)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(await lineOf(rows[2] as Mounted)).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
})

// Claude Code's hint to send a long command to the background is a row of its own under the call.
test('leaves out the run-in-background hint under a folded spree, and keeps it under a call with its own line', { options: { showRunning: true } }, async ($, on) => {
  // Beneath the mod, Claude Code draws the hint it is handed, and nothing for one that is empty.
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: [e.component === 'ToolProgress' ? e.props.hint : ENGINE_ROW] }))
  claudeWorks(on, [[begins(LS)], [begins(EDIT)]])
  const hintOf = (made: Made) => $.ui.mount({ plugin: 'cleaner-tool-lines', surface: 'terminal', component: 'ToolProgress', requestId: `hint-${made.tool_use_id}`, props: { tool_use_id: made.tool_use_id, kind: 'background_hint', hint: '(ctrl+b to run in background)' }, viewport: WIDE })
  await request($, 0)
  await mountRow($, LS)
  const alone = await hintOf(LS)

  expect(textOf(await alone.drawn())).toBe('(ctrl+b to run in background)')

  await request($, 1)
  await mountRow($, EDIT)

  expect(textOf(await (await hintOf(EDIT)).drawn())).toBe('')
})

test('draws a spree as one line on the row of its first call, whatever tools made the calls',{ options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(LS)], [begins(EDIT)], [begins(MCP)]])
  for (const index of [0, 1, 2]) await request($, index)
  const first = await mountRow($, LS)
  const second = await mountRow($, EDIT)
  const third = await mountRow($, MCP)
  const result = await mountResult($, EDIT)
  for (const made of [LS, EDIT, MCP]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 3 tool_calls: 1 Bash, 1 Edit, 1 mcp__inbox__inbox')
  expect(await dotOf(first)).toBe('success')
  expect(textOf(await second.drawn())).toBe('')
  expect(textOf(await third.drawn())).toBe('')
  expect(textOf(await result.drawn())).toBe('')
})

// Every tool row of the transcript is drawn again when one row asks for all of them, which a long
// conversation feels. A call starting or ending draws the rows of its own spree and no others.
test('folds a spree without asking for the whole transcript to be drawn again', { options: { showRunning: false } }, async ($, on) => {
  let asked = 0
  on('ui.invalidate', async ($, e, next) => {
    asked += 1
    return next(e)
  })
  claudeWorks(on, [[begins(LS), begins(EDIT)], [says('Done.')]])
  await request($, 0)
  const first = await mountRow($, LS)
  await mountRow($, EDIT)
  for (const made of [LS, EDIT]) await runCall($, made)
  await request($, 1)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(asked).toBe(0)
})

test('a press on the line of a spree lists its calls, set in under it, and a second press folds them away', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)]])
  await request($, 0)
  const first = await mountRow($, LS)
  const second = await mountRow($, EDIT)
  for (const made of [LS, EDIT]) await runCall($, made)

  await first.press({ key: 'spree' })
  expect(unfilled(textOf(await first.drawn()))).toBe('● ▾ 2 tool_calls● ▸ tool_call: Bash(ls)')
  expect(await lineOf(second)).toBe('▸ tool_call: Edit(/repo/app.ts)')
  expect(elementsOf(await second.drawn(), isBox)[0]?.props?.marginLeft).toBe(4)

  await first.press({ key: 'spree' })
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(textOf(await second.drawn())).toBe('')
})

test('the line of a spree counts the calls that failed, and its dot is red for them', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(TESTS)]])
  await request($, 0)
  const first = await mountRow($, LS)
  await mountRow($, TESTS)
  for (const made of [LS, TESTS]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 2 Bash - 1 failed')
  expect(await dotOf(first)).toBe('error')
})

test('the dot of a spree is yellow while a call of it runs, and the line counts the call from its start', { options: { showRunning: false } }, async ($, on) => {
  const work = claudeWorks(on, [[begins(LS), begins(EDIT)]])
  await request($, 0)
  const first = await mountRow($, LS)
  await runCall($, LS)
  expect(await lineOf(first)).toBe('▸ tool_call: Bash(ls)')

  const running = runCall($, EDIT, { holdOpen: true })
  await work.started
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(await dotOf(first)).toBe('warning')

  work.settle()
  await running
  expect(await dotOf(first)).toBe('success')
})

test('cuts the count by tool so the line of a spree fills one row and no more', { options: { showRunning: false } }, async ($, on) => {
  const batch = { ...MCP, tool_use_id: 'toolu_spree_batch', tool: 'mcp__claude_ai_Claude_Docs__batch' }
  claudeWorks(on, [[begins(LS), begins(MCP), begins(batch)]])
  await request($, 0)
  const first = await mountRow($, LS, NARROW)
  for (const made of [LS, MCP, batch]) await runCall($, made)

  const line = await buttonOf(first)
  expect(line.length).toBe(56)
  expect(line).toBe('▸ 3 tool_calls: 1 Bash, 1 mcp__inbox__inbox, 1 mcp__cla…')
})

test('a spree of one call is that call on its own line', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS)]])
  await request($, 0)
  const only = await mountRow($, LS)
  await runCall($, LS)

  expect(await lineOf(only)).toBe('▸ tool_call: Bash(ls)')
})

test('text from Claude ends a spree, so the calls after it fold apart from the calls before', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)], [says('Now the tests.'), begins(TESTS), begins(NOTES)]])
  await request($, 0)
  const before = await mountRow($, LS)
  for (const made of [LS, EDIT]) await runCall($, made)
  await request($, 1)
  const after = await mountRow($, TESTS)
  for (const made of [TESTS, NOTES]) await runCall($, made)

  expect(await lineOf(before)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(await lineOf(after)).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
})

// Claude Code draws thinking that comes with text as a row of the reply, between the calls around it.
test('a note of thinking that Claude Code draws ends a spree as text does', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)], [thinks(''), thinks('Checking the tests next.'), begins(TESTS), begins(NOTES)]])
  await request($, 0)
  const before = await mountRow($, LS)
  for (const made of [LS, EDIT]) await runCall($, made)
  await request($, 1)
  const after = await mountRow($, TESTS)
  for (const made of [TESTS, NOTES]) await runCall($, made)

  expect(await lineOf(before)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(await lineOf(after)).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
})

test('thinking that comes with no text, and white space, end no spree', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS)], [thinks(''), says('\n\n'), begins(EDIT)]])
  await request($, 0)
  await request($, 1)
  const first = await mountRow($, LS)
  for (const made of [LS, EDIT]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
})

// A turn cut off mid-call may send no end, and its spree is still over.
test('the first request of a turn starts a spree of its own', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS)], [begins(EDIT)]])
  await request($, 0)
  await request($, 0)
  const first = await mountRow($, LS)
  const second = await mountRow($, EDIT)
  for (const made of [LS, EDIT]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ tool_call: Bash(ls)')
  expect(await lineOf(second)).toBe('▸ tool_call: Edit(/repo/app.ts)')
})

test('counts only the calls that ran or got a row, and draws the line on the first of them', { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins({ tool_use_id: 'toolu_spree_never_ran', tool: 'Bash' }), begins(LS), begins(EDIT)]])
  await request($, 0)
  const first = await mountRow($, LS)
  for (const made of [LS, EDIT]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
})

// A subagent's conversation is drawn with the same rows once the person opens it.
test("folds a subagent's calls into a spree of their own, apart from the main conversation's", { options: { showRunning: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS)], [begins(TESTS), begins(NOTES)], [begins(EDIT)]])
  await request($, 0)
  await request($, 0, 'agent')
  await request($, 1)
  const mine = await mountRow($, LS)
  const theirs = await mountRow($, TESTS)
  for (const made of [LS, EDIT]) await runCall($, made)
  for (const made of [TESTS, NOTES]) await runCall($, made, { agentId: 'agent' })
  await mountRow($, EDIT)
  await mountRow($, NOTES)

  expect(await lineOf(mine)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(await lineOf(theirs)).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
})

test('a run folds into the line of its spree with the calls around it', { options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(EDIT), ...RUN_OF_THREE.calls.map(begins)]])
  await request($, 0)
  const first = await mountRow($, EDIT)
  const group = await mountRunOf($, RUN_OF_THREE)
  for (const made of [EDIT, ...RUN_OF_THREE.calls]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 4 tool_calls: 1 Edit, 2 Bash, 1 Read - 1 failed')
  expect(textOf(await group.drawn())).toBe('')

  await first.press({ key: 'spree' })
  expect(textOf(await group.drawn())).toBe(ENGINE_ROW)
})

test('a run that opens a spree draws the line of the spree, over its own calls once the spree is open', { options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[...RUN_OF_THREE.calls.map(begins), begins(EDIT)]])
  await request($, 0)
  const group = await mountRunOf($, RUN_OF_THREE)
  const last = await mountRow($, EDIT)
  for (const made of [...RUN_OF_THREE.calls, EDIT]) await runCall($, made)

  expect(await lineOf(group)).toBe('▸ 4 tool_calls: 2 Bash, 1 Read, 1 Edit - 1 failed')
  expect(textOf(await last.drawn())).toBe('')

  await group.press({ key: 'spree' })
  expect(unfilled(textOf(await group.drawn()))).toBe('● ▾ 4 tool_calls - 1 failed' + ENGINE_ROW)
  expect(await lineOf(last)).toBe('▸ tool_call: Edit(/repo/app.ts)')
})

// Claude Code shades a run it marks expanded and adds a row beneath it, folded into a spree or not.
test('covers the shade of a run that a folded spree hides', { options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(EDIT), ...RUN_OF_THREE.calls.map(begins)]])
  await request($, 0)
  await mountRow($, EDIT)
  const group = await mountRunOf($, { ...RUN_OF_THREE, isExpanded: true })
  const [cover] = elementsOf(await group.drawn(), isBox)

  expect(cover?.props?.backgroundColor).toBe('ansi256()')
  expect(cover?.props?.marginBottom).toBe(-1)
  expect(textOf(cover)).toBe('')
})

test('names the latest call while Claude is still making calls, and counts them by tool once the turn is over',{ options: { showRunning: true } }, async ($, on) => {
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  claudeWorks(on, [[begins(TESTS), begins(NOTES)]])
  await request($, 0)
  const first = await mountRow($, TESTS)
  for (const made of [TESTS, NOTES]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: Read(/repo/notes.md)')
  // The dot and the note are the latest call's, which did not fail.
  expect(await dotOf(first)).toBe('success')

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn', reason: 'answer' })
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
  expect(await dotOf(first)).toBe('error')
})

test('notes that the running call it names failed',{ options: { showRunning: true } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(TESTS)]])
  await request($, 0)
  const first = await mountRow($, LS)
  for (const made of [LS, TESTS]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: Bash(npm test) - error')
  expect(await dotOf(first)).toBe('error')
})

test('counts a spree by tool as soon as Claude writes text after it, where it named the running call before',{ options: { showRunning: true } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)], [says('Both are done.')]])
  await request($, 0)
  const first = await mountRow($, LS)
  for (const made of [LS, EDIT]) await runCall($, made)
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: Edit(/repo/app.ts)')

  await request($, 1)
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
})

// What a conversation hands a mod that is loaded into it: its rows, where thinking has no text, and
// the form of its next request, where thinking is whole.
const ROWS = [
  { role: 'user', text: 'tidy the app', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: LS.tool_use_id, tool: 'Bash', input: LS.input, text: 'app.ts' }] },
  { role: 'user', text: '', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: EDIT.tool_use_id, tool: 'Edit', input: EDIT.input, text: 'updated' }] },
  { role: 'assistant', text: 'Tidied. Now the tests.', toolUses: [{ tool_use_id: TESTS.tool_use_id, tool: 'Bash', input: TESTS.input, text: 'Exit code 1', isError: true }] },
  { role: 'assistant', text: '', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: NOTES.tool_use_id, tool: 'Read', input: NOTES.input, text: 'notes' }] },
]

function holdConversation(on: On, thought: string) {
  const request = [{ role: 'assistant', content: [{ type: 'thinking', thinking: thought }, { type: 'tool_use', id: NOTES.tool_use_id, name: 'Read', input: NOTES.input }] }]
  on('session.messages', async ($, e) => ({ value: (e.as === 'api' ? request : ROWS) as never }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
}

const load = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('folds the sprees of a conversation it is loaded into, read off its messages', { options: { showRunning: true } }, async ($, on) => {
  holdConversation(on, '')
  await load($)
  const first = await mountRow($, LS)

  // No other row has been drawn and no call has run, and none of these sprees is under way.
  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 1 Bash, 1 Edit')
  expect(textOf(await (await mountRow($, EDIT)).drawn())).toBe('')
  expect(await lineOf(await mountRow($, TESTS))).toBe('▸ 2 tool_calls: 1 Bash, 1 Read - 1 failed')
})

test('reads where a note of thinking split two sprees off the request form of the conversation', { options: { showRunning: false } }, async ($, on) => {
  holdConversation(on, 'Reading the notes next.')
  await load($)

  expect(await lineOf(await mountRow($, TESTS))).toBe('▸ tool_call: Bash(npm test) - error')
  expect(await lineOf(await mountRow($, NOTES))).toBe('▸ tool_call: Read(/repo/notes.md)')
})

// The request form holds a conversation only since its last compaction, so the mod keeps the splits it saw.
test('keeps the sprees that a note of thinking split apart when it is loaded again', { options: { showRunning: false } }, async ($, on) => {
  holdConversation(on, '')
  claudeWorks(on, [[begins(TESTS)], [thinks('Reading the notes next.'), begins(NOTES)]])
  await request($, 0)
  await request($, 1)
  await load($)

  expect(await lineOf(await mountRow($, TESTS))).toBe('▸ tool_call: Bash(npm test) - error')
  expect(await lineOf(await mountRow($, NOTES))).toBe('▸ tool_call: Read(/repo/notes.md)')
})

test('leaves the calls of a folded spree to Claude Code while the full transcript is open', { options: { showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(LS), begins(EDIT)]])
  await request($, 0)
  const prompt = await mountPrompt($, false)
  await mountRow($, LS)
  const second = await mountRow($, EDIT)
  expect(textOf(await second.drawn())).toBe('')

  await prompt.redraw({ text: 'find the costs', origin: { kind: 'composer' }, isExpanded: true })
  expect(textOf(await second.drawn())).toBe(ENGINE_ROW)

  await prompt.redraw({ text: 'find the costs', origin: { kind: 'composer' }, isExpanded: false })
})

test('with collapsing set off, every call keeps its line', { options: { collapse: false } }, async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)]])
  await request($, 0)
  const first = await mountRow($, LS)
  const second = await mountRow($, EDIT)
  for (const made of [LS, EDIT]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ tool_call: Bash(ls)')
  expect(await lineOf(second)).toBe('▸ tool_call: Edit(/repo/app.ts)')
})

test('with nothing set, collapses a spree and names its running call', async ($, on) => {
  claudeWorks(on, [[begins(LS), begins(EDIT)]])
  await request($, 0)
  const first = await mountRow($, LS)
  const second = await mountRow($, EDIT)
  for (const made of [LS, EDIT]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: Edit(/repo/app.ts)')
  expect(textOf(await second.drawn())).toBe('')
})

// The color of each piece of text on the first line a row draws.
async function colorsOf(ui: Mounted): Promise<unknown[]> {
  const line = elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.flexDirection === 'row')[0]
  return elementsOf(line, element => element.type === 'Text' && textOf(element) !== '').map(element => element.props?.color)
}

test('with graying set on, a closed call is gray but for its dot, and an open one keeps its colors', { options: { grayscale: true } }, async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, { ...BASH, isErrored: true, output: 'Exit code 1' })

  expect(await lineOf(ui)).toBe('▸ tool_call: Bash(cat a.txt b.txt) - error')
  expect(await colorsOf(ui)).toEqual(['error', 'inactive', 'inactive', 'inactive', 'inactive'])

  await ui.press({ key: 'toggle' })
  expect(await colorsOf(ui)).toEqual(['error', 'inactive', undefined, 'error'])
})

test('with graying set on, a folded spree is gray but for its dot, and an open one keeps its colors', { options: { grayscale: true, showRunning: false } }, async ($, on) => {
  drawEngineRows(on)
  claudeWorks(on, [[begins(LS)], [begins(TESTS)]])
  for (const index of [0, 1]) await request($, index)
  const first = await mountRow($, LS)
  await mountRow($, TESTS)
  for (const made of [LS, TESTS]) await runCall($, made)

  expect(await lineOf(first)).toBe('▸ 2 tool_calls: 2 Bash - 1 failed')
  expect(await colorsOf(first)).toEqual(['error', 'inactive', 'inactive', 'inactive'])

  await first.press({ key: 'spree' })
  expect(await colorsOf(first)).toEqual(['error', 'inactive', 'error'])
})

// MARK: Views the mod stays out of

test('leaves every tool row to Claude Code while the full transcript is open', async ($, on) => {
  drawEngineRows(on)
  const prompt = await mountPrompt($, false)
  const line = await mountRow($, BASH)
  const result = await mountResult($, BASH)

  await prompt.redraw({ text: 'find the costs', origin: { kind: 'composer' }, isExpanded: true })
  expect(textOf(await line.drawn())).toBe(ENGINE_ROW)
  expect(textOf(await result.drawn())).toBe(ENGINE_ROW)

  await prompt.redraw({ text: 'find the costs', origin: { kind: 'composer' }, isExpanded: false })
  expect(await lineOf(line)).toBe('▸ tool_call: Bash(cat a.txt b.txt)')
  expect(textOf(await result.drawn())).toBe('')
})

test('leaves tool rows to Claude Code off the terminal', async ($, on) => {
  drawEngineRows(on)
  const ui = await mountRow($, BASH, WIDE, 'desktop')
  expect(textOf(await ui.drawn())).toBe(ENGINE_ROW)
})
