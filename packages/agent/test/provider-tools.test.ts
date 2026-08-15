import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event");
			},
		);
		queueMicrotask(() => this.push({ type: "done", reason: "stop", message }));
	}
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("agent provider tools", () => {
	it("passes provider tools to the model without local execution", async () => {
		let requestContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			requestContext = context;
			return new MockAssistantStream(assistantMessage());
		};
		const agent = new Agent({ streamFn });
		agent.state.providerTools = [{ type: "web_search", allowedDomains: ["rust-lang.org"] }];

		await agent.prompt("Find the latest Rust post");

		expect(requestContext?.providerTools).toEqual([
			{
				type: "web_search",
				allowedDomains: ["rust-lang.org"],
			},
		]);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toEqual([]);
	});
});
