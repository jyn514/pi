# Show older transcript history as lazy collapsed entries

Status: implemented and reviewed on October 22, 2026.
The selected approach was planned against `12449f11`; implementation follows the plan commit `d4d78622`.
This supersedes [the chunked-history proposal](compaction-chunked-history.md).
The preview optimizations are a separate change, `6711cf7d`.

Repository checks and focused application/TUI tests cover the implementation and subsequent review fixes.
An isolated tmux smoke test resumes a synthetic compacted session offline and checks collapsed history,
search of hidden message/tool text, expansion, and resize without provider calls.
Benchmarks measure production construction/layout, not end-to-end CLI startup, and precede the final search/lifecycle review fixes.

## Contract and decisions

Show the whole selected branch inline, in chronological order.
Before its latest actual compaction entry, show collapsed headings for displayed messages, tool calls/results, summaries, and custom entries.
At and after that entry, render normally; without compaction, render normally throughout.
Retained context entries before the cutoff remain historical for display and appear only once.

- **Decided:** opening a historical heading constructs its normal body through existing renderers.
  Persisted failure/abort signals have a visible indicator while their bodies remain closed.
- **Decided:** use one original-text search for completed entries throughout the selected branch.
  A result navigates to its message/tool start and shows an excerpt; searching does not open historical bodies.
  Do not merge rendered-row matches or map hits onto formatted body text.
- **Decided:** search uses a fixed snapshot, not live streaming updates.
  Capture completed source and build the index on the first nonempty query; keep that snapshot until search closes.
  Reopening search includes newly completed entries.
  Partial streaming output, renderer-generated notices, and extension-only display text are not searchable.
- **Decided:** keep historical components in a separate subtree before the normal live suffix.
  Rebuilding history resets its headings to collapsed rather than restoring expansion choices.
  Display-setting changes rebuild that subtree without replacing live components.
- **Decided:** keep the same component tree in fullscreen and regular mode, including old headings.
  Renderer switching retains that tree and does not replace in-flight tools.
  Do not change the exit-output setting; optional `fullscreenExitOutput: "transcript"` prints this shared view.
- **Conservative default:** clicking toggles one heading; the existing configurable expansion action also toggles historical headings.
  Explicit expand-all can incur the full-history rendering cost.
  Retain opened bodies after collapse until the historical subtree is rebuilt or the view is replaced.

This defers formatting and layout, not session-file parsing.
Do not change model context, session storage, tool execution, export, or extension renderer signatures.
No hybrid search, live search synchronization, expansion-state restoration, background workers, eviction, new settings, or dependencies.
Chunk loading, viewport virtualization, prepend compensation, and general reflow anchoring remain out of scope.

## Ownership and lifecycle

### Transcript construction

`SessionManager.getBranch()` supplies branch order and entry identity.
`buildContextEntries()` still controls model context and existing editor-history population, not the display cutoff.
Never follow a branch summary's `fromId` into a sibling branch.

The interactive transcript owns the historical subtree, lazy bodies, and entry/part-to-component bindings.
One entry can produce several display units; use entry plus local part identity, not tool call ID alone.
An assistant can produce content and several tool units; results complete their calls rather than adding separate bodies.
Pair calls/results chronologically across the cutoff, including parallel calls and reused IDs.
Historical pairing cannot clear or populate live `pendingTools`; only unmatched active calls enter live pending state.
Opening/searching history cannot execute tools, populate editor history, update the footer, or reconstruct the live suffix.

Reuse existing bulk message conversion, renderer fallbacks, summary/cost notices, and spacing in `interactive-mode.ts`.
Refactor only what is needed to construct historical bodies in their own destination with local pairing state.
Do not add a second streaming implementation or a general transcript framework.
Omit tool-only assistant headings unless there is separate visible content or a diagnostic.
Headings use bounded plain-text labels/previews, without Markdown, highlighting, full argument serialization, path resolution, or image conversion.
Keep existing OSC 133 prompt markers on appropriate headings so prompt navigation reaches old messages without opening them.

Preserve custom-entry visibility through `CustomEntryComponent.hasContent()`.
Because its renderer can return no component, call it once per historical rebuild to determine visibility.
This is the explicit lazy-construction exception: retain any returned component behind a heading without laying out the body.
Keep entries without a registered renderer and custom messages with `display: false` absent.
Do not add extension preview/visibility/search APIs.
On a body-construction error outside existing fallbacks, retain the heading, report the failure once, and leave the live suffix usable.

### Rebuilds and cleanup

On theme, thinking, image, preview, or padding changes, rebuild the historical subtree using current settings and closed headings.
Keep existing setting updates for live components; do not forward each setter into cached historical bodies.
Ordinary resize, invalidation, suspension, and renderer remount do not themselves rebuild history or restore saved UI state.
Keep reload's existing refusal during streaming or compaction.
Its idle document rebuild discards old renderer objects in both sections and reconstructs before `session_start` can append new entries.

Successful compaction rederives the cutoff and reconstructs the chronological view through both existing success event paths.
All historical headings start closed; each summary/cost appears once.
Preserve suppression of boundary entries later delivered by `entry_appended`.
Failed/cancelled compaction does not change the cutoff or rebuild history.
Session/branch replacement releases the old subtree and bindings through existing teardown.

Close active search before replacing its document or historical subtree, including settings, compaction, reload, or branch/session replacement.
Renderer stop/replacement and shutdown also release its snapshot, matches, excerpt, and bindings through existing overlay cleanup.
Use existing selection reset for document replacement; do not add selection/viewport anchoring through body expansion or historical reflow.

### Search boundary

TUI owns search input, literal matching, result navigation, scrolling, excerpts, and overlay focus.
The application supplies one completed-entry source snapshot and current message/tool anchor locations.
Configured transcript search uses that source exclusively; unconfigured TUI consumers retain existing rendered-row search.
Keep `Component.render(width)` and general layout unchanged; export and document any new public TUI types.
Internal application helpers can change with their callers; persisted entries and independently installed extensions need no migration.

Source includes original message text/thinking, tool names and argument values, textual results, summaries, and displayed custom-message content.
Use raw string arguments, including write contents and edit replacements, rather than JSON-escaped copies.
Exclude binary/image data, opaque extension `details`/`data`, transport metadata, unseen full-output files, and generated display-only text.
Match within textual fragments, not across unrelated message, argument, or result boundaries.
Use the selected branch's completed entries, including in-memory sessions; do not require a disk flush or index partial component output.
`AgentSession` publishes `message_end` before persistence, so do not assume a persisted entry ID exists in that callback.
Record completed message/component associations through normal UI handling and reconcile them to branch entries when preparing the snapshot.
Do not replace existing live components merely to obtain search anchors.

Reuse literal, case-insensitive Unicode matching and query-whitespace handling from `alt-screen-search.ts`.
Store source references and UTF-16 hit offsets, not terminal-cell spans for source text.
Identify occurrences by unit/fragment and offsets; count every occurrence even when several navigate to one component.
Resolve current component starts after layout at its actual content width, including resources, notices, and spacers.
`layout.ts` does not expose ordinary `Container` descendants individually; reuse measured child heights via a narrow read-only capability if needed.
Do not render hidden bodies, run a second layout pass, or infer rows from entry indices.
Resize/expansion changes anchor positions, not the source snapshot or selected occurrence.
Build only the selected excerpt, sanitize terminal controls, and clip by terminal columns.
Keep existing search keys, counts, mouse controls, and focus restoration; no inline source-to-rendered-body highlights are required.
No asynchronous indexing or cancellation protocol is needed.

## Implementation steps and logical commits

These are proposed boundaries, not authorization to commit.
Tests and documentation land with their behavior.

### 1. Support snapshot-source fullscreen search

Suggested subject: `Support snapshot-source fullscreen transcript search`.

Files: `packages/tui/src/alt-screen-search.ts`, `tui-alt-screen.ts`, `components/scroll-view.ts`, and `index.ts`.
Change `tui.ts` only if a measured child-row lookup is necessary.
Add the optional complete-source search path, occurrence identity, current-anchor resolution, and selected excerpt described above.
Do not add per-component search protocols, rendered/source aggregation, or widen ordinary `TUI`/`ViewportTUI` interfaces.
Remove the overlay's hardcoded navigation-button row assumption if the excerpt changes its height.

Extend `packages/tui/test/tui-alt-screen.test.ts` with synthetic snapshots, real layout, and `VirtualTerminal`.
Document the optional source capability in `packages/tui/README.md`.
This commit independently passes focused TUI tests and `npm run check` without activating application behavior.

### 2. Display lazy history and bind completed-entry search

Suggested subject: `Show lazy pre-compaction history with snapshot search`.

Add the historical subtree and heading component under `packages/coding-agent/src/modes/interactive/`.
Integrate initial/resumed rendering, source/anchor bindings, historical-only settings rebuilds, compaction, reload, and view replacement in `interactive-mode.ts`.
Bind search through the existing transcript `ScrollView` in `chat-viewport.ts` or its interactive owner.
Keep live streaming/tool execution on existing paths and preserve the shared tree across renderer switches.

Add `packages/coding-agent/test/interactive-mode-history.test.ts` and extend existing compaction, tool-preview, tree-navigation, and interactive-TUI tests.
Document cutoff, expansion resets, snapshot refresh, search exclusions, first-search cost, and regular/exit behavior in `packages/coding-agent/docs/usage.md`.
Update `docs/tui.md` only for extension-facing consequences and changelogs only under repository branch policy.
This commit passes the assembled acceptance cases and repository check.

## Acceptance and verification

Use finite constructed branches, `SessionManager.inMemory()`, existing renderers, and `VirtualTerminal`.
Use `test/suite/harness.ts` and the faux provider only if AgentSession integration is needed; no real provider calls or user-state writes.

| Area | Required observation |
| --- | --- |
| Membership | No/repeated compactions, retained tails, multi-part entries, and sibling branches produce correct chronology without omissions or duplicates |
| Laziness | Old message/tool/summary bodies neither construct nor render initially or during search; headings and failure indicators do; custom visibility is the stated exception |
| Opening | Click/global expansion work; collapse/reopen reuses a body; opened bodies preserve normal syntax colors, images, fallbacks, and prompt navigation |
| Settings and reload | Settings reset old headings closed and reopened bodies use current settings without replacing live tools; idle reload uses new renderers in both sections before fresh `session_start` entries |
| Tools | Parallel/reused IDs and call/result pairs crossing the cutoff attach correctly; historical construction, expansion, and search never steal live results |
| Source semantics | Original Markdown/URLs, write/edit contents, thinking, Unicode, whitespace, and repeated occurrences match; fragment boundaries, binary/opaque data, and generated notices do not |
| Snapshot | Empty search builds no index; partial assistant/tool output is absent; completions after capture appear only after reopening; message-end/persistence ordering and in-memory sessions work |
| Navigation | Current and historical hits reach their component starts; repeated hits share anchors without merging; preceding expansion, resize, resources, and notices do not stale targets or open bodies |
| Overlay and cleanup | Narrow widths, terminal controls, mouse buttons, counts, query changes, close/reopen, focus restoration, same-root replacement, and shutdown leave no stale snapshot or hit |
| Compaction and views | Both success paths render one boundary/summary/cost; failure/cancellation leaves history intact; session/tree changes release old state; renderer switching retains the tree and exit policy |
| Unconfigured TUI | Existing rendered-row search, highlights, controls, and selection remain unchanged without the optional source capability |

Run changed/new tests through `test.sh -- ...` from their package directories, following `CONTRIBUTING.md#focused-tests`.
After code implementation, run `npm run check` with full output; no build, `npm test`, or full Vitest suite unless requested.
Follow `.pi/skills/interactive-testing.md` for a disposable compacted-session smoke test without provider calls.

Repeat the three pinned-branch benchmarks through production initialization, not direct eager `renderSessionEntries(allEntries)` calls.
Measure construction, first layout, resize, first/repeated query, reopen-search refresh, one-body expansion, settings rebuild, and retained memory separately.
Compare current-context-only, eager full history, and the implemented view; retain runners/results under `.artifacts/scrollback-perf/`.
The 0.60–0.66 s prototype in `.artifacts/scrollback-perf/inquiry/summary-v4.json` does not establish performance of the final implementation.
Report deferred search/expansion work and the custom-renderer exception, not a guaranteed startup speedup.
