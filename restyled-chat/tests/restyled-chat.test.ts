import { expect, mock, test, type TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const VIEWPORT = { columns: 120, rows: 40 }

function mountReply($: Engine, text: string, more: { isFirstOfReply?: boolean; isSummary?: true } = {}, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'restyled-chat',
    surface,
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: more.isFirstOfReply ?? true, ...(more.isSummary ? { isSummary: true as const } : {}) },
    viewport: VIEWPORT,
  })
}

// Stands for what is beneath the mod: Claude Code's own drawing of a reply block, which shows the text it was
// asked to draw; the files of Shiki's data in the mod's folder; and the theme row of the settings.
function drawEngineReplies(on: On, theme = 'dark'): { asked: string[]; read: string[] } {
  const seen = { asked: [] as string[], read: [] as string[] }
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    seen.asked.push(e.props.text)
    const { Text } = $.ui.resolve(e)
    return Text({ children: [`engine:${e.props.text}`] })
  })
  on('fs.read', async ($, e) => {
    const file = e.path.split('/shiki/')[1] ?? e.path
    seen.read.push(file)
    return { value: JSON.stringify(SHIKI_FILES[file]) }
  })
  on('config.list', async () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice' as const, value: theme, provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false }],
  }))
  return seen
}

function elementsOf(node: unknown, isPicked: (element: Drawn) => boolean): Drawn[] {
  if (typeof node !== 'object' || node === null) return []
  const element = node as Drawn
  const inner = (element.children ?? []).flatMap(child => elementsOf(child, isPicked))
  return isPicked(element) ? [element, ...inner] : inner
}

// The Markdown and Code elements of a drawing, in the order written, each as its tag and its text.
async function partsOf(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const parts = elementsOf(await ui.drawn(), element => element.type === 'Markdown' || element.type === 'Code')
  return parts.map(part => `${part.type}:${String(part.props?.text ?? part.props?.source)}`)
}

// MARK: Replies it leaves alone

test('leaves a reply with no code block to Claude Code', async ($, on) => {
  const engine = drawEngineReplies(on)
  const ui = await mountReply($, 'Just a sentence with `inline code`.')
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine:Just a sentence with `inline code`.'] })
  expect(engine.asked).toEqual(['Just a sentence with `inline code`.'])
})

test('leaves a fence inside a list item to the markdown around it', async ($, on) => {
  drawEngineReplies(on)
  const reply = '1. Run this:\n   ```sh\n   ls\n   ```\n2. Done.'
  expect(await (await mountReply($, reply)).drawn()).toMatchObject({ type: 'Text', children: [`engine:${reply}`] })
})

test('leaves a summary of a reply to Claude Code', async ($, on) => {
  drawEngineReplies(on)
  const reply = 'Before\n```py\nx = 1\n```'
  expect(await (await mountReply($, reply, { isSummary: true })).drawn()).toMatchObject({ type: 'Text', children: [`engine:${reply}`] })
})

test('leaves replies to Claude Code off the terminal', async ($, on) => {
  drawEngineReplies(on)
  const reply = 'Before\n```py\nx = 1\n```'
  expect(await (await mountReply($, reply, {}, 'desktop')).drawn()).toMatchObject({ type: 'Text', children: [`engine:${reply}`] })
})

// MARK: Code blocks

test('draws a fenced block as code on a shaded block of its own', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```haskell\nadd a b = a + b\n```')
  const block = elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.backgroundColor !== undefined)[0]
  const code = elementsOf(block, element => element.type === 'Code')[0]
  expect(code?.props).toEqual({ source: 'add a b = a + b', language: 'haskell' })
})

test('draws the prose around a block as markdown, in the order written', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, 'Here it is:\n\n```text\nconst a = 1\n```\n\nThat is **all**.')
  expect(await partsOf(ui)).toEqual(['Markdown:Here it is:', 'Code:const a = 1', 'Markdown:That is **all**.'])
})

test('draws a fence that names no language as plain code', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```\nplain text\n```')
  expect(elementsOf(await ui.drawn(), element => element.type === 'Code')[0]?.props).toEqual({ source: 'plain text' })
})

test('keeps the blank lines and the indentation inside a block', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```text\nclass A:\n\n    x = 1\n```')
  expect(await partsOf(ui)).toEqual(['Code:class A:\n\n    x = 1'])
})

test('reads a fence still open at the end of a streaming reply as code', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, 'Writing it now:\n```text\nconst half = ')
  expect(await partsOf(ui)).toEqual(['Markdown:Writing it now:', 'Code:const half = '])
})

test('closes a block only at a fence as long as the one that opened it', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '````md\n```js\nlet a\n```\n````\nAfter.')
  expect(await partsOf(ui)).toEqual(['Code:```js\nlet a\n```', 'Markdown:After.'])
})

// MARK: The colors of the code

// A grammar and a theme small enough to read here, in the shape of the files tools/shiki/build.mjs writes.
const TOY_GRAMMAR = {
  name: 'toy',
  scopeName: 'source.toy',
  patterns: [
    { match: '\\b(let|return)\\b', name: 'keyword.control.toy' },
    { match: '\\b[0-9]+\\b', name: 'constant.numeric.toy' },
    { match: '#.*$', name: 'comment.line.toy' },
  ],
}
const toyTheme = (name: string) => ({
  name,
  type: 'dark',
  colors: { 'editor.foreground': '#dddddd', 'editor.background': '#111111' },
  tokenColors: [
    { scope: 'keyword', settings: { foreground: '#ff0000', fontStyle: 'bold' } },
    { scope: 'constant.numeric', settings: { foreground: '#00ff00' } },
    { scope: 'comment', settings: { foreground: '#888888', fontStyle: 'italic' } },
  ],
})
const SHIKI_FILES: Record<string, unknown> = {
  'index.json': { langs: { toy: 'toy', ty: 'toy' }, embedded: { toy: [] }, themes: ['dark-plus', 'toy-theme'] },
  'langs/toy.json': TOY_GRAMMAR,
  'themes/toy-theme.json': toyTheme('toy-theme'),
  'themes/dark-plus.json': toyTheme('dark-plus'),
}
const TOY = 'custom:restyled-chat:toy-theme'

// The lines of the first block's code as the mod colors them: plain strings, and [text, style] for a styled run.
async function codeOf(ui: { drawn: () => Promise<unknown> }): Promise<unknown[][]> {
  const [block] = await blocksOf(ui)
  const body = block?.children?.[1] as Drawn
  return (body.children ?? []).map(line =>
    ((line as Drawn).children ?? []).map(part => (typeof part === 'string' ? part : [(part as Drawn).children?.[0], (part as Drawn).props])),
  )
}

const codeElementsOf = async (ui: { drawn: () => Promise<unknown> }) => elementsOf(await ui.drawn(), element => element.type === 'Code').map(code => code.props)

test('colors code in the colors and styles of the active theme, read from the data of the mod', async ($, on) => {
  drawEngineReplies(on, TOY)
  const ui = await mountReply($, '```toy\nlet x = 1 # one\n```')
  expect(await codeOf(ui)).toEqual([
    [
      ['let', { color: '#ff0000', bold: true }],
      // Code in the theme's plain text color takes no color of its own.
      ' x = ',
      // The space after a styled run joins it, which saves a node.
      ['1 ', { color: '#00ff00' }],
      ['# one', { color: '#888888', italic: true }],
    ],
  ])
  expect(await codeElementsOf(ui)).toEqual([])
})

test('knows a language by any of its names, in either case', async ($, on) => {
  drawEngineReplies(on, TOY)
  const ui = await mountReply($, '```TY\nreturn 2\n```')
  expect(await codeOf(ui)).toEqual([[['return ', { color: '#ff0000', bold: true }], ['2', { color: '#00ff00' }]]])
})

test('keeps a blank line of colored code as a row, and sets a tab as four spaces', async ($, on) => {
  drawEngineReplies(on, TOY)
  const ui = await mountReply($, '```toy\nlet\n\n\treturn\n```')
  // A row of no text would take no height.
  expect(await codeOf(ui)).toEqual([[['let', { color: '#ff0000', bold: true }]], [' '], ['    ', ['return', { color: '#ff0000', bold: true }]]])
})

test('uses the theme of another name that goes with a theme of the mod', async ($, on) => {
  drawEngineReplies(on, 'custom:restyled-chat:dark-modern')
  const ui = await mountReply($, '```toy\nlet\n```')
  expect(await codeOf(ui)).toEqual([[['let', { color: '#ff0000', bold: true }]]])
})

test('leaves the code to Claude Code under a theme that has no namesake in the data', async ($, on) => {
  drawEngineReplies(on, 'dark')
  const ui = await mountReply($, '```toy\nlet x = 1\n```')
  expect(await codeElementsOf(ui)).toEqual([{ source: 'let x = 1', language: 'toy' }])
})

test('leaves a language that has no grammar in the data to Claude Code', async ($, on) => {
  drawEngineReplies(on, TOY)
  const ui = await mountReply($, '```haskell\nadd a b = a + b\n```')
  expect(await codeElementsOf(ui)).toEqual([{ source: 'add a b = a + b', language: 'haskell' }])
})

test('reads a grammar and a theme once, however many blocks use them', async ($, on) => {
  const files = drawEngineReplies(on, TOY)
  await mountReply($, '```toy\nlet\n```')
  const afterFirst = files.read.length

  const second = await mountReply($, 'Again:\n\n```toy\nreturn 1\n```\n\nAnd:\n\n```toy\nlet\n```')
  expect(await codeOf(second)).toEqual([[['return ', { color: '#ff0000', bold: true }], ['1', { color: '#00ff00' }]]])
  expect(files.read.slice(afterFirst)).toEqual([])
})

// Claude Code refuses a drawing of more than 20,000 nodes and draws the reply itself, with no shade.
// Each line of this code costs 8 of them: its row, three styled runs of two, and one plain run.
const longToy = (lines: number) => Array.from({ length: lines }, () => 'let v = 1 # n').join('\n')

test('colors a long block that fits in the size Claude Code allows a drawing', async ($, on) => {
  drawEngineReplies(on, TOY)
  const ui = await mountReply($, '```toy\n' + longToy(1500) + '\n```')
  expect(await codeOf(ui)).toHaveLength(1500)
  expect(await codeElementsOf(ui)).toEqual([])
})

test('leaves a block too long to color within that size to the coloring of Claude Code', async ($, on) => {
  drawEngineReplies(on, TOY)
  const source = longToy(2500)
  const ui = await mountReply($, '```toy\n' + source + '\n```')
  expect(await codeElementsOf(ui)).toEqual([{ source, language: 'toy' }])
  // The block keeps its head and its shade.
  expect(await buttonsOf(ui)).toEqual(['copy'])
})

test('colors the blocks of a reply in order until the size is used up', async ($, on) => {
  drawEngineReplies(on, TOY)
  const source = longToy(1000)
  const ui = await mountReply($, '```toy\n' + source + '\n```\n\nAnd again:\n\n```toy\n' + source + '\n```')
  expect(await codeOf(ui)).toHaveLength(1000)
  expect(await codeElementsOf(ui)).toEqual([{ source, language: 'toy' }])
})

test('leaves a diff block too long to draw line by line to the coloring of Claude Code', async ($, on) => {
  drawEngineReplies(on)
  const source = Array.from({ length: 7000 }, (_, index) => `+line ${index}`).join('\n')
  const ui = await mountReply($, '```diff\n' + source + '\n```')
  expect(await codeElementsOf(ui)).toEqual([{ source, language: 'diff' }])
})

// MARK: The head of a block

// Everything a tree shows, in the order written.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  return ((node as Drawn).children ?? []).map(textOf).join('')
}

// The shaded blocks of a drawing, in the order written.
async function blocksOf(ui: { drawn: () => Promise<unknown> }): Promise<Drawn[]> {
  return elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.backgroundColor === 'userMessageBackground')
}

// Stands for the terminal's clipboard and for the toasts over the transcript.
function takeCopies(on: On, isCopied = true): { copied: string[]; toasts: string[] } {
  const seen = { copied: [] as string[], toasts: [] as string[] }
  on('ui.copy', async ($, e) => {
    seen.copied.push(e.text)
    return { value: isCopied ? { isCopied: true as const } : { isCopied: false as const, reason: 'no-clipboard' as const } }
  })
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('heads a block with its language and a button that copies its code', async ($, on) => {
  drawEngineReplies(on)
  const seen = takeCopies(on)
  const ui = await mountReply($, '```python\ndef add(a, b):\n    return a + b\n```')
  const [block] = await blocksOf(ui)
  expect(textOf(block?.children?.[0])).toBe('pythoncopy')

  await ui.press({ key: 'copy-0' })
  expect(seen.copied).toEqual(['def add(a, b):\n    return a + b'])
})

test('sets the head of a block on a shade apart from the shade of its code', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```sh\nls\n```')
  const [block] = await blocksOf(ui)
  const head = block?.children?.[0] as Drawn
  expect(head.props?.backgroundColor).toBe('composerSidebarBackground')
  expect(block?.props?.backgroundColor).toBe('userMessageBackground')
})

// What each block's button says, in the order of the blocks.
async function buttonsOf(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  return elementsOf(await ui.drawn(), element => element.type === 'Button').map(textOf)
}

test('copies the block whose button is pressed, and that button says so', async ($, on) => {
  drawEngineReplies(on)
  mock.clock(on)
  const seen = takeCopies(on)
  const ui = await mountReply($, '```sh\nls\n```\n\nThen:\n\n```sh\npwd\n```')
  expect(await buttonsOf(ui)).toEqual(['copy', 'copy'])

  await ui.press({ key: 'copy-1' })
  expect(seen.copied).toEqual(['pwd'])
  expect(await buttonsOf(ui)).toEqual(['copy', 'copied'])
  // Claude Code slides a toast in over several frames; the button's own word is the whole notice.
  expect(seen.toasts).toEqual([])
})

test('lets the button go back to its word a moment after a copy', async ($, on) => {
  drawEngineReplies(on)
  const clock = mock.clock(on)
  takeCopies(on)
  const ui = await mountReply($, '```sh\nls\n```')
  await ui.press({ key: 'copy-0' })
  await clock.advance(1400)
  expect(await buttonsOf(ui)).toEqual(['copied'])

  await clock.advance(200)
  expect(await buttonsOf(ui)).toEqual(['copy'])
})

test('keeps a later copy marked when the wait of an earlier one ends', async ($, on) => {
  drawEngineReplies(on)
  const clock = mock.clock(on)
  takeCopies(on)
  const ui = await mountReply($, '```sh\nls\n```\n\nThen:\n\n```sh\npwd\n```')
  await ui.press({ key: 'copy-0' })
  await clock.advance(1000)
  await ui.press({ key: 'copy-1' })
  await clock.advance(600)
  expect(await buttonsOf(ui)).toEqual(['copy', 'copied'])
})

test('heads a block that names no language with the button alone', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```\nplain text\n```')
  const [block] = await blocksOf(ui)
  expect(textOf(block?.children?.[0]).trim()).toBe('copy')
})

test('heads a diff block too, and copies the diff as written', async ($, on) => {
  drawEngineReplies(on)
  const seen = takeCopies(on)
  const ui = await mountReply($, '```diff\n-old\n+new\n```')
  const [block] = await blocksOf(ui)
  expect(textOf(block?.children?.[0])).toBe('diffcopy')

  await ui.press({ key: 'copy-0' })
  expect(seen.copied).toEqual(['-old\n+new'])
})

test('says so when the clipboard does not take the code', async ($, on) => {
  drawEngineReplies(on)
  mock.clock(on)
  const seen = takeCopies(on, false)
  const ui = await mountReply($, '```sh\nls\n```')
  await ui.press({ key: 'copy-0' })
  expect(seen.toasts).toEqual(['Not copied'])
  expect(await buttonsOf(ui)).toEqual(['copy'])
})

// MARK: Diff blocks

// Each row of a shaded diff block under its head: its text, the background of the row, and the color of the text.
async function diffRowsOf(ui: { drawn: () => Promise<unknown> }): Promise<unknown[][]> {
  const [block] = await blocksOf(ui)
  const rows = (block?.children ?? []).slice(1) as Drawn[]
  return rows.map(row => {
    const text = row.children?.[0] as Drawn
    return [text.children?.[0], row.props?.backgroundColor, text.props?.color]
  })
}

// The Code element colors no line of a diff, which Claude Code's own drawing of a reply does.
test('sets the added and removed lines of a diff block on the diff colors of the theme', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```diff\n@@ -1,3 +1,3 @@\n def greet(name):\n-    print("hello " + name)\n+    print(f"hello {name}")\n     return None\n```')
  expect(await diffRowsOf(ui)).toEqual([
    ['@@ -1,3 +1,3 @@', undefined, 'inactive'],
    [' def greet(name):', undefined, undefined],
    ['-    print("hello " + name)', 'diffRemoved', undefined],
    ['+    print(f"hello {name}")', 'diffAdded', undefined],
    ['     return None', undefined, undefined],
  ])
  expect(elementsOf(await ui.drawn(), element => element.type === 'Code')).toEqual([])
})

test('reads the lines that name the files of a diff as lines about it, not as changes', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```diff\ndiff --git a/greet.py b/greet.py\nindex 83db48f..bf2a2c1 100644\n--- a/greet.py\n+++ b/greet.py\n@@ -1 +1 @@\n-old\n+new\n```')
  expect(await diffRowsOf(ui)).toEqual([
    ['diff --git a/greet.py b/greet.py', undefined, 'inactive'],
    ['index 83db48f..bf2a2c1 100644', undefined, 'inactive'],
    ['--- a/greet.py', undefined, 'inactive'],
    ['+++ b/greet.py', undefined, 'inactive'],
    ['@@ -1 +1 @@', undefined, 'inactive'],
    ['-old', 'diffRemoved', undefined],
    ['+new', 'diffAdded', undefined],
  ])
})

test('reads a removed line that begins with dashes as removed', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```diff\n@@ -1,2 +1 @@\n--- an SQL comment\n select 1\n```')
  expect(await diffRowsOf(ui)).toEqual([
    ['@@ -1,2 +1 @@', undefined, 'inactive'],
    ['--- an SQL comment', 'diffRemoved', undefined],
    [' select 1', undefined, undefined],
  ])
})

test('draws a patch block as a diff, and a blank line of it as a row', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```patch\n+one\n\n-two\n```')
  expect(await diffRowsOf(ui)).toEqual([
    ['+one', 'diffAdded', undefined],
    // A row of no text would take no height.
    [' ', undefined, undefined],
    ['-two', 'diffRemoved', undefined],
  ])
})

// MARK: The row around the blocks

// Claude Code draws a reply block's bullet, indent and top margin. Asked for a block of no visible
// text, it draws that frame alone, and the mod sets its own drawing on it.
test('has Claude Code draw the bullet and margins of the row', async ($, on) => {
  const engine = drawEngineReplies(on)
  const ui = await mountReply($, '```py\nx = 1\n```', { isFirstOfReply: true })
  expect(engine.asked).toHaveLength(1)
  expect(engine.asked[0]?.trim()).not.toBe('')
  expect(engine.asked[0]).not.toContain('x = 1')
  const frame = elementsOf(await ui.drawn(), element => element.type === 'Text' && String(element.children?.[0]).startsWith('engine:'))
  expect(frame).toHaveLength(1)
})
