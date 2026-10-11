import { expect, test, type TestBody } from 'claude-code/testing'

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

// Stands for Claude Code's own drawing of a reply block: it shows the text it was asked to draw.
function drawEngineReplies(on: On): { asked: string[] } {
  const seen = { asked: [] as string[] }
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    seen.asked.push(e.props.text)
    const { Text } = $.ui.resolve(e)
    return Text({ children: [`engine:${e.props.text}`] })
  })
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
  const ui = await mountReply($, '```python\ndef add(a, b):\n    return a + b\n```')
  const block = elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.backgroundColor !== undefined)[0]
  const code = elementsOf(block, element => element.type === 'Code')[0]
  expect(code?.props).toEqual({ source: 'def add(a, b):\n    return a + b', language: 'python' })
})

test('draws the prose around a block as markdown, in the order written', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, 'Here it is:\n\n```js\nconst a = 1\n```\n\nThat is **all**.')
  expect(await partsOf(ui)).toEqual(['Markdown:Here it is:', 'Code:const a = 1', 'Markdown:That is **all**.'])
})

test('draws a fence that names no language as plain code', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```\nplain text\n```')
  expect(elementsOf(await ui.drawn(), element => element.type === 'Code')[0]?.props).toEqual({ source: 'plain text' })
})

test('keeps the blank lines and the indentation inside a block', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '```py\nclass A:\n\n    x = 1\n```')
  expect(await partsOf(ui)).toEqual(['Code:class A:\n\n    x = 1'])
})

test('reads a fence still open at the end of a streaming reply as code', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, 'Writing it now:\n```ts\nconst half = ')
  expect(await partsOf(ui)).toEqual(['Markdown:Writing it now:', 'Code:const half = '])
})

test('closes a block only at a fence as long as the one that opened it', async ($, on) => {
  drawEngineReplies(on)
  const ui = await mountReply($, '````md\n```js\nlet a\n```\n````\nAfter.')
  expect(await partsOf(ui)).toEqual(['Code:```js\nlet a\n```', 'Markdown:After.'])
})

// MARK: Diff blocks

// Each row of a shaded diff block: its text, the background of the row, and the color of the text.
async function diffRowsOf(ui: { drawn: () => Promise<unknown> }): Promise<unknown[][]> {
  const block = elementsOf(await ui.drawn(), element => element.type === 'Box' && element.props?.backgroundColor === 'userMessageBackground')[0]
  const rows = (block?.children ?? []) as Drawn[]
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
