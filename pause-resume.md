# Cooperative session pause and resume

This note records the implemented pause lifecycle in `AgentSession`. User-facing RPC and extension contracts are documented in [RPC commands](packages/coding-agent/docs/rpc-commands.md) and [extension APIs](packages/coding-agent/docs/extensions.md).

## Lifecycle

A pause does not abort an active provider response or tool call. It parks the live agent loop so the same work can resume without rebuilding context or replaying tool results.

For an active turn, the provider response and tool calls finish first. `AgentSession` then persists the turn and dispatches the `turn_end` extension boundary. Its wrapped `Agent.finishTurn` callback awaits the existing callback, then changes `pausing` to `paused` and waits before the low-level loop advances. `resume()` sets `unpaused` and releases the wait; the original finish decision and any extension-requested continuation remain in force. This preserves tool-result continuation without injecting an extra `Agent.continue()` call.

The same pause state gates session-level recovery: retries and post-turn handling wait before more provider work, while automatic compaction and asynchronous prompt preflight check pause before admitting a request. Preflight-held work remains available after resume. `abort()` and `dispose()` clear the pause and release waiters; abort also cancels pending admission, preventing a parked run from deadlocking. Already accepted steering and follow-up queues survive abort; use `clearQueue()` to remove them. Abort does not interrupt extension input handlers, but their returned work is cancelled before queue/provider admission.

## State and admission

- An idle `requestPause()` changes `unpaused` directly to `paused`. During an active run it changes the state to `pausing` and returns immediately; the active turn completes before the run publishes `paused`.
- Input admission waiters do not advance `pausing` to `paused`; they only wait for resume or cancellation. Work still held in asynchronous input/preflight before admission is cancelled by abort, unlike already accepted queues.
- `resume()` is idempotent: during `pausing` it cancels the pending pause; during `paused` it releases parked work.
- While `paused`, prompt-like work is rejected; read-only queries and existing control operations remain available.
- Pause state is process-local, not restored from session history. RPC reports `pauseState` separately from `isStreaming`, so a parked run can remain streaming.

`AgentSession` owns the pause state, wait promise, and cancellation generation. The wrapped `finishTurn` callback preserves both the existing callback decision and extension-boundary continuation, and pause does not bypass abort handling.

## Regression coverage

The lifecycle is covered by:

- [AgentSession queue tests](packages/coding-agent/test/suite/agent-session-queue.test.ts): pause transitions, tool-result continuation, preflight admission, resume races, abort, and rejected work.
- [Retry tests](packages/coding-agent/test/suite/agent-session-retry-events.test.ts) and [network recovery tests](packages/coding-agent/test/suite/network-recovery.test.ts): pausing and resuming session-level retries.
- [RPC response tests](packages/coding-agent/test/rpc-prompt-response-semantics.test.ts): immediate command acknowledgement, state reporting, and preflight cancellation.
