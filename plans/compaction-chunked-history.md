# Load transcript history by compaction interval

Status: superseded proposal, not implemented.
The current direction is [lazy collapsed inline history](lazy-collapsed-history.md), not chunk loading.
Prepared against parent `12449f11` and the existing uncommitted collapsed-preview optimizations on October 21, 2026.
Do not fold those optimizations into this feature or alter their authored changes.

## Outcome and scope

Make earlier messages on the selected session branch reachable by scrolling upward in fullscreen mode without rendering the entire branch at startup.
Start with the active context's entries, ordered chronologically on the original branch.
Load earlier omitted entries back to the preceding compaction when the user approaches the loaded start.
Keep loaded history available until the session or branch changes.
Normal compaction, settings, and extension-reload rebuilds may recreate its components; history loading alone does not recreate the loaded suffix.

For example, if the current context retains the last few messages before compaction C3, display those messages, C3, and subsequent messages.
An upward load fills the omitted interval back to C2 without repeating retained messages.
A further load reaches C1, then the beginning of the selected branch.

This is deferred display construction, not deferred session-file parsing or viewport virtualization.
The benefit is access to old history without the eager full-history rendering cost, not faster startup than today's current-context display.
No offscreen component eviction, estimated heights, new setting, keybinding, dependency, session format, or model-context change is required.
A session without compactions still renders its whole current context.
A large compaction interval can still take noticeable time to load.

## Decisions and ownership

- **Decided:** the selected chronological branch and entry IDs are authoritative.
  `SessionManager.getBranch()` supplies that branch; `buildContextEntries()` supplies initial entry membership only.
  Do not concatenate successive model contexts: retained entries overlap.
- **Decided:** the interactive transcript owns the earliest loaded branch position and pending load request.
  Rendered components, chunk boundaries, and row counts are derived state, never persisted.
  Keep `chatContainer.children` flat so existing expansion, thinking, and padding setters continue to reach all loaded components.
- **Decided:** historical replay uses existing message conversion and renderers but cannot clear or replace the live `pendingTools` map.
  It cannot populate editor input history, update the footer, or start tool execution.
- **Decided:** TUI owns scroll offsets, selection coordinates, and search state.
  It receives row-insertion information, not compaction entries or session policy.
  Keep `Component.render(width)` and the general layout algorithm unchanged.
- **Conservative default:** initial entry membership stays the same, but summaries appear in branch chronology.
  This intentionally normalizes startup's summary-first ordering to the chronological ordering already used by live compaction handlers.
- **Conservative default:** search and jump to the beginning load all omitted history before acting.
  Previous-prompt navigation does the same only when its target is outside the loaded range.
  Next-prompt navigation needs no older history.
  This preserves complete-history navigation without adding a second search representation.
  Search retains current rendered-text semantics; it does not start searching hidden tool output.
- **Conservative default:** request one previous interval when an explicit upward scroll reaches the first viewport-height of loaded history.
  An upward request at row zero must also work when the loaded document is shorter than the viewport.
  Initial layout, resize, and incoming output alone must not trigger automatic history loading.

## Repository constraints

`packages/tui/src/layout.ts` measures height by rendering and also supplies complete `scrollContentLines`.
`packages/tui/src/components/scroll-view.ts` clamps scroll offsets against its last measured height.
Consequently, calling `scrollBy(insertedHeight)` before the next layout loses the adjustment against the old maximum.
Search, prompt navigation, and text selection in `packages/tui/src/tui-alt-screen.ts` also use document rows.

`renderSessionItems()` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` clears live pending tools before replay.
The two compaction event paths clear the transcript, and settings/reload paths rebuild only the current context.
These paths must participate in the feature rather than being bypassed.

## Loading contract

### Select and build a historical interval

Add `packages/coding-agent/src/modes/interactive/transcript-history.ts` for interactive-owned range selection.
It selects nonoverlapping earlier ranges from a branch and tracks the loaded start; it does not render, read files, or change session state.
Choose the nearest compaction strictly before that start, or the branch beginning if none exists.
A boundary may separate an assistant call from its result; do not widen initial membership or require closed tool groups.
After replaying an older range, complete its unmatched staged calls from matching persisted results in the already loaded suffix.
Derive that lookup from the selected branch using existing chronological pairing semantics, including parallel calls and reused call IDs.
Do not apply a result twice or transfer unmatched historical calls into live `pendingTools`.
An initially retained result with an omitted call has no separate component today; its call acquires that result when older history is loaded.
Do not invent missing results or traverse a branch summary's `fromId` into a different branch.

Build the selected entries in an unattached target using the existing renderer path.
Prepend the completed components and advance the loaded start together.
Account for entry-to-component conversion producing zero or multiple children; entry IDs are not child-array indices.
Match eager spacing at the join, including the conditional user-message spacer that an initially empty suffix may lack.
Include any added boundary spacer in the measured insertion.
A range producing no visible children still advances the history cursor.
For load-all actions, stage the entire omitted prefix in one replay before publishing.
Reuse current fallback handling for extension renderer errors.
If construction fails outside those fallbacks, keep the previous components, cursor, and live tool map intact and report the failure.
The requested navigation must not continue against incomplete history and report a false absence of matches.

Refactor only the bulk replay helpers that need an explicit destination and a local tool-pairing map.
Move entry-to-display conversion into the shared bulk builder without invoking `renderSessionEntries()`'s document-replacement selection reset.
Do not refactor streaming or tool execution into a new transcript framework.
Historical construction uses current theme, expansion, image, preview, padding, and thinking settings.
Document replacement may rebuild live tool state as it does today, but only unmatched calls in active-context entries may enter `pendingTools`.
Unmatched calls in older loaded history remain historical.

### Publish a prepend without moving existing text

Add the narrow native capabilities needed by the fullscreen transcript:

1. Observe explicit upward scroll requests through the primary `ScrollView`, including an unconsumed request at its start.
   Cover keyboard, wheel, scrollbar, and selection autoscroll paths rather than patching individual key checks.
2. Notify the fullscreen renderer of a measured insertion at a document row.
   Account for headers and loaded resources above the transcript: the insertion is not necessarily at document row zero.
3. Apply the scroll compensation with the new layout bounds before painting, and translate selection endpoints/ranges below the insertion.
   Shift a scroll/selection row only when it is at or below the insertion; headers above it keep their coordinates.
   Translate shared point objects only once, and do not let short-document follow-end override the explicit prepend adjustment.
   Do not reset an active selection merely because older rows were inserted.
4. Let complete-history actions request omitted entries, then resume against a fresh `LayoutFrame` after the insertion and scroll adjustment.
   Neither a search snapshot nor a previous-prompt target may come from the old layout.

Queue loading outside layout traversal and mouse-event dispatch.
Do not mutate children from `render()` or `ScrollView.updateLayout()`.
Use the pending-operation rules below rather than independent queues in the loader, ScrollView, and search.
Measure the inserted components at the actual scroll content width using their existing render methods.
Apply their row count, not the total document-height change: streaming at the tail must not be mistaken for a prepend.
Preserve any unconsumed upward scroll so a short initial document does not require a second gesture to reveal older text.
If the width changes while an insertion is pending, let the resize frame commit before measuring and publishing that insertion.
Never use mixed-width measurements for prepend compensation.
Keep existing resize behavior; do not introduce a general message-anchor or height-estimation subsystem.
Later asynchronous height changes retain the renderer's existing behavior.
This feature does not promise general scroll anchoring for image or extension reflow.

After an explicit prepend, preserve the first visible existing row except for movement requested by that scroll gesture.
A selection wholly on either side of the insertion copies the same text afterward.
A selection spanning the insertion keeps its endpoint content and naturally includes the new rows between them.
An endpoint on the old first transcript row moves with that row; an endpoint above the insertion does not move.
Do not add discontiguous selection support.
Refresh native hit testing, prompt/search row data, and image clipping through the normal next layout.

### Pending requests and native action ordering

The interactive history owner has one pending construction request; AltScreen owns its deferred input continuation and row-insertion transaction.
Requests carry the current view generation so replacing the view cancels both halves.
Construction remains synchronous outside dispatch/layout; add no worker, timer-driven builder, or progress overlay.

- The primary scroll hook may reserve upward movement while requesting an older interval.
  Reserved movement is not returned as unused overscroll for an ancestor to consume.
  While pending, combine upward deltas into one reserved amount and construct only one interval for that request.
  Apply the reserved amount once after the new bounds exist, clamp any remainder, and release the reservation on success or failure.
- Selection autoscroll pauses at a reserved loaded boundary instead of treating it as the branch beginning.
  Resume its existing timer against the new bounds if the drag remains active; release/cancellation stops it normally.
- An absolute scrollbar request near the loaded start can request an interval without inventing a relative wheel delta.
  Another pointer movement can request another interval; a stationary drag does not repeatedly fetch chunks.
- A complete-history action upgrades a queued interval request before construction starts.
  After synchronous construction starts, input cannot interleave; a later action loads any remaining prefix.
  Complete-history intent replaces reserved wheel movement so the old gesture does not override the requested destination.
- Keep at most one deferred navigation continuation; a newer navigation replaces the older one.
  A second search toggle cancels pending search activation; accepted history preparation may still finish.
  Run the retained action only after a fresh layout incorporates the new rows and scroll adjustment.
  Failure, branch/session replacement, renderer teardown, or shutdown drops that continuation.

These rules need only concrete optional ScrollView/AltScreen capabilities.
Do not widen `ViewportTUI` or make existing public `void` navigation methods promise-returning.

### Lifecycle

- On initial render, resume, or branch replacement, derive a new loaded suffix and clear pending requests from the old view.
  A queued request must verify session/branch generation and renderer identity before publishing.
- New messages and tool events continue through existing live paths.
  Loading history cannot recreate or replace a live tool component.
- On successful compaction, preserve the earliest loaded entry and rebuild that chronological suffix through existing reconstruction paths.
  Render each summary/cost once in the resulting document and retain the existing suppression of subsequent boundary-entry replay.
  Cover both `entry_appended` and `compaction_end`; do not replace their event protocol with incremental component-span reconciliation.
  Rebuilds may reset selection as they do today; the exact anchoring guarantee applies to historical prepends, not document replacement.
  Cancellation or failure adds no history boundary and discards no loaded content.
- Every document rebuild cancels queued row/navigation transactions but preserves the loaded boundary unless the session or branch changes.
- Rebuild under current settings; extension reload uses the new runner and discards stale extension-rendered objects.
  Keep its reconstruction before `session_start`, because that hook may append fresh display entries.
- Replacing a session or selecting a different branch releases the old components and history cursor through existing teardown.
  Renderer-mode switching rebinds callbacks and cancels queued requests from the old renderer without dropping loaded history.
  Regular mode displays the loaded transcript but does not automatically fetch older chunks.
- Keep transient status notices outside branch-entry deduplication.
  Do not replay old entry loads into editor history or repeat startup/trust notices.
  Persisted summary/cost entries still render normally; they are not one-time activation notices.

## Implementation sequence and logical commits

These are implementation boundaries, not authorization to commit.
Tests and documentation accompany the behavior they establish.

### 1. Add native prepend-aware scrolling

Suggested subject: `Support anchored transcript prepends in fullscreen mode`.

Files: `packages/tui/src/components/scroll-view.ts`, `packages/tui/src/tui-alt-screen.ts`, and their tests.
Export any new public API types through `packages/tui/src/index.ts`.
Keep the capabilities above optional so existing TUI consumers retain their current behavior.
Expose only what the coding-agent transcript needs; no arbitrary document-edit protocol or callback registry.
Document the native API in `packages/tui/README.md`.

Verify scroll notifications, prepend compensation, selection translation, and action ordering with fake content and `VirtualTerminal`.
Include unconfigured controls proving ordinary scrolling and search remain unchanged.
A nested scroll view must not load transcript history unless its unused movement reaches the primary transcript view.
Stop if this requires changing `Component.render`, replacing general layout, or adding an estimated-height index.
Revise the plan rather than expanding the feature.

### 2. Load historical intervals through the production transcript path

Suggested subject: `Load fullscreen history by compaction interval`.

Files:
- New `packages/coding-agent/src/modes/interactive/transcript-history.ts` and focused tests.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` bulk replay, initial render, compaction, rebuild, and renderer-switch integration.
- `packages/coding-agent/src/modes/interactive/chat-viewport.ts` to bind primary scrolling to the history owner.
- New `packages/coding-agent/test/interactive-mode-history.test.ts` and affected existing interactive tests.

Implement the loading contract, preserve flat component ownership, and connect the native prepend and complete-history operations.
Keep `session-manager.ts`, stored entries, extension renderer contracts, and ordinary live tool event processing unchanged.
Use fresh branch data for later loads so entries appended since startup remain represented without treating every new leaf as a branch switch.

Document upward loading, loaded-range scrollbars, and pauses on complete-history actions.
Update `packages/coding-agent/docs/usage.md` and `packages/coding-agent/docs/tui.md`.
Add a changelog entry only under the repository's branch policy.

### 3. Verify the assembled lifecycle and cost

Finish the acceptance cases below through production transcript assembly plus the fullscreen renderer, not only a mocked history controller.
Extend `interactive-mode-compaction.test.ts` and `interactive-mode-tool-preview.test.ts` for compaction and tool ownership.
Use `interactive-tui.test.ts` and `interactive-mode-tree-navigation.test.ts` for renderer and navigation coverage.
Use `test/suite/harness.ts` and the faux provider only if a new AgentSession-level test is necessary.
No real provider calls, user-state writes, or session migration is needed.

Repeat the retained local renderer benchmark on the three selected large branches with initial load, one interval load, and all-history load.
Use `SessionManager.inMemory(..., entries)` and the production history-aware initialization/loading path.
The old runner's direct `renderSessionEntries(allEntries)` call would bypass this feature and is not an initial-load measurement.
Keep raw measurements and runner sources under `.artifacts/scrollback-perf/`.
Report construction/layout separately and retain eventual full-history cost; do not present deferred work as eliminated work.

## Acceptance and verification

Use small constructed branches with distinct text and entry IDs, real `SessionManager.inMemory()`, built-in renderers, and `VirtualTerminal`.
Change expectations only for deliberate changes: chronological startup summaries and retaining history through compaction.

| Area | Required observation |
| --- | --- |
| Initial load | Only current-context entries are constructed; no historical renderer runs; newest content is visible |
| Range identity | Retained tails, repeated compactions, parallel calls, and first/last intervals produce no omissions or duplicates; a retained result receives its omitted call's component when that call loads |
| Branch scope | Loading reaches the selected branch's root, never a sibling referenced by a branch summary |
| Upward inputs | Wheel, page/line navigation, scrollbar movement, and selection autoscroll each load one earlier interval near the start |
| Short document | An upward gesture at zero loads older content and applies the otherwise unconsumed movement |
| Prepend position | Existing visible text stays anchored at the next paint, including with headers and simultaneous tail growth |
| Selection | Selections on one side copy unchanged text; spanning selections retain endpoints and include inserted rows; shared point objects shift once |
| Repeated loads | Reserve movement once without duplicate entries or chained overscroll; another load needs a new scroll request, including an active selection-drag tick, never merely a layout |
| Complete navigation | Search, earlier omitted prompts, and jump-to-start reach old history using a fresh layout; newer actions replace pending ones and failed/cancelled actions do not run |
| Live tools | A loading gesture during streaming leaves active tool identity intact and subsequent results update the original component |
| Compaction | Both success event paths add one summary/cost and retain loaded history; cancelled/failed compaction changes neither boundary nor cursor |
| Rebuilds | Theme, padding, thinking, expansion, cache notices, and extension reload continue to affect previously loaded history |
| View replacement | A queued old-view request cannot publish into a new session, branch, or renderer |
| Renderer failure | A failed historical build leaves the prior view usable and does not perform incomplete search/navigation |
| Images/custom renderers | Existing clipping, invalidation, and fallback behavior works for newly loaded historical components |
| Fully loaded | Historical entries and join spacing match eager chronology at widths 120 and 100; no tool executes and a prepend does not reconstruct the loaded suffix |

Use a finite input/transition matrix and exact text/selection assertions.
Show that disabling the load trigger or prepend compensation fails the corresponding tests.
Also verify that historical replay clearing live tools fails the live-tool test.
Run focused tests from each package through `../../test.sh -- ...`, preserving package-local aliases.
Run `npm run check` with full output after implementation; do not run a build, `npm test`, or the full Vitest suite unless requested.
Follow `.pi/skills/interactive-testing.md` for a controlled smoke test.
Use a disposable synthetic compacted session with no provider calls.

## Maintenance and rebase assessment

**Conditional recommendation:** proceed with a bounded cross-layer feature, not a transcript-local optimization.
Correctness risk and ongoing maintenance are moderate; rebase burden is moderate-to-high relative to the collapsed-preview optimizations.
The native work changes scrolling, overscroll, selection, and deferred navigation in two shared TUI files.
Coding-agent integration touches bulk replay, both compaction paths, and initial/session/tree activation.
Settings rebuilds, reload, and renderer switching must also preserve the loaded range.

Retaining loaded history through existing rebuilds avoids permanent entry-to-component tracking for live output.
The cost is reconstructing more history on compaction/settings changes after many chunks are loaded.
Insertion-only anchoring, flat children, and unchanged general layout keep this materially smaller than virtualization.
Do not expand it into persistent anchoring across arbitrary renderer reflow merely to remove that limitation.

Compare against local recorded upstream `482c1381`, which is an ancestor of parent `12449f11`.
The existing layout, ScrollView, and chat-viewport files match that recorded upstream tree.
This is a new divergence in upstream-owned UI code; no live upstream fetch or exact conflict-rate estimate is implied.
Keep native TUI changes and coding-agent policy in separate coherent commits.
Re-run navigation, selection, compaction, and streaming integration tests after upstream changes even if the rebase has no textual conflicts.
