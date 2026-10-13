# inbox

The `inbox` mod keeps a list of what a Claude Code conversation leaves open: questions that wait
for your answer, tasks only you can do, findings, and asks that are not finished. A small handle at
the right end of the status row shows how many items are open, in the color of the first section
that waits on you. Click the handle to open the list in a side panel.

[Watch the demo (1 min 47 s)](../media/inbox.mp4)

The idea comes from [petekp/inbox](https://github.com/petekp/inbox).

## What the panel holds

The panel lists goals first, and then everything that belongs to no goal:

- **Goals:** what you asked for. A goal that two or more items share is a block with its progress.
  The block holds the goal's asks and the questions, tasks, and findings about that work. Click the
  goal's name to minimize it, and click **Done** to list what is finished in it. An ask that shares
  a goal with nothing else is listed under **Single goals**.
- **Needs you:** a turn that stopped on an error, checks that failed, questions, questions left
  behind in a question dialog, and your own tasks.
- **Findings:** issues, opportunities, and claims that were not verified by running.
- **Running:** commands that Claude left running in the background.

Each kind of item has its own mark and color, and every section folds when you click its name.

Click an item to open it in place. The item shows why it matters, where it came from, and what
closing it takes, followed by what you can do with it:

- **A question** shows its answers as buttons, with a text box for an answer of your own.
- **A task** shows its command, link, or drafted text, each with a button to copy it.
- **Any item** can go into your prompt box as one quoted line with its id, so that you can add a
  note before you send it. Claude looks up the rest of the item by that id. Several items stack in
  one prompt.

Nothing is sent for you. A click puts text in your prompt box, and the item stays open until a
reply settles it. If you delete the text from the prompt box, the item goes back to open.

`Done` and `Drop` close an item, and `Later` sets it aside until you ask Claude to commit, push, or
wrap up. A closed item stays in the list for four more prompts, with the reason that it closed, and
you can reopen it. A finished goal stays under **Closed** as one row that unfolds to its items.

## Check an item in the background

Two kinds of item have a button that looks into them beside the conversation:

- **Verify**, on an unverified item, runs the claim and reports whether it passed, failed, or could
  not be settled.
- **What's going on?**, on a running item, reports where the task stands.

An agent of the mod does the looking. The agent reads files and runs commands, and it is told to
change nothing. Its report goes to the item, with the time, and never to the conversation, so Claude
takes no turn over it. While a look is running, `Stop` drops it, and `Add to prompt` stops it and
hands the item to the conversation.

- **Passed:** `Close` closes the item with what the check saw as its evidence. If you leave it, the
  item closes when the turn ends.
- **Failed:** the item becomes an issue, named for the problem that the check found. `Fix it` puts
  the issue in your prompt box.
- **Unclear:** the item stays as it was, with the reason.

`Dismiss` throws a result away, and `Details` lists the commands that the agent ran. After three
minutes, you can ask again.

An open item stays open until it is closed or you set it aside. If you tell Claude to keep
something for later, as in "put a pin in those", the inbox lists it under `Later` without waiting
for a click. Items that you set aside together stay under the name of the work they belong to.

## How items open and close

- **Without a model:** the mod watches for a turn that ends on an error, a test or type check that
  fails and later passes, a question dialog that you leave, a background command that ends, and a
  reload of the plugins or a restart that a task was waiting on.
- **On each prompt:** a model reads your message for what it asks and what it answers.
- **On each reply:** a model reads the exchange for what got done, what the reply skipped, and
  what it leaves open. Each close records its evidence.
- **By Claude:** one tool, `inbox`, lets Claude close what you asked for as it finishes each
  thing, list the open items, and record a finding. The reply's read checks each close that Claude
  made and reopens one that the exchange does not bear out. Ask Claude to "resolve the findings in
  the inbox" to work through them.

If you cancel a prompt before Claude writes anything, Claude Code puts the prompt back in the prompt
box, and the inbox goes back to how it stood before that prompt. If you rewind the conversation, the
inbox keeps everything, and an item from a prompt that you rewound past is marked `↶`.

The mod uses the `sonnet` model alias of your Claude Code session for both passes, so each exchange
adds two short model calls to your usage. To use Haiku, which costs less and misses more, run
`/config` and turn on **Read with Haiku**.

## Where the inbox is kept

Each conversation has its own inbox. The mod writes every change, and every model call with its
input and output, to a log for each conversation, with a small file of marks beside it:

```text
~/.claude/inbox/SESSION_ID.jsonl
~/.claude/inbox/SESSION_ID.marks
```

When you resume a conversation, the inbox comes back from its log. When you fork a conversation
with `claude --resume SESSION_ID --fork-session`, the fork starts with the inbox as it stood where
you forked. The marks are how a fork finds the conversation that it came from.

## Before you begin

Set `"tui": "fullscreen"` in your Claude Code settings. Claude Code reports clicks only in the
fullscreen interface.

## Install the mod

```sh
claude plugin marketplace add macwilk/cc-extensions
claude plugin install inbox@cc-extensions
```

In a Claude Code session that is already open, run `/reload-plugins`.

To show or hide the panel without the mouse, run `/inbox`.
