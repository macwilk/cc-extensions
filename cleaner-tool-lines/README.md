# cleaner-tool-lines

The `cleaner-tool-lines` mod replaces the row and the result block of each tool call in the Claude
Code terminal transcript with one line, so the conversation reads straight through:

```text
● ▸ tool_call: Read(…/src/app/main.py)
● ▸ tool_call: Bash(npm test) - error
```

![Claude Code fixes a failing test with five tool calls, each drawn as one line. The pointer opens the failed test run and then the edit.](../media/cleaner-tool-lines.gif)

The dot shows how the call stands:

- **Yellow:** the call is waiting or running.
- **Green:** the call finished.
- **Red:** the call failed or was interrupted.

A long argument is cut to fit one row. A file path keeps its end, where the file name is.

Click a line to open that call. A shaded panel under the line shows the whole argument of the call,
followed by the result. A shell command appears as highlighted code with its line breaks. To close
the call, click its first row again. When you hold the pointer over a line, only that line is
highlighted.

In the full transcript (<kbd>Control+O</kbd>) and under `claude --verbose`, Claude Code draws every
tool call itself.

The mod takes its colors from your Claude Code theme and needs no other mod.

## Before you begin

Set `"tui": "fullscreen"` in your Claude Code settings. Claude Code reports clicks only in the
fullscreen interface.

## Install the mod

```sh
claude plugin marketplace add macwilk/cc-extensions
claude plugin install cleaner-tool-lines@cc-extensions
```

In a Claude Code session that is already open, run `/reload-plugins`.
