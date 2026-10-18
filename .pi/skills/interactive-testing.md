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

## Release smoke tests

A release smoke test requires a model reply, unlike a UI-only check.
Use disposable configuration and only explicitly authorized provider credentials.
`test.sh` removes inherited credentials; supply the chosen credentials only inside its isolated child environment.
Start the tmux session with `-c /tmp` and use absolute paths to both `test.sh` and the release binary instead of the checkout launcher.
Keep startup offline and disable unrelated resources as above.
Test Node and Bun binaries separately, submit a prompt, and wait for the model reply; startup alone is not a passing release smoke test.
