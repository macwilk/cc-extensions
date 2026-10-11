import type { Register } from 'claude-code'

import { diffLinesOf } from './diff'
import { segmentsOf } from './segments'

// Claude Code sets a reply two cells in, under its bullet.
const INDENT = 2
const DIFF_LANGUAGES = ['diff', 'patch']
const DIFF_SHADE = { added: 'diffAdded', removed: 'diffRemoved' } as const
// A reply of no visible text. Asked to draw it, Claude Code draws the row's bullet, indent and top
// margin and nothing else, and the mod sets its own drawing on that row.
const EMPTY_REPLY = '​'

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary keeps Claude Code's own mark, which a drawing of the mod's would drop.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const segments = segmentsOf(e.props.text)
    if (!segments.some(segment => segment.kind === 'code')) return next(e)

    const { Box, Text, Markdown, Code } = $.ui.resolve(e)
    // The Box, not the code, carries the shade, so it reaches the full width on every row.
    const codeBlock = (source: string, language: string | undefined) =>
      Box({
        backgroundColor: 'userMessageBackground',
        paddingX: 1,
        children: [Code(language === undefined ? { source } : { source, language })],
      })
    // The Code element colors no line of a diff. Each line is a row here, an added or removed one on the
    // theme's color for it, as Claude Code draws the diff of an edit.
    const diffBlock = (source: string) =>
      Box({
        backgroundColor: 'userMessageBackground',
        flexDirection: 'column',
        children: diffLinesOf(source).map(line =>
          Box({
            paddingX: 1,
            ...(line.kind === 'added' || line.kind === 'removed' ? { backgroundColor: DIFF_SHADE[line.kind] } : {}),
            // A row of no text would take no height.
            children: [Text({ ...(line.kind === 'about' ? { color: 'inactive' } : {}), children: [line.text === '' ? ' ' : line.text] })],
          }),
        ),
      })
    const row = await next({ ...e, props: { ...e.props, text: EMPTY_REPLY } })
    return Box({
      flexDirection: 'column',
      children: [
        row,
        Box({
          // Up one row, onto the row Claude Code drew.
          marginTop: -1,
          marginLeft: INDENT,
          flexDirection: 'column',
          gap: 1,
          children: segments.map(segment =>
            segment.kind === 'prose'
              ? Markdown({ text: segment.text })
              : DIFF_LANGUAGES.includes(segment.language ?? '')
                ? diffBlock(segment.source)
                : codeBlock(segment.source, segment.language),
          ),
        }),
      ],
    })
  })
}
