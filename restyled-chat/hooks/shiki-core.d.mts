// The part of Shiki that shiki-core.mjs exports, as the mod uses it. tools/shiki/build.mjs writes the module.

export type ShikiToken = { content: string; color?: string; fontStyle?: number }

export type ShikiHighlighter = {
  loadLanguageSync: (...grammars: unknown[]) => void
  loadThemeSync: (...themes: unknown[]) => void
  getTheme: (name: string) => { fg: string }
  codeToTokensBase: (code: string, options: { lang: string; theme: string }) => ShikiToken[][]
}

export function createHighlighterCoreSync(options: { themes: unknown[]; langs: unknown[]; engine: unknown }): ShikiHighlighter
export function createJavaScriptRegexEngine(): unknown
