import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

// Exercise the context received by an executing extension tool, including the
// AgentSession binding: user-text UI counts intentionally omit custom input.
describe("extension tool queue visibility", () => {
	for (const role of ["user", "custom"] as const) {
		for (const lane of ["steering", "followUp"] as const) {
			it(`${role}/${lane}: sees live queued input without consuming it`, async () => {
				const started = Promise.withResolvers<ExtensionToolContext>();
				const release = Promise.withResolvers<void>();
				const h = await createHarness({
					tools: [],
					extensionFactories: [
						(pi) => {
							pi.registerTool({
								name: "wait_for_queue",
								label: "Wait for queue",
								description: "Hold a tool call while input is queued.",
								parameters: Type.Object({}),
								execute: async (_id, _params, _signal, _onUpdate, ctx) => {
									started.resolve(ctx);
									await release.promise;
									return { content: [{ type: "text", text: "released" }], details: {} };
								},
							});
						},
					],
				});
				let prompt: Promise<void> | undefined;
				try {
					await h.session.bindExtensions({});
					h.session.setActiveToolsByName(["wait_for_queue"]);
					h.setResponses([
						fauxAssistantMessage(fauxToolCall("wait_for_queue", {}), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					prompt = h.session.prompt("start");
					const ctx = await started.promise;
					expect(ctx.hasPendingMessages()).toBe(false);
					expect(ctx.hasPendingSteeringMessages()).toBe(false);

					if (role === "user") {
						await h.session[lane === "steering" ? "steer" : "followUp"]("queued input");
					} else {
						await h.session.sendCustomMessage(
							{ customType: "queue-visibility", content: "queued input", display: false },
							{ deliverAs: lane === "steering" ? "steer" : "followUp" },
						);
					}
					for (let i = 0; i < 2; i++) {
						expect(ctx.hasPendingMessages()).toBe(true);
						expect(ctx.hasPendingSteeringMessages()).toBe(lane === "steering");
					}
					expect(h.session.pendingMessageCount).toBe(role === "user" ? 1 : 0);
					expect(h.session.getSteeringMessages()).toEqual(
						role === "user" && lane === "steering" ? ["queued input"] : [],
					);
					expect(h.session.getFollowUpMessages()).toEqual(
						role === "user" && lane === "followUp" ? ["queued input"] : [],
					);

					release.resolve();
					await prompt;
					expect(ctx.hasPendingMessages()).toBe(false);
					expect(ctx.hasPendingSteeringMessages()).toBe(false);
					expect(
						h.session.messages.filter(
							(message) => message.role === role && JSON.stringify(message.content).includes("queued input"),
						),
					).toHaveLength(1);
				} finally {
					release.resolve();
					await prompt;
					h.cleanup();
				}
			});
		}
	}
});
