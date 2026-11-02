import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type QueueMode, type StreamFn } from "../src/index.ts";

interface Notification {
	role: "steeringPriorityNotification";
	content: string;
	timestamp: number;
}

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });
// Model an independently augmented consumer without extending the monorepo-wide message union.
const notification = (content: string): AgentMessage =>
	({ role: "steeringPriorityNotification", content, timestamp: 1 }) as unknown as AgentMessage;
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
const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.flatMap((source): Message[] => {
		const message = source as Message | Notification;
		if (message.role === "steeringPriorityNotification") return [user(message.content)];
		if (
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult"
		)
			return [message];
		return [];
	});

// The queue mode changes batch size, not the recording boundary or ownership of inputs.
describe("steering user priority", () => {
	for (const start of ["prompt", "assistant-tail", "user-tail"] as const) {
		for (const mode of ["one-at-a-time", "all"] as const) {
			it(`${start}/${mode}: selects users before notifications only in one-at-a-time mode`, async () => {
				const requests: string[][] = [];
				const agent = new Agent({
					steeringMode: mode,
					convertToLlm,
					streamFn: (model, context, options) => {
						requests.push(
							context.messages.flatMap((message) => (message.role === "user" ? [String(message.content)] : [])),
						);
						return reply(model, context, options);
					},
				});
				const notifications = Array.from({ length: 5 }, (_, index) => notification(`notification ${index + 1}`));
				const users = [user("first steering"), user("second steering")];
				const queued = [...notifications.slice(0, 3), users[0], ...notifications.slice(3), users[1]];
				for (const message of queued) agent.steer(message);
				const next = mode === "all" ? queued : [users[0]];
				expect(agent.peekQueuedMessages()).toEqual(next);
				expect(agent.peekQueuedMessages()).toEqual(next);
				if (start === "prompt") {
					await agent.prompt(user("start"));
				} else {
					agent.state.messages = start === "assistant-tail" ? [user("start"), assistant] : [user("start")];
					await agent.continue();
				}
				const deliveryOrder = mode === "all" ? queued : [...users, ...notifications];
				const texts = deliveryOrder.map((message) => String((message as UserMessage | Notification).content));
				expect(requests).toEqual(
					mode === "all"
						? [["start", ...texts]]
						: texts.map((_, index) => ["start", ...texts.slice(0, index + 1)]),
				);
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(agent.hasUnrecordedInputs()).toBe(false);
			});
		}
	}

	it.each(["one-at-a-time", "all"] as const)("keeps follow-up FIFO with %s mode", async (mode: QueueMode) => {
		const agent = new Agent({ streamFn: reply, convertToLlm, followUpMode: mode });
		const messages = [notification("first notification"), user("later user"), notification("last notification")];
		const recorded: AgentMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && messages.includes(event.message)) recorded.push(event.message);
		});
		for (const message of messages) agent.followUp(message);
		expect(agent.peekQueuedMessages()).toEqual(mode === "all" ? messages : [messages[0]]);
		await agent.prompt("start");
		expect(recorded).toEqual(messages);
	});

	it("keeps notification-only steering FIFO", async () => {
		const agent = new Agent({ streamFn: reply, convertToLlm });
		const messages = [notification("first"), notification("second")];
		const recorded: AgentMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && messages.includes(event.message)) recorded.push(event.message);
		});
		for (const message of messages) agent.steer(message);
		expect(agent.peekQueuedMessages()).toEqual([messages[0]]);
		await agent.prompt("start");
		expect(recorded).toEqual(messages);
	});

	it.each([false, true])(
		"transfers mixed inputs in source order after priority recording fails, buffered=%s",
		async (buffered) => {
			const agent = new Agent({ streamFn: reply, convertToLlm });
			const first = notification("first");
			const steering = user("steering");
			const last = notification("last");
			for (const message of [first, steering, last]) agent.steer(message);
			agent.subscribe((event) => {
				if (event.type === "message_end" && event.message === steering) {
					if (buffered) agent.markInputRecorded(event.message);
					throw new Error("recording failed");
				}
			});
			await agent.prompt("start");
			expect(agent.hasUnrecordedInputs()).toBe(!buffered);
			const pending = agent.takeQueuedMessages();
			expect(pending.steering).toEqual(buffered ? [first, last] : [first, steering, last]);
			expect(agent.hasQueuedMessages()).toBe(false);
			const restored = new Agent({ streamFn: reply, convertToLlm });
			for (const message of pending.steering) restored.steer(message);
			expect(restored.peekQueuedMessages()).toEqual([buffered ? first : steering]);
			const recorded: AgentMessage[] = [];
			restored.subscribe((event) => {
				if (event.type === "message_end" && pending.steering.includes(event.message)) recorded.push(event.message);
			});
			await restored.prompt("resume");
			expect(recorded).toEqual(buffered ? [first, last] : [steering, first, last]);
		},
	);

	it("removes one selected occurrence when the same user object is queued twice", async () => {
		const agent = new Agent({ streamFn: reply, convertToLlm });
		const first = notification("first");
		const steering = user("shared");
		const last = notification("last");
		for (const message of [first, steering, last, steering]) agent.steer(message);
		let occurrences = 0;
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message === steering && ++occurrences === 2)
				throw new Error("second occurrence failed");
		});
		await agent.prompt("start");
		expect(occurrences).toBe(2);
		expect(agent.takeQueuedMessages().steering).toEqual([first, last, steering]);
	});
});
