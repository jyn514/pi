import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHandoff } from "../../src/core/agent-session.ts";
import type { ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** A stalled admission should fail locally, not consume the suite's 30-second timeout. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("handoff/admission did not settle")), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const custom = (content: string) => ({ customType: "handoff-test", content, display: false, details: { content } });

describe("AgentSession durable handoff and fresh admission", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	const releases: Array<() => void> = [];

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function harness(options: HarnessOptions = {}, durable = true) {
		const directory = mkdtempSync(join(tmpdir(), "pi-handoff-"));
		directories.push(directory);
		const result = await createHarness({
			...options,
			sessionManager: durable ? SessionManager.create(directory, directory) : SessionManager.inMemory(),
		});
		harnesses.push(result);
		return result;
	}

	function blockedSessionFile(h: Harness) {
		const path = h.sessionManager.getSessionFile()!;
		let original: string | undefined;
		const restore = () => {
			if (original === undefined) return;
			rmSync(path, { recursive: true, force: true });
			writeFileSync(path, original);
			original = undefined;
		};
		releases.push(restore);
		return {
			block: () => {
				original = readFileSync(path, "utf8");
				rmSync(path);
				mkdirSync(path);
			},
			restore,
		};
	}

	function heldTool() {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		let executions = 0;
		const tool: AgentTool = {
			name: "held",
			label: "Held",
			description: "Complete only when released by the test",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				entered.release();
				await finish.promise;
				return { content: [{ type: "text", text: "completed exactly once" }], details: { executions } };
			},
		};
		return { tool, entered: entered.promise, finish: finish.release, executions: () => executions };
	}

	// Both modes must export the entire lanes, not the next scheduler-selected batch.
	it.each(["one-at-a-time", "all"] as const)(
		"finishes a running tool once and transfers complete %s queues after transcript flushes",
		async (mode) => {
			const held = heldTool();
			const h = await harness({ tools: [held.tool] });
			h.session.setSteeringMode(mode);
			h.session.setFollowUpMode(mode);
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not request a continuation"),
			]);
			const running = h.session.prompt("start");
			await bounded(held.entered);
			for (const lane of ["steer", "followUp"] as const) {
				await h.session[lane](`${lane} first`, [image]);
				await h.session[lane](`${lane} second`, [image]);
			}
			await h.session.sendCustomMessage(custom("next turn"), { deliverAs: "nextTurn" });
			await h.session.sendCustomMessage(custom("flushed custom"), { triggerTurn: false });
			h.session.recordBashResult("printf saved", {
				output: "saved bash output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});

			let returned = false;
			const stopping = h.session.handoff("generation-1").then((result) => {
				returned = true;
				return result;
			});
			expect(h.session.pauseState).toBe("pausing");
			expect(returned).toBe(false);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
			held.finish();
			const saved = await bounded(stopping);
			await bounded(running);

			expect(saved).toMatchObject({
				requestId: "generation-1",
				sessionId: h.sessionManager.getSessionId(),
				sessionFile: h.sessionManager.getSessionFile(),
				leafId: h.sessionManager.getLeafId(),
				wasActive: true,
				queueModes: { steering: mode, followUp: mode },
			});
			for (const [lane, prefix] of [
				["steering", "steer"],
				["followUp", "followUp"],
			] as const) {
				expect(saved.pending[lane].map(getMessageText)).toEqual([`${prefix} first`, `${prefix} second`]);
				for (const message of saved.pending[lane]) {
					expect(message).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
				}
			}
			expect(saved.pending.nextTurn).toEqual([expect.objectContaining(custom("next turn"))]);
			expect(saved.pending.deferred).toEqual([]);
			expect(JSON.stringify(saved.pending)).not.toContain("flushed custom");
			expect(JSON.stringify(saved.pending)).not.toContain("saved bash output");
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.getSteeringMessages()).toEqual([]);
			expect(h.session.getFollowUpMessages()).toEqual([]);
			expect(held.executions()).toBe(1);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
			expect(h.faux.state.callCount).toBe(1);
			const reopened = SessionManager.open(saved.sessionFile);
			const messages = reopened.buildSessionContext().messages;
			expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			expect(messages.filter((message) => getMessageText(message) === "flushed custom")).toHaveLength(1);
			expect(messages.filter((message) => message.role === "bashExecution")).toHaveLength(1);
			expect(reopened.getLeafId()).toBe(saved.leafId);

			expect(await bounded(h.session.handoff("generation-1"))).toEqual(saved);
			await expect(bounded(h.session.handoff("generation-2"))).rejects.toThrow();
			await h.session.abort();
			expect(await bounded(h.session.submitInput({ kind: "raw", text: "late input" }))).toMatchObject({
				disposition: "rejected",
				error: expect.any(String),
			});
			expect(await bounded(h.session.handoff("generation-1"))).toEqual(saved);
			expect(h.faux.state.callCount).toBe(1);
		},
	);

	it("accepts ownership of a directly prepared message buffered before disk append fails and reports the failure", async () => {
		const h = await harness();
		const diagnostic = gate();
		const errors: string[] = [];
		await h.session.bindExtensions({
			onError: (error) => {
				errors.push(error.error);
				diagnostic.release();
			},
		});
		h.sessionManager.ensurePersisted();
		const disk = blockedSessionFile(h);
		disk.block();

		const result = await bounded(h.session.submitInput({ kind: "prepared", message: custom("buffered admission") }));

		expect(result).toEqual({ disposition: "handled" });
		await bounded(diagnostic.promise);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/EISDIR|directory|flush|persist/i);
		expect(
			h.sessionManager
				.buildSessionContext()
				.messages.filter((message) => getMessageText(message) === "buffered admission"),
		).toHaveLength(1);
		disk.restore();
		const saved = await bounded(h.session.handoff("buffered-admission"));
		const messages = SessionManager.open(saved.sessionFile).buildSessionContext().messages;
		expect(messages.filter((message) => getMessageText(message) === "buffered admission")).toHaveLength(1);
		expect(JSON.stringify(saved.pending)).not.toContain("buffered admission");
		expect(h.faux.state.callCount).toBe(0);
	});

	it("rejects a custom-message flush failure and retries both buffered payloads exactly once after repair", async () => {
		const held = heldTool();
		const h = await harness({ tools: [held.tool] });
		const disk = blockedSessionFile(h);
		const faults: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "turn_end" && faults.length === 0) {
				disk.block();
				faults.push("blocked");
			}
			if (
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				/EISDIR|directory/i.test(event.message.errorMessage ?? "") &&
				faults.length === 1
			) {
				disk.restore();
				faults.push("repaired during loop failure");
			}
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		// Attach a rejection handler before releasing the tool, even if the loop fails unexpectedly.
		const running = h.session.prompt("start").then(
			() => undefined,
			() => undefined,
		);
		await bounded(held.entered);
		await h.session.sendCustomMessage(custom("custom-first"), { triggerTurn: false });
		await h.session.sendCustomMessage(custom("custom-second"), { triggerTurn: false });
		const stopping = expect(bounded(h.session.handoff("custom-flush-failure"))).rejects.toThrow(
			/EISDIR|directory|flush|persist/i,
		);
		held.finish();
		await stopping;
		await bounded(running);
		expect(faults).toEqual(["blocked", "repaired during loop failure"]);
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "still fenced" }))).toMatchObject({
			disposition: "rejected",
		});

		const saved = await bounded(h.session.handoff("custom-flush-failure"));
		const messages = SessionManager.open(saved.sessionFile).buildSessionContext().messages;
		for (const payload of ["custom-first", "custom-second"]) {
			expect(messages.filter((message) => getMessageText(message) === payload)).toHaveLength(1);
		}
		expect(JSON.stringify(saved.pending)).not.toContain("custom-first");
		expect(JSON.stringify(saved.pending)).not.toContain("custom-second");
		expect(held.executions()).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("rejects both prompt and handoff after a bash flush failure, then retries without duplicating the attempted item", async () => {
		const held = heldTool();
		const h = await harness({ tools: [held.tool] });
		const disk = blockedSessionFile(h);
		let blocked = false;
		h.session.subscribe((event) => {
			if (event.type === "agent_end" && !blocked) {
				blocked = true;
				disk.block();
			}
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const running = h.session.prompt("start").then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await bounded(held.entered);
		for (const output of ["bash-first", "bash-second"]) {
			h.session.recordBashResult(`printf ${output}`, { output, exitCode: 0, cancelled: false, truncated: false });
		}
		const stopping = expect(bounded(h.session.handoff("bash-flush-failure"))).rejects.toThrow(
			/EISDIR|directory|flush|persist/i,
		);
		held.finish();
		await stopping;
		const outcome = await bounded(running);
		expect(blocked).toBe(true);
		expect(outcome.status).toBe("rejected");
		if (outcome.status === "rejected") expect(String(outcome.error)).toMatch(/EISDIR|directory|flush|persist/i);
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "still fenced" }))).toMatchObject({
			disposition: "rejected",
		});
		disk.restore();

		const saved = await bounded(h.session.handoff("bash-flush-failure"));
		const messages = SessionManager.open(saved.sessionFile).buildSessionContext().messages;
		for (const output of ["bash-first", "bash-second"]) {
			expect(
				messages.filter((message) => message.role === "bashExecution" && message.output === output),
			).toHaveLength(1);
		}
		expect(h.session.hasPendingBashMessages).toBe(false);
		expect(held.executions()).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("materializes metadata-only history without inventing a conversation message", async () => {
		const h = await harness();
		h.sessionManager.appendSessionInfo("metadata-only suspended session");
		await h.session.sendCustomMessage(custom("unconsumed aside"), { deliverAs: "nextTurn" });
		expect(existsSync(h.sessionManager.getSessionFile()!)).toBe(false);

		const saved = await bounded(h.session.handoff("metadata"));

		expect(saved.wasActive).toBe(false);
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["unconsumed aside"]);
		const reopened = SessionManager.open(saved.sessionFile);
		expect(reopened.getSessionId()).toBe(saved.sessionId);
		expect(reopened.getLeafId()).toBe(saved.leafId);
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({ type: "session_info", name: "metadata-only suspended session" }),
		);
		expect(reopened.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("rejects nonpersisted suspension without surrendering recorded work", async () => {
		const h = await harness({}, false);
		await h.session.sendCustomMessage(custom("keep this aside"), { deliverAs: "nextTurn" });
		await expect(bounded(h.session.handoff("memory"))).rejects.toThrow();
		h.session.resume();
		h.setResponses([fauxAssistantMessage("done")]);
		await bounded(h.session.prompt("consume retained aside"));
		expect(h.session.messages.filter((message) => getMessageText(message) === "keep this aside")).toHaveLength(1);
	});

	it("captures settlement submissions without running them or deadlocking a second pause", async () => {
		const held = heldTool();
		const h = await harness({
			tools: [held.tool],
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						pi.sendUserMessage("settlement raw", { deliverAs: "followUp" });
						pi.sendMessage(custom("settlement prepared"), { triggerTurn: true, deliverAs: "followUp" });
					});
					pi.on("agent_settled", () => pi.requestPause());
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not start"),
		]);
		const running = h.session.prompt("start");
		await bounded(held.entered);
		const stopping = h.session.handoff("settlement");
		held.finish();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(saved.pending.deferred).toEqual([
			expect.objectContaining({ kind: "raw", text: "settlement raw" }),
			expect.objectContaining({ kind: "prepared", message: expect.objectContaining(custom("settlement prepared")) }),
		]);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it.each([
		["raw", "resume"],
		["prepared", "resume"],
		["raw", "handoff"],
		["prepared", "handoff"],
	] as const)("retains recorded %s input across a settlement pause until %s", async (kind, action) => {
		const settled = gate();
		const errors: string[] = [];
		const payload = `deferred ${kind}`;
		let submitted = false;
		let paused = false;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (submitted) return;
						submitted = true;
						if (kind === "raw") pi.sendUserMessage(payload);
						else pi.sendMessage(custom(payload), { triggerTurn: true });
					});
					pi.on("agent_settled", () => {
						if (paused) return;
						paused = true;
						pi.requestPause();
					});
				},
			],
		});
		await h.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		h.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.release();
		});
		h.setResponses([fauxAssistantMessage("initial result"), fauxAssistantMessage("continued")]);
		const running = h.session.prompt("initial task");
		await bounded(settled.promise);
		expect(h.session.pauseState).toBe("paused");
		expect(h.faux.state.callCount).toBe(1);

		if (action === "resume") {
			h.session.resume();
			await bounded(running);
			expect(h.faux.state.callCount).toBe(2);
			expect(h.session.messages.filter((message) => getMessageText(message) === payload)).toHaveLength(1);
		} else {
			const saved = await bounded(h.session.handoff("after-settlement-pause"));
			await bounded(running);
			expect(saved.pending.deferred).toEqual([
				expect.objectContaining(
					kind === "raw" ? { kind, text: payload } : { kind, message: expect.objectContaining(custom(payload)) },
				),
			]);
			expect(h.faux.state.callCount).toBe(1);
			expect(h.session.messages.some((message) => getMessageText(message) === payload)).toBe(false);
		}
		expect(errors).toEqual([]);
	});

	it.each([
		[true, false],
		[true, true],
		[false, false],
		[false, true],
	] as const)(
		"drains settled-listener slash input with expansion=%s and following input=%s in submission order",
		async (expandPromptTemplates, following) => {
			const h = await harness();
			const submitted: Promise<void>[] = [];
			const dispositions: string[] = [];
			let once = false;
			h.session.subscribe((event) => {
				if (event.type !== "agent_settled" || once) return;
				once = true;
				for (const text of ["/not-a-command", ...(following ? ["following input"] : [])]) {
					submitted.push(
						h.session.prompt(text, {
							expandPromptTemplates,
							preflightResult: (disposition) => dispositions.push(`${text}:${disposition}`),
						}),
					);
				}
			});
			h.setResponses([
				fauxAssistantMessage("initial result"),
				fauxAssistantMessage("slash result"),
				fauxAssistantMessage("following result"),
			]);
			await bounded(h.session.prompt("initial task"));
			await bounded(Promise.all(submitted));
			const expected = ["/not-a-command", ...(following ? ["following input"] : [])];
			expect(h.faux.state.callCount).toBe(1 + expected.length);
			expect(h.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
				"initial task",
				...expected,
			]);
			expect(dispositions).toEqual(expected.map((text) => `${text}:started`));
		},
	);

	it("waits for an already-running settled handler and captures submissions from later handlers", async () => {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		const order: string[] = [];
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						order.push("held");
						entered.release();
						await finish.promise;
						order.push("released");
					});
					pi.on("agent_settled", () => {
						pi.sendUserMessage("later settled raw", { deliverAs: "steer" });
						pi.sendMessage(custom("later settled prepared"), { triggerTurn: true, deliverAs: "followUp" });
						order.push("submitted");
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		const running = h.session.prompt("start");
		await bounded(entered.promise);
		const stopping = h.session.handoff("during-settlement").then((saved) => {
			order.push("handed-off");
			return saved;
		});
		finish.release();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(order).toEqual(["held", "released", "submitted", "handed-off"]);
		expect(saved.pending.deferred).toEqual([
			expect.objectContaining({
				kind: "raw",
				text: "later settled raw",
				options: expect.objectContaining({ streamingBehavior: "steer" }),
			}),
			expect.objectContaining({
				kind: "prepared",
				message: expect.objectContaining(custom("later settled prepared")),
				options: expect.objectContaining({ deliverAs: "followUp" }),
			}),
		]);
		expect(h.session.pendingMessageCount).toBe(0);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("dispatches an external safe helper during settlement without deferring it behind its own handoff", async () => {
		const settledEntered = gate();
		const finishSettled = gate();
		const helperEntered = gate();
		releases.push(finishSettled.release);
		let saved: SessionHandoff | undefined;
		const order: string[] = [];
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("safe-helper", {
						allowedWhilePaused: true,
						handler: async (requestId, ctx) => {
							order.push("helper-entered");
							helperEntered.release();
							saved = await ctx.handoff(requestId);
							order.push("helper-returned");
						},
					});
					pi.on("agent_settled", async () => {
						settledEntered.release();
						await finishSettled.promise;
						order.push("settled-released");
					});
					pi.on("agent_settled", () => pi.sendUserMessage("after helper started"));
				},
			],
		});
		await h.session.bindExtensions({ mode: "rpc" });
		h.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		const running = h.session.prompt("start");
		await bounded(settledEntered.promise);
		const helper = h.session.prompt("/safe-helper rpc-settlement");
		await bounded(helperEntered.promise);
		expect(order).toEqual(["helper-entered"]);
		finishSettled.release();
		await bounded(Promise.all([running, helper]));
		expect(order).toEqual(["helper-entered", "settled-released", "helper-returned"]);
		expect(saved).toMatchObject({
			requestId: "rpc-settlement",
			pending: { deferred: [expect.objectContaining({ kind: "raw", text: "after helper started" })] },
		});
		expect(JSON.stringify(saved!.pending)).not.toContain("/safe-helper");
		expect(h.faux.state.callCount).toBe(1);
	});

	it("persists shutdown-style transcript-only descendants without moving the saved handoff anchor", async () => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("shutdown-record", {
						allowedWhilePaused: true,
						handler: async () => {
							pi.sendMessage(custom("shutdown transcript context"), { triggerTurn: false });
							pi.appendEntry("shutdown-control", { status: "saved" });
						},
					});
				},
			],
		});
		h.sessionManager.appendSessionInfo("saved ancestor");
		const saved = await bounded(h.session.handoff("before-shutdown"));
		expect(saved.leafId).not.toBeNull();
		await bounded(h.session.prompt("/shutdown-record"));
		const reopened = SessionManager.open(saved.sessionFile);
		const branch = reopened.getBranch();
		const anchor = branch.findIndex((entry) => entry.id === saved.leafId);
		expect(anchor).toBeGreaterThanOrEqual(0);
		const descendants = branch.slice(anchor + 1);
		expect(descendants.filter((entry) => entry.type === "custom_message")).toEqual([
			expect.objectContaining({ type: "custom_message", ...custom("shutdown transcript context") }),
		]);
		expect(descendants.filter((entry) => entry.type === "custom" && entry.customType === "shutdown-control")).toEqual(
			[expect.objectContaining({ type: "custom", customType: "shutdown-control", data: { status: "saved" } })],
		);
		expect(reopened.getLeafId()).not.toBe(saved.leafId);
		expect(
			reopened
				.buildSessionContext()
				.messages.filter((message) => getMessageText(message) === "shutdown transcript context"),
		).toHaveLength(1);
		expect(await bounded(h.session.handoff("before-shutdown"))).toEqual(saved);
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each(["transform", "handled"] as const)(
		"retains the %s outcome of recorded deferred input already in preflight",
		async (outcome) => {
			const entered = gate();
			const finish = gate();
			releases.push(finish.release);
			let submitted = false;
			const h = await harness({
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", () => {
							if (submitted) return;
							submitted = true;
							pi.sendUserMessage("recorded deferred raw");
						});
						pi.on("input", async (event) => {
							if (event.text !== "recorded deferred raw") return;
							entered.release();
							await finish.promise;
							return outcome === "handled"
								? { action: "handled" }
								: { action: "transform", text: "resolved deferred payload" };
						});
					},
				],
			});
			h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);
			const running = h.session.prompt("start");
			await bounded(entered.promise);
			const stopping = h.session.handoff("recorded-preflight");
			finish.release();
			const saved = await bounded(stopping);
			await bounded(running);
			if (outcome === "handled") {
				expect(saved.pending.deferred).toEqual([]);
			} else {
				expect(saved.pending.deferred).toEqual([
					expect.objectContaining({
						kind: "prepared",
						message: expect.objectContaining({ content: expect.anything() }),
					}),
				]);
				expect(JSON.stringify(saved.pending.deferred)).toContain("resolved deferred payload");
			}
			expect(h.faux.state.callCount).toBe(1);
		},
	);

	it("does not admit a late unrecorded input preflight after handoff", async () => {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.release();
						await finish.promise;
						return { action: "transform", text: "late transformed input" };
					});
				},
			],
		});
		const admission = h.session.submitInput({ kind: "raw", text: "unrecorded" });
		await bounded(entered.promise);
		const saved = await bounded(h.session.handoff("preflight"));
		expect(saved.pending).toEqual({ initial: [], steering: [], followUp: [], nextTurn: [], deferred: [] });
		finish.release();
		expect(await bounded(admission)).toMatchObject({ disposition: "rejected", error: expect.any(String) });
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.messages.some((message) => getMessageText(message) === "late transformed input")).toBe(false);
	});

	it("acknowledges started, delayed queued, handled, rejected and prepared input before the held run ends", async () => {
		const held = heldTool();
		const preflight = gate();
		const finishPreflight = gate();
		releases.push(finishPreflight.release);
		const calls: string[] = [];
		const h = await harness({
			tools: [held.tool],
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						calls.push(event.text);
						if (event.text === "delayed raw") {
							preflight.release();
							await finishPreflight.promise;
							return { action: "transform", text: "prepared raw" };
						}
						if (event.text === "handled raw") return { action: "handled" };
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "start" }))).toEqual({ disposition: "started" });
		await bounded(held.entered);
		const delayed = h.session.submitInput({
			kind: "raw",
			text: "delayed raw",
			options: { streamingBehavior: "followUp" },
		});
		await bounded(preflight.promise);
		expect(h.session.getFollowUpMessages()).toEqual([]);
		finishPreflight.release();
		expect(await bounded(delayed)).toEqual({ disposition: "queued" });
		expect(
			await bounded(
				h.session.submitInput({ kind: "raw", text: "handled raw", options: { streamingBehavior: "followUp" } }),
			),
		).toEqual({ disposition: "handled" });
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "missing streaming behavior" }))).toMatchObject({
			disposition: "rejected",
			error: expect.any(String),
		});
		expect(
			await bounded(
				h.session.submitInput({
					kind: "prepared",
					message: custom("prepared replay"),
					options: { deliverAs: "followUp", triggerTurn: true },
				}),
			),
		).toEqual({ disposition: "queued" });
		expect(calls.slice(0, 3)).toEqual(["start", "delayed raw", "handled raw"]);
		expect(calls).not.toContain("prepared replay");
		expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
		const stopping = h.session.handoff("admissions");
		held.finish();
		const saved = await bounded(stopping);
		expect(saved.pending.followUp.map(getMessageText)).toEqual(["prepared raw", "prepared replay"]);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("recaptures staged equal-text asides with distinct replay identities after handled and rejected continuation", async () => {
		const h = await harness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => (event.text === "handled continuation" ? { action: "handled" } : undefined));
				},
			],
		});
		for (const replayId of ["saved-a", "saved-b"]) {
			expect(
				await bounded(
					h.session.submitInput({
						kind: "prepared",
						message: { ...custom("same payload"), details: { replayId }, timestamp: 123 },
						options: { deliverAs: "nextTurn" },
					}),
				),
			).toEqual({ disposition: "queued" });
		}
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "handled continuation" }))).toEqual({
			disposition: "handled",
		});
		expect(await bounded(h.session.submitInput({ kind: "raw", text: "rejected continuation" }))).toMatchObject({
			disposition: "rejected",
			error: expect.any(String),
		});
		const saved = await bounded(h.session.handoff("failed-continuation"));
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["same payload", "same payload"]);
		expect(saved.pending.nextTurn.map((message) => message.details)).toEqual([
			{ replayId: "saved-a" },
			{ replayId: "saved-b" },
		]);
		expect(h.session.messages.some((message) => getMessageText(message) === "same payload")).toBe(false);
		expect(await bounded(h.session.handoff("failed-continuation"))).toEqual(saved);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("allows an outside controller spawned by a lifecycle handler after that handler has returned", async () => {
		const releaseController = gate();
		releases.push(releaseController.release);
		let context: ExtensionCommandContext | undefined;
		let controller: Promise<unknown> | undefined;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("capture", {
						handler: async (_args, ctx) => {
							context = ctx;
						},
					});
					pi.on("agent_settled", () => {
						// Deliberately inherit the handler's async context, but do not await the controller.
						controller = releaseController.promise.then(async () => {
							const result = await context!.submitInput({
								kind: "prepared",
								message: custom("outside controller aside"),
								options: { deliverAs: "nextTurn" },
							});
							expect(result).toEqual({ disposition: "queued" });
							return context!.handoff("outside-controller");
						});
					});
				},
			],
		});
		// Core actions are present even without a mode's commandContextActions.
		await h.session.prompt("/capture");
		h.setResponses([fauxAssistantMessage("done")]);
		await bounded(h.session.prompt("start"));
		expect(controller).toBeDefined();
		releaseController.release();
		expect(await bounded(controller!)).toMatchObject({
			requestId: "outside-controller",
			pending: { nextTurn: [expect.objectContaining(custom("outside controller aside"))] },
		});
		expect(h.faux.state.callCount).toBe(1);
	});

	it("finishes already-admitted automatic compaction before handing off without another conversation request", async () => {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		let signal: AbortSignal | undefined;
		let aborts = 0;
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Cross the automatic compaction threshold after a completed tool result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		const h = await harness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						signal = event.signal;
						signal.addEventListener("abort", () => {
							aborts++;
						});
						entered.release();
						await finish.promise;
						return {
							compaction: {
								summary: "completed automatic handoff summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not request a conversation continuation"),
		]);
		await bounded(h.session.prompt("seed old history"));
		await bounded(h.session.prompt("seed recent history"));
		const running = h.session.prompt("run the large tool");
		await bounded(entered.promise);
		expect(h.session.isCompacting).toBe(true);
		expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(h.faux.state.callCount).toBe(3);
		expect(
			await bounded(
				h.session.submitInput({
					kind: "prepared",
					message: custom("queued during automatic compaction"),
					options: { deliverAs: "steer", triggerTurn: true },
				}),
			),
		).toEqual({ disposition: "queued" });
		let returned = false;
		const stopping = h.session.handoff("during-auto-compaction").then((saved) => {
			returned = true;
			return saved;
		});
		expect(returned).toBe(false);
		expect(signal!.aborted).toBe(false);
		finish.release();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(aborts).toBe(0);
		expect(signal!.aborted).toBe(false);
		expect(h.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				aborted: false,
				result: expect.objectContaining({ summary: "completed automatic handoff summary" }),
			}),
		]);
		const reopened = SessionManager.open(saved.sessionFile);
		expect(reopened.getLeafId()).toBe(saved.leafId);
		expect(reopened.getBranch(saved.leafId!).filter((entry) => entry.type === "compaction")).toEqual([
			expect.objectContaining({ summary: "completed automatic handoff summary" }),
		]);
		// Selected input may already be persisted before the final request fence;
		// otherwise it must remain in the exported queues. Either owner keeps it once.
		const retained = [
			...reopened.buildSessionContext().messages,
			...saved.pending.initial,
			...saved.pending.steering,
			...saved.pending.followUp,
			...saved.pending.nextTurn,
			...saved.pending.deferred.flatMap((input) => (input.kind === "prepared" ? [input.message] : [])),
		];
		expect(
			retained.filter((message) => getMessageText(message) === "queued during automatic compaction"),
		).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(3);
	});

	it("allows manual compaction to release an ordinary pause, but not a hard handoff fence", async () => {
		const h = await harness({ settings: { compaction: { keepRecentTokens: 1 } } });
		h.sessionManager.appendMessage({ role: "user", content: "history to compact", timestamp: 100 });
		h.sessionManager.appendMessage(fauxAssistantMessage("completed history", { timestamp: 101 }));
		h.session.refreshContext();
		h.session.requestPause();
		h.setResponses([fauxAssistantMessage("manual summary")]);

		const result = await bounded(h.session.compact());

		expect(result.summary).toContain("manual summary");
		expect(h.session.pauseState).toBe("unpaused");
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		await bounded(h.session.handoff("after-manual-compact"));
		await expect(bounded(h.session.compact())).rejects.toThrow();
		expect(h.faux.state.callCount).toBe(1);
	});

	it.each(["paused", "handed off"] as const)(
		"only runs opted-in commands while %s, including RPC-bound core actions",
		async (state) => {
			const calls: string[] = [];
			let context: ExtensionCommandContext | undefined;
			const h = await harness({
				extensionFactories: [
					(pi) => {
						pi.registerCommand("ordinary", {
							handler: async () => {
								calls.push("ordinary");
							},
						});
						pi.registerCommand("control", {
							allowedWhilePaused: true,
							handler: async (args, ctx) => {
								calls.push(args);
								context = ctx;
							},
						});
					},
				],
			});
			await h.session.bindExtensions({ mode: "rpc" });
			if (state === "paused") h.session.requestPause();
			else await bounded(h.session.handoff("command-fence"));

			await bounded(h.session.prompt("/control exact arguments"));
			expect(calls).toEqual(["exact arguments"]);
			expect(context).toBeDefined();
			await expect(bounded(h.session.prompt("/ordinary"))).rejects.toThrow();
			await expect(bounded(h.session.prompt("ordinary provider input"))).rejects.toThrow();
			if (state === "handed off") await expect(bounded(h.session.compact())).rejects.toThrow();
			expect(await bounded(context!.submitInput({ kind: "raw", text: "not a control command" }))).toMatchObject({
				disposition: "rejected",
				error: expect.any(String),
			});
			const saved = await bounded(context!.handoff(state === "paused" ? "paused-control" : "command-fence"));
			expect(saved.sessionId).toBe(h.sessionManager.getSessionId());
			expect(calls).toEqual(["exact arguments"]);
			expect(h.faux.state.callCount).toBe(0);
		},
	);

	it("fails fast for a saved command context used inside an awaited lifecycle callback, not for an external concurrent command", async () => {
		let savedContext: ExtensionCommandContext | undefined;
		const callbackEntered = gate();
		const finishCallback = gate();
		releases.push(finishCallback.release);
		const results: string[] = [];
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("capture", {
						handler: async (_args, ctx) => {
							savedContext = ctx;
						},
					});
					pi.registerCommand("external", {
						allowedWhilePaused: true,
						handler: async (_args, ctx) => {
							const result = await ctx.submitInput({
								kind: "prepared",
								message: custom("external aside"),
								options: { deliverAs: "nextTurn" },
							});
							results.push(`external:${result.disposition}`);
						},
					});
					pi.on("agent_before_settle", async () => {
						await expect(
							bounded(Promise.resolve().then(() => savedContext!.handoff("self-wait"))),
						).rejects.toThrow();
						const rejected = await bounded(
							Promise.resolve().then(async () => {
								try {
									const result = await savedContext!.submitInput({ kind: "raw", text: "self-wait input" });
									return result.disposition === "rejected";
								} catch {
									// Context misuse may throw synchronously or reject admission.
									return true;
								}
							}),
						);
						expect(rejected).toBe(true);
						results.push("callback-rejected");
						callbackEntered.release();
						await finishCallback.promise;
					});
				},
			],
		});
		await h.session.bindExtensions({ mode: "rpc" });
		await h.session.prompt("/capture");
		h.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		const running = h.session.prompt("start");
		await bounded(callbackEntered.promise);
		await bounded(h.session.prompt("/external"));
		expect(results).toEqual(["callback-rejected", "external:queued"]);
		const stopping = h.session.handoff("external-stop");
		finishCallback.release();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["external aside"]);
		expect(h.faux.state.callCount).toBe(1);
	});
});
