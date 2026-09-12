import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test",
	name: "Test",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 1000,
};
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;
const dns = "Codex sidecar authentication or connection failed: [Errno -2] Name does not resolve";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe.each([0, 2])("Codex retry classification with %i provider retries", (maxRetries) => {
	it.each([
		[502, dns, "network"],
		[502, "[SSL: DECRYPTION_FAILED_OR_BAD_RECORD_MAC] bad record mac", "network"],
		[502, "Unfamiliar gateway response", "retryable"],
		[401, "fetch failed: 502", "terminal"],
		[403, "network error", "terminal"],
		[400, "connection refused", "terminal"],
		[502, "insufficient_quota", "terminal"],
		[429, "insufficient_quota", "terminal"],
		[429, '{"error":{"code":"rate_limit_exceeded"}}', "retryable"],
		[429, '{"error":{"code":"usage_limit_reached"}}', "terminal"],
	] as const)("classifies HTTP %i %s as %s", async (status, body, disposition) => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(body, { status }));
		const pending = stream(model, { messages: [] }, { apiKey: token, transport: "sse", fetch, maxRetries }).result();
		await vi.runAllTimersAsync();
		const result = await pending;
		expect(result.errorMessage).toContain(String(status));
		expect(isRetryableAssistantError(result)).toBe(disposition !== "terminal");
		expect(fetch).toHaveBeenCalledTimes(disposition === "terminal" ? 1 : maxRetries + 1);
	});

	it.each(["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])(
		"does not retry fetch failed wrapping %s",
		async (code) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }));
			const result = await stream(
				model,
				{ messages: [] },
				{ apiKey: token, transport: "sse", fetch, maxRetries: 2 },
			).result();
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});

describe("bounded network retries", () => {
	it.each([401, 403])("does not retry a wrapped HTTP %i authentication error", async (status) => {
		vi.useFakeTimers();
		const cause = Object.assign(new Error("Unauthorized"), { status });
		const error = new TypeError("fetch failed", { cause });
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
		const pending = stream(
			model,
			{ messages: [] },
			{ apiKey: token, transport: "sse", fetch, maxRetries: 2 },
		).result();
		await vi.runAllTimersAsync();
		const result = await pending;
		expect(result.errorMessage).toContain(`Codex (${status}): Unauthorized`);
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels a network backoff immediately", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: dns }));
		const result = retryAssistantCall(
			produce,
			{ enabled: true, maxRetries: 20, baseDelayMs: 2000 },
			controller.signal,
		);
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, 30_000, 60_000])("recovers after a three-minute outage with %i ms failed requests", async (latency) => {
		vi.useFakeTimers();
		const produce = async () => {
			const failed = performance.now() < 180_000;
			await new Promise((resolve) => setTimeout(resolve, failed ? latency : 1000));
			return failed
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: dns })
				: fauxAssistantMessage("recovered");
		};
		const result = retryAssistantCall(produce, { enabled: true, maxRetries: 20, baseDelayMs: 2000 }, undefined);
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe("stop");
		expect(performance.now()).toBeLessThan(210_000);
	});

	it.each([0, 3, 20])("stops after %i retries with waits capped at fifteen seconds", async (maxRetries) => {
		vi.useFakeTimers();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: dns }));
		const scheduled = vi.fn();
		const result = retryAssistantCall(produce, { enabled: true, maxRetries, baseDelayMs: 2000 }, undefined, {
			onRetryScheduled: scheduled,
		});
		await vi.runAllTimersAsync();
		expect((await result).stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(maxRetries + 1);
		expect(scheduled.mock.calls.every(([, maximum, delay]) => maximum === maxRetries && delay <= 15_000)).toBe(true);
	});

	it("preserves a certificate cause through a cyclic error chain", async () => {
		const error = new TypeError("fetch failed");
		error.cause = new Error("CERT_HAS_EXPIRED", { cause: error });
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
		const result = await stream(
			model,
			{ messages: [] },
			{ apiKey: token, transport: "sse", fetch, maxRetries: 2 },
		).result();
		expect(result.errorMessage).toContain("CERT_HAS_EXPIRED");
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
