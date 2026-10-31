import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createAssistantOutputExtension } from "../../src/extensions/assistant-output/index.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getToolResult,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

function echoExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echo text.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo: ${text}` }], details: {} }),
	});
}

/** Both persisted history and live events must put assistant output after its matching outer result. */
function expectOutputAfterResult(harness: Harness, toolName: string, text: string): void {
	const result = getToolResult(harness, toolName);
	const resultIndex = harness.session.messages.indexOf(result);
	const outputIndex = harness.session.messages.findIndex(
		(message) => message.role === "assistant" && getMessageText(message) === text,
	);
	expect(resultIndex).toBeGreaterThan(-1);
	expect(outputIndex).toBeGreaterThan(resultIndex);
	const ended = harness.eventsOfType("message_end").map((event) => event.message);
	const resultEvent = ended.findIndex(
		(message) => message.role === "toolResult" && message.toolCallId === result.toolCallId,
	);
	const outputEvent = ended.findIndex((message) => message.role === "assistant" && getMessageText(message) === text);
	expect(resultEvent).toBeGreaterThan(-1);
	expect(outputEvent).toBeGreaterThan(resultEvent);
}

describe("AgentSession assistant output tools", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
	});

	async function setup(options: HarnessOptions = {}) {
		const harness = await createHarness({
			initialActiveToolNames: ["send_commentary", "finish_turn", "codemode", "echo"],
			...options,
			extensionFactories: [
				createAssistantOutputExtension(),
				createCodemodeExtension(),
				echoExtension,
				...(options.extensionFactories ?? []),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(
			options.initialActiveToolNames ?? ["send_commentary", "finish_turn", "codemode", "echo"],
		);
		return harness;
	}

	it("delivers direct commentary as an assistant message in the next provider context", async () => {
		const h = await setup();
		const observed: Array<{ role: string; text: string }> = [];
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("send_commentary", { message: "Checking the result." }), {
				stopReason: "toolUse",
			}),
			(context) => {
				observed.push(
					...context.messages.map((message) => ({ role: message.role, text: getMessageText(message) })),
				);
				return fauxAssistantMessage("Provider final.");
			},
		]);

		await h.session.prompt("Check it.");

		expect(observed.filter((message) => message.text === "Checking the result.")).toEqual([
			{ role: "assistant", text: "Checking the result." },
		]);
		expectOutputAfterResult(h, "send_commentary", "Checking the result.");
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Checking the result.", "Provider final."]);
		expect(h.faux.state.callCount).toBe(2);
	});

	it.each(["The work is complete.", ""])(
		"finishes directly with message %j without a post-tool request",
		async (message) => {
			const h = await setup();
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("finish_turn", { message }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Unexpected post-tool request."),
			]);

			await h.session.prompt("Finish now.");

			expect(h.faux.state.callCount).toBe(1);
			expect(getToolResult(h, "finish_turn").isError).toBe(false);
			expect(getAssistantTexts(h).filter(Boolean)).toEqual(message ? [message] : []);
			// The provider's tool-call message remains, but silent finish adds no blank assistant message.
			expect(h.session.messages.filter((item) => item.role === "assistant")).toHaveLength(message ? 2 : 1);
			if (message) expectOutputAfterResult(h, "finish_turn", message);
		},
	);

	it("discovers ordinary output tools in codemode and sends commentary before continuing", async () => {
		const h = await setup({ initialActiveToolNames: ["codemode"] });
		let seen = false;
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: `
						for (const name of ["send_commentary", "finish_turn"]) {
							if (!ALL_TOOLS.some((tool) => tool.name === name)) throw new Error("Missing " + name);
							await describeTool(name);
						}
						await tools.send_commentary({ message: "Nested progress." });
						text("script kept running");
					`,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				seen = context.messages.some(
					(message) => message.role === "assistant" && getMessageText(message) === "Nested progress.",
				);
				return fauxAssistantMessage("Nested final.");
			},
		]);

		await h.session.prompt("Run a script.");

		expect(seen).toBe(true);
		expect(getToolResult(h, "codemode").isError).toBe(false);
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("script kept running");
		expectOutputAfterResult(h, "codemode", "Nested progress.");
		expect(h.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});

	it("finishes from a mixed nested batch without cancelling the script or sibling tools", async () => {
		const h = await setup({ initialActiveToolNames: ["codemode", "echo"] });
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							await Promise.all([
								tools.send_commentary({ message: "Batch progress." }),
								tools.finish_turn({ message: "Batch complete." }),
								tools.echo({ text: "nested sibling" }),
							]);
							text(await tools.echo({ text: "after finish" }));
						`,
					}),
					fauxToolCall("echo", { text: "outer sibling" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Unexpected continuation."),
		]);

		await h.session.prompt("Run the batch.");

		expect(h.faux.state.callCount).toBe(1);
		expect(getToolResult(h, "codemode").isError).toBe(false);
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("echo: after finish");
		expect(getMessageText(getToolResult(h, "echo"))).toBe("echo: outer sibling");
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Batch progress.", "Batch complete."]);
		expectOutputAfterResult(h, "codemode", "Batch progress.");
		expectOutputAfterResult(h, "codemode", "Batch complete.");
	});

	it("discards a failed script's pending finish and allows the next prompt's ordinary tool continuation", async () => {
		const h = await setup({ initialActiveToolNames: ["codemode", "echo"] });
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'await tools.finish_turn({ message: "Must not escape the failed script." }); throw new Error("script failed");',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Recovered from failure."),
			fauxAssistantMessage(fauxToolCall("echo", { text: "next prompt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Answered the next prompt."),
		]);

		await h.session.prompt("Run a failing script.");
		expect(getToolResult(h, "codemode").isError).toBe(true);
		expect(h.faux.state.callCount).toBe(2);
		await h.session.prompt("Try something else.");

		expect(h.faux.state.callCount).toBe(4);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Recovered from failure.", "Answered the next prompt."]);
		expect(getMessageText(getToolResult(h, "echo"))).toBe("echo: next prompt");
	});

	it("does not finish when a result hook rejects the nested finish call but the script recovers", async () => {
		const h = await setup({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) =>
						event.toolName === "finish_turn"
							? { isError: true, content: [{ type: "text", text: "Completion rejected by result hook." }] }
							: undefined,
					);
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'try { await tools.finish_turn({ message: "Rejected final." }); } catch {} text("script recovered");',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Provider handled the rejection."),
		]);

		await h.session.prompt("Try to finish.");

		expect(getToolResult(h, "codemode").isError).toBe(false);
		expect(getMessageText(getToolResult(h, "codemode"))).toContain("script recovered");
		expect(h.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Provider handled the rejection."]);
	});

	it("keeps a queued user follow-up after finish", async () => {
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName === "finish_turn") {
							pi.sendUserMessage("Queued next request.", { deliverAs: "followUp" });
						}
					});
				},
			],
		});
		let sawFollowUp = false;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("finish_turn", { message: "Finished first request." }), {
				stopReason: "toolUse",
			}),
			(context) => {
				sawFollowUp = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "Queued next request.",
				);
				return fauxAssistantMessage("Answered queued request.");
			},
		]);

		await h.session.prompt("Finish with work queued.");

		expect(sawFollowUp).toBe(true);
		expect(h.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Finished first request.", "Answered queued request."]);
	});

	it("still allows the normal pre-settlement hook to request a continuation", async () => {
		let continued = false;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						if (continued) return;
						continued = true;
						return {
							entries: [
								{
									type: "custom_message",
									customType: "test-continuation",
									content: "Run the final check.",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("finish_turn", { message: "Tool final." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Hook continuation final."),
		]);

		await h.session.prompt("Finish, then run normal hooks.");

		expect(continued).toBe(true);
		expect(h.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Tool final.", "Hook continuation final."]);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("allows an explicit turn-end continuation whose context includes the native final", async () => {
		let continued = false;
		let finalInHookContext = false;
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (continued) return;
						continued = true;
						finalInHookContext = event.context.contextMessages.some(
							(message) => message.role === "assistant" && getMessageText(message) === "Turn-end final.",
						);
						return {
							entries: [
								{
									type: "custom_message",
									customType: "test-turn-continuation",
									content: "Verify the final result.",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		let finalInProviderContext = false;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("finish_turn", { message: "Turn-end final." }), { stopReason: "toolUse" }),
			(context) => {
				finalInProviderContext = context.messages.some(
					(message) => message.role === "assistant" && getMessageText(message) === "Turn-end final.",
				);
				return fauxAssistantMessage("Verified final.");
			},
		]);

		await h.session.prompt("Finish with an explicit turn-end continuation.");

		expect(finalInHookContext).toBe(true);
		expect(finalInProviderContext).toBe(true);
		expect(h.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Turn-end final.", "Verified final."]);
	});

	it("discards pending output when the enclosing script aborts", async () => {
		let entered!: () => void;
		const holding = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const h = await setup({
			initialActiveToolNames: ["codemode", "echo", "hold_until_abort"],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "hold_until_abort",
						label: "Hold until abort",
						description: "Wait for this call to be aborted.",
						parameters: Type.Object({}),
						execute: async (_id, _params, signal) => {
							if (!signal) throw new Error("Expected an abort signal");
							await new Promise<void>((resolve) => {
								signal.addEventListener("abort", () => resolve(), { once: true });
								entered();
							});
							throw new Error("Holding call aborted");
						},
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'await tools.send_commentary({ message: "Aborted progress." }); await tools.finish_turn({ message: "Aborted final." }); await tools.hold_until_abort({});',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("echo", { text: "after abort" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Answered after abort."),
		]);
		const running = h.session.prompt("Start a script that will be aborted.");
		await holding;
		expect(h.eventsOfType("tool_execution_end").some((event) => event.toolName === "finish_turn")).toBe(true);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual([]);
		await h.session.abort();
		await running;
		await h.session.prompt("Continue after abort.");

		expect(h.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["Answered after abort."]);
	});

	it("allows a subsequent user prompt after a successful finish", async () => {
		const h = await setup();
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("finish_turn", { message: "First answer." }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("echo", { text: "fresh request" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Second answer."),
		]);

		await h.session.prompt("First request.");
		expect(h.faux.state.callCount).toBe(1);
		await h.session.prompt("Second request.");

		expect(h.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(h).filter(Boolean)).toEqual(["First answer.", "Second answer."]);
	});

	it("persists assistant output once and resumes without replaying finish", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-assistant-output-"));
		directories.push(directory);
		const first = await setup({ sessionManager: SessionManager.create(directory, directory) });
		first.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'await tools.send_commentary({ message: "Saved progress." }); await tools.finish_turn({ message: "Saved final." });',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Unexpected continuation."),
		]);
		await first.session.prompt("Save the answer.");
		expect(first.faux.state.callCount).toBe(1);
		const path = first.sessionManager.getSessionFile();
		if (!path) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(path);
		const savedMessages = reopened.buildSessionContext().messages;
		expect(
			savedMessages
				.filter((message) => message.role === "assistant")
				.map(getMessageText)
				.filter(Boolean),
		).toEqual(["Saved progress.", "Saved final."]);
		const savedFinal = savedMessages.find(
			(message) => message.role === "assistant" && getMessageText(message) === "Saved final.",
		);
		expect(savedFinal).toBeDefined();
		expect(savedFinal).not.toHaveProperty("outputFromToolCallId");
		const replay = convertToLlm(savedMessages);
		const conversation = replay.filter((message) => message.role === "assistant" || message.role === "toolResult");
		expect(conversation.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant"]);
		expect(getMessageText(conversation[0])).toBe("Saved progress.");
		expect(conversation[1]).toMatchObject({ toolCallId: getToolResult(first, "codemode").toolCallId });
		expect(conversation[2]).toEqual(savedFinal);
		expect(savedMessages.find((message) => getMessageText(message) === "Saved progress.")).toHaveProperty(
			"outputFromToolCallId",
			getToolResult(first, "codemode").toolCallId,
		);
		const resumed = await setup({ sessionManager: reopened });
		resumed.session.refreshContext();
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "resumed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Resumed answer."),
		]);

		await resumed.session.prompt("Continue after resume.");

		expect(resumed.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(resumed).filter(Boolean)).toEqual([
			"Saved progress.",
			"Saved final.",
			"Resumed answer.",
		]);
		expect(
			resumed.eventsOfType("message_end").filter((event) => getMessageText(event.message) === "Saved final."),
		).toHaveLength(0);
	});
});
