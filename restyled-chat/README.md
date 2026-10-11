# restyled-chat

The `restyled-chat` mod changes how the Claude Code terminal looks:

- It adds color themes.
- It draws each fenced code block in a reply as one full-width shaded block.

<p>
  <img src="../media/restyled-chat-before.png" alt="A prompt, an edit and a reply with a code block, in the dark theme of Claude Code with no mod" width="49%">
  <img src="../media/themes/dracula.png" alt="The same conversation in the Dracula theme, with the code block shaded" width="49%">
</p>

## Themes

Each preview shows the same conversation.

<p>
  <img src="../media/themes/catppuccin-mocha.png" alt="The Catppuccin Mocha theme" width="49%">
  <img src="../media/themes/dark-modern.png" alt="The Dark Modern theme" width="49%">
  <img src="../media/themes/dracula.png" alt="The Dracula theme" width="49%">
  <img src="../media/themes/github-dark.png" alt="The GitHub Dark theme" width="49%">
  <img src="../media/themes/gruvbox-dark.png" alt="The Gruvbox Dark theme" width="49%">
  <img src="../media/themes/monokai.png" alt="The Monokai theme" width="49%">
  <img src="../media/themes/noctis-uva.png" alt="The Noctis Uva theme" width="49%">
  <img src="../media/themes/nord.png" alt="The Nord theme" width="49%">
  <img src="../media/themes/one-dark-pro.png" alt="The One Dark Pro theme" width="49%">
  <img src="../media/themes/solarized-dark.png" alt="The Solarized Dark theme" width="49%">
  <img src="../media/themes/tokyo-night.png" alt="The Tokyo Night theme" width="49%">
</p>

## Install the mod

```sh
claude plugin marketplace add macwilk/cc-extensions
claude plugin install restyled-chat@cc-extensions
```

In a Claude Code session that is already open, run `/reload-plugins`.

## Turn on a theme

1. In Claude Code, run `/theme`.
2. Select the theme, for example **Dracula**.

## What a theme colors

A theme sets the colors that Claude Code chooses: the accent, the borders, the status colors, the
diff backgrounds, and the message backgrounds.

Your terminal's color scheme sets the remaining colors:

- The body text of a reply uses the terminal's foreground color.
- Links use the terminal's 16 ANSI colors.

Code blocks and inline code use the syntax colors of Claude Code itself.

Every theme here uses the `dark` base and assumes the background of its source theme. To match the
remaining colors, set the same color scheme in your terminal.

## Add a theme

1. Create `palettes/SLUG.json` with the name of the theme, its base, and its 13 colors by role. To
   start, copy another palette.

   Replace `SLUG` with a short name for the theme, for example `dracula`.

2. Build the theme file:

   ```sh
   python3 scripts/build_theme.py palettes/SLUG.json --out themes
   ```

3. Add the theme and a preview of it to [Themes](#themes).
4. In a Claude Code session that is already open, run `/reload-plugins`.

The theme appears in `/theme` under its `name`. If you change the `base` of a theme that a session
already uses, start a new session to see the change. The `/reload-plugins` command doesn't apply it.

Noctis Uva has no palette. Its theme file is written by hand.
