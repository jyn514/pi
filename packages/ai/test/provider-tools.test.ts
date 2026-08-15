import { describe, expect, it } from "vitest";
import { toAnthropicProviderTools, toGoogleProviderTools, toOpenAIProviderTools } from "../src/utils/provider-tools.ts";

describe("provider tools", () => {
	it("serializes web search for Anthropic", () => {
		expect(
			toAnthropicProviderTools([
				{
					type: "web_search",
					allowedDomains: ["rust-lang.org"],
					maxUses: 3,
				},
			]),
		).toEqual([
			{
				type: "web_search_20250305",
				name: "web_search",
				allowed_domains: ["rust-lang.org"],
				max_uses: 3,
			},
		]);
	});

	it("serializes web search for OpenAI Responses", () => {
		expect(
			toOpenAIProviderTools([
				{
					type: "web_search",
					allowedDomains: ["rust-lang.org"],
					searchContextSize: "high",
				},
			]),
		).toEqual([
			{
				type: "web_search",
				filters: { allowed_domains: ["rust-lang.org"] },
				search_context_size: "high",
			},
		]);
	});

	it("serializes web search for Google", () => {
		expect(toGoogleProviderTools([{ type: "web_search" }])).toEqual([{ googleSearch: {} }]);
	});

	it("rejects conflicting Anthropic domain filters", () => {
		expect(() =>
			toAnthropicProviderTools([
				{
					type: "web_search",
					allowedDomains: ["rust-lang.org"],
					blockedDomains: ["example.com"],
				},
			]),
		).toThrow("cannot combine");
	});
});
