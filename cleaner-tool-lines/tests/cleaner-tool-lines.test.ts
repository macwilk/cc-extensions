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
