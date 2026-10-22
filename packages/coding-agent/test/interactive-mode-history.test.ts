import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AltScreenSearchSource,
	type Component,
	Container,
	Input,
	resetCapabilitiesCache,
	ScrollView,
	setCapabilities,
	Text,
	type TUI,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { EntryRenderer, MessageRenderer } from "../src/core/extensions/types.ts";
import { createCustomMessage } from "../src/core/messages.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { HistoricalEntryComponent } from "../src/modes/interactive/components/historical-entry.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { collectTranscriptUnits, type TranscriptUnit } from "../src/modes/interactive/transcript-history.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

interface HistoryHarness {
	renderInitialMessages(): void;
	renderSessionEntries(entries: SessionEntry[], options?: { updateFooter?: boolean }): void;
	rebuildTranscript(): void;
	rebuildHistoricalPrefix(): void;
	createHistoricalBody(unit: TranscriptUnit): Component;
	createTranscriptSearchSource(): AltScreenSearchSource;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	setToolsExpanded(expanded: boolean): void;
	applyOutputPadY(padding: 0 | 1): void;
	updateThinkingBlockVisibility(): void;
	handleReloadCommand(): Promise<void>;
	historicalContainer: Container;
	historicalUnits: TranscriptUnit[];
	chatContainer: Container;
	documentContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	transcriptBindings: Map<string, Component>;
	settingsManager: SettingsManager;
	streamingComponent: Component | undefined;
	streamingMessage: AssistantMessage | undefined;
	editor: { addToHistory: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

/** The production initialization path with in-memory branch membership, renderers, and layout. */
function createHistory(sessionManager = SessionManager.inMemory(), entryRenderers = new Map<string, EntryRenderer>()) {
	const settingsManager = SettingsManager.inMemory({ showCacheMissNotices: false });
	const chatContainer = new Container();
	const documentContainer = new Container();
	documentContainer.addChild(new Text("resources\nabove chat", 0, 0));
	documentContainer.addChild(chatContainer);
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session: {
				sessionManager,
				settingsManager,
				modelRuntime: {},
				state: { messages: [] },
				retryAttempt: 0,
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
				extensionRunner: {
					getEntryRenderer: (name: string) => entryRenderers.get(name),
					getMessageRenderer: () => undefined,
					getMarkdownTransformers: () => [],
					resolveToolRenderers: (_name: string, fallback: () => unknown) => fallback(),
				},
				getToolDefinition: () => undefined,
			},
		},
		chatContainer,
		documentContainer,
		historicalContainer: new Container(),
		historicalUnits: [],
		transcriptBindings: new Map(),
		completedMessageBindings: new WeakMap<AgentMessage, Map<string, Component>>(),
		completedCustomBindings: [],
		completedToolOwners: new Map(),
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		entriesRenderedByBoundaryCompaction: new Set(),
		loadedResourcesContainer: new Container(),
		pendingMessagesContainer: new Container(),
		renderWidgets: vi.fn(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 0,
		outputPadY: 0,
		mermaidMarkdownTransformer: { transform: (text: string) => text },
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		editor: { addToHistory: vi.fn() },
		ui: { requestRender: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		renderProjectTrustWarningIfNeeded: vi.fn(),
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: (name: string) => withBuiltInRenderers(name, undefined),
		clearStatusIndicator: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
	}) as HistoryHarness;
	return {
		host,
		sessionManager,
		text: () => stripAnsi(documentContainer.render(100).join("\n")),
		headings: () => host.historicalContainer.children as HistoricalEntryComponent[],
	};
}

function tool(id: string, needle: string): AssistantMessage {
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall", name: "write", id, arguments: { path: "file.txt", content: needle } }],
		stopReason: "toolUse",
	};
}

beforeEach(() => initTheme("dark"));

describe("lazy historical transcript", () => {
	it.each([
		["empty complete", "empty", "stop", false],
		["empty truncated", "empty", "length", true],
		["tool-only complete", "tool", "toolUse", false],
		["tool-only truncated", "tool", "length", true],
		["text complete", "text", "stop", true],
		["text truncated", "text", "length", true],
	] as const)("preserves normal assistant visibility: %s", (_label, content, stopReason, visible) => {
		const { host, sessionManager, headings, text } = createHistory();
		const first = sessionManager.appendMessage(userMsg("historical prompt"));
		const message: AssistantMessage = {
			...(content === "tool"
				? tool("truncated-call", "tool arguments")
				: assistantMsg(content === "text" ? "reply" : "")),
			stopReason,
		};
		sessionManager.appendMessage(message);
		sessionManager.appendCompaction("summary", first, 1);
		host.renderInitialMessages();
		const messages = host.historicalUnits.filter(
			(unit) => unit.kind === "message" && unit.message.role === "assistant",
		);
		expect(messages).toHaveLength(visible ? 1 : 0);
		if (visible) {
			const normal = stripAnsi(
				new AssistantMessageComponent(message, false, undefined, undefined, 0, [], 0).render(100).join("\n"),
			).trim();
			expect(normal).not.toBe("");
			for (const heading of headings()) heading.setExpanded(true);
			expect(text()).toContain(normal);
		}
	});

	it.each([
		[
			"bold opening line",
			["**Evaluating local resources**\n\nMore reasoning."],
			undefined,
			"Evaluating local resources",
		],
		["plain opening line", ["Evaluating local resources\nMore reasoning."], undefined, "Evaluating local resources"],
		[
			"leading blank lines",
			["\n \n **Evaluating local resources**\r\nMore reasoning."],
			undefined,
			"Evaluating local resources",
		],
		["blank thinking block", [" \n", "**Evaluating local resources**"], undefined, "Evaluating local resources"],
		["blank text block", ["**Evaluating local resources**"], [" \n"], "Evaluating local resources"],
		["visible text wins", ["**Evaluating local resources**"], ["Visible response"], "Visible response"],
		[
			"blank blocks before visible text",
			["**Reasoning title**"],
			["", " \n", "Visible response"],
			"Visible response",
		],
		["multiple bold spans", ["**First** and **second**\nMore reasoning"], undefined, "**First** and **second**"],
		["asterisk inside a bold title", ["**2 * 3**\nMore reasoning"], undefined, "2 * 3"],
		["bounded opening line", ["x".repeat(10000)], undefined, "x".repeat(120)],
		["bounded leading whitespace", [`${"\n".repeat(200)}Later reasoning`], undefined, ""],
		[
			"large reasoning body",
			[`**Evaluating local resources**\n${"More reasoning. ".repeat(10000)}`],
			undefined,
			"Evaluating local resources",
		],
	] as const)("previews thinking-only entries without constructing bodies: %s", (_name, thinking, text, preview) => {
		const { host, sessionManager, headings } = createHistory();
		const content: AssistantMessage["content"] = thinking.map((value) => ({ type: "thinking", thinking: value }));
		for (const value of text ?? []) content.push({ type: "text", text: value });
		const first = sessionManager.appendMessage({ ...assistantMsg(""), content });
		sessionManager.appendCompaction("summary", first, 1);
		const construct = vi.spyOn(host, "createHistoricalBody");
		host.renderInitialMessages();
		const lines = headings()[0].render(200);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]).trimEnd()).toBe(` ▸ Assistant${preview ? `: ${preview}` : ""}`);
		expect(construct).not.toHaveBeenCalled();
	});

	it.each(["dark", "light"])("keeps normal component colors on closed headings with the %s theme", async (name) => {
		initTheme(name);
		const { host, sessionManager, headings } = createHistory();
		const first = sessionManager.appendMessage(userMsg("user text"));
		sessionManager.appendMessage(assistantMsg("assistant text"));
		sessionManager.appendMessage({
			...assistantMsg(""),
			content: [{ type: "thinking", thinking: "thinking text" }],
		});
		for (const [id, isError] of [
			["success", false],
			["error", true],
		] as const) {
			sessionManager.appendMessage(tool(id, "tool text"));
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "write",
				content: [{ type: "text", text: "tool result" }],
				isError,
				timestamp: Date.now(),
			});
		}
		sessionManager.appendMessage(tool("pending", "pending text"));
		for (const excludeFromContext of [false, true]) {
			sessionManager.appendMessage({
				role: "bashExecution",
				command: "echo text",
				output: "text",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext,
				timestamp: Date.now(),
			});
		}
		sessionManager.appendCustomMessageEntry("notice", "custom text", true);
		sessionManager.appendCompaction("earlier summary", first, 1);
		host.renderSessionEntries(sessionManager.getBranch());
		const units = collectTranscriptUnits(sessionManager.getBranch());
		const normal = units.map((unit) => host.transcriptBindings.get(unit.id)!);
		expect(normal.every(Boolean)).toBe(true);
		sessionManager.appendCompaction("latest summary", first, 1);
		host.rebuildTranscript();
		expect(headings()).toHaveLength(normal.length);
		const construct = vi.spyOn(host, "createHistoricalBody");
		const colors = async (lines: string[]) => {
			const terminal = new xterm.Terminal({ cols: 80, rows: 40, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
				const buffer = terminal.buffer.active;
				for (let row = 0; row < 40; row++) {
					const line = buffer.getLine(buffer.viewportY + row);
					if (!line) continue;
					for (let col = 0; col < 80; col++) {
						const cell = line.getCell(col);
						if (!cell?.getChars().trim()) continue;
						return {
							fg: [cell.getFgColorMode(), cell.getFgColor(), cell.isDim()],
							bg: [cell.getBgColorMode(), cell.getBgColor()],
						};
					}
				}
				throw new Error("No visible component text");
			} finally {
				terminal.dispose();
			}
		};
		for (const width of [80, 12]) {
			for (const [index, heading] of headings().entries()) {
				const lines = heading.render(width);
				expect(lines).toHaveLength(1);
				expect(stripAnsi(lines[0])).toContain("▸");
				const expected = await colors(normal[index].render(width));
				const actual = await colors(lines);
				expect(actual.bg, units[index].label).toEqual(expected.bg);
				if (!units[index].failed) expect(actual.fg, units[index].label).toEqual(expected.fg);
			}
		}
		expect(construct).not.toHaveBeenCalled();
	});

	it("reuses heading formatting until resize, expansion, or invalidation without constructing closed bodies", () => {
		const body = vi.fn(() => new Text("opened body", 0, 0));
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("long heading label"));
		const heading = new HistoricalEntryComponent(
			collectTranscriptUnits(session.getBranch())[0],
			body,
			vi.fn(),
			vi.fn(),
		);
		const label = heading.children[0];
		const original = label.render(80);
		expect(label.render(80)).toBe(original);
		expect(body).not.toHaveBeenCalled();
		const narrow = label.render(9);
		expect(stripAnsi(narrow.join("\n"))).not.toContain("long heading label");
		expect(label.render(9)).toBe(narrow);
		heading.invalidate();
		expect(label.render(9)).not.toBe(narrow);
		expect(body).not.toHaveBeenCalled();
		heading.setExpanded(true);
		expect(stripAnsi(heading.render(80).join("\n"))).toContain("▾ You: long heading label");
		expect(body).toHaveBeenCalledOnce();
	});

	it("keeps a native search snapshot fixed through completions and closes it before a prefix rebuild", async () => {
		const { host, sessionManager, headings } = createHistory();
		const first = sessionManager.appendMessage(userMsg("needle original"));
		sessionManager.appendCompaction("summary", first, 1);
		host.renderInitialMessages();
		const terminal = new VirtualTerminal(80, 12);
		const renderer = new TuiAltScreen(terminal);
		const scroll = new ScrollView(host.documentContainer, { primary: true });
		const source = host.createTranscriptSearchSource();
		const snapshot = vi.spyOn(source, "snapshot");
		scroll.searchSource = source;
		const editor = new Input();
		renderer.setLayoutRoot(
			new VStack([
				{ component: scroll, grow: 1, basis: 0 },
				{ component: editor, basis: 1 },
			]),
		);
		renderer.setFocus(editor);
		Object.assign(host, { renderer, ui: renderer });
		renderer.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			await terminal.waitForRender();
			expect(snapshot).not.toHaveBeenCalled();
			terminal.sendInput("needle");
			await terminal.waitForRender();
			expect(snapshot).toHaveBeenCalledOnce();
			expect(terminal.getViewport().join("\n")).toContain("1/1");
			const completed = assistantMsg("needle new completion");
			await host.handleEvent({ type: "message_start", message: completed });
			await host.handleEvent({ type: "message_end", message: completed });
			sessionManager.appendMessage(completed);
			renderer.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("1/1");
			expect(snapshot).toHaveBeenCalledOnce();
			expect(stripAnsi(headings()[0].render(80).join("\n"))).toContain("▸");
			renderer.closeSearch();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			expect(snapshot).toHaveBeenCalledTimes(2);
			expect(terminal.getViewport().join("\n")).toMatch(/[12]\/2/);
			host.rebuildHistoricalPrefix();
			expect(editor.focused).toBe(true);
			expect(renderer.hasOverlayEntries).toBe(false);
		} finally {
			renderer.stop();
		}
	});

	it("opens normal ANSI-colored Markdown and renderer fallbacks without losing native prompt navigation", async () => {
		const { host, sessionManager, headings } = createHistory();
		const session = Reflect.get(Reflect.get(host, "runtimeHost"), "session") as {
			extensionRunner: { getMessageRenderer(name: string): MessageRenderer | undefined };
		};
		session.extensionRunner.getMessageRenderer = (name) => {
			if (name === "absent") return undefined;
			return () => {
				if (name === "throwing") throw new Error("renderer failed");
				return undefined;
			};
		};
		const first = sessionManager.appendMessage(userMsg("historical first prompt"));
		sessionManager.appendMessage(assistantMsg("```typescript\nconst answer: number = 42;\n```"));
		for (const name of ["absent", "undefined", "throwing"]) {
			sessionManager.appendCustomMessageEntry(name, `fallback **${name}** body`, true);
		}
		sessionManager.appendMessage(userMsg("historical last prompt"));
		sessionManager.appendMessage(assistantMsg(Array.from({ length: 20 }, (_, i) => `tail reply ${i}`).join("\n")));
		host.renderSessionEntries(sessionManager.getBranch(), { updateFooter: false });
		const expected = collectTranscriptUnits(sessionManager.getBranch()).map((unit) => {
			const component = host.transcriptBindings.get(unit.id);
			expect(component).toBeDefined();
			return [...component!.render(80)];
		});
		expect(expected[1].join("\n")).not.toBe(stripAnsi(expected[1].join("\n")));
		sessionManager.appendCompaction("summary", first, 1);
		host.rebuildTranscript();
		for (const [index, heading] of headings().entries()) {
			heading.setExpanded(true);
			expect(heading.children[1].render(80)).toEqual(expected[index]);
		}

		const terminal = new VirtualTerminal(80, 10);
		const renderer = new TuiAltScreen(terminal);
		const scroll = new ScrollView(host.documentContainer, { primary: true, follow: "end", scrollbar: "hidden" });
		const editor = new Input();
		renderer.setLayoutRoot(
			new VStack([
				{ component: scroll, grow: 1, basis: 0 },
				{ component: editor, basis: 1 },
			]),
		);
		renderer.setFocus(editor);
		Object.assign(host, { renderer, ui: renderer });
		renderer.start();
		try {
			await terminal.waitForRender();
			const bottom = scroll.scrollTop;
			expect(bottom).toBeGreaterThan(0);
			terminal.sendInput("\x1b[1;6A");
			await terminal.waitForRender();
			expect(scroll.scrollTop).toBeLessThan(bottom);
			expect(terminal.getViewport()[0]).toContain("▾ Assistant: tail reply 0");
			const previous = scroll.scrollTop;
			terminal.sendInput("\x1b[1;6A");
			await terminal.waitForRender();
			expect(scroll.scrollTop).toBeLessThan(previous);
			expect(terminal.getViewport()[0]).toContain("▾ You: historical last prompt");
			terminal.sendInput("\x1b[1;6B");
			await terminal.waitForRender();
			expect(scroll.scrollTop).toBe(previous);
			terminal.sendInput("\x1b[1;5F");
			await terminal.waitForRender();
			expect(scroll.scrollTop).toBe(bottom);
			expect(terminal.getViewport().join("\n")).toContain("tail reply 19");
		} finally {
			renderer.stop({ preserveScreen: true });
		}
	});

	it("opens tool images with normal graphics and honors disabled-image settings on a prefix rebuild", () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const { host, sessionManager, headings } = createHistory();
			host.settingsManager.setShowImages(true);
			const first = sessionManager.appendMessage({
				...assistantMsg(""),
				content: [{ type: "toolCall", id: "image", name: "fixture", arguments: {} }],
				stopReason: "toolUse",
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "image",
				toolName: "fixture",
				content: [{ type: "image", data: png, mimeType: "image/png" }],
				isError: false,
				timestamp: 0,
			});
			host.renderSessionEntries(sessionManager.getBranch(), { updateFooter: false });
			const normal = host.chatContainer.children.find((child) => child instanceof ToolExecutionComponent)!;
			const widths = [80, 30];
			const expected = widths.map((width) => [...normal.render(width)]);
			expect(expected[0].join("\n")).toContain("\x1b]1337;File=");
			expect(expected[0].join("\n")).toContain(png);
			sessionManager.appendCompaction("summary", first, 1);
			host.rebuildTranscript();
			headings()[0].setExpanded(true);
			for (const [index, width] of widths.entries()) {
				expect(headings()[0].children[1].render(width)).toEqual(expected[index]);
			}
			host.settingsManager.setShowImages(false);
			host.rebuildHistoricalPrefix();
			headings()[0].setExpanded(true);
			const hidden = headings()[0].children[1].render(80).join("\n");
			expect(hidden).not.toContain("\x1b]1337;File=");
			expect(hidden).not.toContain(png);
			expect(stripAnsi(hidden)).toContain("fixture");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("keeps uncompacted messages in the normal view and global expansion opens old headings", () => {
		const { host, sessionManager, headings, text } = createHistory();
		const first = sessionManager.appendMessage(userMsg("normal prompt"));
		Object.assign(host, { outputPadY: 1 });
		host.renderSessionEntries(sessionManager.getBranch(), { updateFooter: false });
		const normal = host.chatContainer.render(100);
		host.renderInitialMessages();
		expect(host.chatContainer.render(100)).toEqual(normal);
		expect(headings()).toHaveLength(0);
		expect(text()).not.toContain("▸");
		sessionManager.appendCompaction("summary", first, 1);
		host.rebuildTranscript();
		expect(text()).toContain("▸ You: normal prompt");
		host.setToolsExpanded(true);
		expect(text()).toContain("▾ You: normal prompt");
		expect(text().match(/normal prompt/g)).toHaveLength(2);
	});

	it.each(["manual", "boundary"] as const)(
		"rebuilds on %s compaction with one chronological summary/cost and suppresses boundary append duplicates",
		async (path) => {
			const { host, sessionManager, headings, text } = createHistory();
			host.settingsManager.setShowCacheMissNotices(true);
			const first = sessionManager.appendMessage(userMsg("before compaction"));
			host.renderInitialMessages();
			const usage = {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const compactionId = sessionManager.appendCompaction("completed summary", first, 100, undefined, false, usage);
			if (path === "manual") {
				await host.handleEvent({
					type: "compaction_end",
					reason: "manual",
					result: { summary: "completed summary", firstKeptEntryId: first, tokensBefore: 100, usage },
					aborted: false,
					willRetry: false,
				});
			} else {
				sessionManager.appendCustomMessageEntry("after", "boundary custom message", true);
				const branch = sessionManager.getBranch();
				await host.handleEvent({
					type: "entry_appended",
					entry: branch.find((entry) => entry.id === compactionId)!,
				});
				await host.handleEvent({ type: "entry_appended", entry: branch[branch.length - 1] });
				expect(text().match(/boundary custom message/g)).toHaveLength(1);
			}
			expect(headings()).toHaveLength(1);
			host.setToolsExpanded(true);
			const output = text();
			expect(output.match(/completed summary/g)).toHaveLength(1);
			expect(output.match(/Compaction: 30 tokens billed/g)).toHaveLength(1);
			expect(output.indexOf("before compaction")).toBeLessThan(output.indexOf("completed summary"));
		},
	);

	it.each(["cancelled", "failed"] as const)(
		"does not rebuild historical bodies after %s compaction",
		async (state) => {
			const { host, sessionManager, headings, text } = createHistory();
			const first = sessionManager.appendMessage(userMsg("old body"));
			sessionManager.appendCompaction("existing summary", first, 1);
			host.renderInitialMessages();
			headings()[0].setExpanded(true);
			const heading = headings()[0];
			await host.handleEvent({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: state === "cancelled",
				errorMessage: state === "failed" ? "failure" : undefined,
				willRetry: false,
			});
			expect(headings()[0]).toBe(heading);
			expect(text()).toContain("▾ You: old body");
		},
	);

	it("shows the selected whole branch once, while editor history stays in current context", () => {
		const { host, sessionManager, text, headings } = createHistory();
		sessionManager.appendMessage(userMsg("old prompt"));
		const kept = sessionManager.appendMessage(userMsg("retained prompt"));
		sessionManager.appendCompaction("first summary", kept, 100);
		sessionManager.appendMessage(assistantMsg("middle answer"));
		sessionManager.appendCompaction("latest summary", kept, 200);
		sessionManager.appendMessage(userMsg("new prompt"));
		host.renderInitialMessages();
		expect(text()).toContain("You: old prompt");
		expect(text().match(/retained prompt/g)).toHaveLength(1);
		expect(text()).not.toContain("latest summary"); // Normal summary starts collapsed.
		expect(headings()).toHaveLength(4);
		expect(host.editor.addToHistory.mock.calls.flat()).toEqual(["retained prompt", "new prompt"]);
		const snapshot = host.createTranscriptSearchSource().snapshot();
		expect(snapshot.flatMap((unit) => unit.fragments)).toContain("latest summary");
		expect(snapshot.flatMap((unit) => unit.fragments)).toContain("first summary");
	});

	it("routes a heading click through normal container dispatch and reports body failure only once", () => {
		const { host, sessionManager, headings, text } = createHistory();
		const first = sessionManager.appendMessage(userMsg("old prompt"));
		sessionManager.appendCompaction("summary", first, 1);
		const construct = vi
			.spyOn(host as unknown as { createHistoricalBody(unit: TranscriptUnit): Component }, "createHistoricalBody")
			.mockImplementation(() => {
				throw new Error("fixture body failed");
			});
		host.renderInitialMessages();
		text(); // Normal layout measures the clickable heading.
		const heading = headings()[0];
		expect(
			heading.handleMouse({
				type: "click",
				button: "left",
				x: 0,
				y: 0,
				screenX: 0,
				screenY: 0,
				width: 100,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
			})?.handled,
		).toBe(true);
		expect(construct).toHaveBeenCalledOnce();
		expect(text()).toContain("fixture body failed");
		heading.setExpanded(false);
		heading.setExpanded(true);
		expect(construct).toHaveBeenCalledOnce();
		expect(text().match(/fixture body failed/g)).toHaveLength(1);
	});

	it("does not construct old message/tool bodies on layout or search, and caches opened bodies", () => {
		const { host, sessionManager, text, headings } = createHistory();
		const old = sessionManager.appendMessage(userMsg("**original markdown**"));
		sessionManager.appendMessage(tool("write-1", "write body\nreal newline"));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			content: [{ type: "text", text: "result body" }],
			isError: true,
			timestamp: 0,
		});
		sessionManager.appendCompaction("summary", old, 100);
		const construct = vi.spyOn(
			host as unknown as { createHistoricalBody(unit: TranscriptUnit): Component },
			"createHistoricalBody",
		);
		host.renderInitialMessages();
		text();
		const source = host.createTranscriptSearchSource();
		expect(source.snapshot().flatMap((unit) => unit.fragments)).toContain("write body\nreal newline");
		expect(construct).not.toHaveBeenCalled();
		expect(text()).toContain("[failed/aborted] write");
		headings()[1].setExpanded(true);
		text();
		expect(construct).toHaveBeenCalledOnce();
		expect(text()).toContain("result body");
		headings()[1].setExpanded(false);
		headings()[1].setExpanded(true);
		expect(construct).toHaveBeenCalledOnce();
		host.historicalContainer.invalidate();
		expect(construct).toHaveBeenCalledOnce();
		host.rebuildHistoricalPrefix();
		expect(text()).not.toContain("result body");
		headings()[1].setExpanded(true);
		expect(construct).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			"branch summary",
			() =>
				new BranchSummaryMessageComponent(
					{ role: "branchSummary", summary: "branch text", fromId: null, timestamp: 0 },
					undefined,
					1,
					0,
				),
		],
		[
			"compaction summary",
			() =>
				new CompactionSummaryMessageComponent(
					{ role: "compactionSummary", summary: "compaction text", tokensBefore: 1, timestamp: 0 },
					undefined,
					1,
					0,
				),
		],
		[
			"custom entry",
			() =>
				new CustomEntryComponent(
					{
						type: "custom",
						customType: "fixture",
						id: "custom",
						parentId: null,
						timestamp: new Date(0).toISOString(),
					},
					() => new Text("custom text", 0, 0),
					1,
					0,
				),
		],
		[
			"generic tool",
			() => {
				const { host } = createHistory();
				const component = new ToolExecutionComponent(
					"fixture",
					"id",
					{},
					{ outputPadY: 0 },
					undefined,
					host.ui as unknown as TUI,
					"/fixture",
				);
				component.updateResult({ content: [{ type: "text", text: "result text" }], isError: false });
				return component;
			},
		],
		[
			"bash output",
			() => {
				const { host } = createHistory();
				const component = new BashExecutionComponent("not executed", host.ui as unknown as TUI, false, 1, 0);
				component.appendOutput("bash text");
				component.setComplete(0, false);
				return component;
			},
		],
	] satisfies Array<[string, () => Component & { setOutputPadY(padding: 0 | 1): void }]>)(
		"updates %s vertical padding in place without losing content",
		(_name, create) => {
			const component = create();
			const original = component.render(100);
			component.setOutputPadY(1);
			expect(component.render(100).length).toBeGreaterThan(original.length);
			component.setOutputPadY(0);
			expect(component.render(100)).toEqual(original);
		},
	);

	it("resets old headings on thinking/padding changes while preserving live tool identity and result ownership", async () => {
		const { host, sessionManager, headings, text } = createHistory();
		const old = sessionManager.appendMessage(tool("old", "historical body"));
		sessionManager.appendCompaction("summary", old, 1);
		// Generic tools show successful result text; write intentionally hides it.
		sessionManager.appendMessage({
			...assistantMsg(""),
			content: [{ type: "toolCall", id: "live", name: "fixture", arguments: { query: "live body" } }],
			stopReason: "toolUse",
		});
		host.renderInitialMessages();
		headings()[0].setExpanded(true);
		const live = host.pendingTools.get("live")!;
		const initialHeight = live.render(100).length;
		host.applyOutputPadY(1);
		expect(text()).toContain("▸ write");
		expect(host.pendingTools.get("live")).toBe(live);
		expect(host.chatContainer.children).toContain(live);
		expect(live.render(100).length).toBeGreaterThan(initialHeight);
		headings()[0].setExpanded(true);
		Object.assign(host, { hideThinkingBlock: true });
		host.updateThinkingBlockVisibility();
		expect(text()).toContain("▸ write");
		expect(host.pendingTools.get("live")).toBe(live);
		host.applyOutputPadY(0);
		expect(live.render(100)).toHaveLength(initialHeight);
		await host.handleEvent({
			type: "tool_execution_end",
			toolCallId: "live",
			toolName: "fixture",
			result: { content: [{ type: "text", text: "live completed result" }] },
			isError: false,
		});
		expect(host.pendingTools.has("live")).toBe(false);
		expect(host.chatContainer.children).toContain(live);
		expect(text()).toContain("live completed result");
	});

	it("pairs parallel/reused calls across the cutoff without stealing live pending tools", () => {
		const { host, sessionManager, headings } = createHistory();
		const parallel = tool("same-id", "first");
		parallel.content.push({
			type: "toolCall",
			name: "edit",
			id: "parallel",
			arguments: { path: "notes.md", oldText: "old\nraw text", newText: "new\nraw text" },
		});
		const old = sessionManager.appendMessage(parallel);
		sessionManager.appendCompaction("summary", old, 1);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "parallel",
			toolName: "edit",
			content: [{ type: "text", text: "parallel result" }],
			isError: false,
			timestamp: 0,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "same-id",
			toolName: "write",
			content: [{ type: "text", text: "first result" }],
			isError: false,
			timestamp: 0,
		});
		sessionManager.appendMessage(tool("same-id", "second"));
		host.renderInitialMessages();
		const live = host.pendingTools.get("same-id");
		expect(live).toBeInstanceOf(ToolExecutionComponent);
		headings()[0].setExpanded(true);
		expect(host.pendingTools.get("same-id")).toBe(live);
		const toolUnits = host
			.createTranscriptSearchSource()
			.snapshot()
			.filter((unit) => unit.id.includes(":tool:"));
		expect(toolUnits).toHaveLength(3);
		expect(toolUnits[0].fragments).toContain("first result");
		expect(toolUnits[1].fragments).toEqual(["edit", "notes.md", "old\nraw text", "new\nraw text", "parallel result"]);
		expect(toolUnits[2].fragments).not.toContain("first result");
		host.rebuildHistoricalPrefix();
		expect(host.pendingTools.get("same-id")).toBe(live);
		expect(host.chatContainer.children).toContain(live);
	});

	it("preserves custom renderer visibility without laying out hidden bodies", () => {
		const bodyRender = vi.fn(() => ["custom rendered-only text"]);
		const visible = vi.fn(() => ({ render: bodyRender, invalidate: () => {} }));
		const hidden = vi.fn(() => undefined);
		const { host, sessionManager, text, headings } = createHistory(
			undefined,
			new Map<string, EntryRenderer>([
				["visible", visible],
				["hidden", hidden],
			]),
		);
		const first = sessionManager.appendCustomEntry("visible", { secret: "opaque" });
		sessionManager.appendCustomEntry("hidden");
		sessionManager.appendCustomEntry("missing");
		sessionManager.appendCustomMessageEntry("hidden-message", "invisible content", false);
		sessionManager.appendCompaction("summary", first, 1);
		host.renderInitialMessages();
		text();
		expect(visible).toHaveBeenCalledOnce();
		expect(hidden).toHaveBeenCalledOnce();
		expect(bodyRender).not.toHaveBeenCalled();
		expect(headings()).toHaveLength(1);
		expect(
			host
				.createTranscriptSearchSource()
				.snapshot()
				.flatMap((unit) => unit.fragments),
		).not.toContain("opaque");
		host.setToolsExpanded(true);
		expect(text()).toContain("custom rendered-only text");
		expect(visible).toHaveBeenCalledOnce();
		host.documentContainer.invalidate();
		expect(text()).toContain("custom rendered-only text");
		headings()[0].setExpanded(false);
		headings()[0].setExpanded(true);
		expect(visible).toHaveBeenCalledOnce();

		host.rebuildHistoricalPrefix();
		expect(visible).toHaveBeenCalledTimes(2);
		expect(hidden).toHaveBeenCalledTimes(2);
		expect(visible).toHaveBeenLastCalledWith(expect.anything(), { expanded: true, outputPadY: 0 }, expect.anything());
		headings()[0].setExpanded(true);
		host.documentContainer.invalidate();
		expect(text()).toContain("custom rendered-only text");
		expect(visible).toHaveBeenCalledTimes(2);
	});

	it("idle reload discards old renderers in both sections before session_start appends fresh entries", async () => {
		const { host, sessionManager, headings, text } = createHistory();
		const first = sessionManager.appendCustomMessageEntry("fixture", "historical original", true);
		sessionManager.appendCompaction("summary", first, 1);
		sessionManager.appendCustomMessageEntry("fixture", "current original", true);
		let renderer: MessageRenderer = () => new Text("old renderer", 0, 0);
		const session = Reflect.get(Reflect.get(host, "runtimeHost"), "session") as {
			extensionRunner: { getMessageRenderer(): MessageRenderer };
			modelRuntime: object;
		};
		session.extensionRunner.getMessageRenderer = () => renderer;
		host.renderInitialMessages();
		headings()[0].setExpanded(true);
		expect(text().match(/old renderer/g)).toHaveLength(2);
		let beforeSessionStart = false;
		Object.assign(session, {
			isStreaming: false,
			isCompacting: false,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			reload: async (options: { beforeSessionStart(): void }) => {
				renderer = () => new Text("new renderer", 0, 0);
				options.beforeSessionStart();
				expect(text()).not.toContain("old renderer");
				expect(text().match(/new renderer/g)).toHaveLength(1);
				const latest = sessionManager.appendCustomMessageEntry("fixture", "fresh session_start original", true);
				await host.handleEvent({
					type: "entry_appended",
					entry: sessionManager.getBranch().find((entry) => entry.id === latest)!,
				});
				beforeSessionStart = true;
			},
		});
		Object.assign(session.modelRuntime, { getError: () => undefined });
		Object.assign(host, {
			resetExtensionUI: vi.fn(),
			editorContainer: new Container(),
			themeController: { applyFromSettings: vi.fn() },
			keybindings: { reload: vi.fn() },
			applyRuntimeSettings: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			showLoadedResources: vi.fn(),
			maybeSaveImplicitProjectTrustAfterReload: () => false,
		});
		Object.assign(host.ui, { setFocus: vi.fn() });
		await host.handleReloadCommand();
		expect(beforeSessionStart).toBe(true);
		expect(text()).not.toContain("old renderer");
		expect(text().match(/new renderer/g)).toHaveLength(2);
		headings()[0].setExpanded(true);
		expect(text().match(/new renderer/g)).toHaveLength(3);
		expect(
			host
				.createTranscriptSearchSource()
				.snapshot()
				.flatMap((unit) => unit.fragments),
		).toContain("fresh session_start original");
	});

	it("binds finalized user/custom objects before persistence rather than requiring message_start object identity", async () => {
		const { host, sessionManager, text } = createHistory();
		host.renderInitialMessages();
		const start = userMsg("user original");
		await host.handleEvent({ type: "message_start", message: start });
		const final = { ...start, timestamp: 123 };
		await host.handleEvent({ type: "message_end", message: final });
		sessionManager.appendMessage(final);
		const customStart = createCustomMessage(
			"fixture",
			"custom original",
			true,
			{ excluded: "opaque" },
			new Date(0).toISOString(),
		);
		await host.handleEvent({ type: "message_start", message: customStart });
		const customFinal = { ...customStart, timestamp: 456 };
		await host.handleEvent({ type: "message_end", message: customFinal });
		sessionManager.appendCustomMessageEntry(customFinal.customType, customFinal.content, true, customFinal.details);
		text();
		expect(
			host
				.createTranscriptSearchSource()
				.snapshot()
				.flatMap((unit) => unit.fragments),
		).toEqual(["user original", "custom original"]);
	});

	it("reconciles completed streaming associations after message_end persistence without replacing live UI", async () => {
		const { host, sessionManager, text } = createHistory();
		host.renderInitialMessages();
		const partial = assistantMsg("partial");
		await host.handleEvent({ type: "message_start", message: partial });
		const source = host.createTranscriptSearchSource();
		expect(source.snapshot()).toHaveLength(0);
		const component = host.streamingComponent;
		const completed = assistantMsg("completed original");
		await host.handleEvent({ type: "message_end", message: completed });
		expect(source.snapshot()).toHaveLength(0);
		const entry = sessionManager.appendMessage(completed);
		text();
		const snapshot = source.snapshot();
		expect(snapshot).toEqual([{ id: `${entry}:message:0`, fragments: ["completed original"] }]);
		expect(host.chatContainer.children).toContain(component);
		expect(source.getAnchorRow(snapshot[0].id, 100)).toBe(2);
		expect(source.getAnchorRow(snapshot[0].id, 80)).toBeUndefined();
	});

	it("resolves measured anchors after expansion and excludes sibling branches and opaque source", () => {
		const { host, sessionManager, headings, text } = createHistory();
		const root = sessionManager.appendMessage(userMsg("root original"));
		sessionManager.appendMessage(userMsg("sibling secret"));
		sessionManager.branch(root);
		sessionManager.appendMessage({
			...assistantMsg("https://original.invalid/**bold**"),
			content: [
				{ type: "thinking", thinking: "思考 Straße", thinkingSignature: "opaque signature" },
				{ type: "text", text: "https://original.invalid/**bold**" },
			],
		});
		sessionManager.appendCompaction("summary", root, 1);
		sessionManager.appendCustomMessageEntry(
			"display",
			[
				{ type: "text", text: "custom original" },
				{ type: "image", data: "binary secret", mimeType: "image/png" },
			],
			true,
			{ hidden: "details secret" },
		);
		host.renderInitialMessages();
		text();
		const source = host.createTranscriptSearchSource();
		const snapshot = source.snapshot();
		const fragments = snapshot.flatMap((unit) => unit.fragments);
		expect(fragments).toContain("思考 Straße");
		expect(fragments).toContain("https://original.invalid/**bold**");
		expect(fragments).toContain("custom original");
		for (const excluded of ["binary secret", "details secret", "sibling secret", "opaque signature"])
			expect(fragments).not.toContain(excluded);
		const last = snapshot[snapshot.length - 1];
		const before = source.getAnchorRow(last.id, 100)!;
		headings()[0].setExpanded(true);
		text();
		expect(source.getAnchorRow(last.id, 100)).toBeGreaterThan(before);
		expect(collectTranscriptUnits(sessionManager.getBranch()).filter((unit) => unit.historical)).toHaveLength(2);
	});
});
it.each([0, 1] as const)(
	"cache-notice settings retain live owners and retroactive notices with padding %s",
	async (initialPadding) => {
		const { host, sessionManager, headings, text } = createHistory();
		const session = Reflect.get(Reflect.get(host, "runtimeHost"), "session") as { modelRuntime: object };
		Object.assign(session.modelRuntime, { getAvailableSnapshot: () => [], getModel: () => undefined });
		Object.assign(host, { outputPadY: initialPadding });
		const usage = {
			input: 30_000,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30_001,
			cost: { input: 0.3, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		const warmUsage = { ...usage, input: 0, cacheWrite: 30_000 };
		const first = sessionManager.appendMessage(userMsg("old prompt"));
		sessionManager.appendUsage("cache_warm", "anthropic", "test", warmUsage);
		sessionManager.appendCompaction("current summary", first, 1, undefined, false, usage);
		sessionManager.appendUsage("cache_warm", "anthropic", "test", warmUsage);
		sessionManager.appendMessage({ ...assistantMsg("persisted reply"), usage });
		host.renderInitialMessages();
		Object.assign(host, {
			maybeShowThinkingDropNotice: Reflect.get(InteractiveMode.prototype, "maybeShowThinkingDropNotice"),
			maybeShowCacheMissNotice: Reflect.get(InteractiveMode.prototype, "maybeShowCacheMissNotice"),
		});
		const completed: AssistantMessage = {
			...assistantMsg("completed before persistence"),
			usage,
			diagnostics: [
				{
					type: "anthropic_input_transformations",
					timestamp: 1,
					details: { transformations: [{ type: "thinking_dropped" }, { type: "thinking_dropped" }] },
				},
			],
		};
		await host.handleEvent({ type: "message_start", message: completed });
		await host.handleEvent({ type: "message_end", message: completed });
		expect(sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message === completed)).toBe(
			false,
		);
		sessionManager.appendMessage(completed);
		const streaming: AssistantMessage = {
			...assistantMsg("still streaming"),
			content: [
				{ type: "text", text: "still streaming" },
				{ type: "toolCall", name: "fixture", id: "live-cache-tool", arguments: { value: "pending" } },
			],
		};
		await host.handleEvent({ type: "message_start", message: streaming });
		await host.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: streaming,
			},
		});
		const live = host.pendingTools.get("live-cache-tool")!;
		const pending = host.pendingTools;
		const streamer = host.streamingComponent;
		expect(live).toBeInstanceOf(ToolExecutionComponent);
		expect(streamer).toBeDefined();
		const labels = /Cache warmed|Cache miss|tokens billed|Anthropic dropped/;
		expect(text()).not.toMatch(labels);
		let list: { handleInput(data: string): void } = {
			handleInput: (_data: string) => {
				throw new Error("settings selector was not constructed");
			},
		};
		Object.assign(host, {
			themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
			showSelector: (create: (done: () => void) => { component: Component }) => {
				const selector = create(() => {}).component as Component & { getSettingsList(): typeof list };
				list = selector.getSettingsList();
			},
		});
		const showSettings = Reflect.get(InteractiveMode.prototype, "showSettingsSelector") as (
			this: HistoryHarness,
		) => void;
		showSettings.call(host);
		list.handleInput("Cache miss notices");
		let notices: Component[] = [];
		for (const shown of [true, false, true]) {
			const previousHeading = headings()[0];
			previousHeading.setExpanded(true);
			list.handleInput("\r");
			expect(host.settingsManager.getShowCacheMissNotices()).toBe(shown);
			expect(headings()[0]).not.toBe(previousHeading);
			expect(headings()).toHaveLength(shown ? 2 : 1);
			expect(text()).toContain("▸ You: old prompt");
			expect(host.pendingTools).toBe(pending);
			expect(host.pendingTools.get("live-cache-tool")).toBe(live);
			expect(host.chatContainer.children).toContain(live);
			expect(host.streamingComponent).toBe(streamer);
			expect(host.streamingMessage).toBe(streaming);
			if (shown) {
				const visible = host.chatContainer.children.filter((child) =>
					labels.test(stripAnsi(child.render(100).join("\n"))),
				);
				if (!notices.length) notices = visible;
				expect(visible).toHaveLength(5);
				visible.forEach((notice, index) => {
					expect(notice).toBe(notices[index]);
				});
				expect(text().match(/Cache miss/g)).toHaveLength(2);
				expect(text()).toContain("Anthropic dropped 2 thinking blocks");
			} else {
				expect(text()).not.toMatch(labels);
				for (const notice of notices) {
					expect(host.chatContainer.children).toContain(notice);
					expect(notice.render(100)).toEqual([]);
				}
				expect(host.chatContainer.render(100)).toEqual(
					host.chatContainer.children
						.filter((child) => !notices.includes(child))
						.flatMap((child) => child.render(100)),
				);
			}
		}
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			initTheme("dark");
			host.chatContainer.invalidate();
			const labels = notices.map((notice) => stripAnsi(notice.render(100).join("\n")).trim());
			initTheme("light");
			host.chatContainer.invalidate();
			notices.forEach((notice, index) => {
				const label = labels[index];
				const color = label.startsWith("Cache warmed") ? "dim" : "warning";
				const fresh = new Text(theme.fg(color, label), 1, 0);
				expect(notice.render(100).slice(initialPadding)).toEqual(fresh.render(100));
			});
		} finally {
			resetCapabilitiesCache();
			initTheme("dark");
			host.chatContainer.invalidate();
		}
		for (const padding of [0, 1] as const) {
			host.applyOutputPadY(padding);
			for (const notice of notices) expect(notice.render(100)).toHaveLength(1 + padding);
		}
		await host.handleEvent({
			type: "tool_execution_end",
			toolCallId: "live-cache-tool",
			toolName: "fixture",
			result: { content: [{ type: "text", text: "original tool receives result" }] },
			isError: false,
		});
		expect(host.pendingTools.has("live-cache-tool")).toBe(false);
		expect(host.chatContainer.children).toContain(live);
		expect(stripAnsi(live.render(100).join("\n"))).toContain("original tool receives result");
		expect(host.streamingComponent).toBe(streamer);
	},
);
