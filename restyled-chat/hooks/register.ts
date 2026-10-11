import { atom, memberOf, read, update } from 'claude-code'
import type { Register, RenderSurface } from 'claude-code'

import { diffLinesOf, type DiffLine } from './diff'
import { segmentsOf } from './segments'
import { linesOf, themeFor, type Read, type Run } from './shiki'

// Claude Code sets a reply two cells in, under its bullet.
const INDENT = 2
// In this mod's themes, darker than the terminal's own background, where the code's shade is lighter.
const HEAD_SHADE = 'composerSidebarBackground'
// How long a block's button says that its code was copied.
const COPIED_MS = 1500
// Which block of a reply has its button saying so: the button's key, or none.
const copiedBlock = atom({ plugin: 'restyled-chat', key: 'copiedBlock' } as const, '')
// Claude Code refuses a drawing of more than 20,000 nodes and draws the reply itself. This much of it
// is for the lines of code and of diffs; the rest of a reply's drawing is small.
const NODE_ROOM = 15_000
// The row of a diff line, its text, and the string in it.
const DIFF_ROW_NODES = 3
const DIFF_LANGUAGES = ['diff', 'patch']
const DIFF_SHADE = { added: 'diffAdded', removed: 'diffRemoved' } as const
// A reply of no visible text. Asked to draw it, Claude Code draws the row's bullet, indent and top
// margin and nothing else, and the mod sets its own drawing on that row.
const EMPTY_REPLY = '​'

const isPlain = ({ text: _, ...style }: Run) => Object.keys(style).length === 0

/** The nodes a drawing of these lines holds: a row for each line, a styled run and its text, a plain run. */
function nodesOf(lines: Run[][]): number {
  return lines.reduce((sum, line) => sum + 1 + (line.length === 0 ? 1 : line.reduce((runs, run) => runs + (isPlain(run) ? 1 : 2), 0)), 0)
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary keeps Claude Code's own mark, which a drawing of the mod's would drop.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const segments = segmentsOf(e.props.text)
    if (!segments.some(segment => segment.kind === 'code')) return next(e)

    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const mine = memberOf(copiedBlock, e)
    const copied = await read($, mine)
    const copy = async (text: string, key: string, surface: RenderSurface) => {
      const { isCopied } = await $.ui.copy({ text, surface })
      // Claude Code slides a toast in over several frames, so a copy that took is said on the button.
      if (!isCopied) return $.ui.toast('Not copied')
      await update($, mine, () => key)
      // Another block of the reply may be copied before the wait ends; its mark stays.
      $.clock.after(COPIED_MS, () => void update($, mine, marked => (marked === key ? '' : marked)))
    }
    // The first row of a block, a shade apart from its code: the language its fence names, and a button
    // that copies the block.
    const head = (language: string | undefined, source: string, key: string) =>
      Box({
        backgroundColor: HEAD_SHADE,
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingX: 1,
        children: [
          // With no language named, a blank holds the left end, so the button stays at the right.
          Text({ color: 'inactive', children: [language ?? ' '] }),
          Button({
            key,
            plain: true,
            onPress: press => void copy(source, key, press.surface),
            children: [copied === key ? Text({ color: 'success', children: ['copied'] }) : Text({ color: 'suggestion', children: ['copy'] })],
          }),
        ],
      })
    // The lines the mod draws are counted against its share of the nodes a drawing may hold. A block
    // that no longer fits is left whole to the Code element, which is one node.
    let room = NODE_ROOM
    const takes = (nodes: number) => {
      if (nodes > room) return false
      room -= nodes
      return true
    }
    const readData: Read = path => $.fs.read(`${$.plugin.root}/shiki/${path}`)
    // The Shiki theme that goes with the theme the person has on, looked up when a block first needs it.
    let theme: Promise<string | undefined> | undefined
    const themeNow = () =>
      (theme ??= $.config.list().then(rows => {
        const active = rows.find(row => row.key === 'theme')?.value
        return typeof active === 'string' ? themeFor(readData, active) : undefined
      }))
    // Code takes the colors its language has in the person's theme, a line to a row. Under a theme or
    // in a language Shiki's data has nothing for, it is left to the Code element, which colors it from
    // a palette of Claude Code's own.
    const code = async (source: string, language: string | undefined) => {
      const shikiTheme = language === undefined ? undefined : await themeNow()
      const lines = language === undefined || shikiTheme === undefined ? undefined : await linesOf(readData, source, language, shikiTheme)
      if (lines === undefined || !takes(nodesOf(lines))) return [Code(language === undefined ? { source } : { source, language })]
      return lines.map(line =>
        Text({
          // A row of no text would take no height.
          children:
            line.length === 0
              ? [' ']
              : line.map(run => {
                  const { text, ...style } = run
                  return isPlain(run) ? text : Text({ ...style, children: [text] })
                }),
        }),
      )
    }
    // The Box, not the code, carries the shade, so it reaches the full width on every row.
    const codeBlock = async (source: string, language: string | undefined, key: string) =>
      Box({
        backgroundColor: 'userMessageBackground',
        flexDirection: 'column',
        children: [head(language, source, key), Box({ paddingX: 1, flexDirection: 'column', children: await code(source, language) })],
      })
    // Each line of a diff is a row, an added or removed one on the theme's color for it, as Claude Code
    // draws the diff of an edit.
    const diffBlock = (lines: DiffLine[], source: string, language: string | undefined, key: string) =>
      Box({
        backgroundColor: 'userMessageBackground',
        flexDirection: 'column',
        children: [
          head(language, source, key),
          ...lines.map(line =>
            Box({
              paddingX: 1,
              ...(line.kind === 'added' || line.kind === 'removed' ? { backgroundColor: DIFF_SHADE[line.kind] } : {}),
              // A row of no text would take no height.
              children: [Text({ ...(line.kind === 'about' ? { color: 'inactive' } : {}), children: [line.text === '' ? ' ' : line.text] })],
            }),
          ),
        ],
      })

    const row = await next({ ...e, props: { ...e.props, text: EMPTY_REPLY } })
    // In the order written, so the blocks of a reply take their share of the nodes in that order.
    const parts = []
    let blocks = 0
    for (const segment of segments) {
      if (segment.kind === 'prose') {
        parts.push(Markdown({ text: segment.text }))
        continue
      }
      // The button of a block is told from the others of the reply by the block's place among them.
      const key = `copy-${blocks++}`
      const diff = DIFF_LANGUAGES.includes(segment.language ?? '') ? diffLinesOf(segment.source) : undefined
      parts.push(
        diff !== undefined && takes(diff.length * DIFF_ROW_NODES)
          ? diffBlock(diff, segment.source, segment.language, key)
          : await codeBlock(segment.source, segment.language, key),
      )
    }
    return Box({
      flexDirection: 'column',
      children: [
        row,
        // Up one row, onto the row Claude Code drew.
        Box({ marginTop: -1, marginLeft: INDENT, flexDirection: 'column', gap: 1, children: parts }),
      ],
    })
  })
}
