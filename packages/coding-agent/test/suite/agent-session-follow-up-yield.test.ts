import { contentText, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult } from "./harness.ts";

describe("AgentSession follow-up yields", () => {
	for (const call of ["direct", "forwarded", "codemode"] as const) {
		it(`${call}: exposes call origin and only direct results select queued follow-ups`, async () => {
			const started = Promise.withResolvers<ExtensionToolContext>();
			const release = Promise.withResolvers<void>();
			const requests: string[][] = [];
			const h = await createHarness({
				tools: [],
				extensionFactories: [
					createCodemodeExtension(),
					(pi) => {
						pi.registerTool({
							name: "wait_for_input",
							label: "Wait for input",
							description: "Wait for queued input.",
							parameters: Type.Object({}),
							async execute(_id, _params, _signal, _onUpdate, ctx) {
								started.resolve(ctx);
								await release.promise;
								return {
									content: [{ type: "text", text: "interrupted" }],
									details: {},
									yieldToFollowUps: true,
								};
							},
						});
						pi.registerTool({
							name: "forward",
							label: "Forward",
							description: "Forward a nested result unchanged.",
							parameters: Type.Object({}),
							async execute(_id, _params, _signal, _onUpdate, ctx) {
								expect(ctx.isDirectToolCall).toBe(true);
								return (await ctx.executeTool("wait_for_input", {})).result;
							},
						});
					},
				],
			});
			let running: Promise<void> | undefined;
			try {
				await h.session.bindExtensions({});
				h.session.setActiveToolsByName(["wait_for_input", "forward", "codemode"]);
				const record = (context: TranscriptContext) => {
					requests.push(
						context.messages.flatMap((message) =>
							message.role === "user" ? [contentText(message.content)] : [],
						),
					);
					return fauxAssistantMessage("done");
				};
				const toolCall =
					call === "direct"
						? fauxToolCall("wait_for_input", {})
						: call === "forwarded"
							? fauxToolCall("forward", {})
							: fauxToolCall("codemode", { code: "return await tools.wait_for_input({});" });
				h.setResponses([fauxAssistantMessage(toolCall, { stopReason: "toolUse" }), record, record]);
				running = h.session.prompt("start");
				const ctx = await started.promise;
				expect(ctx.isDirectToolCall).toBe(call === "direct");
				await h.session.followUp("queued follow-up");
				expect(ctx.hasPendingMessages()).toBe(true);
				expect(ctx.hasPendingSteeringMessages()).toBe(false);
				release.resolve();
				await running;

				expect(requests).toEqual(
					call === "direct" ? [["start", "queued follow-up"]] : [["start"], ["start", "queued follow-up"]],
				);
				expect(
					h.session.messages.filter(
						(message) => message.role === "user" && contentText(message.content) === "queued follow-up",
					),
				).toHaveLength(1);
				expect(h.session.getFollowUpMessages()).toEqual([]);
				expect(h.session.pendingMessageCount).toBe(0);
				const result = getToolResult(h, toolCall.name);
				expect(result.isError).toBe(false);
				expect(result).not.toHaveProperty("yieldToFollowUps");
				const persisted = h.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
				expect(persisted).toMatchObject({
					type: "message",
					message: { role: "toolResult", toolName: toolCall.name },
				});
				expect(persisted).not.toHaveProperty("message.yieldToFollowUps");
			} finally {
				release.resolve();
				await running;
				h.cleanup();
			}
		});
	}
});
