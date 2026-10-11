import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { cellsIn, closedSubject, detailOf, dotColorOf, noteOf } from './line'

const INDENT = 2
const DOT = '● '
// The viewport is absent until the terminal has been measured.
const UNMEASURED_COLUMNS = 80

const isOpen = atom({ plugin: 'cleaner-tool-lines', key: 'isOpen' } as const, false)

// The shade an open call's input and result are set on, apart from the lines around them. A shade,
// not a frame: a result that draws nothing then leaves nothing behind.
const PANEL = { marginLeft: INDENT + DOT.length, paddingX: 1, backgroundColor: 'userMessageBackground', flexDirection: 'column' } as const

// A background that passes as a color and names none: Claude Code draws no color for it, and a Box set
// on it still keeps the background of the Box around it out.
const NO_COLOR = 'ansi256()'

// A tool row is not told which view it is drawn in, or whether it belongs to a folded run. The rows
// that are told (the person's prompts, the runs) record it here.
let isFullTranscript = false
const callsInRuns = new Set<string>()

export const register: Register = on => {
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.props.isExpanded !== isFullTranscript) {
      isFullTranscript = e.props.isExpanded
      // Tool rows keep their last drawing until asked again.
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    let hasChanged = false
    for (const { tool_use_id: id } of e.props.calls) {
      if (id === undefined || callsInRuns.has(id)) continue
      callsInRuns.add(id)
      hasChanged = true
    }
    if (hasChanged) $.ui.invalidate('ui.render')
    // Unfolded, each call of the run is drawn through the ToolUse hook below. That holds when Claude
    // Code marks the run expanded too: a click on an open call's input or result is a click on the run
    // to Claude Code, and handing the run back there would redraw every call in it natively.
    const run = await next({ ...e, props: { ...e.props, isExpanded: true } })
    // The full view draws every run expanded and marks none.
    if (!e.props.isExpanded || isFullTranscript) return run
    // A run Claude Code marks expanded is shaded whole, with a spare row beneath it. The Box draws the
    // terminal's own background over the shade, and its margin takes the row back.
    const { Box } = $.ui.resolve(e)
    return Box({ backgroundColor: NO_COLOR, marginBottom: -1, flexDirection: 'column', children: [run] })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (isFullTranscript) return next(e)
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const mine = memberOf(isOpen, e)
    const open = await read($, mine)

    const head = `${open ? '▾' : '▸'} tool_call: `
    const note = noteOf(e.props)
    const noteText = note === undefined ? '' : ` - ${note}`
    const columns = e.viewport?.columns ?? UNMEASURED_COLUMNS
    const lineRoom = columns - INDENT - DOT.length
    const subject = open ? '' : `(${closedSubject(e.props.input, lineRoom - cellsIn(`${head}${e.props.tool}()${noteText}`))})`
    // A press lands on the button alone, so spaces carry the button on to the edge of the row.
    const fill = ' '.repeat(Math.max(0, lineRoom - cellsIn(`${head}${e.props.tool}${subject}${noteText}`)))
    const line = Box({
      flexDirection: 'row',
      marginLeft: INDENT,
      children: [
        Text({ color: dotColorOf(e.props), children: [DOT] }),
        // One press wherever on the row it lands. An open call keeps the button to the row of its head,
        // so its input below can be read, selected and copied without the pointer inverting it.
        Button({
          key: 'toggle',
          plain: true,
          onPress: () => update($, mine, wasOpen => !wasOpen),
          children: [
            // A color, not dimColor: while the pointer is on a folded run, Claude Code draws every dim
            // text in the run at full strength, which would light this line whenever a neighbour is hovered.
            Text({ color: 'inactive', children: [head] }),
            Text({ bold: true, children: [e.props.tool] }),
            subject,
            ...(note === undefined
              ? []
              : [Text({ color: e.props.isErrored || e.props.isInterrupted ? 'error' : 'inactive', children: [noteText] })]),
            fill,
          ],
        }),
      ],
    })
    if (!open) return line

    const detail = detailOf(e.props.input)
    const input =
      detail.text === ''
        ? []
        : [detail.language === undefined ? Text({ children: [detail.text] }) : Code({ source: detail.text, language: detail.language })]
    // A standalone call's result is the ToolResult row beneath; a call of a run has no row but this one,
    // and nothing to show in it until its result is stored. Claude Code draws such a call as a header
    // named by `tool` over its result, one row down: an empty name leaves the header out, and the margin
    // takes that row back.
    const result =
      callsInRuns.has(e.props.tool_use_id) && e.props.output !== undefined
        ? [Box({ marginTop: -1, flexDirection: 'column', children: [await next({ ...e, props: { ...e.props, tool: '' } })] })]
        : []
    if (input.length + result.length === 0) return line
    return Box({ flexDirection: 'column', children: [line, Box({ ...PANEL, children: [...input, ...result] })] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || isFullTranscript) return next(e)
    const { Box } = $.ui.resolve(e)
    if (await read($, memberOf(isOpen, e))) return Box({ ...PANEL, children: [await next(e)] })
    return Box({})
  })
}
