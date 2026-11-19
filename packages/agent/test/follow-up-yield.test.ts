import {
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

function responses(requests: string[][], tools: string[][]): StreamFn {
	return (_model, context, options) => {
		if (options?.signal?.aborted) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "error",
					reason: "aborted",
					error: fauxAssistantMessage("", { stopReason: "aborted" }),
				}),
			);
			return stream;
		}
		const calls = tools[requests.length] ?? [];
		requests.push(
			context.messages.flatMap((message) => (message.role === "user" ? [contentText(message.content)] : [])),
		);
		const message = calls.length
			? fauxAssistantMessage(
					calls.map((name) => fauxToolCall(name, {})),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage("done");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message }));
		return stream;
	};
}

describe("tool results yielding to follow-ups", () => {
	for (const execution of ["parallel", "sequential"] as const) {
		for (const mode of ["one-at-a-time", "all"] as const) {
			for (const outcome of ["yield", "ordinary", "error", "throw"] as const) {
				it(`${execution}/${mode}/${outcome}: delivers follow-ups at the requested boundary exactly once`, async () => {
					const requests: string[][] = [];
					const tool: AgentTool = {
						name: "wait",
						label: "Wait",
						description: "Wait for input.",
						parameters: obj({}),
						async execute() {
							agent.followUp({ role: "user", content: "first", timestamp: 1 });
							agent.followUp({ role: "user", content: "second", timestamp: 2 });
							if (outcome === "throw") throw new Error("wait failed");
							return {
								content: [],
								details: {},
								isError: outcome === "error",
								yieldToFollowUps: outcome !== "ordinary",
							};
						},
					};
					const agent = new Agent({
						initialState: { tools: [tool] },
						streamFn: responses(requests, [["wait"]]),
						toolExecution: execution,
						followUpMode: mode,
					});
					await agent.prompt("start");
					const deliveries =
						mode === "all"
							? [["start", "first", "second"]]
							: [
									["start", "first"],
									["start", "first", "second"],
								];
					expect(requests).toEqual([["start"], ...(outcome === "yield" ? [] : [["start"]]), ...deliveries]);
					expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(3);
					expect(agent.hasQueuedMessages()).toBe(false);
					expect(agent.hasUnrecordedInputs()).toBe(false);
					expect(agent.state.messages.find((message) => message.role === "toolResult")).not.toHaveProperty(
						"yieldToFollowUps",
					);
				});
			}
		}
	}

	it("selects steering first without promoting follow-ups on later ordinary turns", async () => {
		const requests: string[][] = [];
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for input.",
			parameters: obj({}),
			async execute() {
				agent.followUp({ role: "user", content: "follow-up", timestamp: 1 });
				agent.steer({ role: "user", content: "steering", timestamp: 2 });
				return { content: [], details: {}, yieldToFollowUps: true };
			},
		};
		const ordinary: AgentTool = { ...tool, name: "ordinary", execute: async () => ({ content: [], details: {} }) };
		const agent = new Agent({
			initialState: { tools: [tool, ordinary] },
			streamFn: responses(requests, [["wait"], ["ordinary"]]),
		});
		await agent.prompt("start");
		expect(requests).toEqual([
			["start"],
			["start", "steering"],
			["start", "steering"],
			["start", "steering", "follow-up"],
		]);
	});

	it("uses the yield for one selection only", async () => {
		const requests: string[][] = [];
		let calls = 0;
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for input.",
			parameters: obj({}),
			async execute() {
				calls++;
				agent.followUp({ role: "user", content: `follow-up ${calls}`, timestamp: calls });
				return { content: [], details: {}, yieldToFollowUps: calls === 1 };
			},
		};
		const agent = new Agent({ initialState: { tools: [tool] }, streamFn: responses(requests, [["wait"], ["wait"]]) });
		await agent.prompt("start");
		expect(requests).toEqual([
			["start"],
			["start", "follow-up 1"],
			["start", "follow-up 1"],
			["start", "follow-up 1", "follow-up 2"],
		]);
	});

	it("waits for sibling tools to finish before delivering the follow-up", async () => {
		const requests: string[][] = [];
		const yielded = Promise.withResolvers<void>();
		const siblingStarted = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for input.",
			parameters: obj({}),
			async execute() {
				await siblingStarted.promise;
				agent.followUp({ role: "user", content: "follow-up", timestamp: 1 });
				yielded.resolve();
				return { content: [], details: {}, yieldToFollowUps: true };
			},
		};
		const sibling: AgentTool = {
			...tool,
			name: "sibling",
			async execute() {
				siblingStarted.resolve();
				await releaseSibling.promise;
				return { content: [], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool, sibling] },
			streamFn: responses(requests, [["wait", "sibling"]]),
		});
		const running = agent.prompt("start");
		try {
			await yielded.promise;
			expect(requests).toEqual([["start"]]);
			expect(agent.hasQueuedMessages("followUp")).toBe(true);
		} finally {
			releaseSibling.resolve();
			await running;
		}
		expect(requests).toEqual([["start"], ["start", "follow-up"]]);
		expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	});

	it("keeps a follow-up queued when finishTurn explicitly ends the run", async () => {
		const requests: string[][] = [];
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for input.",
			parameters: obj({}),
			async execute() {
				agent.followUp({ role: "user", content: "follow-up", timestamp: 1 });
				return { content: [], details: {}, yieldToFollowUps: true };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: responses(requests, [["wait"]]),
			finishTurn: () => ({ action: "end" }),
		});
		await agent.prompt("start");
		expect(agent.takeQueuedMessages().followUp).toMatchObject([{ content: "follow-up" }]);
		expect(requests).toEqual([["start"]]);
	});

	it("keeps a follow-up queued when the run is aborted", async () => {
		const requests: string[][] = [];
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for input.",
			parameters: obj({}),
			async execute() {
				agent.followUp({ role: "user", content: "follow-up", timestamp: 1 });
				agent.abort();
				return { content: [], details: {}, yieldToFollowUps: true };
			},
		};
		const agent = new Agent({ initialState: { tools: [tool] }, streamFn: responses(requests, [["wait"]]) });
		await agent.prompt("start");
		expect(agent.takeQueuedMessages().followUp).toMatchObject([{ content: "follow-up" }]);
		expect(requests).toEqual([["start"]]);
	});
});
