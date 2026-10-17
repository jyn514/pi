import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type AgentTool, type QueueMode, type StreamFn } from "../src/index.ts";

const unusedStream: StreamFn = () => {
	throw new Error("No provider expected");
};
const assistant: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-responses",
	provider: "openai",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};
const reply: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { ...assistant } }));
	return stream;
};
const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
const tool: AgentTool = {
	name: "test",
	label: "test",
	description: "test",
	parameters: Type.Object({}),
	execute: async () => ({ content: [], details: undefined }),
};

const modes: QueueMode[] = ["one-at-a-time", "all"];

describe("Agent retained input", () => {
	// Requirement-derived matrix: initial versus either queue lane; selection before
	// the first member versus a partial batch; failure before versus after buffering.
	for (const lane of ["initial", "steering", "followUp"] as const) {
		for (const mode of modes) {
			for (const failAt of [0, 1]) {
				for (const buffered of [false, true]) {
					it(`${lane}/${mode}: failure at ${failAt}, buffered=${buffered}`, async () => {
						const agent = new Agent({ streamFn: reply, steeringMode: mode, followUpMode: mode });
						const messages = [user("A"), user("B"), user("C")];
						const recorded: AgentMessage[] = [];
						agent.subscribe((event) => {
							if (event.type !== "message_end" || !messages.includes(event.message as UserMessage)) return;
							if (event.message === messages[failAt]) {
								if (buffered) {
									recorded.push(event.message);
									agent.markInputRecorded(event.message);
								}
								throw new Error("append failed");
							}
							recorded.push(event.message);
						});
						if (lane !== "initial") {
							for (const message of messages) agent[lane === "steering" ? "steer" : "followUp"](message);
							expect(agent.hasUnrecordedInputs()).toBe(false);
						}
						await agent.prompt(lane === "initial" ? messages : user("start"));
						const recordedCount = failAt + (buffered ? 1 : 0);
						// In one-at-a-time mode a buffered failed member leaves only queued
						// work, whereas an all-mode batch also has an unattempted selected tail.
						expect(agent.hasUnrecordedInputs()).toBe(lane === "initial" || mode === "all" || !buffered);
						const pending = agent.takeQueuedMessages();
						expect(pending[lane]).toEqual(messages.slice(recordedCount));
						expect([...recorded, ...pending[lane]]).toEqual(messages);
						expect(agent.hasQueuedMessages()).toBe(false);
						expect(agent.hasUnrecordedInputs()).toBe(false);
					});
				}
			}
		}
	}

	for (const lane of ["initial", "steering", "followUp"] as const) {
		for (const buffered of [false, true]) {
			it(`${lane}: same-object occurrences survive repeated acknowledgment, buffered=${buffered}`, async () => {
				const agent = new Agent({ streamFn: reply, steeringMode: "all", followUpMode: "all" });
				const message = user("same object");
				let occurrence = 0;
				agent.markInputRecorded(message); // Outside an emission must do nothing.
				agent.subscribe((event) => {
					if (event.type !== "message_end" || event.message !== message) return;
					occurrence++;
					if (occurrence === 1 || buffered) {
						agent.markInputRecorded(message);
						agent.markInputRecorded(message);
					}
					if (occurrence === 2) throw new Error("append failed");
				});
				if (lane !== "initial")
					for (let i = 0; i < 3; i++) agent[lane === "steering" ? "steer" : "followUp"](message);
				await agent.prompt(lane === "initial" ? [message, message, message] : user("start"));
				agent.markInputRecorded(message); // Cannot acknowledge a future or failed emission.
				const pending = agent.takeQueuedMessages()[lane];
				expect(occurrence).toBe(2);
				expect(pending).toHaveLength(buffered ? 1 : 2);
				for (const retained of pending) expect(retained).toBe(message);
			});
		}
	}

	it("requires stopped ownership even inside final settlement listeners", async () => {
		const agent = new Agent({ streamFn: reply });
		const message = user("retained");
		agent.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "agent_end") {
				expect(() => agent.takeQueuedMessages()).toThrow("Wait for completion");
			}
			if (event.type === "agent_start") {
				expect(agent.hasUnrecordedInputs()).toBe(true);
				agent.abort();
				throw new Error("cancel before input events");
			}
		});
		await agent.prompt(message);
		expect(agent.takeQueuedMessages().initial).toEqual([message]);
	});

	it("standalone completion waits for all observers, while successful dispatch retires input", async () => {
		const agent = new Agent({ streamFn: reply });
		const message = user("input");
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === message) expect(agent.hasUnrecordedInputs()).toBe(true);
		});
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === message) throw new Error("last observer failed");
		});
		await agent.prompt(message);
		expect(agent.takeQueuedMessages().initial).toEqual([message]);
		unsubscribe();
		await agent.prompt(message);
		expect(agent.hasUnrecordedInputs()).toBe(false);
		expect(agent.takeQueuedMessages().initial).toEqual([]);
	});

	it("retains an entire selected batch when message_start fails", async () => {
		const agent = new Agent({ streamFn: reply, steeringMode: "all" });
		const messages = [user("A"), user("B"), user("C")];
		for (const message of messages) agent.steer(message);
		agent.subscribe((event) => {
			if (event.type === "message_start" && event.message === messages[0]) throw new Error("observer failed");
		});
		await agent.prompt(user("start"));
		expect(agent.takeQueuedMessages().steering).toEqual(messages);
	});

	it("retains original system/user/custom sources when tool declarations clone a system input", async () => {
		const agent = new Agent({ streamFn: unusedStream });
		agent.state.tools = [tool]; // Forces a tool delta merged into the pending system message.
		const system: AgentMessage = { role: "system", content: "instructions", timestamp: 1 };
		// Simulate an independently augmented consumer without changing the monorepo's global message union.
		const custom = { role: "retainedTestCustom", payload: "aside", timestamp: 1 } as unknown as AgentMessage;
		const messages = [system, user("request"), custom];
		let emittedSystem: AgentMessage | undefined;
		agent.subscribe((event) => {
			if (event.type !== "message_end") return;
			if (event.message.role === "system") {
				emittedSystem = event.message;
				expect(event.message).not.toBe(system);
				agent.markInputRecorded(event.message);
			}
			if (event.message === custom) throw new Error("custom append failed");
		});
		await agent.prompt(messages);
		expect(emittedSystem?.role).toBe("system");
		expect(agent.takeQueuedMessages().initial).toEqual([custom]);
	});

	for (const buffered of [false, true]) {
		it(`associates a cloned same-object system successor, buffered=${buffered}`, async () => {
			const agent = new Agent({ streamFn: unusedStream });
			agent.state.tools = [tool];
			const system: AgentMessage = { role: "system", content: "instructions", timestamp: 1 };
			let occurrence = 0;
			agent.subscribe((event) => {
				if (event.type !== "message_end" || event.message.role !== "system") return;
				if (++occurrence === 1) {
					expect(event.message).toBe(system);
					agent.markInputRecorded(event.message);
					agent.markInputRecorded(event.message);
				} else {
					expect(event.message).not.toBe(system);
					if (buffered) agent.markInputRecorded(event.message);
					throw new Error("cloned system append failed");
				}
			});
			await agent.prompt([system, system]);
			const pending = agent.takeQueuedMessages().initial;
			expect(occurrence).toBe(2);
			expect(pending).toHaveLength(buffered ? 0 : 1);
			if (!buffered) expect(pending[0]).toBe(system);
		});
	}

	it("does not acknowledge real input when a synthetic system declaration buffers", async () => {
		const agent = new Agent({ streamFn: unusedStream });
		agent.state.tools = [tool];
		const message = user("request");
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "system") {
				agent.markInputRecorded(event.message);
				throw new Error("synthetic declaration write failed");
			}
		});
		await agent.prompt(message);
		expect(agent.takeQueuedMessages().initial).toEqual([message]);
	});

	it("associates prepared and selected same-object messages with their own batches", async () => {
		const shared = user("shared");
		let turn = 0;
		const agent = new Agent({
			streamFn: reply,
			finishTurn: () => {
				if (++turn === 1) agent.steer(shared);
			},
			prepareNextTurn: () => ({ messages: [shared] }),
		});
		let occurrence = 0;
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === shared) {
				if (++occurrence === 2) throw new Error("selected append failed");
			}
		});
		await agent.prompt(user("start"));
		expect(agent.takeQueuedMessages().steering).toEqual([shared]);
	});

	it("preserves lane ownership in assistant-tail continue fallback", async () => {
		const agent = new Agent({ streamFn: unusedStream, initialState: { messages: [assistant] }, steeringMode: "all" });
		const message = user("queued");
		agent.steer(message);
		agent.subscribe((event) => {
			if (event.type === "agent_start") throw new Error("before initial emission");
		});
		await agent.continue();
		const pending = agent.takeQueuedMessages();
		expect(pending.initial).toEqual([]);
		expect(pending.steering).toEqual([message]);
	});

	it("does not confuse earlier failed occurrences with a later run using the same object", async () => {
		const agent = new Agent({ streamFn: reply });
		const message = user("shared");
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === message) throw new Error("append failed");
		});
		await agent.prompt(message);
		unsubscribe();
		await agent.prompt(message);
		expect(agent.takeQueuedMessages().initial).toEqual([message]);
	});

	it("explicit lane clearing discards selected work only in that lane; reset discards initial work", async () => {
		const agent = new Agent({ streamFn: reply, steeringMode: "all" });
		const initial = user("initial");
		const steering = user("steering");
		const followUp = user("followUp");
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "agent_start") throw new Error("before initial emission");
		});
		await agent.prompt(initial);
		unsubscribe();
		agent.steer(steering);
		agent.followUp(followUp);
		agent.subscribe((event) => {
			if (event.type === "message_start" && event.message === steering) throw new Error("before steering emission");
		});
		await agent.prompt(user("new run"));
		agent.clearSteeringQueue();
		expect(agent.takeQueuedMessages()).toMatchObject({ initial: [initial], steering: [], followUp: [followUp] });
		agent.subscribe((event) => {
			if (event.type === "agent_start") throw new Error("leave initial pending for reset");
		});
		await agent.prompt(initial);
		expect(agent.hasUnrecordedInputs()).toBe(true);
		agent.reset();
		expect(agent.hasUnrecordedInputs()).toBe(false);
		expect(agent.takeQueuedMessages()).toMatchObject({ initial: [], steering: [], followUp: [] });
	});
});

describe("Agent.takeQueuedMessages", () => {
	it("retains the initial batch tail when recording fails", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("No provider expected");
			},
		});
		const messages: AgentMessage[] = [
			{ role: "user", content: "A", timestamp: 1 },
			{ role: "user", content: "B", timestamp: 2 },
			{ role: "user", content: "C", timestamp: 3 },
		];
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === messages[1]) throw new Error("append failed");
		});
		await agent.prompt(messages);
		expect(agent.hasUnrecordedInputs()).toBe(true);
		expect(agent.takeQueuedMessages().initial).toEqual(messages.slice(1));
		expect(agent.hasUnrecordedInputs()).toBe(false);
	});
	for (const steeringMode of modes) {
		for (const followUpMode of modes) {
			it(`transfers every item with steering=${steeringMode}, followUp=${followUpMode}`, () => {
				const agent = new Agent({
					steeringMode,
					followUpMode,
					streamFn: () => {
						throw new Error("Queue transfer must not call a provider");
					},
				});
				const steering: UserMessage[] = [
					{ role: "user", content: "same text", timestamp: 1 },
					{ role: "user", content: "same text", timestamp: 2 },
					{
						role: "user",
						content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
						timestamp: 3,
					},
				];
				const followUp: UserMessage[] = [
					{ role: "user", content: "follow one", timestamp: 4 },
					{ role: "user", content: "follow two", timestamp: 5 },
				];
				for (const message of followUp) agent.followUp(message);
				expect(agent.peekQueuedMessages()).toEqual(followUpMode === "all" ? followUp : [followUp[0]]);
				for (const message of steering) agent.steer(message);
				const preview = steeringMode === "all" ? steering : [steering[0]];
				expect(agent.peekQueuedMessages()).toEqual(preview);
				expect(agent.peekQueuedMessages()).toEqual(preview);

				const transferred = agent.takeQueuedMessages();
				expect(transferred).toEqual({ initial: [], steering, followUp, steeringMode, followUpMode });
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(agent.peekQueuedMessages()).toEqual([]);
				expect(agent.takeQueuedMessages()).toEqual({
					initial: [],
					steering: [],
					followUp: [],
					steeringMode,
					followUpMode,
				});

				agent.steer(steering[0]);
				expect(transferred.steering).toEqual(steering);
				expect(agent.peekQueuedMessages()).toEqual([steering[0]]);
				expect(agent.steeringMode).toBe(steeringMode);
				expect(agent.followUpMode).toBe(followUpMode);
			});
		}
	}
});
