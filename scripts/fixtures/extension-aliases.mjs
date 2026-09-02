import assert from "node:assert/strict";
import { getAliases } from "./dist/core/extensions/aliases.ts";

const aliases = getAliases();
for (const name of ["pi-agent-core", "pi-tui", "pi-ai/compat", "pi-ai/oauth", "pi-ai/providers/all"]) {
	assert.match(aliases[`@earendil-works/${name}`], /import\.js$/);
	assert.equal(aliases[`@mariozechner/${name}`], aliases[`@earendil-works/${name}`]);
}
assert.match(aliases.typebox, /require\.cjs$/);
