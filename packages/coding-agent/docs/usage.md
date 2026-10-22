# Use Pi in the terminal

Run `pi` from the folder you want to work in. Pi uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Pi or chosen a model yet, follow the [Quickstart](quickstart.md).

Pi may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="Pi interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, Pi's responses, tool calls, results, and errors. You write prompts and commands in the editor. The footer shows the current folder, session, model, context usage, and accumulated usage and cost.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

## Follow Pi's work

Pi shows each tool call and result while it works.
Press `Ctrl+O` to expand or collapse tool output.
To hide collapsed tool-result text previews, set `"toolPreviewLines": 0` in `~/.pi/agent/settings.json` and run `/reload`.
A positive number sets the result preview length; removing the setting restores tool defaults.
Write/edit call previews are unaffected.
See [display settings](settings.md#terminal-and-display) for limits and [configuration](configuration.md) for custom agent directories and project overrides.
Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources Pi loaded. The editor border indicates the current thinking level. The footer updates as the model uses context and reports usage.

Pi does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Read and search older history

The transcript shows the whole selected branch in chronological order.
Messages before its latest compaction appear as collapsed headings, including messages retained in the model's current context.
The latest compaction summary and later messages use the normal view.
Without a compaction, the normal view is unchanged.
This does not change what is sent to the model.

Click an older heading in fullscreen mode to open it, or use the configurable tool-expansion action (`Ctrl+O` by default) to expand all headings.
Opening creates that entry's normal rendered body; closing and reopening reuses it.
Expanding all can be expensive for a long session.
Failed or aborted older entries are marked even while closed.

Display-setting changes rebuild the older section with closed headings and current settings.
Ordinary resize and switching between fullscreen and regular mode retain expansion state.
Both modes share the same transcript; regular mode uses terminal scrollback, and `fullscreenExitOutput: "transcript"` prints this same view on exit.

Fullscreen transcript search searches original completed text across the selected branch, including thinking,
tool argument values (such as write contents and edit replacements), textual results, summaries, and displayed custom messages.
It searches literal fragments rather than formatted screen rows.
A hit goes to its message or tool heading and shows an excerpt without opening older bodies or highlighting formatted body text.

Search captures a fixed snapshot on the first nonempty query.
Empty search does not build an index; the first query can take longer on a large branch.
Partial streaming output is excluded.
Close and reopen search to include new completions.
Binary/image data, opaque extension data and details, unseen full-output files, generated notices,
and extension-only renderer text are not searchable.
Replacing the transcript or rebuilding older headings closes active search.

## Change direction

You can send more input while Pi is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task. Aborting returns queued messages to the editor.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the same selector.
- `/thinking` selects how much reasoning the current model uses. Press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

Pi saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. See [Sessions and Context](sessions.md) for these workflows.

After leaving Pi, run `pi --continue` from the same folder to resume its most recent session.

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` when you want to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. By default, Radius authentication makes the artifact visible to your Radius organization; otherwise, Pi creates a private GitHub gist through the GitHub CLI. The [`sessionShareDestination`](settings.md#sessions-and-context) setting can force either destination. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Fullscreen mode, the default, keeps the editor and status area fixed while the transcript scrolls within the terminal window. Regular mode uses the terminal's normal scrollback. Choose a mode through `/settings` or `--tui-mode`.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. Pi writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
