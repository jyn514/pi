import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const networkError = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "Name does not resolve",
	});
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

describe("session network recovery", () => {
	it("recovers from a three-minute outage without replaying completed tools", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "saved" }], details: {} }));
		const harness = await createHarness({
			settings: { retry: { maxRetries: 20, maxAgentDelayMs: 15_000 } },
			tools: [{ name: "save", label: "Save", description: "Save", parameters: Type.Object({}), execute }],
		});
		harnesses.push(harness);
		vi.useFakeTimers();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("save", {})], { stopReason: "toolUse" }),
			...Array.from({ length: 25 }, () => (context: { messages: { role: string }[] }) => {
				expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
				return performance.now() < 180_000
					? { ...networkError(), content: [fauxToolCall("save", {})] }
					: fauxAssistantMessage("recovered");
			}),
		]);
		const prompt = harness.session.prompt("save then continue");
		await vi.runAllTimersAsync();
		await prompt;
		expect(execute).toHaveBeenCalledTimes(1);
		expect(harness.session.getLastAssistantText()).toBe("recovered");
		expect(harness.eventsOfType("auto_retry_start").length).toBeGreaterThan(3);
		expect(harness.eventsOfType("auto_retry_start").every((event) => event.delayMs <= 15_000)).toBe(true);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true }]);
		const errors = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
		expect(errors.length).toBeGreaterThan(3);
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(0);
	});

	it.each([{ maxRetries: 1 }, { maxRetries: 0 }, { enabled: false }])(
		"honors explicit recovery limits %j",
		async (retry) => {
			const harness = await createHarness({ settings: { retry } });
			harnesses.push(harness);
			vi.useFakeTimers();
			harness.setResponses(Array.from({ length: 10 }, networkError));
			const prompt = harness.session.prompt("test");
			await vi.runAllTimersAsync();
			await prompt;
			expect(harness.faux.state.callCount).toBe("enabled" in retry ? 1 : retry.maxRetries + 1);
		},
	);

	it("recovers a compaction summary after three minutes", async () => {
		const harness = await createHarness({
			settings: { retry: { maxRetries: 20 }, compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "summarize this", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("a completed answer"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		vi.useFakeTimers();
		harness.setResponses(
			Array.from(
				{ length: 25 },
				() => () => (performance.now() < 180_000 ? networkError() : fauxAssistantMessage("recovered summary")),
			),
		);
		const compact = harness.session.compact();
		await vi.runAllTimersAsync();
		expect((await compact).summary).toContain("recovered summary");
		expect(harness.eventsOfType("summarization_retry_scheduled").length).toBeGreaterThan(3);
	});

	it("keeps simultaneous session budgets independent", async () => {
		const first = await createHarness({ settings: { retry: { maxRetries: 1 } } });
		const second = await createHarness({ settings: { retry: { maxRetries: 20 } } });
		harnesses.push(first, second);
		vi.useFakeTimers();
		first.setResponses(Array.from({ length: 10 }, networkError));
		second.setResponses(
			Array.from(
				{ length: 25 },
				() => () => (performance.now() < 180_000 ? networkError() : fauxAssistantMessage("recovered")),
			),
		);
		const prompts = Promise.all([first.session.prompt("first"), second.session.prompt("second")]);
		await vi.runAllTimersAsync();
		await prompts;
		expect(first.faux.state.callCount).toBe(2);
		expect(first.eventsOfType("auto_retry_end")).toMatchObject([{ success: false }]);
		expect(second.session.getLastAssistantText()).toBe("recovered");
	});

	it("recovers a branch summary after three minutes", async () => {
		const harness = await createHarness({ settings: { retry: { maxRetries: 20 } } });
		harnesses.push(harness);
		const target = harness.sessionManager.appendMessage({
			role: "user",
			content: "first branch",
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("first answer"));
		harness.sessionManager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("abandoned answer"));
		vi.useFakeTimers();
		harness.setResponses(
			Array.from(
				{ length: 25 },
				() => () =>
					performance.now() < 180_000 ? networkError() : fauxAssistantMessage("recovered branch summary"),
			),
		);
		const navigation = harness.session.navigateTree(target, { summarize: true });
		await vi.runAllTimersAsync();
		expect((await navigation).summaryEntry?.summary).toContain("recovered branch summary");
		expect(harness.eventsOfType("summarization_retry_scheduled").length).toBeGreaterThan(3);
	});

	it("uses a numeric default and preserves explicit attempt caps", () => {
		expect(SettingsManager.inMemory().getRetrySettings().maxRetries).toBe(3);
		expect(SettingsManager.inMemory({ retry: { maxRetries: 20 } }).getRetrySettings().maxRetries).toBe(20);
	});
});
