---
name: interactive-testing
description: Test and debug pi's interactive mode in a controlled tmux terminal. Use for TUI behavior checks and interactive release smoke tests.
---

# Testing pi Interactive Mode with tmux

## UI-only checks

Run from the repository root, two directories above this skill.
Use `test.sh --` to isolate configuration, credentials, caches, and session storage; see [Focused tests](../../CONTRIBUTING.md#focused-tests).
Keep startup offline and disable resource discovery, loading only explicit extensions needed by the check.
Even a `pi-test.sh --help` probe can discover and install configured packages without isolation.
`--no-env` alone does not isolate configuration.

```bash
tmux new-session -d -s pi-test -x 80 -y 24 \
  "./test.sh -- ./pi-test.sh --offline --no-session --no-extensions --no-mcp \
    --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve \
    --tui-mode fullscreen"
sleep 3
tmux capture-pane -t pi-test -p
# Send local commands or key events, not model prompts.
tmux send-keys -t pi-test /settings Enter
sleep 1
tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test Escape   # C-o sends Ctrl+O
# Exit normally so test.sh removes its disposable state.
tmux send-keys -t pi-test C-d
```

Wait for the application to render before sending input; inspect another capture if startup takes longer.
Inspect the UI after the action under test, not only after startup.
A `No models available` warning is expected without credentials; local UI commands still work.
If the application does not exit, stop the owned session with `tmux kill-session -t pi-test` and remove any disposable state left by interrupted cleanup.

For an extension check, append its explicit `-e <path>` to the startup command; explicit paths still load with `--no-extensions`.
For example, load `-e ./packages/coding-agent/examples/extensions/message-renderer.ts` and run `/status hello`.
Click the message to show or hide its timestamp.

`--offline` disables startup network operations; it is not a network sandbox.
Do not submit model prompts or invoke networked extension actions for UI-only checks.

### Busy shrink/restore resize check

For stale rows after resizing, exercise the real PTY and Node signal path before expanding an emulator-only test matrix.
A virtual terminal can report every resize even when Node suppresses stdout's `resize` event.

Use a separate owned tmux server and session, both named `resize-probe`, with the isolated fullscreen startup above at `116×25`.
Use `tmux -L resize-probe` for every controller command and verify the pane dimensions, not just the window dimensions.
Load an explicit disposable extension from `work/` with these local-only fixture commands:

- `/probe-busy`: write a start marker in `work/`, then block the JavaScript thread for 2000 ms without terminal writes.
  Use a synchronous loop; an awaited timer does not hold up resize handling.
- `/probe-capture`: write `TuiAltScreen.getScreenLines()` to a file in `work/` without changing the rendered content.
  A test footer factory receives the TUI instance and can retain it for this command.

Have the fixture log raw `SIGWINCH` and stdout `resize` notifications to a file, including the dimensions seen by each callback.
Remove those listeners on fixture shutdown.
Do not add a signal-triggered redraw to the fixture: it would hide a production repaint failure.
Use a recognizable bottom-row footer sentinel and wait for it to appear before testing.

Use a controller script so both size changes occur while Pi is blocked, rather than entering the commands by hand.
Capture the undamaged pane, remove any previous start marker, send `/probe-busy`, and wait for its new marker before resizing.
Bound the marker wait and fail if the command never starts.
While Pi is still blocked, run:

```bash
tmux -L resize-probe resize-window -t resize-probe -x 116 -y 24
sleep 0.7
tmux -L resize-probe resize-window -t resize-probe -x 116 -y 25
sleep 1.6
tmux -L resize-probe capture-pane -p -t resize-probe
```

Capture the physical pane before sending `/probe-capture` or selecting text, since either action can cause rendering.
Confirm that raw resize signals arrived and stdout emitted no resize notification during the shrink/restore interval.
Otherwise the suppressed-notification case was not exercised.
All footer rows should match the undamaged capture after Pi resumes.
A row present in the logical frame but absent or stale in the pane identifies a repaint failure rather than missing layout content.
Selecting outside versus inside the damaged row can test whether selection repairs only the rows it rewrites.
This reproduces missed repainting, not necessarily the original artifact's exact leftover text.

Also check ordinary width changes and start/stop listener cleanup.
Keep those separate from the same-final-size case.
Exit Pi normally and stop only the owned tmux server; remove disposable fixture state after preserving decisive findings.

## Release smoke tests

A release smoke test requires a model reply, unlike a UI-only check.
Use disposable configuration and only explicitly authorized provider credentials.
`test.sh` removes inherited credentials; supply the chosen credentials only inside its isolated child environment.
Start the tmux session with `-c /tmp` and use absolute paths to both `test.sh` and the release binary instead of the checkout launcher.
Keep startup offline and disable unrelated resources as above.
Test Node and Bun binaries separately, submit a prompt, and wait for the model reply; startup alone is not a passing release smoke test.
