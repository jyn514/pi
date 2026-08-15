import type { ProviderTool } from "../types.ts";

export function toAnthropicProviderTools(tools: readonly ProviderTool[]): Record<string, unknown>[] {
	return tools.map((tool) => {
		if (tool.allowedDomains?.length && tool.blockedDomains?.length) {
			throw new Error("Anthropic web search cannot combine allowedDomains and blockedDomains");
		}
		return {
			type: "web_search_20250305",
			name: "web_search",
			...(tool.maxUses !== undefined ? { max_uses: tool.maxUses } : {}),
			...(tool.allowedDomains?.length ? { allowed_domains: tool.allowedDomains } : {}),
			...(tool.blockedDomains?.length ? { blocked_domains: tool.blockedDomains } : {}),
		};
	});
}

export function toOpenAIProviderTools(tools: readonly ProviderTool[]): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: "web_search",
		...(tool.searchContextSize ? { search_context_size: tool.searchContextSize } : {}),
		...(tool.allowedDomains?.length ? { filters: { allowed_domains: tool.allowedDomains } } : {}),
	}));
}

export function toGoogleProviderTools(tools: readonly ProviderTool[]): Array<{ googleSearch: Record<string, never> }> {
	return tools.map(() => ({ googleSearch: {} }));
}
