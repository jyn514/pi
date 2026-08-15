import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";

const nativeEvent = {
	type: "response.completed",
	sequence_number: 0,
	response: {
		id: "resp_azure",
		status: "completed",
		output: [],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	},
} as unknown as ResponseStreamEvent;

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: () => {
				const responseStream = (async function* () {
					yield nativeEvent;
				})();
				const promise = Promise.resolve(responseStream) as unknown as Promise<
					AsyncIterable<ResponseStreamEvent>
				> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}
	return { AzureOpenAI };
});

import { stream as streamAzureOpenAI } from "../src/api/azure-openai-responses.ts";
import type { Context, Model, ProviderEvent } from "../src/types.ts";

const model: Model<"azure-openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure-openai-responses",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = {
	messages: [{ role: "user", content: "Search", timestamp: 0 }],
};

describe("Azure OpenAI provider events", () => {
	it("delivers parsed native events before normalization", async () => {
		const observed: ProviderEvent[] = [];
		const result = await streamAzureOpenAI(model, context, {
			apiKey: "test-key",
			onProviderEvent: (event) => observed.push(event),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(observed).toEqual([
			{
				provider: "azure-openai-responses",
				api: "azure-openai-responses",
				model: "gpt-5-mini",
				type: "response.completed",
				payload: nativeEvent,
			},
		]);
	});
});
