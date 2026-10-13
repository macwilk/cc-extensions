# cc-extensions

Mods for the Claude Code terminal. Each mod works on its own, so install only the ones that you
want.

- [`cleaner-tool-lines`](#cleaner-tool-lines): one line for each tool call
- [`restyled-chat`](#restyled-chat): color themes, and code blocks in the colors of the theme
- [`inbox`](#inbox): a side panel of what the conversation leaves open

## Get started

Add this repository as a plugin marketplace:

```sh
claude plugin marketplace add macwilk/cc-extensions
```

Then install a mod with the command in its section. In a Claude Code session that is already open,
run `/reload-plugins` afterward.

## cleaner-tool-lines

Folds the tool calls that Claude makes in a row into one line, so the conversation reads straight
through. Click the line to list its calls, and click a call to open it.

<p>
  <img src="media/cleaner-tool-lines-default.gif" alt="Claude Code fixes a failing test with four tool calls, folded into one line that names the call that is running. The pointer opens the line to its calls, and then opens the edit." width="32%">
  <img src="media/cleaner-tool-lines-counts.gif" alt="The same task with the running call not shown: the one line counts the calls by tool while they run." width="32%">
  <img src="media/cleaner-tool-lines-lines.gif" alt="The same task with collapsing off: each of the four tool calls has its own line. The pointer opens the edit." width="32%">
</p>

From left to right: the default, **Show the running tool call** turned off, and **Collapse tool
calls** turned off.

```sh
claude plugin install cleaner-tool-lines@cc-extensions
```

The mod needs the fullscreen interface. For that setting, and for what the dot and the note on a
line mean, see the [`cleaner-tool-lines` README](cleaner-tool-lines/README.md).

## restyled-chat

Adds color themes. Draws each code block in a reply as a shaded block with a copy button, and colors
the code as VS Code colors it under the same theme.

<p>
  <img src="media/restyled-chat-before.png" alt="A prompt, an edit and a reply with a code block, in the dark theme of Claude Code with no mod" width="49%">
  <img src="media/themes/dracula.png" alt="The same conversation in the Dracula theme, with the code block shaded" width="49%">
</p>

```sh
claude plugin install restyled-chat@cc-extensions
```

For a preview of every theme, and for how to add one, see the
[`restyled-chat` README](restyled-chat/README.md).

## inbox

Keeps a list of what the conversation leaves open: questions, your own tasks, findings, and asks
that are not finished. A handle in the status row shows the count and opens the list in a side
panel.

[Watch the demo (1 min 47 s)](media/inbox.mp4)

```sh
claude plugin install inbox@cc-extensions
```

The mod needs the fullscreen interface, and it adds two short model calls to each exchange. For how
items open and close, see the [`inbox` README](inbox/README.md).

## Check a change

Run the following commands from the root of the repository. Replace `MOD` with the directory of the
mod that you changed.

```sh
claude plugin validate MOD
claude plugin test MOD
npx -p typescript tsc -p MOD
```

The `tsc` command reads type declarations from `MOD/.claude-plugin/types`. Claude Code writes that
directory each time it loads the mod by path, for example when you run
`claude --plugin-dir ./cleaner-tool-lines`.

After you change a palette or the theme builder, also run the following command:

```sh
python3 restyled-chat/scripts/build_theme.py --check restyled-chat/palettes restyled-chat/themes
```

## Update Shiki

The `restyled-chat/shiki` directory and the `restyled-chat/hooks/shiki-core.mjs` file are generated
from [Shiki](https://shiki.style). To rebuild them, for example after you change the Shiki version
in `tools/shiki/package.json`, run the following commands:

```sh
cd tools/shiki
npm install
npm run build
```

Claude Code reads no module file over 1 MB and loads no module on demand. That is why only the
engine of Shiki is a module, and the mod reads each grammar and theme as a data file.

## Credit

The idea of one line for each tool call, and the idea of restyling replies, come from
[Tickloop/claude-mods](https://github.com/Tickloop/claude-mods).

The theme colors come from [Catppuccin](https://catppuccin.com), [Dracula](https://draculatheme.com),
the [GitHub theme](https://github.com/primer/github-vscode-theme) for VS Code,
[Gruvbox](https://github.com/morhetz/gruvbox), [Noctis](https://github.com/liviuschera/noctis),
[Nord](https://www.nordtheme.com), [One Dark Pro](https://github.com/Binaryify/OneDark-Pro),
[Solarized](https://ethanschoonover.com/solarized/),
[Tokyo Night](https://github.com/tokyo-night/tokyo-night-vscode-theme), and the
[Dark Modern](https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults) and
[Monokai](https://github.com/microsoft/vscode/tree/main/extensions/theme-monokai) themes of VS Code.

The code colors come from [Shiki](https://shiki.style).

## License

The mods are licensed under the [GNU General Public License](LICENSE), version 3 or any later
version.

The engine, the grammars and the themes of Shiki, and the Noctis Uva theme, are the work of others
and keep their own licenses. Those files are `restyled-chat/hooks/shiki-core.mjs` and the
`restyled-chat/shiki` directory, and their licenses are in `restyled-chat/shiki/licenses`.
