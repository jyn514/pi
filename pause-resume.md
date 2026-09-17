# Semantics

 This version pauses only at an existing completed-turn boundary:

 1. Current provider response finishes.
 2. Every tool call from that response finishes.
 3. turn_end is emitted and transcript state is complete.
 4. Pi stops before:
     - another provider request,
     - automatic retry,
     - automatic compaction,
     - queued steering or follow-up work.

 It reuses Agent.shouldStopAfterTurn; packages/agent/src/agent-loop.ts requires no changes.

 State model

 Keep pause state entirely in AgentSession:

 ```ts
   type PauseState = "unpaused" | "pausing" | "paused";
 ```

 Add fields such as:

 ```ts
   private _pauseState: PauseState = "unpaused";
   private _pauseWaiter?: PromiseWithResolvers<void>;
   private _pauseStoppedWithToolResults = false;
 ```

 Public API:

 ```ts
   get pauseState(): PauseState;
   requestPause(): void;
   resume(): void;
 ```

 Rules:

 - Pause while idle: immediately paused.
 - Pause during a turn: pausing.
 - Completed turn reaches the hook: paused.
 - Resume while pausing: cancel the request; the agent continues normally.
 - Resume while paused: release the parked orchestration.
 - Repeated pause/resume calls are idempotent.
 - Abort and shutdown release pause waiters before aborting.
 - Starting a new session resets state to unpaused.

 Hook installation

 Add _installAgentPauseHook() beside the existing hook installation in AgentSession:

 ```ts
   this._installAgentToolHooks();
   this._installAgentNextTurnRefresh();
   this._installAgentPauseHook();
 ```

 Preserve any SDK-provided shouldStopAfterTurn callback:

 ```ts
   private _installAgentPauseHook(): void {
       const previous = this.agent.shouldStopAfterTurn;

       this.agent.shouldStopAfterTurn = async (turn, signal) => {
           if (await previous?.(turn, signal)) {
               return true;
           }

           if (this._pauseState !== "pausing") {
               return false;
           }

           this._pauseStoppedWithToolResults = turn.toolResults.length > 0;
           this._setPauseState("paused");
           return true;
       };
   }
 ```

 Calling the previous hook first matters: if an application already requested a genuine stop, Pi must not later invent a continuation merely because pause was requested concurrently.

 Parking AgentSession

 Adjust _runAgentPrompt():

 ```ts
   private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
       this._isAgentRunActive = true;
       try {
           await this.agent.prompt(messages);

           while (true) {
               await this._waitWhilePaused();

               const pauseContinuation = this._pauseStoppedWithToolResults;
               this._pauseStoppedWithToolResults = false;

               const postRunContinuation = await this._handlePostAgentRun();
               if (!pauseContinuation && !postRunContinuation) {
                   break;
               }

               await this.agent.continue();
           }
       } finally {
           // existing cleanup
       }
   }
 ```

 The extra continuation flag is necessary when the stopped turn produced tools. Normally the low-level loop would immediately send those tool results back to the model. Since shouldStopAfterTurn deliberately
 ended that loop, resume must call agent.continue() even when no steering message exists.

 Pause acknowledgement

 requestPause() should not wait:

 ```ts
   requestPause(): void {
       if (this._pauseState !== "unpaused") return;

       if (!this._isAgentRunActive) {
           this._setPauseState("paused");
           return;
       }

       this._setPauseState("pausing");
   }
 ```

 This avoids RPC timeouts when the current provider request or tool batch lasts longer than 30 seconds.

 State transitions emit one session event:

 ```ts
   type PauseStateChangedEvent = {
       type: "pause_state_changed";
       state: PauseState;
   };
 ```

 Consumers wanting confirmation watch for state: "paused".

 Resume and abort

 ```ts
   resume(): void {
       if (this._pauseState === "unpaused") return;

       this._setPauseState("unpaused");
       this._pauseWaiter?.resolve();
       this._pauseWaiter = undefined;
   }
 ```

 Abort must resume the waiter internally without changing the user-visible operation into an ordinary resume:

 ```ts
   async abort(): Promise<void> {
       this._releasePauseWaiter();
       this.abortRetry();
       this.agent.abort();
       await this.waitForIdle();
   }
 ```

 The same release is required during session shutdown and replacement. Otherwise /new, /resume, process exit, or extension reload could wait forever on a paused run.

 Input behavior

 To keep the first version small and unambiguous:

 - While pausing, steering and follow-up messages continue to queue normally.
 - While actively paused, new prompt-like RPC commands return Session is paused; resume it before submitting work.
 - Read-only commands such as state, entries, tree, and session statistics remain available.
 - abort, resume, session replacement, and shutdown remain available.

 Queueing entirely new prompts while idle-paused can be added later, but requires another queue and rules for command/template preflight ownership.

 RPC changes

 Update:

 - packages/coding-agent/src/modes/rpc/rpc-types.ts
 - packages/coding-agent/src/modes/rpc/rpc-mode.ts
 - packages/coding-agent/src/modes/rpc/rpc-client.ts
 - packages/coding-agent/src/modes/json-event.ts only if event conversion needs adjustment

 Commands:

 ```ts
   { type: "pause" }
   { type: "resume" }
 ```

 State:

 ```ts
   interface RpcSessionState {
       // existing fields
       pauseState: PauseState;
   }
 ```

 Client:

 ```ts
   pause(): Promise<void>;
   resume(): Promise<void>;
 ```

 Both commands acknowledge immediately. The subagent extension can issue pause concurrently to each child, then observe pause_state_changed or poll get_state.

 Tests

 ### AgentSession tests

 1. Pause during provider streaming becomes paused only after turn_end.
 2. Tool batch completes before pause.
 3. Tool results cause exactly one continuation after resume.
 4. No provider request starts while parked.
 5. Steering queued during pausing runs after resume.
 6. Resume before the turn ends cancels the pending pause.
 7. Abort while paused settles without deadlock.
 8. Existing shouldStopAfterTurn retains precedence.

 ### Retry and compaction tests

 - Retry does not begin until resume.
 - Automatic compaction does not begin until resume.
 - Retry/compaction runs exactly once after resume.
 - A naturally completed turn does not create an unnecessary continuation.

 ### RPC tests

 - pause responds before the running turn finishes.
 - State transitions unpaused → pausing → paused.
 - Read-only requests work while paused.
 - Prompt requests fail clearly while paused.
 - Shutdown and session replacement work while paused.

 Scope and impact

 No changes are required in:

 - packages/agent/src/agent-loop.ts
 - provider implementations,
 - tool contracts,
 - transcript/session formats,
 - extension event execution,
 - model streaming.

 The principal changes stay inside AgentSession and RPC. Expect roughly 5–8 production files, 3–5 test files, and 2–4 engineering days. The main invariant to protect is: a pause-induced shouldStopAfterTurn must
 preserve whether completed tool results require one continuation after resume.
