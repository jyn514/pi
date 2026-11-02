import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type StreamFn } from "../src/index.ts";

const unusedStream: StreamFn = () => {
	throw new Error("Queue visibility must not call a provider");
};

const user: UserMessage = { role: "user", content: "request", timestamp: 1 };
// Model an independently augmented consumer without adding a global test role.
const custom = { role: "queueVisibilityCustom", payload: "notification", timestamp: 2 } as unknown as AgentMessage;

describe("Agent queue visibility", () => {
	for (const mode of ["one-at-a-time", "all"] as const) {
		for (const message of [user, custom]) {
			for (const lane of ["steering", "followUp"] as const) {
				it(`${mode}/${message.role}/${lane}: observes only the requested lane without consuming`, () => {
					const agent = new Agent({ streamFn: unusedStream, steeringMode: mode, followUpMode: mode });
					expect(agent.hasQueuedMessages()).toBe(false);
					expect(agent.hasQueuedMessages("steering")).toBe(false);
					expect(agent.hasQueuedMessages("followUp")).toBe(false);

					agent[lane === "steering" ? "steer" : "followUp"](message);
					for (let i = 0; i < 2; i++) {
						expect(agent.hasQueuedMessages()).toBe(true);
						expect(agent.hasQueuedMessages("steering")).toBe(lane === "steering");
						expect(agent.hasQueuedMessages("followUp")).toBe(lane === "followUp");
					}
					expect(agent.takeQueuedMessages()).toMatchObject({
						initial: [],
						steering: lane === "steering" ? [message] : [],
						followUp: lane === "followUp" ? [message] : [],
					});
					expect(agent.hasQueuedMessages()).toBe(false);
					expect(agent.hasQueuedMessages("steering")).toBe(false);
					expect(agent.hasQueuedMessages("followUp")).toBe(false);
				});
			}
		}
	}

	it("keeps follow-up visibility independent when steering also exists", () => {
		const agent = new Agent({ streamFn: unusedStream });
		agent.steer(custom);
		agent.followUp(user);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.hasQueuedMessages("steering")).toBe(true);
		expect(agent.hasQueuedMessages("followUp")).toBe(true);
		agent.clearSteeringQueue();
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.hasQueuedMessages("steering")).toBe(false);
		expect(agent.hasQueuedMessages("followUp")).toBe(true);
		expect(agent.takeQueuedMessages().followUp).toEqual([user]);
	});
});
