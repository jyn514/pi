import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AltScreenSearchSource,
	type Component,
	Container,
	Input,
	ScrollView,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface BashSearchHost {
	runtimeHost: { session: AgentSession };
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	createTranscriptSearchSource(): AltScreenSearchSource;
	flushPendingBashComponents(): void;
	rebuildTranscript(): void;
	renderCurrentSessionState(): void;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	documentContainer: Container;
	completedMessageBindings: WeakMap<AgentMessage, Map<string, Component>>;
}

function createHost(harness: Harness): BashSearchHost {
	const chatContainer = new Container();
	const documentContainer = new Container();
	documentContainer.addChild(chatContainer);
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		chatContainer,
		documentContainer,
		pendingMessagesContainer: new Container(),
		loadedResourcesContainer: new Container(),
		editor: { addToHistory: vi.fn() },
		renderProjectTrustWarningIfNeeded: vi.fn(),
		pendingBashComponents: [],
		historicalContainer: new Container(),
		historicalUnits: [],
		transcriptBindings: new Map(),
		completedMessageBindings: new WeakMap<AgentMessage, Map<string, Component>>(),
		completedCustomBindings: [],
		completedToolOwners: new Map(),
		pendingTools: new Map(),
		outputPad: 0,
		outputPadY: 0,
		ui: { requestRender: vi.fn() },
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
	}) as BashSearchHost;
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const result = { output: "needle", exitCode: 0, cancelled: false, truncated: false };
const command = "printf needle";
const operations: BashOperations = {
	exec: async (_command, _cwd, options) => {
		options.onData(Buffer.from(result.output));
		return { exitCode: 0 };
	},
};

// The missing dimension was completed CLI bash while persistence is deferred, not
// an already-persisted result passed directly to the binding helper. Exercise all
// producers without requiring local execution, custom operations, and intercepted
// results to share their internal implementation.
describe("completed bash source-search ownership", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it.each([
		["local", false],
		["local", true],
		["operations", false],
		["operations", true],
		["intercepted", false],
		["intercepted", true],
	] as const)(
		"binds idle and deferred %s results with exclusion %s to distinct anchors",
		async (producer, excluded) => {
			const release = deferred();
			const started = deferred();
			const wait: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Hold the real session streaming until deferred bash results are queued",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			};
			const harness = await createHarness({ tools: [wait] });
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			vi.spyOn(harness.session.extensionRunner, "emitUserBash").mockResolvedValue(
				producer === "intercepted" ? { result } : producer === "operations" ? { operations } : undefined,
			);
			const host = createHost(harness);
			const source = host.createTranscriptSearchSource();
			await host.handleBashCommand(command, excluded);
			host.documentContainer.render(80);
			const frozen = source.snapshot();
			expect(frozen).toHaveLength(1);
			expect(source.getAnchorRow(frozen[0].id, 80)).toBeDefined();
			const running = harness.session.prompt("start");
			try {
				await started.promise;
				expect(harness.session.isStreaming).toBe(true);
				// Another producer can record the exact same command and output. It has
				// no CLI component and must not steal either later CLI anchor.
				harness.session.recordBashResult(command, result, { excludeFromContext: excluded });
				await host.handleBashCommand(command, excluded);
				await host.handleBashCommand(command, excluded);
				expect(harness.session.hasPendingBashMessages).toBe(true);
				expect(source.snapshot()).toEqual(frozen);
				expect(host.pendingMessagesContainer.children).toHaveLength(2);
				expect(host.chatContainer.children.filter((child) => child instanceof BashExecutionComponent)).toHaveLength(
					1,
				);
			} finally {
				release.resolve();
				await running;
			}
			expect(harness.session.hasPendingBashMessages).toBe(false);
			const snapshot = source.snapshot();
			expect(snapshot).toHaveLength(3);
			expect(frozen).toHaveLength(1); // Captured source does not acquire later completions.
			expect(snapshot.map((unit) => unit.fragments)).toEqual(
				Array.from({ length: 3 }, () => [command, result.output]),
			);
			const bashMessages = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message] : [],
				);
			expect(bashMessages).toHaveLength(4);
			expect(bashMessages.every((message) => message.excludeFromContext === excluded)).toBe(true);
			expect(host.completedMessageBindings.has(bashMessages[1])).toBe(false);
			host.documentContainer.render(80);
			// Persistence must not move the pending components into the transcript.
			expect(host.pendingMessagesContainer.children).toHaveLength(2);
			expect(source.getAnchorRow(snapshot[1].id, 80)).toBeUndefined();
			host.flushPendingBashComponents();
			host.documentContainer.render(80);
			const rows = snapshot.map((unit) => source.getAnchorRow(unit.id, 80));
			expect(rows.every((row) => row !== undefined)).toBe(true);
			expect(new Set(rows).size).toBe(3);
			expect(rows[0]!).toBeLessThan(rows[1]!);
			expect(rows[1]!).toBeLessThan(rows[2]!);
		},
	);

	it("refreshes native search after handoff persistence without moving pending bodies, then releases them on replacement", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bash-search-"));
		directories.push(directory);
		const started = deferred();
		const release = deferred();
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Hold a tool boundary for handoff",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const first = await createHarness({ tools: [wait], sessionManager: SessionManager.create(directory, directory) });
		const replacement = await createHarness();
		harnesses.push(first, replacement);
		first.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
		vi.spyOn(first.session.extensionRunner, "emitUserBash").mockResolvedValue({ result });
		const host = createHost(first);
		const source = host.createTranscriptSearchSource();
		await host.handleBashCommand(command);
		const terminal = new VirtualTerminal(80, 12);
		const renderer = new TuiAltScreen(terminal);
		const scroll = new ScrollView(host.documentContainer, { primary: true });
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
		let running: Promise<void> | undefined;
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toMatch(/[12]\/2/);
			running = first.session.prompt("start");
			await started.promise;
			await host.handleBashCommand(command);
			expect(first.session.hasPendingBashMessages).toBe(true);
			const handoff = first.session.handoff("bash-search");
			release.resolve();
			await handoff;
			await running;
			expect(first.session.hasPendingBashMessages).toBe(false);
			expect(source.snapshot()).toHaveLength(2);
			expect(host.pendingMessagesContainer.children).toHaveLength(1);
			renderer.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toMatch(/[12]\/2/);
			renderer.closeSearch();
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toMatch(/[1-4]\/4/);
			// The completed body is still pending at replacement. It must not
			// reappear when the replacement receives normal input.
			expect(host.pendingMessagesContainer.children).toHaveLength(1);
			host.runtimeHost.session = replacement.session;
			host.renderCurrentSessionState();
			expect(renderer.hasOverlayEntries).toBe(false);
			host.flushPendingBashComponents();
			expect(host.pendingMessagesContainer.children).toHaveLength(0);
			expect(host.chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(false);
			expect(source.snapshot()).toEqual([]);
		} finally {
			release.resolve();
			await running;
			renderer.stop();
		}
	});

	it.each(
		(["local", "operations", "intercepted"] as const).flatMap((producer) =>
			(["unchanged", "rebuild", "replace-before-rebind", "replace"] as const).map(
				(transition) => [producer, transition] as const,
			),
		),
	)("revalidates %s ownership after an awaited user_bash handler: %s", async (producer, transition) => {
		const started = deferred();
		const release = deferred();
		const customExecution = vi.fn(operations.exec);
		const first = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async () => {
						started.resolve();
						await release.promise;
						return producer === "intercepted"
							? { result }
							: producer === "operations"
								? { operations: { exec: customExecution } }
								: undefined;
					});
				},
			],
		});
		const replacement = await createHarness();
		harnesses.push(first, replacement);
		const oldExecution = vi.spyOn(first.session, "executeBash");
		const newExecution = vi.spyOn(replacement.session, "executeBash");
		const host = createHost(first);
		const source = host.createTranscriptSearchSource();
		const running = host.handleBashCommand(command);
		try {
			await started.promise;
			// The hook is awaiting, but command execution has not begun. A session
			// replacement or idle reload can run during this window.
			expect(first.session.isBashRunning).toBe(false);
			expect(oldExecution).not.toHaveBeenCalled();
			expect(host.chatContainer.children).toHaveLength(0);
			if (transition === "replace" || transition === "replace-before-rebind") {
				first.session.dispose();
				host.runtimeHost.session = replacement.session;
			}
			// Runtime ownership changes before the UI rebind. Test that window
			// independently of replacing the transcript within the same session.
			if (transition === "rebuild" || transition === "replace") host.renderCurrentSessionState();
		} finally {
			release.resolve();
			await running;
		}
		const active = transition === "unchanged";
		expect(oldExecution).toHaveBeenCalledTimes(active && producer !== "intercepted" ? 1 : 0);
		expect(newExecution).not.toHaveBeenCalled();
		expect(customExecution).toHaveBeenCalledTimes(active && producer === "operations" ? 1 : 0);
		expect(host.chatContainer.children.filter((child) => child instanceof BashExecutionComponent)).toHaveLength(
			active ? 1 : 0,
		);
		host.flushPendingBashComponents();
		expect(host.pendingMessagesContainer.children).toHaveLength(0);
		expect(source.snapshot()).toHaveLength(active ? 1 : 0);
	});

	it("excludes partial output and does not resurrect completion bindings after session replacement", async () => {
		const first = await createHarness();
		const replacement = await createHarness();
		harnesses.push(first, replacement);
		const started = deferred();
		const finish = deferred();
		vi.spyOn(first.session.extensionRunner, "emitUserBash").mockResolvedValue({
			operations: {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("partial needle"));
					started.resolve();
					await finish.promise;
					return { exitCode: 0 };
				},
			},
		});
		const host = createHost(first);
		const source = host.createTranscriptSearchSource();
		const running = host.handleBashCommand(command);
		await started.promise;
		expect(source.snapshot()).toEqual([]);
		host.runtimeHost.session = replacement.session;
		host.rebuildTranscript();
		finish.resolve();
		await running;
		const completed = first.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "bashExecution");
		expect(completed?.type).toBe("message");
		if (completed?.type !== "message") throw new Error("Old session did not record its completed command");
		expect(host.completedMessageBindings.has(completed.message)).toBe(false);
		expect(source.snapshot()).toEqual([]);
	});
});
