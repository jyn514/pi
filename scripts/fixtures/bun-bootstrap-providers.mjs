import assert from "node:assert/strict";

assert.ok(process.env.PI_PACKAGE_DIR, "providers evaluated before environment restoration");
export const bedrockProviderModule = {};
export function registerBunOAuthFlows() {
	process.env.PI_TEST_OAUTH_REGISTERED = "1";
}
export function setBedrockProviderModule(provider) {
	assert.equal(provider, bedrockProviderModule);
	process.env.PI_TEST_BEDROCK_REGISTERED = "1";
}
