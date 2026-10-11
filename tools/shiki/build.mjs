// usage: npm install && npm run build
//
// Writes what restyled-chat needs of Shiki into the mod:
//   restyled-chat/hooks/shiki-core.mjs   Shiki's engine as one module, with no language or theme in it
//   restyled-chat/shiki/langs/NAME.json   one grammar each, for every language Shiki ships
//   restyled-chat/shiki/themes/NAME.json  one theme each: Shiki's, and the ones in ./themes
//   restyled-chat/shiki/index.json        which names there are, and which grammars a grammar needs
//   restyled-chat/shiki/licenses/         the licenses of what was copied
//
// Claude Code reads no module file over 1 MB and loads none on demand, so only the engine is a module.
// The mod reads a grammar or a theme as data the first time a reply needs it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { bundledLanguagesInfo } from 'shiki/langs'
import { bundledThemesInfo } from 'shiki/themes'

const here = dirname(fileURLToPath(import.meta.url))
const mod = join(here, '..', '..', 'restyled-chat')
const data = join(mod, 'shiki')

rmSync(data, { recursive: true, force: true })
for (const folder of ['langs', 'themes', 'licenses']) mkdirSync(join(data, folder), { recursive: true })

await build({
  stdin: {
    contents: "export { createHighlighterCoreSync } from 'shiki/core'\nexport { createJavaScriptRegexEngine } from 'shiki/engine/javascript'\n",
    resolveDir: here,
  },
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'none',
  outfile: join(mod, 'hooks', 'shiki-core.mjs'),
})

// Every name and alias of a language, to the name of its grammar.
const langs = {}
// The grammars a grammar embeds, which load with it.
const embedded = {}
for (const info of bundledLanguagesInfo) {
  // A language's module holds the grammars it embeds, then its own.
  const grammars = (await info.import()).default
  for (const grammar of grammars) {
    const path = join(data, 'langs', `${grammar.name}.json`)
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(grammar))
    embedded[grammar.name] ??= grammar.embeddedLangs ?? []
  }
  for (const name of [info.id, ...(info.aliases ?? [])]) langs[name] = grammars.at(-1).name
}

const themes = []
for (const info of bundledThemesInfo) {
  writeFileSync(join(data, 'themes', `${info.id}.json`), JSON.stringify((await info.import()).default))
  themes.push(info.id)
}
// The themes Shiki does not ship.
for (const file of readdirSync(join(here, 'themes')).filter(name => name.endsWith('.json'))) {
  copyFileSync(join(here, 'themes', file), join(data, 'themes', file))
  themes.push(file.slice(0, -'.json'.length))
}

writeFileSync(join(data, 'index.json'), JSON.stringify({ langs, embedded, themes: themes.sort() }))

for (const name of ['shiki', '@shikijs/core', '@shikijs/langs', '@shikijs/themes']) {
  copyFileSync(join(here, 'node_modules', name, 'LICENSE'), join(data, 'licenses', `${name.replace('@shikijs/', 'shikijs-')}-LICENSE`))
}
copyFileSync(join(here, 'themes', 'noctis-LICENSE.md'), join(data, 'licenses', 'noctis-LICENSE.md'))

console.log(`${Object.keys(embedded).length} grammars under ${Object.keys(langs).length} names, ${themes.length} themes`)
