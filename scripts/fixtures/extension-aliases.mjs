import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getAliases } from "./dist/core/extensions/aliases.ts";

const aliases = getAliases();
for (const name of ["pi-agent-core", "pi-tui", "pi-ai/models", "pi-ai/oauth", "pi-ai/providers/all"]) {
	assert.match(aliases[`@earendil-works/${name}`], /import\.js$/);
	assert.equal(aliases[`@mariozechner/${name}`], aliases[`@earendil-works/${name}`]);
}
for (const name of ["pi-ai", "pi-ai/compat"]) {
	assert.equal(
		aliases[`@earendil-works/${name}`],
		fileURLToPath(new URL("./dist/core/extensions/pi-ai-extension-view.js", import.meta.url)),
	);
	assert.equal(aliases[`@mariozechner/${name}`], aliases[`@earendil-works/${name}`]);
}
assert.match(aliases.typebox, /require\.cjs$/);
