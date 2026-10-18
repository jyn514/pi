import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHandoff } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("input ownership operation did not settle")), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const custom = (content: string) => ({ customType: "retained-input", content, display: true });
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };

function pendingTexts(saved: SessionHandoff): string[] {
	return [
		...(saved.pending.initial ?? []),
		...saved.pending.steering,
		...saved.pending.followUp,
		...saved.pending.nextTurn,
	].map(getMessageText);
}

describe("AgentSession input ownership", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	const releases: Array<() => void> = [];

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		for (const h of harnesses.splice(0)) h.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function harness(options: HarnessOptions = {}) {
		const directory = mkdtempSync(join(tmpdir(), "pi-input-ownership-"));
		directories.push(directory);
		const h = await createHarness({
			...options,
			settings: { retry: { enabled: false }, compaction: { enabled: false }, ...options.settings },
			sessionManager: SessionManager.create(directory, directory),
		});
		harnesses.push(h);
		return h;
	}

	function blockedFile(h: Harness) {
		h.sessionManager.ensurePersisted();
		const path = h.sessionManager.getSessionFile()!;
		const previous = readFileSync(path, "utf8");
		let blocked = false;
		const restore = () => {
			if (!blocked) return;
			rmSync(path, { recursive: true, force: true });
			writeFileSync(path, previous);
			blocked = false;
		};
		releases.push(restore);
		return {
			block: () => {
				rmSync(path);
				mkdirSync(path);
				blocked = true;
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
			description: "Hold a real tool boundary without using a provider service",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				entered.release();
				await finish.promise;
				return { content: [{ type: "text", text: "completed held tool" }], details: {} };
			},
		};
		return { tool, entered: entered.promise, finish: finish.release, executions: () => executions };
	}

	it.each([
		["raw", "before buffering"],
		["raw", "after buffering"],
		["prepared", "before buffering"],
		["prepared", "after buffering"],
	] as const)("retains admitted %s input and asides when recording fails %s", async (kind, failure) => {
		const h = await harness();
		const disk = blockedFile(h);
		let injected = false;
		h.session.subscribe((event) => {
			if (event.type !== "message_start" || getMessageText(event.message) !== "initial payload" || injected) return;
			injected = true;
			if (failure === "before buffering") throw new Error("injected initial notification failure");
			disk.block();
		});
		for (const text of ["aside B", "aside C"]) {
			await h.session.sendCustomMessage(custom(text), { deliverAs: "nextTurn" });
		}
		const settled = gate();
		h.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.release();
		});
		expect(
			await bounded(
				h.session.submitInput(
					kind === "raw"
						? { kind, text: "initial payload" }
						: { kind, message: custom("initial payload"), options: { triggerTurn: true } },
				),
			),
		).toEqual({ disposition: "started" });
		await bounded(settled.promise);
		disk.restore();
		const saved = await bounded(h.session.handoff(`initial-${failure}`));
		const history = SessionManager.open(saved.sessionFile).buildSessionContext().messages.map(getMessageText);
		const initial = failure === "before buffering" ? ["initial payload"] : [];
		expect(saved.pending.initial.map(getMessageText)).toEqual([...initial, "aside B", "aside C"]);
		// Upstream prepares both user/custom-triggered runs with their next-turn asides.
		expect(saved.pending.nextTurn).toEqual([]);
		for (const payload of ["initial payload", "aside B", "aside C"]) {
			expect([...history, ...pendingTexts(saved)].filter((text) => text === payload)).toHaveLength(1);
		}
		expect(injected).toBe(true);
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each([
		["steer", "one-at-a-time", "before first"],
		["steer", "all", "before first"],
		["followUp", "one-at-a-time", "before first"],
		["followUp", "all", "before first"],
		["steer", "all", "after first"],
		["followUp", "all", "after first"],
		["steer", "one-at-a-time", "disk append"],
		["steer", "all", "disk append"],
		["followUp", "one-at-a-time", "disk append"],
		["followUp", "all", "disk append"],
	] as const)("retains selected %s occurrences in %s mode on %s failure", async (lane, mode, failure) => {
		const held = heldTool();
		const h = await harness({ tools: [held.tool] });
		h.session.setSteeringMode(mode);
		h.session.setFollowUpMode(mode);
		const disk = blockedFile(h);
		let selected = 0;
		let injected = false;
		h.session.subscribe((event) => {
			if (event.type !== "message_start" || getMessageText(event.message) !== "equal payload") return;
			selected++;
			if (injected || selected !== (failure === "after first" ? 2 : 1)) return;
			injected = true;
			if (failure === "disk append") disk.block();
			else throw new Error("injected selected notification failure");
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finish the held tool task"),
		]);
		const running = h.session.prompt("start held tool").catch(() => {});
		await bounded(held.entered);
		for (const text of ["equal payload", "equal payload", "tail C"]) await h.session[lane](text, [image]);
		held.finish();
		await bounded(running);
		disk.restore();
		const saved = await bounded(h.session.handoff(`selected-${lane}-${mode}-${failure}`));
		const messages = SessionManager.open(saved.sessionFile).buildSessionContext().messages;
		const pending = saved.pending[lane === "steer" ? "steering" : "followUp"];
		expect(pending.map(getMessageText)).toEqual(
			failure === "before first" ? ["equal payload", "equal payload", "tail C"] : ["equal payload", "tail C"],
		);
		const retained = [...messages, ...pending];
		expect(retained.filter((message) => getMessageText(message) === "equal payload")).toHaveLength(2);
		expect(retained.filter((message) => getMessageText(message) === "tail C")).toHaveLength(1);
		for (const message of pending) {
			expect(message).toMatchObject({ content: expect.arrayContaining([image]) });
		}
		expect(injected).toBe(true);
		expect(held.executions()).toBe(1);
		// Follow-up selection waits for the natural response after the tool result.
		expect(h.faux.state.callCount).toBe(lane === "followUp" ? 2 : 1);
	});

	it("consumes only the original asides when agent_start synchronously stages another", async () => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", () => pi.sendMessage(custom("later aside"), { deliverAs: "nextTurn" }));
				},
			],
		});
		await h.session.sendCustomMessage(custom("original aside"), { deliverAs: "nextTurn" });
		h.setResponses([fauxAssistantMessage("completed")]);
		await bounded(h.session.prompt("initial task"));
		const saved = await bounded(h.session.handoff("aside-transfer"));
		const history = SessionManager.open(saved.sessionFile).buildSessionContext().messages.map(getMessageText);
		expect(history.filter((text) => text === "original aside")).toHaveLength(1);
		expect(history).not.toContain("later aside");
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["later aside"]);
	});

	it("keeps the initial run's ownership when preparation reentrantly submits prepared input", async () => {
		let armed = false;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "loadout_submission",
						label: "Loadout submission",
						description: "Submit only while preparing the requested run",
						parameters: Type.Object({}),
						prepareLoadout: () => {
							if (!armed) return;
							armed = false;
							pi.sendMessage(custom("reentrant prepared input"), { triggerTurn: true });
						},
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage("completed")]);
		armed = true;
		await bounded(h.session.prompt("reserved initial input"));
		const history = h.sessionManager.buildSessionContext().messages.map(getMessageText);
		expect(history.filter((text) => text === "reserved initial input")).toHaveLength(1);
		expect(history.filter((text) => text === "reentrant prepared input")).toHaveLength(1);
		expect(history.indexOf("reserved initial input")).toBeLessThan(history.indexOf("reentrant prepared input"));
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("retains a completed capture before notifying throwing and reentrant observers", async () => {
		const h = await harness();
		const errors: string[] = [];
		await h.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		await h.session.steer("capture payload", [image]);
		await h.session.sendCustomMessage(custom("capture aside"), { deliverAs: "nextTurn" });
		let armed = true;
		let reentrant: Promise<SessionHandoff> | undefined;
		h.session.subscribe((event) => {
			if (event.type !== "queue_update" || !armed) return;
			armed = false;
			reentrant = h.session.handoff("observer-capture");
			throw new Error("injected capture observer failure");
		});
		const saved = await bounded(h.session.handoff("observer-capture"));
		expect(await bounded(reentrant!)).toBe(saved);
		expect(await bounded(h.session.handoff("observer-capture"))).toBe(saved);
		expect(saved.pending.steering.map(getMessageText)).toEqual(["capture payload"]);
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["capture aside"]);
		expect(errors).toContain("injected capture observer failure");
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each([
		{ stage: "input", streamingBehavior: undefined },
		{ stage: "input", streamingBehavior: "steer" },
		{ stage: "input", streamingBehavior: "followUp" },
		{ stage: "auth", streamingBehavior: undefined },
		{ stage: "auth", streamingBehavior: "steer" },
		{ stage: "auth", streamingBehavior: "followUp" },
	] as const)(
		"keeps B active when unreserved A reaches admission ($stage fixture, $streamingBehavior)",
		async ({ stage, streamingBehavior }) => {
			const preflight = gate();
			const finishPreflight = gate();
			releases.push(finishPreflight.release);
			const held = heldTool();
			const startups: string[] = [];
			const h = await harness({
				tools: [held.tool],
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (stage !== "input" || event.text !== "overlapping A") return;
							preflight.release();
							await finishPreflight.promise;
						});
						pi.on("before_agent_start", (event) => {
							if (event.messageType === "user") startups.push(event.prompt);
						});
					},
				],
			});
			if (stage === "auth") {
				const runtime = h.session.modelRuntime;
				const checkAuth = runtime.checkAuth.bind(runtime);
				let checks = 0;
				vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(false);
				vi.spyOn(runtime, "checkAuth").mockImplementation(async (provider, options) => {
					if (++checks === 1) {
						preflight.release();
						await finishPreflight.promise;
					}
					return checkAuth(provider, options);
				});
			}
			h.setResponses([fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" })]);
			const admission = h.session.submitInput({
				kind: "raw",
				text: "overlapping A",
				options: { streamingBehavior },
			});
			await bounded(preflight.promise);
			expect(h.session.isStreaming).toBe(false);
			expect(h.session.isIdle).toBe(true);
			expect(h.faux.state.callCount).toBe(0);
			const running = h.session.prompt("active B").catch(() => {});
			await bounded(held.entered);
			finishPreflight.release();
			expect(await bounded(admission)).toMatchObject({ disposition: streamingBehavior ? "queued" : "rejected" });
			expect(h.session.isStreaming).toBe(true);
			expect(h.session.isIdle).toBe(false);
			expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			expect(startups).toEqual(["active B"]);
			let captured = false;
			const stopping = h.session.handoff("overlap").then((saved) => {
				captured = true;
				return saved;
			});
			expect(captured).toBe(false);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(0);
			held.finish();
			const saved = await bounded(stopping);
			await bounded(running);
			expect(pendingTexts(saved)).toEqual(streamingBehavior ? ["overlapping A"] : []);
			expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
			expect(held.executions()).toBe(1);
			expect(h.faux.state.callCount).toBe(1);
		},
	);

	it.each([true, false])(
		"parks recorded slash input across a microtask pause with expansion %s",
		async (expandPromptTemplates) => {
			const h = await harness();
			const paused = gate();
			let once = false;
			h.session.subscribe((event) => {
				if (event.type === "pause_state_changed" && event.state === "paused") paused.release();
				if (event.type !== "agent_settled" || once) return;
				once = true;
				void h.session.prompt("/unknown-slash", { expandPromptTemplates });
				void h.session.prompt("following raw");
				queueMicrotask(() => h.session.requestPause());
			});
			h.setResponses([fauxAssistantMessage("first response")]);
			const running = h.session.prompt("initial task").catch(() => {});
			await bounded(paused.promise);
			const saved = await bounded(h.session.handoff("slash-pause"));
			await bounded(running);
			expect(
				saved.pending.deferred.map((input) => (input.kind === "raw" ? input.text : getMessageText(input.message))),
			).toEqual(["/unknown-slash", "following raw"]);
			expect(h.faux.state.callCount).toBe(1);
		},
	);

	it("retains a failed deferred preflight without automatically retrying its handler", async () => {
		const h = await harness();
		const templates = vi.spyOn(h.session.resourceLoader, "getPrompts");
		let submitted = false;
		h.session.subscribe((event) => {
			if (event.type !== "agent_settled" || submitted) return;
			submitted = true;
			templates.mockImplementationOnce(() => {
				throw new Error("injected deferred resource failure");
			});
			void h.session.prompt("failed deferred payload");
		});
		h.setResponses([fauxAssistantMessage("initial response")]);
		await bounded(h.session.prompt("initial task"));
		const saved = await bounded(h.session.handoff("failed-deferred"));
		expect(saved.pending.deferred).toEqual([
			expect.objectContaining({ kind: "raw", text: "failed deferred payload" }),
		]);
		expect(templates).toHaveBeenCalledTimes(2);
		expect(h.faux.state.callCount).toBe(1);
	});

	it.each([
		{ kind: "raw", streamingBehavior: undefined },
		{ kind: "raw", streamingBehavior: "steer" },
		{ kind: "raw", streamingBehavior: "followUp" },
		{ kind: "prepared", streamingBehavior: undefined },
		{ kind: "prepared", streamingBehavior: "steer" },
		{ kind: "prepared", streamingBehavior: "followUp" },
	] as const)(
		"keeps reserved $kind startup busy during competing admission ($streamingBehavior) until fenced cancellation",
		async ({ kind, streamingBehavior }) => {
			const entered = gate();
			const finish = gate();
			releases.push(finish.release);
			const h = await harness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							entered.release();
							await finish.promise;
						});
					},
				],
			});
			const admission = h.session.submitInput(
				kind === "raw"
					? { kind, text: "caller-owned task" }
					: { kind, message: custom("caller-owned task"), options: { triggerTurn: true } },
			);
			await bounded(entered.promise);
			expect(h.session.isStreaming).toBe(true);
			expect(h.session.isIdle).toBe(false);
			expect(h.faux.state.callCount).toBe(0);
			expect(
				await bounded(h.session.submitInput({ kind: "raw", text: "competing B", options: { streamingBehavior } })),
			).toMatchObject({ disposition: streamingBehavior ? "queued" : "rejected" });
			expect(h.session.isStreaming).toBe(true);
			expect(h.session.isIdle).toBe(false);
			expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			expect(h.faux.state.callCount).toBe(0);
			await h.session.sendCustomMessage(custom("retained aside"), { deliverAs: "nextTurn" });
			const stopping = h.session.handoff(`startup-${kind}`);
			finish.release();
			expect(await bounded(admission)).toMatchObject({ disposition: "rejected" });
			const saved = await bounded(stopping);
			expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["retained aside"]);
			expect(saved.pending.initial).toEqual([]);
			expect(saved.pending.deferred).toEqual([]);
			expect(saved.pending.steering.map(getMessageText)).toEqual(
				streamingBehavior === "steer" ? ["competing B"] : [],
			);
			expect(saved.pending.followUp.map(getMessageText)).toEqual(
				streamingBehavior === "followUp" ? ["competing B"] : [],
			);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.eventsOfType("agent_settled")).toHaveLength(0);
			expect(h.session.isStreaming).toBe(false);
			expect(h.session.isIdle).toBe(true);
		},
	);

	it("retains deferred startup transformations and asides in separate owners when fenced", async () => {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		let submitted = false;
		let handlerCalls = 0;
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.messageType !== "user" || event.prompt !== "deferred task") return;
						handlerCalls++;
						entered.release();
						await finish.promise;
						return { message: custom("handler addition") };
					});
				},
			],
		});
		h.session.subscribe((event) => {
			if (event.type !== "agent_settled" || submitted) return;
			submitted = true;
			void h.session.prompt("deferred task");
		});
		h.setResponses([fauxAssistantMessage("first response")]);
		const running = h.session.prompt("initial task");
		await bounded(entered.promise);
		await h.session.sendCustomMessage(custom("deferred aside"), { deliverAs: "nextTurn" });
		const stopping = h.session.handoff("deferred-startup");
		finish.release();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["deferred aside"]);
		expect(saved.pending.deferred.map((input) => input.kind === "prepared" && getMessageText(input.message))).toEqual(
			["deferred task", "handler addition"],
		);
		expect(handlerCalls).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("parks reserved startup before provider admission until ordinary resume", async () => {
		const entered = gate();
		const finish = gate();
		const paused = gate();
		const dispositions: string[] = [];
		let handlerCalls = 0;
		releases.push(finish.release);
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						handlerCalls++;
						entered.release();
						await finish.promise;
					});
				},
			],
		});
		h.session.subscribe((event) => {
			if (event.type === "pause_state_changed" && event.state === "paused") paused.release();
		});
		h.setResponses([fauxAssistantMessage("resumed response")]);
		const running = h.session.prompt("initial task", {
			preflightResult: (disposition) => dispositions.push(disposition),
		});
		await bounded(entered.promise);
		h.session.requestPause();
		expect(h.session.pauseState).toBe("pausing");
		finish.release();
		await bounded(paused.promise);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.isStreaming).toBe(true);
		expect(dispositions).toEqual([]);
		h.session.resume();
		await bounded(running);
		expect(h.faux.state.callCount).toBe(1);
		expect(dispositions).toEqual(["started"]);
		expect(handlerCalls).toBe(1);
	});

	it("releases reserved startup after a buffered transcript-only observer throws without consuming asides", async () => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.sendMessage(custom("startup note"), { triggerTurn: false });
					});
				},
			],
		});
		await h.session.sendCustomMessage(custom("unconsumed aside"), { deliverAs: "nextTurn" });
		let armed = true;
		h.session.subscribe((event) => {
			if (event.type !== "message_start" || getMessageText(event.message) !== "startup note" || !armed) return;
			armed = false;
			throw new Error("startup flush observer failure");
		});
		await expect(bounded(h.session.prompt("unaccepted task"))).rejects.toThrow("startup flush observer failure");
		expect(h.session.isIdle).toBe(true);
		expect(h.eventsOfType("agent_settled")).toHaveLength(0);
		const saved = await bounded(h.session.handoff("startup-flush"));
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["unconsumed aside"]);
		const history = SessionManager.open(saved.sessionFile).buildSessionContext().messages.map(getMessageText);
		expect(history.filter((text) => text === "startup note")).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("awaits the retained Agent run even when its admission observer throws", async () => {
		const held = heldTool();
		const h = await harness({ tools: [held.tool] });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("completed"),
		]);
		let rejected = false;
		const running = h.session
			.prompt("retained task", {
				preflightResult: () => {
					throw new Error("admission observer failure");
				},
			})
			.catch((error: unknown) => {
				rejected = true;
				return error;
			});
		await bounded(held.entered);
		expect(rejected).toBe(false);
		held.finish();
		expect(await bounded(running)).toMatchObject({ message: "admission observer failure" });
		expect(h.session.isIdle).toBe(true);
		const saved = await bounded(h.session.handoff("admission-observer"));
		expect(saved.pending.initial).toEqual([]);
		expect(held.executions()).toBe(1);
	});

	it.each([
		{ phase: "preparation", expectedRoutes: 0 },
		{ phase: "routing", expectedRoutes: 1 },
	])("fences the conversation after handoff interrupts $phase", async ({ phase, expectedRoutes }) => {
		const entered = gate();
		const finish = gate();
		releases.push(finish.release);
		let routes = 0;
		const h = await harness({
			models: [{ id: "physical" }],
			prepareRequest: async () => {
				if (phase !== "preparation") return;
				entered.release();
				await finish.promise;
			},
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "handoff-router",
						id: "auto",
						name: "Handoff router",
						thinkingLevels: ["off"],
						contextWindow: 100_000,
						async route(_request, ctx) {
							routes++;
							if (phase === "routing") {
								entered.release();
								await finish.promise;
							}
							return { model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		await h.session.setModel(h.session.modelRuntime.getModel("handoff-router", "auto")!);
		h.setResponses([fauxAssistantMessage("should not run")]);
		const running = h.session.prompt("recorded routed task");
		await bounded(entered.promise);
		expect(routes).toBe(expectedRoutes);
		await h.session.sendCustomMessage(custom("retained routing aside"), { deliverAs: "nextTurn" });
		const stopping = h.session.handoff("routing-preparation");
		finish.release();
		const saved = await bounded(stopping);
		await bounded(running);
		expect(routes).toBe(expectedRoutes);
		expect(h.faux.state.callCount).toBe(0);
		const history = SessionManager.open(saved.sessionFile).buildSessionContext().messages.map(getMessageText);
		expect(history.filter((text) => text === "recorded routed task")).toHaveLength(1);
		expect(saved.pending.nextTurn.map(getMessageText)).toEqual(["retained routing aside"]);
		expect(saved.pending.initial).toEqual([]);
		expect(h.session.isIdle).toBe(true);
	});

	it("does not strand handoff when a final settlement observer throws", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("completed")]);
		h.session.subscribe((event) => {
			if (event.type === "agent_settled") throw new Error("settlement observer failure");
		});
		await expect(bounded(h.session.prompt("recorded task"))).rejects.toThrow("settlement observer failure");
		const saved = await bounded(h.session.handoff("settled-observer"));
		expect(await bounded(h.session.handoff("settled-observer"))).toBe(saved);
		expect(saved.pending.initial).toEqual([]);
	});
});
