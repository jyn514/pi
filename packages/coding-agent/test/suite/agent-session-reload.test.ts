import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ReloadCompletionHandler } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Submit through the real editor command dispatcher and reload admission, with rendering omitted. */
function createEditor(
	session: Harness["session"],
	reload = (performReload: Harness["session"]["reload"]) => performReload(),
) {
	const editor = { setText: vi.fn() };
	const host = {
		session,
		editor,
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		requestReload: Reflect.get(
			InteractiveMode.prototype,
			"requestReload",
		) as ExtensionCommandContext["requestReload"],
		reloadResources: reload,
		handleReloadCommand: Reflect.get(InteractiveMode.prototype, "handleReloadCommand") as () => Promise<void>,
	};
	Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler").call(host);
	return { host, submit: () => host.defaultEditor.onSubmit!("/reload") };
}

describe("queued interactive reload", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("finishes all current tools, reloads once, and sends fresh tools and context before the next response", async () => {
		const started = deferred();
		const release = deferred();
		const reloadStarted = deferred();
		const releaseReload = deferred();
		const trace: string[] = [];
		let version = "old";
		const completions: Array<Error | undefined> = [];
		const callbackErrors: string[] = [];
		const extensions = () =>
			createTestExtensionsResult(
				[
					(pi) => {
						const loadedVersion = version;
						pi.registerCommand("queue-reload", {
							description: "Queue a reload",
							handler: async (_args, ctx) => {
								await ctx.requestReload((error) => {
									completions.push(error);
									trace.push(`${loadedVersion}:complete`);
									expect(() => ctx.isIdle()).toThrow("stale");
									if (completions.length === 1) throw new Error("callback fixture failed");
								});
							},
						});
						pi.on("turn_end", () => {
							trace.push(`${loadedVersion}:turn_end`);
						});
						pi.on("turn_start", () => {
							trace.push(`${loadedVersion}:turn_start`);
						});
						pi.on("session_shutdown", () => {
							trace.push(`${loadedVersion}:shutdown`);
						});
						pi.on("session_start", () => {
							trace.push(`${loadedVersion}:start`);
						});
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.toolSnippets.versioned = "run-specific snippet";
							event.systemPromptOptions.promptGuidelines.push("run-specific rule");
						});
						pi.registerTool({
							name: "versioned",
							label: "Versioned",
							description: `${loadedVersion} tool`,
							promptSnippet: `${loadedVersion} snippet`,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: loadedVersion }], details: {} }),
						});
					},
				],
				"/tmp",
			);
		let loaded = await extensions();
		const loader = createTestResourceLoader();
		loader.getExtensions = () => loaded;
		loader.getAgentsFiles = () => ({ agentsFiles: [{ path: "/fixture/AGENTS.md", content: `${version} context` }] });
		loader.reload = async () => {
			trace.push("reload");
			reloadStarted.resolve();
			await releaseReload.promise;
			version = "new";
			loaded = await extensions();
		};
		const wait: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				trace.push("tool finished");
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const harness = await createHarness({
			resourceLoader: loader,
			tools: [wait],
			settings: { compaction: { enabled: false } },
		});
		const provider = getApiProvider(harness.faux.api)!;
		const reloadLoader = loader.reload;
		loader.reload = async () => {
			await reloadLoader();
			registerApiProvider(provider);
		};
		harnesses.push(harness);
		const { host, submit } = createEditor(harness.session, async (performReload) => {
			await performReload();
			trace.push("UI refreshed");
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext(),
			onError: (error) => callbackErrors.push(error.error),
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: () => harness.session.reload(),
				requestReload: (onComplete) => host.requestReload(onComplete),
			},
		});
		let nextContext: TranscriptContext | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {}), fauxToolCall("versioned", {})], { stopReason: "toolUse" }),
			(context) => {
				trace.push("provider");
				nextContext = structuredClone(context);
				return fauxAssistantMessage("finished");
			},
		]);
		const running = harness.session.prompt("start");
		await started.promise;
		await submit();
		await harness.session.prompt("/queue-reload");
		await harness.session.prompt("/queue-reload");
		await submit();
		expect(completions).toEqual([]);
		expect(host.showWarning).not.toHaveBeenCalled();
		expect(trace).not.toContain("reload");
		release.resolve();
		await reloadStarted.promise;
		expect(trace).not.toContain("provider");
		expect(harness.session.isStreaming).toBe(true);
		await expect(harness.session.reload()).rejects.toThrow(
			"Wait for the current response to finish before reloading.",
		);
		expect(trace.filter((entry) => entry === "reload")).toHaveLength(1);
		releaseReload.resolve();
		await running;
		expect(nextContext).toBeDefined();
		expect(getCurrentSystemPrompt(nextContext!.messages)).toContain("new context");
		expect(getCurrentSystemPrompt(nextContext!.messages)).not.toContain("old context");
		expect(getCurrentSystemPrompt(nextContext!.messages)).toContain("run-specific snippet");
		expect(getCurrentSystemPrompt(nextContext!.messages)).toContain("run-specific rule");
		expect(getCurrentTools(nextContext!.messages).find((tool) => tool.name === "versioned")?.description).toBe(
			"new tool",
		);
		expect(trace).toEqual(
			expect.arrayContaining([
				"tool finished",
				"old:turn_end",
				"old:shutdown",
				"new:start",
				"new:turn_start",
				"provider",
			]),
		);
		expect(trace.filter((entry) => entry === "reload")).toHaveLength(1);
		expect(trace.indexOf("tool finished")).toBeLessThan(trace.indexOf("old:turn_end"));
		expect(trace.indexOf("old:turn_end")).toBeLessThan(trace.indexOf("old:shutdown"));
		expect(trace.indexOf("new:start")).toBeLessThan(trace.indexOf("new:turn_start"));
		expect(trace.indexOf("new:turn_start")).toBeLessThan(trace.indexOf("provider"));
		expect(completions).toEqual([undefined, undefined]);
		expect(callbackErrors).toEqual(["callback fixture failed"]);
		expect(trace.indexOf("UI refreshed")).toBeLessThan(trace.indexOf("old:complete"));
		expect(trace.indexOf("old:complete")).toBeLessThan(trace.indexOf("new:turn_start"));
	});

	it.each([false, true])(
		"drains a queued reload after a final response (abort=%s) without another request",
		async (abort) => {
			const started = deferred();
			const release = deferred();
			const harness = await createHarness({ settings: { compaction: { enabled: false } } });
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("final");
				},
			]);
			const running = harness.session.prompt("start");
			await started.promise;
			const reload = vi.fn(async () => {});
			const { submit } = createEditor(harness.session, reload);
			await submit();
			expect(reload).not.toHaveBeenCalled();
			const aborted = abort ? harness.session.abort() : undefined;
			release.resolve();
			await running;
			await aborted;
			await harness.session.waitForIdle();
			expect(reload).toHaveBeenCalledOnce();
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("reloads before an already queued follow-up response", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		let reloaded = false;
		let reloadedAtRequest = false;
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			() => {
				reloadedAtRequest = reloaded;
				return fauxAssistantMessage("follow up");
			},
		]);
		const running = harness.session.prompt("start");
		await started.promise;
		await harness.session.followUp("queued");
		await createEditor(harness.session, async () => {
			reloaded = true;
		}).submit();
		release.resolve();
		await running;
		expect(reloadedAtRequest).toBe(true);
	});

	it("refreshes prompt and tool declarations on the first request of a retry, preserving a forced run prompt", async () => {
		let version = "old";
		const load = () =>
			createTestExtensionsResult(
				[
					(pi) => {
						pi.on("before_agent_start", () => ({ systemPrompt: "exact run prompt" }));
						pi.registerTool({
							name: "versioned",
							label: "Versioned",
							description: `${version} tool`,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: version }], details: {} }),
						});
					},
				],
				"/tmp",
			);
		let loaded = await load();
		const loader = createTestResourceLoader();
		loader.getExtensions = () => loaded;
		const harness = await createHarness({
			resourceLoader: loader,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const provider = getApiProvider(harness.faux.api)!;
		loader.reload = async () => {
			version = "new";
			loaded = await load();
			registerApiProvider(provider);
		};
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		const { submit } = createEditor(harness.session);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") void submit();
		});
		let nextContext: TranscriptContext | undefined;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				nextContext = structuredClone(context);
				return fauxAssistantMessage("recovered");
			},
		]);
		await harness.session.prompt("start");
		expect(nextContext).toBeDefined();
		expect(harness.faux.state.callCount).toBe(2);
		expect(getCurrentSystemPrompt(nextContext!.messages)).toBe("exact run prompt");
		expect(getCurrentTools(nextContext!.messages).find((tool) => tool.name === "versioned")?.description).toBe(
			"new tool",
		);
		expect(getCurrentTools(harness.session.messages).find((tool) => tool.name === "versioned")?.description).toBe(
			"new tool",
		);
		expect(harness.session.isIdle).toBe(true);
	});

	it("reports a queued reload failure and admits a later reload without stranding idle waiters", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("final");
			},
		]);
		const running = harness.session.prompt("start");
		await started.promise;
		const reload = vi.fn(async (): Promise<void> => {
			throw new Error("reload fixture failed");
		});
		const { host, submit } = createEditor(harness.session, reload);
		const completed = vi.fn<ReloadCompletionHandler>();
		const coalesced = vi.fn<ReloadCompletionHandler>();
		await submit();
		await host.requestReload(completed);
		await host.requestReload(coalesced);
		expect(completed).not.toHaveBeenCalled();
		const idle = harness.session.waitForIdle();
		release.resolve();
		await running;
		await idle;
		expect(host.showError).toHaveBeenCalledWith("Reload failed: reload fixture failed");
		expect(completed).toHaveBeenCalledExactlyOnceWith(new Error("reload fixture failed"));
		expect(coalesced).toHaveBeenCalledExactlyOnceWith(new Error("reload fixture failed"));
		reload.mockImplementation(async () => {});
		await submit();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(harness.session.isIdle).toBe(true);
	});

	it("rejects a managed reload if tree navigation starts while its callback awaits", async () => {
		const callbackStarted = deferred();
		const releaseReload = deferred();
		const treeStarted = deferred();
		const releaseTree = deferred();
		const shutdown = vi.fn();
		const treeFinished = vi.fn();
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", shutdown);
					pi.on("session_tree", treeFinished);
					pi.on("session_before_tree", async () => {
						treeStarted.resolve();
						await releaseTree.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed input");
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		const runner = harness.session.extensionRunner;
		const replaceResources = vi.spyOn(harness.session.resourceLoader, "reload");
		expect(harness.session.isIdle).toBe(true);
		const reloading = harness.session
			.requestReload(async (performReload) => {
				callbackStarted.resolve();
				await releaseReload.promise;
				await performReload();
			})
			.catch((error: unknown) => error);
		await callbackStarted.promise;
		const navigating = harness.session.navigateTree(target.id);
		try {
			await treeStarted.promise;
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.session.isCompacting).toBe(true);
			releaseReload.resolve();
			// Settle the reload before releasing navigation: its finally path also drains reloads.
			expect(await reloading).toEqual(new Error("Wait for compaction to finish before reloading."));
			expect(shutdown).not.toHaveBeenCalled();
			expect(replaceResources).not.toHaveBeenCalled();
			expect(harness.session.extensionRunner).toBe(runner);
		} finally {
			releaseReload.resolve();
			releaseTree.resolve();
			await navigating;
		}
		expect(await navigating).toEqual({ editorText: "seed input", cancelled: false, summaryEntry: undefined });
		expect(treeFinished).toHaveBeenCalledOnce();
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);
	});

	it("drains a queued reload after branch summarization without another model request", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						started.resolve();
						await release.promise;
						return { summary: { summary: "branch summary", details: {} } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first input");
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		await harness.session.prompt("second input");
		const navigating = harness.session.navigateTree(target.id, { summarize: true });
		await started.promise;
		const reload = vi.fn(async () => {});
		await createEditor(harness.session, reload).submit();
		expect(reload).not.toHaveBeenCalled();
		const idle = harness.session.waitForIdle();
		release.resolve();
		expect((await navigating).cancelled).toBe(false);
		await idle;
		expect(reload).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("drains after cancelled manual compaction before notifying queued prompt consumers", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						started.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("seed compactable context");
		const compacting = harness.session.compact().catch((error: unknown) => error);
		await started.promise;
		const trace: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") trace.push("compaction_end");
		});
		await createEditor(harness.session, async () => {
			trace.push("reload");
		}).submit();
		expect(trace).toEqual([]);
		release.resolve();
		expect(await compacting).toBeInstanceOf(Error);
		await harness.session.waitForIdle();
		expect(trace).toEqual(["reload", "compaction_end"]);
	});
});
