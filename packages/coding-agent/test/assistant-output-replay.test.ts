import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Message, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, findCutPoint, prepareCompaction } from "../src/core/compaction/index.ts";
import { type AssistantOutputMessage, convertToLlm } from "../src/core/messages.ts";
import { SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { getMessageText } from "./suite/harness.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-6",
	name: "Claude replay test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 100,
	};
}

function nativeOutput(message: string, toolCallId = "outer-call"): AssistantOutputMessage {
	return { ...assistant([{ type: "text", text: message }]), outputFromToolCallId: toolCallId };
}

function workflow() {
	const caller = assistant(
		[
			{ type: "thinking", thinking: "Preserve this reasoning.", thinkingSignature: "opaque-reasoning-signature" },
			{ type: "toolCall", id: "outer-call", name: "codemode", arguments: { code: "run the workflow" } },
		],
		"toolUse",
	);
	const result: Message = {
		role: "toolResult",
		toolCallId: "outer-call",
		toolName: "codemode",
		content: [{ type: "text", text: "Script complete." }],
		isError: false,
		timestamp: 101,
	};
	const progress = nativeOutput("Native progress.");
	const laterProgress = nativeOutput("More progress.");
	const messages: Message[] = [
		{ role: "user", content: "Run the workflow.", timestamp: 99 },
		caller,
		result,
		progress,
		laterProgress,
	];
	return { caller, result, progress, laterProgress, messages };
}

function messageEntries(messages: AgentMessage[]): SessionMessageEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message,
	}));
}

describe("native assistant output provider replay", () => {
	it("projects native text into its caller without mutating persisted history or repeating output on conversion", () => {
		const { messages, caller, result } = workflow();
		const manager = SessionManager.inMemory();
		for (const message of messages) manager.appendMessage(message);
		const projection = manager.buildSessionProjection();
		const before = structuredClone(projection);
		const entriesBefore = structuredClone(manager.getEntries());
		Object.freeze(caller.content);

		const replay = convertToLlm(projection.messages);

		expect(replay).toEqual([
			messages[0],
			{
				...caller,
				content: [
					...caller.content,
					{ type: "text", text: "Native progress." },
					{ type: "text", text: "More progress." },
				],
			},
			result,
		]);
		expect(replay[1]).not.toBe(caller);
		expect(projection).toEqual(before);
		expect(manager.getEntries()).toEqual(entriesBefore);
		expect(convertToLlm(projection.messages)).toEqual(replay);
		expect(convertToLlm(replay)).toEqual(replay);
		expect(projection.messages.map(getMessageText)).toEqual([
			"Run the workflow.",
			"",
			"Script complete.",
			"Native progress.",
			"More progress.",
		]);
	});

	it("keeps repeated native text as distinct ordered outputs and attaches each group to its own caller", () => {
		const { messages, caller } = workflow();
		const secondCaller = assistant(
			[{ type: "toolCall", id: "second-call", name: "send_commentary", arguments: { message: "Second progress." } }],
			"toolUse",
		);
		const secondResult: Message = {
			role: "toolResult",
			toolCallId: "second-call",
			toolName: "send_commentary",
			content: [],
			isError: false,
			timestamp: 103,
		};
		messages.push(
			nativeOutput("Native progress."),
			secondCaller,
			secondResult,
			nativeOutput("Second progress.", "second-call"),
		);

		const replay = convertToLlm(messages);
		const assistants = replay.filter((message) => message.role === "assistant");

		expect(assistants).toHaveLength(2);
		expect(assistants[0].content).toEqual([
			...caller.content,
			{ type: "text", text: "Native progress." },
			{ type: "text", text: "More progress." },
			{ type: "text", text: "Native progress." },
		]);
		expect(assistants[1].content).toEqual([...secondCaller.content, { type: "text", text: "Second progress." }]);
		expect(replay.every((message) => !("outputFromToolCallId" in message))).toBe(true);
		expect(replay.at(-1)).toBe(secondResult);
	});

	it("leaves ordinary assistant messages unchanged, including a standalone final response", () => {
		const { messages, caller, result } = workflow();
		const final = assistant([{ type: "text", text: "Ordinary final." }]);
		const ordinary = [messages[0], caller, result, final];

		expect(convertToLlm(ordinary)).toEqual(ordinary);
		expect(convertToLlm(ordinary).at(-1)).toBe(final);
	});

	it("retains orphan output without leaking its local marker or attaching it to an unrelated call", () => {
		const { caller, result } = workflow();
		const orphan = nativeOutput("Keep this orphan output.", "missing-call");
		const before = structuredClone(orphan);
		const replay = convertToLlm([caller, result, orphan]);

		expect(replay).toHaveLength(3);
		expect(replay[0]).toEqual(caller);
		expect(replay[2]).toEqual(assistant([{ type: "text", text: "Keep this orphan output." }]));
		expect(replay[2]).not.toHaveProperty("outputFromToolCallId");
		expect(orphan).toEqual(before);
	});

	it("serializes Anthropic replay with native text once, unchanged signed thinking, and a final user tool result", async () => {
		const { messages } = workflow();
		interface Payload {
			messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
		}
		let payload: Payload | undefined;
		const stream = streamAnthropic(model, normalizeContext({ messages: convertToLlm(messages) }), {
			apiKey: "fake-key",
			cacheRetention: "none",
			thinkingEnabled: true,
			onPayload: (value) => {
				payload = value as Payload;
				throw new Error("Payload captured before any network request");
			},
		});
		await stream.result();
		if (!payload) throw new Error("Expected Anthropic payload capture before request");

		expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(payload.messages[1].content).toEqual([
			{ type: "thinking", thinking: "Preserve this reasoning.", signature: "opaque-reasoning-signature" },
			{ type: "tool_use", id: "outer-call", name: "codemode", input: { code: "run the workflow" } },
			{ type: "text", text: "Native progress." },
			{ type: "text", text: "More progress." },
		]);
		expect(payload.messages.at(-1)).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "outer-call", content: "Script complete.", is_error: false }],
		});
		expect(JSON.stringify(payload)).not.toContain("outputFromToolCallId");
	});
});

describe("native assistant output compaction groups", () => {
	it.each([1, 20])("keeps the caller, result, and native outputs together with a %i-token suffix budget", (budget) => {
		const { messages, caller } = workflow();
		const oldUser: AgentMessage = { role: "user", content: "Old history.", timestamp: 1 };
		const oldAnswer = assistant([{ type: "text", text: "Old answer." }]);
		const entries = messageEntries([oldUser, oldAnswer, ...messages]);
		const callerIndex = entries.findIndex((entry) => entry.message === caller);

		const cut = findCutPoint(entries, 0, entries.length, budget);
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: budget });

		expect(cut.firstKeptEntryIndex).toBe(callerIndex);
		expect(preparation?.firstKeptEntryId).toBe(entries[callerIndex].id);
		expect(preparation?.messagesToSummarize).toEqual([oldUser, oldAnswer]);
		expect(preparation?.turnPrefixMessages).toEqual([messages[0]]);
		const retained = entries.slice(cut.firstKeptEntryIndex).map((entry) => entry.message);
		expect(retained).toEqual(messages.slice(1));
		expect(convertToLlm(retained).at(-1)?.role).toBe("toolResult");
	});

	it("still allows compaction to start at an ordinary standalone assistant response", () => {
		const { messages } = workflow();
		const ordinaryFinal = assistant([{ type: "text", text: "An ordinary final answer." }]);
		const entries = messageEntries([...messages, ordinaryFinal]);

		expect(findCutPoint(entries, 0, entries.length, 1).firstKeptEntryIndex).toBe(entries.length - 1);
		expect(
			prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 })?.firstKeptEntryId,
		).toBe(entries.at(-1)?.id);
	});
});
