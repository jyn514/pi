import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

function createHeldInput() {
	let release = () => {};
	let markStarted = () => {};
	let markReturned = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const returned = new Promise<void>((resolve) => {
		markReturned = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		started,
		returned,
		release: () => release(),
		extension: (pi: ExtensionAPI) => {
			pi.on("input", async (event) => {
				if (event.text !== "held input") return;
				markStarted();
				await released;
				markReturned();
				return { action: "transform", text: "transformed held input" };
			});
		},
	};
}

const queuePaths = ["prompt steer", "prompt followUp", "steer", "followUp"] as const;

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("clears pause state when disposed", async () => {
		const harness = await createHarness({ tools: [] });
		harness.session.requestPause();
		expect(harness.session.pauseState).toBe("paused");

		harness.cleanup();

		expect(harness.session.pauseState).toBe("unpaused");
	});

	it("exposes pause and resume through the extension API", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);

		expect(extensionApi?.getPauseState()).toBe("unpaused");
		extensionApi?.requestPause();
		expect(extensionApi?.getPauseState()).toBe("paused");

		extensionApi?.resume();
		expect(extensionApi?.getPauseState()).toBe("unpaused");
	});

	it("completes a pending pause when an active agent run throws", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let rejectPrompt: ((error: Error) => void) | undefined;
		const agentPrompt = vi.spyOn(harness.session.agent, "prompt").mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
				}),
		);

		const promptPromise = harness.session.prompt("start");
		const rejection = expect(promptPromise).rejects.toThrow("provider failed unexpectedly");
		await vi.waitFor(() => expect(agentPrompt).toHaveBeenCalledOnce());

		harness.session.requestPause();
		expect(harness.session.pauseState).toBe("pausing");
		rejectPrompt?.(new Error("provider failed unexpectedly"));
		await rejection;

		expect(harness.session.pauseState).toBe("paused");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("pauses after a complete tool turn and resumes its required continuation", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const pauseStates: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after pause"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "pause_state_changed") pauseStates.push(event.state);
		});

		await waitForToolStart;
		harness.session.requestPause();
		expect(harness.session.pauseState).toBe("pausing");
		releaseToolExecution();

		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).toEqual([""]);

		harness.session.resume();
		await promptPromise;

		expect(getAssistantTexts(harness)).toEqual(["", "continued after pause"]);
		expect(pauseStates).toEqual(["pausing", "paused", "unpaused"]);
	});

	it("does not let a stale resume bypass a new pause request", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued"),
		]);

		await waitForToolStart;
		harness.session.requestPause();
		releaseToolExecution();
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));

		harness.session.resume();
		harness.session.requestPause();
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));
		expect(harness.faux.state.callCount).toBe(1);

		harness.session.resume();
		await promptPromise;
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not continue after a terminating tool result when resumed", async () => {
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const terminatingTool: AgentTool = {
			name: "terminate",
			label: "Terminate",
			description: "Terminate after release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
			},
		};
		const harness = await createHarness({ tools: [terminatingTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("terminate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "terminate") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		harness.session.requestPause();
		releaseTool?.();
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));

		harness.session.resume();
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels a requested pause when resumed before the turn boundary", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const pauseStates: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued without parking"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "pause_state_changed") pauseStates.push(event.state);
		});

		await waitForToolStart;
		harness.session.requestPause();
		harness.session.resume();
		releaseToolExecution();
		await promptPromise;

		expect(getAssistantTexts(harness)).toEqual(["", "continued without parking"]);
		expect(pauseStates).toEqual(["pausing", "unpaused"]);
	});

	it("aborts a parked session without starting its continuation", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await waitForToolStart;
		harness.session.requestPause();
		releaseToolExecution();
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));

		await harness.session.abort();
		await promptPromise;

		expect(harness.session.pauseState).toBe("unpaused");
		expect(harness.session.isIdle).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).toEqual([""]);
	});

	it("rejects new work while paused and accepts it after resume", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("blocked", {
						description: "Must not run while paused",
						handler: async () => {
							commandRuns.push("ran");
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.requestPause();

		await expect(harness.session.prompt("blocked")).rejects.toThrow(
			"Session is paused; resume it before submitting work.",
		);
		await expect(harness.session.steer("blocked")).rejects.toThrow(
			"Session is paused; resume it before submitting work.",
		);
		await expect(harness.session.followUp("blocked")).rejects.toThrow(
			"Session is paused; resume it before submitting work.",
		);
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "blocked", content: "blocked", display: false, details: {} },
				{ triggerTurn: true },
			),
		).rejects.toThrow("Session is paused; resume it before submitting work.");
		await expect(harness.session.prompt("/blocked")).rejects.toThrow(
			"Session is paused; resume it before submitting work.",
		);
		expect(commandRuns).toEqual([]);

		const bashResult = await harness.session.executeBash("printf allowed");
		expect(bashResult.output).toBe("allowed");

		harness.session.resume();
		harness.setResponses([fauxAssistantMessage("accepted")]);
		await harness.session.prompt("allowed");
		expect(getAssistantTexts(harness)).toEqual(["accepted"]);
	});

	it("does not admit a provider run when paused during asynchronous prompt preflight", async () => {
		let releaseInput: (() => void) | undefined;
		let markInputStarted: (() => void) | undefined;
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						markInputStarted?.();
						await inputRelease;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "retained", content: "queued context", display: false, details: {} },
			{ deliverAs: "nextTurn" },
		);

		const promptPromise = harness.session.prompt("blocked during preflight");
		await inputStarted;
		harness.session.requestPause();
		expect(harness.session.pauseState).toBe("paused");
		releaseInput?.();

		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));
		expect(harness.faux.state.callCount).toBe(0);

		harness.setResponses([
			(context) =>
				fauxAssistantMessage(
					context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "queued context"),
					)
						? "retained context"
						: "lost context",
				),
		]);
		harness.session.resume();
		await promptPromise;
		expect(getAssistantTexts(harness)).toEqual(["retained context"]);
	});

	it("aborts a provider admission parked after asynchronous prompt preflight", async () => {
		let releaseInput: (() => void) | undefined;
		let markInputStarted: (() => void) | undefined;
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						markInputStarted?.();
						await inputRelease;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "retained-after-abort", content: "retained after abort", display: false, details: {} },
			{ deliverAs: "nextTurn" },
		);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const preflightCancelled = vi.fn();

		const promptPromise = harness.session.prompt("abort during preflight", { preflightCancelled });
		await inputStarted;
		harness.session.requestPause();
		releaseInput?.();
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));

		await harness.session.abort();
		await promptPromise;

		expect(preflightCancelled).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isIdle).toBe(true);

		harness.setResponses([
			(context) =>
				fauxAssistantMessage(
					context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "retained after abort"),
					)
						? "retained"
						: "lost",
				),
		]);
		await harness.session.prompt("after abort");
		expect(getAssistantTexts(harness)).toEqual(["retained"]);
	});

	it("cancels normal prompt input still held when abort returns, preserving accepted queues", async () => {
		const input = createHeldInput();
		const harness = await createHarness({ tools: [], extensionFactories: [input.extension] });
		harnesses.push(harness);
		await harness.session.steer("accepted steer");
		await harness.session.followUp("accepted follow-up");
		const preflightCancelled = vi.fn();
		const preflightResult = vi.fn();
		const submission = harness.session.prompt("held input", { preflightCancelled, preflightResult });
		await input.started;

		await harness.session.abort();
		// A later pause must not park work already cancelled by abort.
		harness.session.requestPause();
		input.release();
		await submission;

		expect(preflightCancelled).toHaveBeenCalledOnce();
		expect(preflightResult).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual(["accepted steer"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["accepted follow-up"]);
		harness.session.resume();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await harness.session.prompt("after abort");
		expect(getUserTexts(harness)).toEqual(["after abort", "accepted steer", "accepted follow-up"]);
	});

	it.each(queuePaths)("cancels held %s input on abort without losing accepted queues", async (path) => {
		const input = createHeldInput();
		const waiting = await createWaitingHarness({ extensionFactories: [input.extension] });
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
		await waitForToolStart;
		await harness.session.steer("accepted steer");
		await harness.session.followUp("accepted follow-up");
		const preflightCancelled = vi.fn();
		const preflightResult = vi.fn();
		const submission =
			path === "prompt steer" || path === "prompt followUp"
				? harness.session.prompt("held input", {
						streamingBehavior: path === "prompt steer" ? "steer" : "followUp",
						preflightCancelled,
						preflightResult,
					})
				: harness.session[path]("held input");
		const settled =
			path === "steer" || path === "followUp"
				? expect(submission).rejects.toThrow("Input cancelled before acceptance.")
				: expect(submission).resolves.toBeUndefined();
		await input.started;

		// Complete input while abort is settling: the run is still streaming,
		// so prompt() must cancel rather than commit to its streaming queue branch.
		const abort = harness.session.abort();
		try {
			input.release();
			await settled;
		} finally {
			// The test tool is non-abortable; let the admitted run settle.
			releaseToolExecution();
			await abort;
			await promptPromise;
		}

		expect(preflightResult).not.toHaveBeenCalled();
		if (path.startsWith("prompt")) expect(preflightCancelled).toHaveBeenCalledOnce();
		expect(harness.session.getSteeringMessages()).toEqual(["accepted steer"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["accepted follow-up"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await harness.session.prompt("after abort");
		expect(getUserTexts(harness)).toEqual(["start", "after abort", "accepted steer", "accepted follow-up"]);
	});

	it.each(queuePaths)("parks preflight-held %s input until resume before queue acceptance", async (path) => {
		const input = createHeldInput();
		const waiting = await createWaitingHarness({ extensionFactories: [input.extension] });
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued"),
			fauxAssistantMessage("followed up"),
		]);
		await waitForToolStart;
		const preflightResult = vi.fn();
		let accepted = false;
		const submission = (
			path === "prompt steer" || path === "prompt followUp"
				? harness.session.prompt("held input", {
						streamingBehavior: path === "prompt steer" ? "steer" : "followUp",
						preflightResult,
					})
				: harness.session[path]("held input")
		).then((result) => {
			accepted = true;
			return result;
		});
		// Disposal cancels admission if an ordering assertion fails before resume.
		void submission.catch(() => {});
		await input.started;
		harness.session.requestPause();
		input.release();
		await input.returned;
		// Input admission must not publish paused before the held tool finishes.
		await new Promise((resolve) => setTimeout(resolve, 0));
		try {
			expect(harness.session.pauseState).toBe("pausing");
			expect(harness.eventsOfType("pause_state_changed").map((event) => event.state)).toEqual(["pausing"]);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
			expect(accepted).toBe(false);
			expect(harness.session.pendingMessageCount).toBe(0);
		} finally {
			releaseToolExecution();
		}
		await vi.waitFor(() => expect(harness.session.pauseState).toBe("paused"));
		expect(accepted).toBe(false);
		expect(preflightResult).not.toHaveBeenCalled();
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);

		harness.session.resume();
		const result = await submission;
		if (path.startsWith("prompt")) expect(preflightResult).toHaveBeenCalledWith("queued");
		else expect(result).toBe("queued");
		await promptPromise;
		expect(getUserTexts(harness)).toEqual(["start", "transformed held input"]);
	});

	it.each(["steer", "followUp"] as const)(
		"aborts parked direct %s admission even if paused again",
		async (behavior) => {
			const input = createHeldInput();
			const harness = await createHarness({ tools: [], extensionFactories: [input.extension] });
			harnesses.push(harness);
			const submission = harness.session[behavior]("held input");
			const rejection = expect(submission).rejects.toThrow("Input cancelled before acceptance.");
			await input.started;
			harness.session.requestPause();
			input.release();
			await input.returned;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(harness.session.pendingMessageCount).toBe(0);

			const abort = harness.session.abort();
			harness.session.requestPause();
			await abort;
			await rejection;
			expect(harness.session.pauseState).toBe("paused");
			expect(harness.session.pendingMessageCount).toBe(0);
		},
	);

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	// Regression test for #8718.
	it("runs direct steering and follow-up messages through input handlers", async () => {
		const inputEvents: Array<Pick<InputEvent, "text" | "source" | "streamingBehavior">> = [];
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push({
							text: event.text,
							source: event.source,
							streamingBehavior: event.streamingBehavior,
						});
						if (event.text.startsWith("handle")) return { action: "handled" };
						return { action: "transform", text: `transformed: ${event.text}` };
					});
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed up"),
		]);

		await waitForToolStart;
		inputEvents.length = 0;
		try {
			await harness.session.steer("steer me", undefined, { source: "rpc" });
			await harness.session.steer("handle steer", undefined, { source: "rpc" });
			await harness.session.followUp("follow me", undefined, { source: "rpc" });
			await harness.session.followUp("handle follow", undefined, { source: "rpc" });

			expect(inputEvents).toEqual([
				{ text: "steer me", source: "rpc", streamingBehavior: "steer" },
				{ text: "handle steer", source: "rpc", streamingBehavior: "steer" },
				{ text: "follow me", source: "rpc", streamingBehavior: "followUp" },
				{ text: "handle follow", source: "rpc", streamingBehavior: "followUp" },
			]);
			expect(harness.session.getSteeringMessages()).toEqual(["transformed: steer me"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["transformed: follow me"]);
		} finally {
			releaseToolExecution();
		}
		await promptPromise;
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"custom",
			"assistant",
		]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});
});
