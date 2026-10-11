import { createHighlighterCoreSync, createJavaScriptRegexEngine, type ShikiHighlighter, type ShikiToken } from './shiki-core.mjs'

/** A run of code in one style. A run in the theme's plain text color has no color of its own. */
export type Run = { text: string; color?: string; italic?: true; bold?: true; underline?: true }

/** Reads one of the data files tools/shiki/build.mjs wrote, by its path under the mod's `shiki` folder. */
export type Read = (path: string) => Promise<string>

type Index = {
  /** Every name and alias of a language, to the name of its grammar. */
  langs: Record<string, string>
  /** The grammars a grammar embeds, which load with it. */
  embedded: Record<string, string[]>
  themes: string[]
}

// The themes of this mod whose colors Shiki has under another name.
const THEME_NAMES: Record<string, string> = { 'dark-modern': 'dark-plus', 'gruvbox-dark': 'gruvbox-dark-medium' }
// Shiki's bits for a token's font style.
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4

// What a session has read so far. A grammar or a theme is read when a reply first needs it, since
// Claude Code loads no module on demand and the data is too large to load with the mod.
let index: Promise<Index> | undefined
let highlighter: ShikiHighlighter | undefined
const loaded = new Set<string>()

function indexOf(read: Read): Promise<Index> {
  index ??= read('index.json').then(text => JSON.parse(text) as Index)
  return index
}

/** The Shiki theme that goes with a Claude Code theme, such as `custom:restyled-chat:dracula`, if there is one. */
export async function themeFor(read: Read, activeTheme: string): Promise<string | undefined> {
  const slug = activeTheme.slice(activeTheme.lastIndexOf(':') + 1)
  const name = THEME_NAMES[slug] ?? slug
  return (await indexOf(read)).themes.includes(name) ? name : undefined
}

async function load(read: Read, kind: 'langs' | 'themes', names: string[]): Promise<unknown[]> {
  const missing = names.filter(name => !loaded.has(`${kind}/${name}`))
  const files = await Promise.all(missing.map(name => read(`${kind}/${name}.json`)))
  for (const name of missing) loaded.add(`${kind}/${name}`)
  return files.map(text => JSON.parse(text) as unknown)
}

/** A grammar and every grammar it embeds, however deep. */
function withEmbedded({ langs, embedded }: Index, grammar: string): string[] {
  const all = new Set<string>()
  const visit = (name: string) => {
    if (all.has(name)) return
    all.add(name)
    for (const inner of embedded[name] ?? []) visit(langs[inner] ?? inner)
  }
  visit(grammar)
  return [...all]
}

function runOf(token: ShikiToken, plainColor: string): Run {
  const style = token.fontStyle ?? 0
  const color = token.color?.toLowerCase()
  return {
    text: token.content,
    ...(color !== undefined && color !== plainColor ? { color } : {}),
    ...(style & ITALIC ? { italic: true as const } : {}),
    ...(style & BOLD ? { bold: true as const } : {}),
    ...(style & UNDERLINE ? { underline: true as const } : {}),
  }
}

const isSameStyle = (a: Run, b: Run) => a.color === b.color && a.italic === b.italic && a.bold === b.bold && a.underline === b.underline

/** The runs of a line with neighbours of one style joined, and white space joined to the run before it. */
function joined(runs: Run[]): Run[] {
  const line: Run[] = []
  for (const run of runs) {
    const last = line[line.length - 1]
    // Space shows no color, so it can ride on any run that draws no line under it.
    const rides = last !== undefined && run.text.trim() === '' && last.underline === undefined
    if (last !== undefined && (rides || isSameStyle(last, run))) last.text += run.text
    else if (run.text !== '') line.push(run.text.trim() === '' ? { text: run.text } : run)
  }
  return line
}

/**
 * The code line by line, each line as runs in the colors and styles the theme gives them.
 *
 * @param theme a name `themeFor` returned
 * @returns undefined for a language Shiki has no grammar for
 */
export async function linesOf(read: Read, source: string, language: string, theme: string): Promise<Run[][] | undefined> {
  const known = await indexOf(read)
  const grammar = known.langs[language.toLowerCase()]
  if (grammar === undefined) return undefined

  highlighter ??= createHighlighterCoreSync({ themes: [], langs: [], engine: createJavaScriptRegexEngine() })
  const [themes, grammars] = await Promise.all([load(read, 'themes', [theme]), load(read, 'langs', withEmbedded(known, grammar))])
  if (themes.length > 0) highlighter.loadThemeSync(...themes)
  if (grammars.length > 0) highlighter.loadLanguageSync(...grammars)

  const plainColor = highlighter.getTheme(theme).fg.toLowerCase()
  return highlighter.codeToTokensBase(source.replaceAll('\t', '    '), { lang: grammar, theme }).map(line => joined(line.map(token => runOf(token, plainColor))))
}
