import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { cellsIn, closedSubject, cut, detailOf, dotColorOf, noteOf } from './line'
import { type Book, type Mark, type Spree, emptyBook, end, join, note, restore, tallyOf, thoughtSplits } from './spree'

const INDENT = 2
const DOT = '● '
// How far the lines of an open spree stand in from the line that counts them.
const LISTED = 2
// The viewport is absent until the terminal has been measured.
const UNMEASURED_COLUMNS = 80

const isOpen = atom({ plugin: 'cleaner-tool-lines', key: 'isOpen' } as const, false)
// Whether the person opened a spree to a line for each of its calls. A spree goes by its first call.
const isSpreeOpen = atom({ plugin: 'cleaner-tool-lines', key: 'isSpreeOpen' } as const, false)
// Counts the changes to a spree. A row reads the count of its spree while it draws, so a change draws
// the rows of that spree again and no other row of the transcript.
const spreeChanges = atom({ plugin: 'cleaner-tool-lines', key: 'spreeChanges' } as const, 0)
// The calls that open a spree because Claude Code drew a note of Claude's thinking before them. The
// rows of the conversation do not tell such a note from thinking that is not drawn, so the mod keeps
// the ones it saw arrive.
const thoughtSplitsSeen = atom({ plugin: 'cleaner-tool-lines', key: 'thoughtSplitsSeen' } as const, [] as string[])


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

const STATE_COLOR = { running: 'warning', done: 'success', failed: 'error' } as const

type Elements = ReturnType<EngineInterface['ui']['resolve']>
/** A spree folded into one line: the calls of it that have a row, and whether the person opened it. */
type Fold = { spree: Spree; first: string; shown: string[]; marks: Mark[]; isOpen: boolean }

/** The fold a call is in. A spree of one call is no fold: that call is its own line. */
async function foldOf($: EngineInterface, book: Book, id: string | undefined): Promise<Fold | undefined> {
  const spree = id === undefined || isFullTranscript ? undefined : book.spreeOf.get(id)
  const first = spree?.calls[0]
  if (spree === undefined || first === undefined) return undefined
  // Read for the redraw alone, and before a lone call returns: it folds when a second one joins it.
  await read($, memberOf(spreeChanges, { requestId: first }))
  // The model can begin a call that never runs and so never gets a row.
  const shown = spree.calls.filter(call => book.markOf.has(call))
  if (shown.length < 2) return undefined
  const marks = shown.flatMap(call => book.markOf.get(call) ?? [])
  return { spree, first, shown, marks, isOpen: await read($, memberOf(isSpreeOpen, { requestId: first })) }
}

/** Draws the rows of a spree again, the spree named by its first call. */
async function redraw($: EngineInterface, first: string | undefined) {
  if (first !== undefined) await update($, memberOf(spreeChanges, { requestId: first }), count => count + 1)
}

/** The one line of a spree: how many calls, then what they were. A press opens and closes the spree. */
function spreeLine($: EngineInterface, { Box, Text, Button }: Elements, fold: Fold, isShowingRunning: boolean, columns: number) {
  // Where the setting asks, a spree still under way names its latest call, and its dot and note are that call's.
  const naming = isShowingRunning && fold.spree.isLive && !fold.isOpen ? fold.marks.at(-1) : undefined
  const failed = fold.marks.filter(mark => mark.state === 'failed').length
  const state = naming?.state ?? (fold.marks.some(mark => mark.state === 'running') ? 'running' : failed > 0 ? 'failed' : 'done')
  const head = `${fold.isOpen ? '▾' : '▸'} ${fold.marks.length} tool_calls${fold.isOpen ? '' : ': '}`
  const said = naming === undefined ? (failed === 0 ? undefined : `${failed} failed`) : naming.note
  const noteText = said === undefined ? '' : ` - ${said}`
  const room = columns - INDENT - DOT.length - cellsIn(`${head}${noteText}`)
  const told =
    naming !== undefined
      ? `${naming.tool}(${cut(naming.subject, room - cellsIn(`${naming.tool}()`))})`
      : fold.isOpen
        ? ''
        : cut({ text: tallyOf(fold.marks), isPath: false }, room)
  return Box({
    flexDirection: 'row',
    marginLeft: INDENT,
    children: [
      Text({ color: STATE_COLOR[state], children: [DOT] }),
      Button({
        key: 'spree',
        plain: true,
        onPress: () => update($, memberOf(isSpreeOpen, { requestId: fold.first }), wasOpen => !wasOpen),
        children: [
          Text({ color: 'inactive', children: [head] }),
          ...(naming === undefined ? [told] : [Text({ bold: true, children: [naming.tool] }), told.slice(naming.tool.length)]),
          ...(noteText === '' ? [] : [Text({ color: state === 'failed' ? 'error' : 'inactive', children: [noteText] })]),
          ' '.repeat(Math.max(0, room - cellsIn(told))),
        ],
      }),
    ],
  })
}

export const register: Register = (on, options) => {
  // Collapsing folds a spree, the tool calls Claude makes between two pieces of its reply, into one
  // line that counts them by tool. Off, every call has its line. Showing the running call has that
  // one line name the latest call while Claude is still making calls. Both are on unless set off.
  const isCollapsing = options.collapse !== false
  const isShowingRunning = options.showRunning !== false
  const book = emptyBook()

  // The conversations whose response under way last drew a note of Claude's thinking: the main one
  // goes by '', and a subagent's by its id.
  const afterThought = new Set<string>()
  // Whether the person has typed a prompt into the turn under way that Claude has not been sent yet.
  let hasTypedAhead = false

  if (isCollapsing) {
    on('session.start', async ($, e, next) => {
      const splits = [...(await read($, thoughtSplitsSeen)), ...thoughtSplits(await $.session.messages({ as: 'api' }))]
      restore(book, await $.session.messages(), new Set(splits))
      // A subagent's conversation is drawn with the same rows when the person opens it.
      for (const agent of await $.agent.list().catch(() => [])) {
        const rows = await $.session.messages({ agentId: agent.id }).catch(() => [])
        if (Array.isArray(rows)) restore(book, rows, new Set(splits), agent.id)
      }
      // The rows drawn while the conversation was read knew no spree.
      $.ui.invalidate('ui.render')
      return next(e)
    })

    // A prompt submitted while a turn runs carries that turn's id: it waits for the turn's next request.
    on('prompt.submit', async ($, e, next) => {
      if (e.origin.kind === 'composer' && e.turnId !== undefined) hasTypedAhead = true
      return next(e)
    })

    // The response says where a spree begins and ends before any row is drawn: each call as the
    // model begins it, and what Claude Code draws between two sprees, which is Claude's text and any
    // thinking that comes with text. A subagent's responses do the same for its own conversation,
    // whose sprees are kept apart from the main one's.
    on('turn.step', async function* ($, e, next) {
      const loop = e.agentId ?? ''
      // A prompt typed while Claude works goes out with the turn's next request, and Claude Code
      // draws it there, between the calls made before it and the calls made after. So the spree
      // before it has ended, as at any text.
      if (e.index === 0 || (loop === '' && hasTypedAhead)) await redraw($, end(book, loop))
      if (loop === '') hasTypedAhead = false
      for await (const chunk of next(e)) {
        if (chunk.kind === 'tool') {
          const first = join(book, chunk.id, loop)
          if (afterThought.has(loop) && first === chunk.id) await update($, thoughtSplitsSeen, seen => [...seen, chunk.id])
          afterThought.delete(loop)
        } else if ((chunk.kind === 'text' || chunk.kind === 'thinking') && chunk.text.trim() !== '') {
          if (chunk.kind === 'thinking') afterThought.add(loop)
          else afterThought.delete(loop)
          await redraw($, end(book, loop))
        }
        yield chunk
      }
    })

    on('turn.complete', async ($, e, next) => {
      await redraw($, end(book, e.agentId ?? ''))
      return next(e)
    })

    // A row may not ask for another row to be drawn again, so the call does: when it starts and when
    // it ends, which are the two times the line of its spree has something new to say.
    on('tool.call', async ($, e, next) => {
      const { tool, tool_use_id: id, agentId, requestMeta, ...input } = e
      const first = book.spreeOf.get(id)?.calls[0]
      note(book, id, { tool, input, isRunning: true, isErrored: false, isInterrupted: false })
      await redraw($, first)
      try {
        const answer = await next(e)
        const isErrored = answer.isError === true || answer.deny !== undefined
        note(book, id, { tool, input, output: answer.result ?? answer.text ?? '', isRunning: false, isErrored, isInterrupted: false })
        return answer
      } finally {
        await redraw($, first)
      }
    })
  }

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
    for (const call of e.props.calls) {
      const id = call.tool_use_id
      if (id === undefined) continue
      if (isCollapsing) note(book, id, call)
      if (callsInRuns.has(id)) continue
      callsInRuns.add(id)
      hasChanged = true
    }
    if (hasChanged) $.ui.invalidate('ui.render')
    const elements = $.ui.resolve(e)
    const { Box } = elements
    const columns = e.viewport?.columns ?? UNMEASURED_COLUMNS
    const fold = await foldOf($, book, e.props.calls[0]?.tool_use_id)
    const count = fold !== undefined && e.props.calls.some(call => call.tool_use_id === fold.shown[0]) ? [spreeLine($, elements, fold, isShowingRunning, columns)] : []
    // A run Claude Code marks expanded is shaded whole, with a spare row beneath it. The Box draws the
    // terminal's own background over the shade, and its margin takes the row back.
    const cover = e.props.isExpanded ? { backgroundColor: NO_COLOR, marginBottom: -1 } : {}
    // A folded spree is one line, on the row of its first call. Every other row of it draws nothing.
    if (fold !== undefined && !fold.isOpen) return Box({ ...cover, flexDirection: 'column', children: count })
    // Unfolded, each call of the run is drawn through the ToolUse hook below. That holds when Claude
    // Code marks the run expanded too: a click on an open call's input or result is a click on the run
    // to Claude Code, and handing the run back there would redraw every call in it natively.
    const run = await next({ ...e, props: { ...e.props, isExpanded: true } })
    // The full view draws every run expanded and marks none.
    if (isFullTranscript || (count.length === 0 && !e.props.isExpanded)) return run
    return Box({ ...cover, flexDirection: 'column', children: [...count, run] })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (isFullTranscript) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const id = e.props.tool_use_id
    if (isCollapsing) note(book, id, e.props)
    const columns = e.viewport?.columns ?? UNMEASURED_COLUMNS
    const inRun = callsInRuns.has(id)
    const fold = await foldOf($, book, id)
    // A run draws the line of its spree itself, above the calls it holds.
    const count = fold !== undefined && !inRun && fold.shown[0] === id ? [spreeLine($, elements, fold, isShowingRunning, columns)] : []
    if (fold !== undefined && !fold.isOpen) return Box({ flexDirection: 'column', children: count })
    const inset = fold === undefined ? 0 : LISTED
    const mine = memberOf(isOpen, e)
    const open = await read($, mine)

    const head = `${open ? '▾' : '▸'} tool_call: `
    const callNote = noteOf(e.props)
    const noteText = callNote === undefined ? '' : ` - ${callNote}`
    const lineRoom = columns - INDENT - inset - DOT.length
    const subject = open ? '' : `(${closedSubject(e.props.input, lineRoom - cellsIn(`${head}${e.props.tool}()${noteText}`))})`
    // A press lands on the button alone, so spaces carry the button on to the edge of the row.
    const fill = ' '.repeat(Math.max(0, lineRoom - cellsIn(`${head}${e.props.tool}${subject}${noteText}`)))
    const line = Box({
      flexDirection: 'row',
      marginLeft: INDENT + inset,
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
            ...(callNote === undefined
              ? []
              : [Text({ color: e.props.isErrored || e.props.isInterrupted ? 'error' : 'inactive', children: [noteText] })]),
            fill,
          ],
        }),
      ],
    })
    const closed = count.length === 0 ? line : Box({ flexDirection: 'column', children: [...count, line] })
    if (!open) return closed

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
      inRun && e.props.output !== undefined
        ? [Box({ marginTop: -1, flexDirection: 'column', children: [await next({ ...e, props: { ...e.props, tool: '' } })] })]
        : []
    if (input.length + result.length === 0) return closed
    return Box({ flexDirection: 'column', children: [...count, line, Box({ ...PANEL, marginLeft: PANEL.marginLeft + inset, children: [...input, ...result] })] })
  })

  // Claude Code's hint to send a long command to the background is a row of its own under the call.
  // Under a folded spree it would hang beneath a line that is not that call's, so there it is left out.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (isFullTranscript) return next(e)
    const fold = await foldOf($, book, e.props.tool_use_id)
    return next(fold !== undefined && !fold.isOpen ? { ...e, props: { ...e.props, hint: '' } } : e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || isFullTranscript) return next(e)
    const { Box } = $.ui.resolve(e)
    const fold = await foldOf($, book, e.props.tool_use_id)
    if (fold !== undefined && !fold.isOpen) return Box({})
    const inset = fold === undefined ? 0 : LISTED
    if (await read($, memberOf(isOpen, e))) return Box({ ...PANEL, marginLeft: PANEL.marginLeft + inset, children: [await next(e)] })
    return Box({})
  })
}
