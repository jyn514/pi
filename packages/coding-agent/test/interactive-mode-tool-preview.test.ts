import { Container } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTranscript(toolPreviewLines: number) {
	const host = {
		settingsManager: SettingsManager.inMemory({ toolPreviewLines }),
		sessionManager: SessionManager.inMemory(),
		chatContainer: new Container(),
		pendingTools: new Map<string, ToolExecutionComponent>(),
		toolOutputExpanded: false,
		outputPad: 0,
		outputPadY: 0,
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		streamingComponent: { updateContent: vi.fn() },
		getRegisteredToolDefinition: (name: string) => withBuiltInRenderers(name, undefined),
		addMessageToChat: vi.fn(),
	};
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: typeof host,
		event: AgentSessionEvent,
	) => Promise<void>;
	const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
		this: typeof host,
		items: readonly unknown[],
	) => void;
	return {
		host,
		handle: (event: AgentSessionEvent) => handleEvent.call(host, event),
		restore: (items: readonly unknown[]) => renderSessionItems.call(host, items),
		text: () => stripAnsi(host.chatContainer.render(120).join("\n")),
	};
}

const args = { pattern: "needle", path: "notes.txt" };
const result = { content: [{ type: "text" as const, text: "PREVIEW_FIRST\nPREVIEW_SECOND" }], details: undefined };
const assistant = {
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id: "call-1", name: "grep", arguments: args }],
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse" as const,
	timestamp: 0,
};

beforeAll(() => initTheme("dark"));

// Protect settings propagation at all three UI creation paths, not only renderer options.
// These tests use real settings, tool components and renderers; no provider or terminal is started.
test.each(["streamed call", "execution start", "restored session"] as const)(
	"%s uses configured previews and still expands stored output",
	async (path) => {
		for (const limit of [0, 1]) {
			const transcript = createTranscript(limit);
			if (path === "restored session") {
				transcript.restore([
					assistant,
					{ role: "toolResult", toolCallId: "call-1", toolName: "grep", ...result, isError: false, timestamp: 0 },
				]);
			} else {
				if (path === "streamed call") {
					await transcript.handle({
						type: "message_update",
						message: assistant,
						assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistant },
					});
				} else {
					await transcript.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "grep", args });
				}
				await transcript.handle({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "grep",
					result,
					isError: false,
				});
			}
			expect(transcript.text()).toContain("grep");
			expect(transcript.text()).toContain("to expand");
			if (limit === 0) expect(transcript.text()).not.toContain("PREVIEW_FIRST");
			else expect(transcript.text()).toContain("PREVIEW_FIRST");
			expect(transcript.text()).not.toContain("PREVIEW_SECOND");
			for (const child of transcript.host.chatContainer.children) {
				(child as ToolExecutionComponent).setExpanded(true);
			}
			expect(transcript.text()).toContain("PREVIEW_SECOND");
		}
	},
);
